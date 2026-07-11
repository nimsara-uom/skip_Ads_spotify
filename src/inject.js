// ============================================================
// inject.js — Stupefy! Main-World Injection
// ============================================================
//
// LESSON: The Two Worlds of Chrome Extensions
//
// Chrome content scripts run in an "isolated world":
//   - They CAN read/modify the page's DOM
//   - They CANNOT access the page's JavaScript variables
//
// Spotify creates its audio via `new Audio()` or a <video>
// element in its OWN JavaScript context. These elements are
// never appended to the DOM, so document.querySelector()
// can't find them from the content script.
//
// Solution: This file is registered in manifest.json with
// "world": "MAIN" — it runs inside Spotify's own JS context,
// BEFORE Spotify's code loads (run_at: document_start).
//
// We monkey-patch HTMLMediaElement.prototype.play() to capture
// every media element the moment Spotify calls .play() on it.
// Then the content script can tell us to speed up or mute
// those elements via CustomEvent messages.
//
// LESSON: Monkey-patching prototype methods
//   Every <audio> and <video> element inherits from
//   HTMLMediaElement. By overriding .play() on the prototype,
//   we intercept ALL media playback — past and future elements.
//   We save the original function and call it normally, so
//   Spotify works exactly as before. We just get a reference
//   to the element for later manipulation.
// ============================================================

(function () {
  'use strict';

  const PREFIX = '[Stupefy! inject]';
  const log = (...args) => console.log(PREFIX, ...args);

  // ── Storage for captured media elements ──────────────────────
  // WeakSet wouldn't let us iterate, so we use a Set.
  // We clear dead references periodically to avoid leaks.
  const capturedMedia = new Set();

  // ── Speed enforcer state ────────────────────────────────────
  let enforcerInterval = null;
  let isSpedUp = false;
  const SPEED_RATE = 16;  // 16x = 30s ad → ~1.9s
  const ENFORCER_INTERVAL = 50; // ms between enforcement checks

  // ============================================================
  // Monkey-patch: HTMLMediaElement.prototype.play
  // ============================================================
  //
  // LESSON: Function.prototype.apply
  //   When we override a method, we must call the ORIGINAL
  //   implementation to keep things working. We use:
  //     originalFn.apply(this, arguments)
  //   `this` = the media element that called .play()
  //   `arguments` = any arguments passed to .play()
  //   This preserves the exact behavior as if we weren't here.

  const originalPlay = HTMLMediaElement.prototype.play;

  HTMLMediaElement.prototype.play = function () {
    // Capture this element
    if (!capturedMedia.has(this)) {
      capturedMedia.add(this);
      log(`Captured new media element: <${this.tagName.toLowerCase()}>`,
        `src=${(this.src || this.currentSrc || '(MediaSource)').slice(0, 80)}`,
        `| total captured: ${capturedMedia.size}`);
    }

    // If we're currently in speed-up mode, apply it immediately
    // to any newly-playing element (e.g., Spotify switching tracks
    // or loading a new ad audio segment)
    if (isSpedUp) {
      this.playbackRate = SPEED_RATE;
      this.muted = true;
      log('Auto-applied speed-up to newly playing element');
    }

    // Call the original .play() — returns a Promise
    return originalPlay.apply(this, arguments);
  };

  // Also patch the Audio constructor for `new Audio(url)` usage
  const OriginalAudio = window.Audio;
  window.Audio = function (...args) {
    const audioEl = new OriginalAudio(...args);
    capturedMedia.add(audioEl);
    log(`Captured Audio constructor element, total: ${capturedMedia.size}`);
    return audioEl;
  };
  // Preserve prototype chain
  window.Audio.prototype = OriginalAudio.prototype;

  // ============================================================
  // Speed Enforcer
  // ============================================================
  //
  // LESSON: Why enforcement is necessary
  //   Spotify's own JS periodically sets playbackRate = 1 on
  //   its media elements. We fight back by re-applying our
  //   desired rate every 50ms. At this speed, the user never
  //   hears normal-speed ad audio — our override wins the race.

  function startEnforcer() {
    if (enforcerInterval) return; // Already running

    enforcerInterval = setInterval(() => {
      capturedMedia.forEach(el => {
        // Clean up dead elements (garbage collected or removed)
        try {
          // Check if element is still alive by reading a property
          const _ = el.paused;
        } catch (e) {
          capturedMedia.delete(el);
          return;
        }

        // Only enforce on elements that are playing
        if (!el.paused && !el.ended) {
          if (el.playbackRate !== SPEED_RATE) {
            el.playbackRate = SPEED_RATE;
          }
          if (!el.muted) {
            el.muted = true;
          }
        }
      });
    }, ENFORCER_INTERVAL);

    log(`Speed enforcer started (${ENFORCER_INTERVAL}ms interval, ${capturedMedia.size} elements)`);
  }

  function stopEnforcer() {
    if (enforcerInterval) {
      clearInterval(enforcerInterval);
      enforcerInterval = null;
      log('Speed enforcer stopped');
    }
  }

  // ============================================================
  // Communication: Content Script ↔ Main World
  // ============================================================
  //
  // LESSON: CustomEvent for cross-world communication
  //   Content scripts and main-world scripts share the same DOM.
  //   They can communicate via CustomEvent on the `window` object.
  //
  //   Content script → Main world:
  //     window.dispatchEvent(new CustomEvent('__stupefy_cmd', { detail: { action: 'speedup' } }));
  //
  //   Main world → Content script:
  //     window.dispatchEvent(new CustomEvent('__stupefy_status', { detail: { ... } }));
  //
  //   This is the standard, clean way to bridge the two worlds.

  window.addEventListener('__stupefy_cmd', (e) => {
    const action = e.detail?.action;
    log(`Received command: ${action}`);

    switch (action) {
      case 'speedup':
        isSpedUp = true;
        // Apply to all currently captured elements immediately
        capturedMedia.forEach(el => {
          try {
            el.playbackRate = SPEED_RATE;
            el.muted = true;
            el.defaultPlaybackRate = SPEED_RATE;
          } catch (err) {
            // Element might be dead
          }
        });
        startEnforcer();
        // Tell the content script we succeeded
        window.dispatchEvent(new CustomEvent('__stupefy_status', {
          detail: { ok: true, action: 'speedup', elements: capturedMedia.size }
        }));
        break;

      case 'revert':
        isSpedUp = false;
        stopEnforcer();
        // Restore all elements
        capturedMedia.forEach(el => {
          try {
            el.playbackRate = 1;
            el.defaultPlaybackRate = 1;
            el.muted = false;
          } catch (err) {
            // Element might be dead
          }
        });
        window.dispatchEvent(new CustomEvent('__stupefy_status', {
          detail: { ok: true, action: 'revert' }
        }));
        break;

      case 'mute':
        capturedMedia.forEach(el => {
          try {
            el.muted = true;
            el.volume = 0;
          } catch (err) {}
        });
        window.dispatchEvent(new CustomEvent('__stupefy_status', {
          detail: { ok: true, action: 'mute', elements: capturedMedia.size }
        }));
        break;

      case 'unmute':
        capturedMedia.forEach(el => {
          try {
            el.muted = false;
            el.volume = 1;
          } catch (err) {}
        });
        window.dispatchEvent(new CustomEvent('__stupefy_status', {
          detail: { ok: true, action: 'unmute' }
        }));
        break;

      case 'status':
        // Report current state for debugging
        const info = [];
        capturedMedia.forEach(el => {
          try {
            info.push({
              tag: el.tagName,
              paused: el.paused,
              muted: el.muted,
              rate: el.playbackRate,
              src: (el.src || el.currentSrc || '').slice(0, 60),
              duration: el.duration,
              currentTime: el.currentTime,
            });
          } catch (e) {}
        });
        window.dispatchEvent(new CustomEvent('__stupefy_status', {
          detail: { action: 'status', isSpedUp, elements: info }
        }));
        break;
    }
  });

  log('✅ Main-world injection complete. Waiting for media elements...');
})();
