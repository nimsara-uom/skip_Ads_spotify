// ============================================================
// content.js — AdVanish for Spotify
// ============================================================
// Full implementation: DetectionModule + ReactionModule + StatsTracker + UIOverlay
// Built commit-by-commit — see git log for individual lesson steps.
// ============================================================

'use strict';

// ── Configuration ────────────────────────────────────────────
const CONFIG = {
  POLL_INTERVAL_MS:  800,
  SPEED_RATE:        16,    // How fast to play ads (16x ≈ ~1.5s per 30s ad)
  REACTION_DELAY_MS: 300,   // Small delay before reacting (lets DOM settle)
  LOG_PREFIX:        '[AdVanish]',
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

  getAudioElement() {
    return document.querySelector('audio');
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
  react() {
    log(`Reaction chain starting (mode: ${state.mode})...`);
    const audio = DetectionModule.getAudioElement();

    // In 'mute' mode — skip the fancy stuff, just silence it
    if (state.mode === 'mute') {
      if (audio && this.fallbackMute(audio)) {
        this._activeAction = 'mute';
      }
      return;
    }

    // In 'speed' mode — skip if possible, then speed, skip mute-only fallback
    if (state.mode === 'speed') {
      if (this.tryClickSkip()) { this._activeAction = 'skip'; return; }
      if (audio && this.trySpeedUp(audio)) { this._activeAction = 'speed'; return; }
      return;
    }

    // 'auto' mode — full fallback chain
    if (this.tryClickSkip()) { this._activeAction = 'skip'; return; }
    if (audio && this.trySpeedUp(audio)) { this._activeAction = 'speed'; return; }
    if (audio && this.fallbackMute(audio)) { this._activeAction = 'mute'; return; }

    warn('All reaction strategies failed.');
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
    const skipBtn = document.querySelector('[data-testid="skip-forward-button"]');

    if (!skipBtn) {
      log('tryClickSkip: no skip button found');
      return false;
    }

    if (skipBtn.getAttribute('aria-disabled') === 'true') {
      log('tryClickSkip: skip button is disabled (non-skippable ad)');
      return false;
    }

    skipBtn.click();
    log('✅ tryClickSkip: clicked skip button');
    return true;
  },

  /**
   * trySpeedUp(audio) — Set playbackRate to CONFIG.SPEED_RATE (16x).
   *
   * LESSON: playbackRate
   *   The HTML spec says browsers MAY limit playbackRate to a certain range.
   *   Chrome supports at least 0.0625 to 16.0 on <audio>/<video>.
   *   Spotify's own JS might also try to reset playbackRate to 1.
   *   We'll handle that in Commit 24 (SPA navigation / periodic check).
   *
   *   At 16x speed, a 30-second ad finishes in about 1.875 seconds.
   *   We also mute it so the chipmunk-speed audio is silent.
   */
  trySpeedUp(audio) {
    try {
      audio.playbackRate = CONFIG.SPEED_RATE;
      audio.muted = true; // Mute during speedup — nobody wants 16x voice ads
      log(`✅ trySpeedUp: set playbackRate to ${CONFIG.SPEED_RATE}x, muted`);
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
  fallbackMute(audio) {
    try {
      audio.muted = true;
      log('✅ fallbackMute: audio muted');
      return true;
    } catch (err) {
      warn('fallbackMute failed:', err.message);
      return false;
    }
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
    const audio = DetectionModule.getAudioElement();

    switch (this._activeAction) {
      case 'speed':
        if (audio) {
          audio.playbackRate = 1;
          audio.muted = false;
          log('Reverted: playbackRate → 1, unmuted');
        }
        break;

      case 'mute':
        if (audio) {
          audio.muted = false;
          log('Reverted: unmuted');
        }
        break;

      case 'skip':
        log('Skip action: no revert needed');
        break;

      case null:
        break; // Nothing was done

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
    // Tell background.js an ad was handled — it updates storage + badge
    chrome.runtime.sendMessage({ type: 'AD_HANDLED' }, (response) => {
      if (chrome.runtime.lastError) {
        // This error fires if the background worker is asleep and not yet awake.
        // It's harmless — Chrome will have already woken it up.
        warn('sendMessage AD_HANDLED error (usually harmless):', chrome.runtime.lastError.message);
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
  StatsTracker.increment();

  // React after a small delay to let the DOM settle
  setTimeout(() => {
    ReactionModule.react();
    UIOverlay.showToast('⚡ Ad detected — handling...');
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
  log('Initializing AdVanish v0.1...');

  // LESSON: Read settings from storage on startup
  // chrome.storage.local.get() is async — we use a Promise wrapper
  // or pass a callback. Here we wrap it for async/await cleanliness.
  const stored = await chrome.storage.local.get(['enabled', 'mode']);
  if (stored.enabled !== undefined) state.enabled = stored.enabled;
  if (stored.mode    !== undefined) state.mode    = stored.mode;
  log('Settings loaded:', state);

  startObserver();
  startPolling();
  onDomChange(); // Check immediately on load
  log('✅ Ready. Watching for ads...');
}

init();

