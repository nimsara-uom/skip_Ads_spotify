// ============================================================
// content.js — Stupefy!
// ============================================================
// Full implementation: DetectionModule + ReactionModule + StatsTracker + UIOverlay
// Built commit-by-commit — see git log for individual lesson steps.
// ============================================================

'use strict';

// ── Configuration ────────────────────────────────────────────
const CONFIG = {
  POLL_INTERVAL_MS:  800,
  SPEED_RATE:        16,
  REACTION_DELAY_MS: 500,   // Delay before reacting (lets DOM settle)
  RELOAD_COOLDOWN:   5000,  // Min ms between reloads (prevents infinite loop)
  LOG_PREFIX:        '[Stupefy!]',
};

const DEBUG = true;
const log  = (...args) => DEBUG && console.log(CONFIG.LOG_PREFIX, ...args);
const warn = (...args) => console.warn(CONFIG.LOG_PREFIX, ...args);

// LESSON: Extension context can become "invalidated"
// When you reload the extension (↻ in chrome://extensions), Chrome
// injects a NEW content script but the OLD one keeps running with a
// DEAD chrome.runtime. Any chrome.* call from the old script throws
// "Extension context invalidated". This helper lets us check first.
function isContextValid() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}

// Safe wrapper for chrome.runtime.sendMessage
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


// ============================================================
// MODULE 1: DetectionModule
// ============================================================
// Returns true if an ad is currently playing.
// Uses multiple DOM signals in priority order.
// ============================================================

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

  /**
   * getAudioElement() → HTMLMediaElement | null
   *
   * LESSON: Spotify does NOT use a plain <audio> tag!
   * Modern Spotify uses Encrypted Media Extensions (EME) with a
   * <video> element for DRM-protected audio playback. Yes — a
   * <video> tag even though it's only playing audio. This is how
   * browsers handle DRM (Widevine/PlayReady).
   *
   * We search for ALL media elements: video AND audio.
   * Priority: playing element > element with src > any element
   */
  getAudioElement() {
    // Search BOTH video and audio — Spotify typically uses <video>
    const all = Array.from(document.querySelectorAll('video, audio'));
    log(`getAudioElement: found ${all.length} media elements in DOM`);

    // Log details of each for debugging
    all.forEach((el, i) => {
      log(`  [${i}] <${el.tagName.toLowerCase()}> src=${el.src?.slice(0, 80) || '(none)'} paused=${el.paused} muted=${el.muted} rate=${el.playbackRate}`);
    });

    // Prefer one that is actively playing
    const playing = all.find(a => !a.paused && !a.ended);
    // Fall back to one with a MediaSource (src is blob:)
    const withBlob = all.find(a => a.src?.startsWith('blob:'));
    // Fall back to any with a src
    const withSrc = all.find(a => a.src);
    // Last resort: any media element at all
    const found = playing || withBlob || withSrc || all[0] || null;

    if (!found) {
      warn('getAudioElement: NO media element found (no <video> or <audio> in DOM)');
    } else {
      log(`getAudioElement: selected <${found.tagName.toLowerCase()}> paused=${found.paused} src=${found.src?.slice(0, 60)}`);
    }
    return found;
  },
};


// ============================================================
// MODULE 2: ReactionModule
// ============================================================
// LESSON: The Fallback Chain
//
// We try actions in order, from "best user experience" to
// "least ideal". This is a common pattern in robust systems:
// try the best option first, degrade gracefully if it fails.
//
// Order:
//   1. tryClickSkip()  → Best: ad disappears immediately
//   2. trySpeedUp()    → Good: ad plays in ~1s at 16x speed
//   3. fallbackMute()  → OK:   ad plays silently at normal speed
//
// LESSON: HTMLMediaElement API
//   Every <audio> and <video> element in HTML inherits from
//   HTMLMediaElement. Key properties:
//     .playbackRate  → 1 = normal, 2 = 2x speed, 0.5 = slow, 16 = very fast
//     .muted         → true/false (separate from .volume)
//     .volume        → 0.0 to 1.0
//     .currentTime   → seconds into the track
//     .duration      → total length in seconds
//     .paused        → is it paused?
//   All of these are READ/WRITE (except .duration which is read-only)
// ============================================================

const ReactionModule = {

  // Tracks which action was taken so we can undo it in onAdEnd()
  _activeAction: null, // 'skip' | 'speed' | 'mute' | null

  /**
   * react() — Main entry point.
   *
   * LESSON: Respecting user preferences via state.mode
   *   'auto'  → full chain: skip → speed → mute (best to worst)
   *   'speed' → skip straight to speed-up (skip first if possible)
   *   'mute'  → skip straight to mute (most conservative)
   *
   *   The key insight: inject.js runs in Spotify's MAIN world and
   *   has captured all media elements via prototype patching.
   *   We communicate with it via CustomEvent on window.
   *   This gives us direct control over playbackRate and muted
   *   even though the content script can't see those elements.
   *
   * Fallback chain (auto mode):
   *   tryClickSkip() → trySpeedUpViaInject() → tryMuteViaInject()
   *   → tryMuteViaUI() → tryReloadSkip()
   */
  react() {
    log(`Reaction chain starting (mode: ${state.mode})...`);
    let succeeded = false;

    try {
      if (state.mode === 'mute') {
        // Mute-only mode
        if      (this.tryMuteViaInject()) { this._activeAction = 'inject-mute'; succeeded = true; }
        else if (this.tryMuteViaUI())     { this._activeAction = 'uimute';      succeeded = true; }
      }
      else {
        // Auto or Speed mode — try to genuinely skip/speed the ad
        if      (this.tryClickSkip())        { this._activeAction = 'skip';         succeeded = true; }
        else if (this.trySpeedUpViaInject()) { this._activeAction = 'inject-speed'; succeeded = true; }
        else if (this.tryMuteViaInject())    { this._activeAction = 'inject-mute';  succeeded = true; }
        else if (this.tryMuteViaUI())        { this._activeAction = 'uimute';       succeeded = true; }
        else if (this.tryReloadSkip())       { this._activeAction = 'reload';       succeeded = true; }
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

  /**
   * tryClickSkip() — Simulate clicking Spotify's skip button.
   */
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

  /**
   * trySpeedUpViaInject() — THE PRIMARY STRATEGY
   *
   * LESSON: Cross-world communication via CustomEvent
   *   inject.js runs in Spotify's main JS world. It has captured
   *   every media element via monkey-patching. We send it a
   *   'speedup' command via CustomEvent on the window object.
   *
   *   The inject.js will:
   *   1. Set playbackRate = 16 on ALL captured media elements
   *   2. Mute them so you don't hear chipmunk audio
   *   3. Start a 50ms enforcer loop that re-applies the rate
   *      (because Spotify's own JS tries to reset it to 1)
   *
   *   Result: 30-second ad plays in ~1.9 seconds, silently.
   *   Your current song is NOT lost — no page reload needed.
   */
  trySpeedUpViaInject() {
    log('trySpeedUpViaInject: sending speedup command to inject.js...');

    // Listen for the response from inject.js
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

    // Send the command
    window.dispatchEvent(new CustomEvent('__stupefy_cmd', {
      detail: { action: 'speedup' }
    }));

    // Clean up listener after a short delay (sync response expected)
    setTimeout(() => window.removeEventListener('__stupefy_status', handler), 100);

    // The command is synchronous (inject.js handles it immediately)
    // We consider it succeeded even if we haven't gotten the response yet
    // because the event dispatch itself is synchronous
    log('✅ trySpeedUpViaInject: speedup command dispatched');
    return true;
  },

  /**
   * tryMuteViaInject() — Mute via the injected main-world script.
   *   Falls back to this if speed-up isn't desired (mute mode).
   */
  tryMuteViaInject() {
    log('tryMuteViaInject: sending mute command to inject.js...');
    window.dispatchEvent(new CustomEvent('__stupefy_cmd', {
      detail: { action: 'mute' }
    }));
    log('✅ tryMuteViaInject: mute command dispatched');
    return true;
  },

  /**
   * tryMuteViaUI() — Click Spotify's own volume/mute button.
   *   Last resort before reload — interacts with the visible UI.
   */
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

  /**
   * tryReloadSkip() — Nuclear option: reload the page.
   *   Only used as absolute last resort when inject.js AND UI mute both fail.
   */
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

    try { chrome.storage.local.set({ _reloadSkipTime: now }); } catch (e) {}

    UIOverlay.showToast('⚡ Skipping ad via reload...');
    setTimeout(() => location.reload(), 200);
    return true;
  },

  /**
   * revert() — Undo whatever action we took when the ad ends.
   *   Sends 'revert' to inject.js to restore normal playback.
   */
  revert() {
    log(`Reverting action: ${this._activeAction}`);

    switch (this._activeAction) {
      case 'inject-speed':
        // Tell inject.js to restore playbackRate and unmute
        window.dispatchEvent(new CustomEvent('__stupefy_cmd', {
          detail: { action: 'revert' }
        }));
        log('Reverted: sent revert to inject.js');
        break;

      case 'inject-mute':
        // Tell inject.js to unmute
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


// ============================================================
// MODULE 3: StatsTracker
// ============================================================
// LESSON: chrome.runtime.sendMessage from content script
//
// Content scripts can send messages to the background service
// worker using chrome.runtime.sendMessage(). The background
// worker handles it in its onMessage listener.
//
// Content scripts CANNOT directly call chrome.storage from
// the content script context in all cases — it's cleaner to
// route stats through the background so the badge can update.
// ============================================================

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


// ============================================================
// MODULE 4: UIOverlay — Toast Notification
// ============================================================
// LESSON: Injecting DOM elements from a content script
//
// Our content script can freely ADD elements to Spotify's DOM.
// We create a floating toast div and inject it into <body>.
// The toast is styled with our own CSS (injected via a <style>
// tag) so it doesn't inherit Spotify's styles.
//
// Key challenge: Spotify's page might have a high z-index on
// its UI elements. We use z-index: 99999 to float above them.
// ============================================================

const UIOverlay = (() => {
  // We only inject the styles once
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

      // Set message and show
      toast.textContent = message;
      toast.classList.add('visible');

      // Auto-hide after durationMs
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        toast.classList.remove('visible');
      }, durationMs);

      log(`Toast: "${message}"`);
    },
  };
})(); // IIFE — Immediately Invoked Function Expression
      // This creates a private scope for stylesInjected and hideTimeout
      // so they're not accessible globally. A simple module pattern.


// ============================================================
// LESSON: Debouncing
// ============================================================
// A debounce prevents a function from being called too rapidly.
// Without debouncing, a single "ad started" DOM mutation could
// fire onDomChange() dozens of times (every child mutation),
// triggering multiple clicks on the skip button.
//
// How debounce works:
//   - Each call resets a timer to fire after `delay` ms
//   - Only the LAST call in a burst actually executes
//   - This coalesces many rapid calls into one
//
// Example without debounce:
//   DOM mutation → onDomChange() → click skip
//   DOM mutation → onDomChange() → click skip  ← double trigger!
//   DOM mutation → onDomChange() → click skip  ← triple trigger!
//
// Example with debounce (delay=200ms):
//   DOM mutation → timer reset
//   DOM mutation → timer reset
//   DOM mutation → timer reset
//   ...200ms pass → onDomChange() fires ONCE ← 

function debounce(fn, delay) {
  let timerId = null;
  return function (...args) {
    clearTimeout(timerId);                      // Reset the timer
    timerId = setTimeout(() => fn(...args), delay); // Schedule the real call
  };
}


// ============================================================
// State & Handlers
// ============================================================

let adIsPlaying = false;
let adStartTime = null; // Track when ad started (for toast timing)

function onAdStart() {
  adStartTime = Date.now();

  UIOverlay.showToast('⚡ Ad detected — handling...');

  // React after a short delay to let the DOM finish rendering
  // (Spotify's React takes a moment to update button states)
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

// Debounced version of the change handler — prevents rapid-fire reactions
const onDomChange = debounce(function () {
  // LESSON: Check enabled state before reacting
  // The popup can toggle the extension on/off. We check the flag here
  // so the observer/polling continue running (cheap), but reactions
  // are gated by user preference.
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


// ============================================================
// State — persisted settings from chrome.storage
// ============================================================

const state = {
  enabled: true,  // Can be toggled from popup
  mode:    'auto', // 'auto' | 'mute' | 'speed'
};


// ============================================================
// Observer + Polling
// ============================================================

function startObserver() {
  const observer = new MutationObserver(onDomChange);
  observer.observe(document.body, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ['aria-label', 'aria-disabled'],
  });
  log('MutationObserver active');
  return observer;
}

function startPolling() {
  return setInterval(onDomChange, CONFIG.POLL_INTERVAL_MS);
}


// ============================================================
// Message Listener — Receives commands from popup.js
// ============================================================
// LESSON: chrome.tabs.sendMessage vs chrome.runtime.sendMessage
//
// popup.js → content.js:  use chrome.tabs.sendMessage(tabId, msg)
//   (popup must know the tab ID — it gets it via chrome.tabs.query)
//
// content.js → background.js: use chrome.runtime.sendMessage(msg)
//   (no tab ID needed — goes straight to the service worker)
//
// chrome.runtime.onMessage handles BOTH directions.
// The `sender` object tells you who sent it.

if (isContextValid()) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('Message from popup:', message.type);

  switch (message.type) {
    case 'SET_ENABLED':
      state.enabled = message.value;
      log(`Extension ${state.enabled ? 'enabled' : 'disabled'}`);
      if (!state.enabled) ReactionModule.revert(); // Clean up if turning off mid-ad
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
} // end isContextValid() guard for message listener


// ============================================================
// Init
// ============================================================

async function init() {
  log('Initializing Stupefy! v0.1...');

  try {
    const stored = await chrome.storage.local.get(['enabled', 'mode', '_reloadSkipTime']);
    if (stored.enabled !== undefined) state.enabled = stored.enabled;
    if (stored.mode    !== undefined) state.mode    = stored.mode;

    // If we just did a reload-skip, transfer the timestamp to the
    // ReactionModule so the cooldown is respected across page reloads.
    // Without this, a reload would reset _lastReloadTime to 0 and
    // potentially cause an infinite loop.
    if (stored._reloadSkipTime) {
      const elapsed = Date.now() - stored._reloadSkipTime;
      if (elapsed < CONFIG.RELOAD_COOLDOWN) {
        ReactionModule._lastReloadTime = stored._reloadSkipTime;
        log(`Post-reload cooldown active (${elapsed}ms ago)`);
      }
      // Clean up the flag
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


// ============================================================
// Commit 24: SPA Navigation Handler
// ============================================================
// LESSON: The Single-Page App (SPA) problem
//
// Spotify is a React app. When you click "Home" → "Artist" →
// "Album", the URL changes (via history.pushState) but the
// PAGE NEVER RELOADS. Chrome injected our content script ONCE
// when the tab first loaded. It keeps running across all these
// "navigations".
//
// The problem: when Spotify navigates, the player bar DOM is
// re-rendered. Our MutationObserver handles this fine since it
// watches document.body broadly. But adIsPlaying state could
// get stuck in the wrong state if the ad ends mid-navigation.
//
// Solution: Listen for navigation events and reset state.
//
// HOW history.pushState PATCHING WORKS:
//   The browser doesn't fire a useful event for pushState calls.
//   We monkey-patch (wrap) the native function to intercept calls:
//     const original = history.pushState;
//     history.pushState = function(...args) {
//       original.apply(this, args);  // Call the real pushState
//       ourCallback();               // Then do our thing
//     }
// This is a common SPA content script technique.

function handleSpaNavigation() {
  // Patch history.pushState
  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    originalPushState(...args);
    onNavigate();
  };

  // Also handle back/forward button (popstate event)
  window.addEventListener('popstate', onNavigate);

  log('SPA navigation handler registered');
}

function onNavigate() {
  log('SPA navigation detected → URL:', window.location.pathname);

  // If an ad was "playing" but we navigated away, reset state.
  // The new page might not have an ad. Let the observer re-detect.
  if (adIsPlaying) {
    log('Navigation mid-ad: reverting and resetting state');
    ReactionModule.revert();
    adIsPlaying = false;
  }

  // Re-check the new page after a short delay (DOM needs to update)
  setTimeout(onDomChange, 500);
}


init();


