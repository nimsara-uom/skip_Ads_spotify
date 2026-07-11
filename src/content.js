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
   *   Notice state is referenced here even though it's declared
   *   later in the file. This works because react() is called
   *   at runtime (not at parse time), so state is already defined
   *   by then. This is called "temporal dead zone" safety — as long
   *   as the const is declared before the function is CALLED (not
   *   just defined), you're fine.
   */
  /**
   * LESSON: The Reload Trick (the real exploit)
   *
   * After extensive testing, we confirmed:
   *   - Spotify's Web Player has NO accessible <audio> or <video> element
   *   - They use Encrypted Media Extensions (EME) + Web Audio API
   *   - playbackRate is not controllable from content scripts
   *
   * BUT: Spotify's servers don't save "mid-ad" state to your session.
   * If you reload the page during an ad, Spotify forgets the ad was
   * playing and loads the next actual song in your queue.
   *
   * This is the primary strategy now:
   *   1. Mute via UI (so you don't hear the ad during the ~2s reload)
   *   2. Reload the page
   *   3. On reload, content script re-injects, detects no ad, music plays
   *
   * Fallback chain:
   *   tryClickSkip() → tryReloadSkip() → tryMuteViaUI()
   */
  react() {
    log(`Reaction chain starting (mode: ${state.mode})...`);
    let succeeded = false;

    if (state.mode === 'mute') {
      // Mute-only mode: just silence the ad, no reload
      if (this.tryMuteViaUI())  { this._activeAction = 'uimute'; succeeded = true; }
    }
    else {
      // Auto or Speed mode: try to actually skip the ad
      if      (this.tryClickSkip())    { this._activeAction = 'skip';   succeeded = true; }
      else if (this.tryReloadSkip())   { this._activeAction = 'reload'; succeeded = true; }
      else if (this.tryMuteViaUI())    { this._activeAction = 'uimute'; succeeded = true; }
    }

    if (succeeded) {
      StatsTracker.increment();
      log(`✅ Reaction succeeded: ${this._activeAction}`);
    } else {
      warn('All reaction strategies failed — ad playing normally.');
    }
  },

  /**
   * tryClickSkip() — Simulate clicking Spotify's skip button.
   *
   * LESSON: Simulating user events
   *   content scripts CAN dispatch synthetic events on DOM nodes.
   *   element.click() is the simplest way.
   *   For more complex interactions, use new MouseEvent() or PointerEvent.
   *
   *   Note: This only works on SKIPPABLE ads. During non-skippable ads,
   *   the button exists but aria-disabled="true". Clicking it does nothing,
   *   which is why we check aria-disabled before clicking.
   */
  tryClickSkip() {
    // BUG FIX: Spotify uses different skip-button selectors depending
    // on ad type and web player version. We try all known ones.
    const SKIP_SELECTORS = [
      '[data-testid="skip-forward-button"]',     // regular track skip (sometimes works)
      '[data-testid="skip-ad-button"]',           // explicit ad skip button
      'button[class*="skip"]',                   // class-based fallback
      'button[aria-label*="Skip"]',              // aria-label based
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

    if (skipBtn.getAttribute('aria-disabled') === 'true'
        || skipBtn.disabled) {
      log('tryClickSkip: skip button is disabled (non-skippable ad)');
      return false;
    }

    skipBtn.click();
    log('✅ tryClickSkip: clicked skip button');
    return true;
  },

  /**
   * tryReloadSkip() — THE RELOAD TRICK
   *
   * LESSON: Exploiting server-side state gaps
   *   Spotify's CDN streams ad audio directly to the browser.
   *   The ad playback state is LOCAL — the Spotify backend only
   *   tracks "this user should see an ad soon" but NOT
   *   "this user is currently mid-ad at 12 seconds in".
   *
   *   When we reload the page:
   *   1. The browser kills all audio streams
   *   2. Spotify's web app boots fresh
   *   3. Backend says "ad was served" (or sometimes serves another)
   *   4. Your music queue resumes from where it was
   *
   *   We mute FIRST so the user hears nothing during the ~2s reload.
   *   A cooldown prevents infinite reload loops if an ad appears
   *   immediately after reload.
   */
  _lastReloadTime: 0,

  tryReloadSkip() {
    const now = Date.now();
    const timeSinceLastReload = now - this._lastReloadTime;

    // Cooldown check: don't reload again within 5 seconds
    // This prevents infinite loops: ad → reload → ad → reload → ...
    if (timeSinceLastReload < CONFIG.RELOAD_COOLDOWN) {
      log(`tryReloadSkip: cooldown active (${timeSinceLastReload}ms since last reload, need ${CONFIG.RELOAD_COOLDOWN}ms)`);
      return false;
    }

    log('tryReloadSkip: muting first, then reloading page...');

    // Step 1: Mute via UI so user doesn't hear the ad blast during reload
    this.tryMuteViaUI();

    // Step 2: Save the reload timestamp so we can enforce cooldown
    this._lastReloadTime = now;

    // Step 3: Store that we're doing a reload-skip (so init() knows on restart)
    try {
      chrome.storage.local.set({ _reloadSkipTime: now });
    } catch (e) {
      // Extension context might be invalidated — that's fine, we're reloading
    }

    // Step 4: Show toast briefly before reload
    UIOverlay.showToast('⚡ Skipping ad via reload...');

    // Step 5: Reload after a tiny delay (lets the mute + toast register)
    setTimeout(() => {
      log('🔄 Reloading page NOW');
      location.reload();
    }, 200);

    return true;
  },

  /**
   * trySpeedUp(media) — Set playbackRate to CONFIG.SPEED_RATE (16x).
   *
   * LESSON: Speed enforcement
   *   Spotify's own JavaScript WILL reset playbackRate back to 1.
   *   It polls its own media element and corrects the rate.
   *   To counter this, we use a "speed enforcer" — a setInterval
   *   that re-applies our desired rate every 50ms.
   *   This is a cat-and-mouse game: we keep setting 16x,
   *   Spotify keeps resetting to 1x. We're faster.
   *
   *   At 16x speed, a 30-second ad finishes in about 1.875 seconds.
   *   We also mute it so the chipmunk-speed audio is silent.
   */
  _speedEnforcerId: null, // setInterval ID for the speed enforcer

  trySpeedUp(media) {
    try {
      media.playbackRate = CONFIG.SPEED_RATE;
      media.muted = true;
      media.defaultPlaybackRate = CONFIG.SPEED_RATE; // Some players respect this

      // Start the speed enforcer — re-apply every 50ms
      // This beats Spotify's own reset loop
      this._speedEnforcerId = setInterval(() => {
        if (media && !media.paused) {
          if (media.playbackRate !== CONFIG.SPEED_RATE) {
            log(`Speed enforcer: Spotify reset rate to ${media.playbackRate}, re-applying ${CONFIG.SPEED_RATE}x`);
            media.playbackRate = CONFIG.SPEED_RATE;
          }
          if (!media.muted) {
            media.muted = true;
          }
        }
      }, 50);

      log(`✅ trySpeedUp: set playbackRate to ${CONFIG.SPEED_RATE}x, muted, enforcer active`);
      return true;
    } catch (err) {
      warn('trySpeedUp failed:', err.message);
      return false;
    }
  },

  /**
   * fallbackMute(audio) — Mute the audio element entirely.
   *
   * LESSON: .muted vs .volume
   *   audio.muted = true  → silences output but preserves .volume value
   *   audio.volume = 0    → also silences, but changes the volume knob
   *
   *   We prefer .muted because it's easier to revert cleanly:
   *   audio.muted = false  → restores previous volume automatically
   *   audio.volume = prev  → requires us to store and restore the old value
   */
  fallbackMute(media) {
    try {
      media.muted = true;
      media.volume = 0;
      log('✅ fallbackMute: media muted + volume=0');
      return true;
    } catch (err) {
      warn('fallbackMute failed:', err.message);
      return false;
    }
  },

  /**
   * tryMuteViaUI() — Click Spotify's own volume/mute button.
   *
   * LESSON: When no media element exists in the DOM
   *   If Spotify uses Web Audio API or a Shadow DOM for playback,
   *   we can't directly access the audio pipeline. But we CAN
   *   interact with Spotify's UI controls — the volume button
   *   in the player bar is always accessible in the DOM.
   *
   *   This is the "nuclear option" — it mutes the whole player,
   *   and the user will see the volume icon change. We revert it
   *   when the ad ends.
   */
  _uiWasMuted: false, // Track whether we muted via UI

  tryMuteViaUI() {
    const VOLUME_SELECTORS = [
      '[data-testid="volume-bar-toggle-mute-button"]',  // Spotify's mute toggle
      'button[aria-label*="Mute"]',
      'button[aria-label*="mute"]',
      'button[aria-label*="Volume"]',
    ];

    for (const sel of VOLUME_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) {
        // Check if already muted (aria-label might say "Unmute")
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
   * revert() — Undo whatever action we took when the ad ends.
   *
   * LESSON: State machines
   *   We use _activeAction to track what we did.
   *   This is a simple state machine with states:
   *     null   → no active action
   *     'skip' → ad was skipped (no revert needed)
   *     'speed'→ we sped up audio (revert: restore rate + unmute)
   *     'mute' → we muted audio (revert: unmute)
   *   State machines make it easy to reason about what needs cleanup.
   */
  revert() {
    const media = DetectionModule.getAudioElement();

    // Stop speed enforcer if running
    if (this._speedEnforcerId) {
      clearInterval(this._speedEnforcerId);
      this._speedEnforcerId = null;
      log('Speed enforcer stopped');
    }

    switch (this._activeAction) {
      case 'speed':
        if (media) {
          media.playbackRate = 1;
          media.defaultPlaybackRate = 1;
          media.muted = false;
          log('Reverted: playbackRate → 1, unmuted');
        }
        break;

      case 'mute':
        if (media) {
          media.muted = false;
          media.volume = 1;
          log('Reverted: unmuted, volume restored');
        }
        break;

      case 'uimute':
        // Click the mute button again to unmute
        if (this._uiWasMuted) {
          const btn = document.querySelector(
            '[data-testid="volume-bar-toggle-mute-button"], button[aria-label*="Unmute"], button[aria-label*="unmute"]'
          );
          if (btn) {
            btn.click();
            log('Reverted: clicked unmute via UI');
          }
          this._uiWasMuted = false;
        }
        break;

      case 'skip':
        log('Skip action: no revert needed');
        break;

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
    // BUG FIX: Wrap in try-catch to handle "Extension context invalidated"
    // This error occurs when the extension is reloaded/updated while
    // the content script is still running in an old tab. The old content
    // script's chrome.runtime reference becomes stale.
    try {
      chrome.runtime.sendMessage({ type: 'AD_HANDLED' }, (response) => {
        if (chrome.runtime.lastError) {
          warn('sendMessage AD_HANDLED error (harmless):', chrome.runtime.lastError.message);
          return;
        }
        log('StatsTracker: AD_HANDLED acknowledged by background');
      });
    } catch (err) {
      warn('StatsTracker: extension context invalidated, skipping:', err.message);
    }
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


