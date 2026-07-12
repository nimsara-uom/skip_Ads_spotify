'use strict';


const CONFIG = {
  POLL_INTERVAL_MS: 800,
  SPEED_RATE: 16,
  REACTION_DELAY_MS: 500,   // Delay before reacting (lets DOM settle)
  RELOAD_COOLDOWN: 5000,  // Min ms between reloads (prevents infinite loop)
  LOG_PREFIX: '[Stupefy!]',
};

const DEBUG = true;
const log = (...args) => DEBUG && console.log(CONFIG.LOG_PREFIX, ...args);
const warn = (...args) => console.warn(CONFIG.LOG_PREFIX, ...args);

// When the extension reloads, the old content script keeps running with a
// dead chrome.runtime any chrome.call from it Extension context invalidated
// Check first before calling any chrome API
function isContextValid() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

function safeSendMessage(msg, callback) {
  if (!isContextValid()) {
    warn('safeSendMessage: extension context invalidated, skipping');
    return;
  }
  try {
    chrome.runtime.sendMessage(msg, callback || (() => {
      if (chrome.runtime.lastError) { /* swallow */ }
    }));
  } catch (e) {
    warn('safeSendMessage failed:', e.message);
  }
}



// Returns true if an ad is currently playing.
// Uses multiple DOM signals in priority order.

const DetectionModule = {

  detectAd() {
    // Signal 1: aria-label (most stable)
    const widget = document.querySelector('[data-testid="now-playing-widget"]');
    if (widget?.getAttribute('aria-label') === 'Advertisement') {
      return true;
    }

    // Signal 2: subtitle text
    const subtitle = document.querySelector('[data-testid="context-item-info-subtitles"]');
    if (subtitle?.textContent?.includes('Advertisement')) {
      return true;
    }

    // Signal 3: page title (least reliable)
    if (document.title.startsWith('Advertisement')) {
      return true;
    }

    return false;
  },


  getAudioElement() {
    const all = Array.from(document.querySelectorAll('video, audio'));
    log(`getAudioElement: found ${all.length} media elements in DOM`);

    all.forEach((el, i) => {
      log(`  [${i}] <${el.tagName.toLowerCase()}> src=${el.src?.slice(0, 80) || '(none)'} paused=${el.paused} muted=${el.muted} rate=${el.playbackRate}`);
    });

    const playing = all.find(a => !a.paused && !a.ended);
    const withBlob = all.find(a => a.src?.startsWith('blob:'));
    const withSrc = all.find(a => a.src);
    const found = playing || withBlob || withSrc || all[0] || null;

    if (!found) {
      warn('getAudioElement: NO media element found (no <video> or <audio> in DOM)');
    } else {
      log(`getAudioElement: selected <${found.tagName.toLowerCase()}> paused=${found.paused} src=${found.src?.slice(0, 60)}`);
    }
    return found;
  },
};



const ReactionModule = {

  _activeAction: null, // 'skip' | 'speed' | 'mute' | null

  react() {
    log(`Reaction chain starting (mode: ${state.mode})...`);
    let succeeded = false;

    try {
      if (state.mode === 'mute') {
        if (this.tryMuteViaInject()) { this._activeAction = 'inject-mute'; succeeded = true; }
        else if (this.tryMuteViaUI()) { this._activeAction = 'uimute'; succeeded = true; }
      }
      else {
        if (this.tryClickSkip()) { this._activeAction = 'skip'; succeeded = true; }
        else if (this.trySpeedUpViaInject()) { this._activeAction = 'inject-speed'; succeeded = true; }
        else if (this.tryMuteViaInject()) { this._activeAction = 'inject-mute'; succeeded = true; }
        else if (this.tryMuteViaUI()) { this._activeAction = 'uimute'; succeeded = true; }
        else if (this.tryReloadSkip()) { this._activeAction = 'reload'; succeeded = true; }
      }
    } catch (err) {
      warn('react() threw an error:', err.message);
    }

    if (succeeded) {
      if (this._activeAction !== 'reload') {
        StatsTracker.increment();
      }
      log(`✅ Reaction succeeded: ${this._activeAction}`);
    } else {
      warn('All reaction strategies failed — ad playing normally.');
    }
  },

  tryClickSkip() {
    const SKIP_SELECTORS = [
      '[data-testid="skip-forward-button"]',
      '[data-testid="skip-ad-button"]',
      'button[class*="skip"]',
      'button[aria-label*="Skip"]',
      'button[aria-label*="skip"]',
    ];

    let skipBtn = null;
    for (const sel of SKIP_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) { skipBtn = el; log('tryClickSkip: found button via', sel); break; }
    }

    if (!skipBtn) {
      log('tryClickSkip: no skip button found with any selector');
      return false;
    }

    if (skipBtn.getAttribute('aria-disabled') === 'true' || skipBtn.disabled) {
      log('tryClickSkip: skip button is disabled (non-skippable ad)');
      return false;
    }

    skipBtn.click();
    log('✅ tryClickSkip: clicked skip button');
    return true;
  },


  trySpeedUpViaInject() {
    log('trySpeedUpViaInject: sending speedup command to inject.js...');

    let gotResponse = false;
    const handler = (e) => {
      if (e.detail?.action === 'speedup') {
        gotResponse = true;
        log(`trySpeedUpViaInject: inject.js responded — ${e.detail.elements} media elements sped up`);
        if (e.detail.elements === 0) {
          warn('trySpeedUpViaInject: inject.js has 0 captured elements — speed-up may not work');
        }
      }
    };
    window.addEventListener('__stupefy_status', handler, { once: true });

    window.dispatchEvent(new CustomEvent('__stupefy_cmd', {
      detail: { action: 'speedup' }
    }));

    setTimeout(() => window.removeEventListener('__stupefy_status', handler), 100);

    log('✅ trySpeedUpViaInject: speedup command dispatched');
    return true;
  },

  tryMuteViaInject() {
    log('tryMuteViaInject: sending mute command to inject.js...');
    window.dispatchEvent(new CustomEvent('__stupefy_cmd', {
      detail: { action: 'mute' }
    }));
    log('✅ tryMuteViaInject: mute command dispatched');
    return true;
  },

  _uiWasMuted: false,

  tryMuteViaUI() {
    const VOLUME_SELECTORS = [
      '[data-testid="volume-bar-toggle-mute-button"]',
      'button[aria-label*="Mute"]',
      'button[aria-label*="mute"]',
      'button[aria-label*="Volume"]',
    ];

    for (const sel of VOLUME_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) {
        const label = btn.getAttribute('aria-label') || '';
        if (label.toLowerCase().includes('unmute')) {
          log('tryMuteViaUI: already muted, skipping click');
          this._uiWasMuted = false;
          return true;
        }
        btn.click();
        this._uiWasMuted = true;
        log(`✅ tryMuteViaUI: clicked mute button via ${sel}`);
        return true;
      }
    }

    log('tryMuteViaUI: no mute button found');
    return false;
  },

  _lastReloadTime: 0,

  tryReloadSkip() {
    const now = Date.now();
    if (now - this._lastReloadTime < CONFIG.RELOAD_COOLDOWN) {
      log('tryReloadSkip: cooldown active, skipping');
      return false;
    }

    log('tryReloadSkip: all else failed — reloading page...');
    this.tryMuteViaUI();
    this._lastReloadTime = now;

    try { chrome.storage.local.set({ _reloadSkipTime: now }); } catch (e) { }

    UIOverlay.showToast('⚡ Skipping ad via reload...');
    setTimeout(() => location.reload(), 200);
    return true;
  },

  revert() {
    log(`Reverting action: ${this._activeAction}`);

    switch (this._activeAction) {
      case 'inject-speed':
        window.dispatchEvent(new CustomEvent('__stupefy_cmd', {
          detail: { action: 'revert' }
        }));
        log('Reverted: sent revert to inject.js');
        break;

      case 'inject-mute':
        window.dispatchEvent(new CustomEvent('__stupefy_cmd', {
          detail: { action: 'unmute' }
        }));
        log('Reverted: sent unmute to inject.js');
        break;

      case 'uimute':
        if (this._uiWasMuted) {
          const btn = document.querySelector(
            '[data-testid="volume-bar-toggle-mute-button"], button[aria-label*="Unmute"], button[aria-label*="unmute"]'
          );
          if (btn) { btn.click(); log('Reverted: clicked unmute via UI'); }
          this._uiWasMuted = false;
        }
        break;

      case 'skip':
      case 'reload':
      case null:
        break;

      default:
        warn('revert: unknown action:', this._activeAction);
    }

    this._activeAction = null;
  },
};


// ── StatsTracker ──────────────────────────────────────────────

const StatsTracker = {
  increment() {
    safeSendMessage({ type: 'AD_HANDLED' }, (response) => {
      if (chrome.runtime?.lastError) {
        warn('AD_HANDLED error (harmless):', chrome.runtime.lastError.message);
        return;
      }
      log('StatsTracker: AD_HANDLED acknowledged by background');
    });
  },
};


// ── UIOverlay — Toast Notification ───────────────────────────

const UIOverlay = (() => {
  let stylesInjected = false;

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;

    const style = document.createElement('style');
    style.id = 'advanish-styles';
    style.textContent = `
      #advanish-toast {
        position: fixed;
        bottom: 100px;            /* Above Spotify's player bar */
        left: 50%;
        transform: translateX(-50%) translateY(20px);
        background: #1e1e1e;
        color: #ffffff;
        border: 1px solid #1DB954;
        border-radius: 999px;
        padding: 10px 20px;
        font-family: 'Circular', 'Helvetica', sans-serif;
        font-size: 14px;
        font-weight: 500;
        z-index: 99999;
        opacity: 0;
        transition: opacity 0.3s ease, transform 0.3s ease;
        pointer-events: none;     /* Don't block clicks on Spotify's UI */
        white-space: nowrap;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      }
      #advanish-toast.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    `;
    document.head.appendChild(style);
  }

  function getOrCreateToast() {
    let toast = document.getElementById('advanish-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'advanish-toast';
      document.body.appendChild(toast);
    }
    return toast;
  }

  let hideTimeout = null;

  return {
    showToast(message, durationMs = 3000) {
      injectStyles();
      const toast = getOrCreateToast();

      toast.textContent = message;
      toast.classList.add('visible');

      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        toast.classList.remove('visible');
      }, durationMs);

      log(`Toast: "${message}"`);
    },
  };
})();


// Coalesces rapid DOM mutations into a single handler call.
function debounce(fn, delay) {
  let timerId = null;
  return function (...args) {
    clearTimeout(timerId);
    timerId = setTimeout(() => fn(...args), delay);
  };
}


// ── State & Handlers ──────────────────────────────────────────

let adIsPlaying = false;
let adStartTime = null;

function onAdStart() {
  adStartTime = Date.now();

  UIOverlay.showToast('⚡ Ad detected — handling...');

  // Delay lets Spotify's React finish updating button states
  setTimeout(() => {
    ReactionModule.react();
  }, CONFIG.REACTION_DELAY_MS);
}

function onAdEnd() {
  ReactionModule.revert();

  if (adStartTime) {
    const elapsed = ((Date.now() - adStartTime) / 1000).toFixed(1);
    UIOverlay.showToast(`✅ Ad handled in ${elapsed}s`);
    adStartTime = null;
  }
}

const onDomChange = debounce(function () {
  if (!state.enabled) return;

  const nowPlaying = DetectionModule.detectAd();

  if (nowPlaying && !adIsPlaying) {
    adIsPlaying = true;
    log('🔴 Ad STARTED');
    onAdStart();
  } else if (!nowPlaying && adIsPlaying) {
    adIsPlaying = false;
    log('🟢 Ad ENDED');
    onAdEnd();
  }
}, 200);


// ── Persisted settings from chrome.storage ────────────────────

const state = {
  enabled: true,  // Can be toggled from popup
  mode: 'auto', // 'auto' | 'mute' | 'speed'
};


// ── Observer + Polling ────────────────────────────────────────

function startObserver() {
  const observer = new MutationObserver(onDomChange);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-disabled'],
  });
  log('MutationObserver active');
  return observer;
}

function startPolling() {
  return setInterval(onDomChange, CONFIG.POLL_INTERVAL_MS);
}


// ── Message Listener — Receives commands from popup.js ────────
// popup.js → content.js:   chrome.tabs.sendMessage(tabId, msg)
// content.js → background: chrome.runtime.sendMessage(msg)

if (isContextValid()) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('Message from popup:', message.type);

    switch (message.type) {
      case 'SET_ENABLED':
        state.enabled = message.value;
        log(`Extension ${state.enabled ? 'enabled' : 'disabled'}`);
        if (!state.enabled) ReactionModule.revert();
        sendResponse({ ok: true });
        break;

      case 'SET_MODE':
        state.mode = message.value;
        log(`Mode set to: ${state.mode}`);
        sendResponse({ ok: true });
        break;

      case 'PING':
        // Popup pings to check if content script is alive in this tab
        sendResponse({ ok: true, adIsPlaying, state });
        break;
    }
  });
}


// ── Init ──────────────────────────────────────────────────────

async function init() {
  log('Initializing Stupefy! v0.1...');

  try {
    const stored = await chrome.storage.local.get(['enabled', 'mode', '_reloadSkipTime']);
    if (stored.enabled !== undefined) state.enabled = stored.enabled;
    if (stored.mode !== undefined) state.mode = stored.mode;

    // Transfer reload timestamp so the cooldown is respected across page reloads,
    // preventing an infinite reload loop.
    if (stored._reloadSkipTime) {
      const elapsed = Date.now() - stored._reloadSkipTime;
      if (elapsed < CONFIG.RELOAD_COOLDOWN) {
        ReactionModule._lastReloadTime = stored._reloadSkipTime;
        log(`Post-reload cooldown active (${elapsed}ms ago)`);
      }
      chrome.storage.local.remove('_reloadSkipTime');
    }

    log('Settings loaded:', state);
  } catch (err) {
    warn('init: could not read storage (extension context may be stale):', err.message);
  }

  startObserver();
  startPolling();
  onDomChange();
  handleSpaNavigation();
  log('✅ Ready. Watching for ads...');
}


// ── SPA Navigation Handler ────────────────────────────────────
// Spotify is a React SPA — navigations use history.pushState without
// reloading the page. We monkey-patch pushState to reset ad state on
// navigation, preventing the detector from getting stuck.

function handleSpaNavigation() {
  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    originalPushState(...args);
    onNavigate();
  };

  // Also handle back/forward navigation
  window.addEventListener('popstate', onNavigate);

  log('SPA navigation handler registered');
}

function onNavigate() {
  log('SPA navigation detected → URL:', window.location.pathname);

  if (adIsPlaying) {
    log('Navigation mid-ad: reverting and resetting state');
    ReactionModule.revert();
    adIsPlaying = false;
  }

  // Re-check after DOM updates
  setTimeout(onDomChange, 500);
}


init();
