# 📚 LEARNING.md — Stupefy! Chrome Extension Deep-Dive

>**This is Fully AI genarated(Its saying by human, yeah me, Nimsara), I built this cause I want people to understand the code, not just fork and vibe code netire thing
> **What is this?**
> A complete, beginner-to-advanced guide for understanding **every file, every concept, and every design decision** in the Stupefy! Chrome extension. Read this before diving into the source code.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [How to Read This Project](#2-how-to-read-this-project)
3. [Chrome Extension Fundamentals](#3-chrome-extension-fundamentals)
4. [File-by-File Breakdown](#4-file-by-file-breakdown)
5. [Core Concepts Deep Dive](#5-core-concepts-deep-dive)
6. [Architecture and Data Flow](#6-architecture-and-data-flow)
7. [API Reference Cheatsheet](#7-api-reference-cheatsheet)
8. [Common Gotchas and Edge Cases](#8-common-gotchas-and-edge-cases)
9. [How to Rebuild This From Scratch](#9-how-to-rebuild-this-from-scratch)

---

## 1. Project Overview

**Stupefy!** is a Chrome extension (Manifest V3) that:
- Detects Spotify Web Player ads using DOM signals
- Handles them via a 3-tier fallback chain: Skip → Speed-Up → Mute
- Tracks daily stats shown on the extension badge
- Notifies the user with a toast notification

**Why it was built:** As an educational project to learn Chrome extension development, DOM observation, browser APIs, and JavaScript patterns like debouncing, monkey-patching, and module patterns.

> WARNING: Spotify Terms of Service prohibit ad-blocking. This project is for **learning only**.

---

## 2. How to Read This Project

**Recommended reading order:**

```
1. manifest.json          <- Start here: the extension ID card
2. src/inject.js          <- The main world script that captures media
3. src/content.js         <- The orchestrator: detect -> react -> revert
4. src/background.js      <- The service worker: storage + badge
5. src/popup/popup.html   <- The UI skeleton
6. src/popup/popup.js     <- Popup logic and messaging
7. src/popup/popup.css    <- Popup styles (Spotify dark theme)
8. src/onboard/           <- First-install welcome page
```

---

## 3. Chrome Extension Fundamentals

### What is a Chrome Extension?

A Chrome extension is a package of HTML, CSS, and JavaScript files that runs inside Chrome and can:
- Modify web pages (via **content scripts**)
- Run persistent background code (via a **service worker**)
- Show a custom popup UI (via the **action popup**)
- Access privileged browser APIs (storage, tabs, scripting, etc.)

### Manifest V3 vs Manifest V2

| Feature | MV2 (old) | MV3 (current) |
|---|---|---|
| Background | Persistent page | Ephemeral Service Worker |
| Script injection | chrome.tabs.executeScript | chrome.scripting.executeScript |
| Remote code | Allowed | BLOCKED (no eval, no remote scripts) |
| CSP | Configurable | Strict (no inline scripts in extension pages) |

**Key implication:** In MV3, your background worker **sleeps** after ~30 seconds of inactivity and wakes up on demand. Never store state in module-level variables in background.js!

---

## 4. File-by-File Breakdown

### 4.1 manifest.json

This is the **entry point** and **configuration file** for the entire extension. Chrome reads this first.

| Field | Purpose |
|---|---|
| manifest_version | Must be 3 for MV3 |
| name | Extension name shown in Chrome |
| permissions | Declare what APIs you need (storage, scripting, tabs) |
| host_permissions | Which URLs the extension can access |
| background.service_worker | Path to the background script |
| content_scripts | Which scripts inject into which pages, and when |
| action | The toolbar icon, popup HTML, and badge color |

**Lesson: Two content scripts, two worlds**

inject.js runs early in the MAIN world so it can intercept media elements before Spotify's own JavaScript creates them.
content.js runs later in the ISOLATED world — it cannot see Spotify's JS variables, but it can modify the DOM.

---

### 4.2 src/inject.js

**Role:** Runs in Spotify's main JavaScript world. Captures every media element by monkey-patching HTMLMediaElement.prototype.play.

**Key concepts demonstrated:**
- Monkey-patching prototype methods
- Function.prototype.apply
- WeakSet vs Set for element tracking
- CustomEvent for inter-world communication
- Speed enforcer loop (fighting Spotify's own rate resets)

**How it works:**

```js
// 1. Save the original play() before overriding it
const originalPlay = HTMLMediaElement.prototype.play;

// 2. Replace it with our wrapper
HTMLMediaElement.prototype.play = function () {
  capturedMedia.add(this);                        // Capture the element
  return originalPlay.apply(this, arguments);     // Call original
};
```

Every audio and video element in the entire page inherits from HTMLMediaElement. By patching the prototype, we intercept ALL of them — even ones Spotify creates dynamically later.

**The Speed Enforcer:**

Spotify's own JavaScript periodically resets playbackRate = 1. The enforcer runs every 50ms during an ad and re-applies our 16x rate.

**Commands it listens for (via CustomEvent on window):**

| Command | What it does |
|---|---|
| speedup | Sets playbackRate = 16 + starts enforcer loop |
| revert | Restores playbackRate = 1, unmutes, stops enforcer |
| mute | Sets el.muted = true, el.volume = 0 |
| unmute | Restores volume |
| status | Reports debug info back to content script |

---

### 4.3 src/content.js

**Role:** The main orchestrator. Detects ads, triggers reactions, reverts when ads end, sends stats, and shows toasts.
**Runs in:** Isolated world (default content script context)

**DetectionModule** uses 3 DOM signals in priority order to detect ads:

```
Signal 1: aria-label on now-playing widget         <- Most reliable
Signal 2: Subtitle text contains "Advertisement"   <- Moderate
Signal 3: document.title starts with "Advertisement" <- Least reliable
```

**NOTE:** Spotify uses a video element (not audio) for DRM-protected audio playback via Encrypted Media Extensions (EME).

**ReactionModule** implements the fallback chain:

```
tryClickSkip()         -> Simulates clicking Spotify skip button
      | fails?
trySpeedUpViaInject()  -> Sends speedup CustomEvent to inject.js
      | fails?
tryMuteViaInject()     -> Sends mute CustomEvent to inject.js
      | fails?
tryMuteViaUI()         -> Clicks Spotify volume/mute button
      | fails?
tryReloadSkip()        -> Nuclear option: page reload
```

**StatsTracker** routes stat increments through the background service worker via chrome.runtime.sendMessage.

**UIOverlay** is an IIFE (Immediately Invoked Function Expression) that creates a module pattern with private state for injecting floating toast notifications.

**Debounce function** wraps onDomChange to prevent the MutationObserver from firing dozens of times during a single DOM update burst.

**Message Listener** receives commands from popup.js:

| Message Type | Effect |
|---|---|
| SET_ENABLED | Toggles state.enabled on/off |
| SET_MODE | Changes state.mode (auto / mute / speed) |
| PING | Returns current state for popup status check |

**SPA Navigation Handler** patches history.pushState to detect Spotify React navigation and resets state on page changes.

---

### 4.4 src/background.js

**Role:** The MV3 Service Worker. Handles storage updates, badge management, and relays messages.

**It is ephemeral:** Chrome starts it when needed, stops it after ~30s of inactivity. Never use module-level variables for state — use chrome.storage.local instead.

**chrome.runtime.onInstalled** fires on first install, update, or Chrome update. Used to set default storage values and open the onboarding page.

**Async sendResponse rule:** When a message handler needs async work before responding, it must return true to keep the message channel open.

**Badge update:** Shows the number of ads handled today on the extension icon. Max ~4 visible characters.



---

### 4.5 src/popup/popup.html

The popup is a tiny Chrome-managed HTML page shown when the user clicks the extension icon.

**Key lessons:**
- No inline scripts allowed in MV3 extension pages due to CSP. Always use an external .js file.
- The popup is recreated every time it opens and destroyed when it loses focus.
- Always read state from chrome.storage.local on open; never rely on module-level variables.

---

### 4.6 src/popup/popup.js

**Role:** Wires up the popup HTML, reads current state from background, and sends commands when user changes settings.

**Two types of messages:**

```js
// To background.js — use chrome.runtime.sendMessage
chrome.runtime.sendMessage({ type: 'GET_STATS' }, callback);

// To content.js — use chrome.tabs.sendMessage (needs tab ID!)
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  chrome.tabs.sendMessage(tab.id, { type: 'SET_ENABLED', value: true });
});
```

Why two different APIs?
- chrome.runtime.sendMessage goes to the background service worker (no tab ID needed)
- chrome.tabs.sendMessage goes to a content script in a specific tab (tab ID required)

**Promise wrapper pattern:** Wrapping callback-based Chrome APIs in a Promise allows using async/await for cleaner code.

---

### 4.7 src/popup/popup.css

Uses a Spotify-inspired dark theme with CSS custom properties:

```css
:root {
  --green:   #1DB954;  /* Spotify green */
  --dark:    #121212;  /* Background */
  --surface: #1e1e1e;  /* Card backgrounds */
  --text:    #ffffff;
  --muted:   #a7a7a7;
}
```

**Toggle switch:** Pure CSS using a hidden checkbox and styled span. The ::before pseudo-element is the circular knob.

---

### 4.8 src/onboard/onboard.html and .css

A welcome page shown automatically on first install (opened via chrome.tabs.create() in background.js).

**Purpose:** Greets new users, explains how to use the extension in 4 steps, includes a ToS disclaimer.

---

## 5. Core Concepts Deep Dive

### 5.1 The Two Worlds of Chrome Extensions

```
MAIN WORLD (Spotify JS context)
- Spotify React app runs here
- Audio/Video elements created here
- inject.js runs here ("world": "MAIN")
- CANNOT access chrome.* APIs

ISOLATED WORLD (Content Script context)
- content.js runs here
- CAN see the DOM
- CANNOT see Spotify JS variables
- HAS access to chrome.* APIs

SHARED: The DOM (document, window)
They CAN communicate via CustomEvent on window
```

Why does this matter? Spotify creates media elements in its own JS context. inject.js runs in the MAIN world to capture them at creation time via prototype patching.

---

### 5.2 MutationObserver vs setInterval

The extension uses BOTH for ad detection:

```js
// Method 1: MutationObserver — fires immediately on DOM changes
const observer = new MutationObserver(onDomChange);
observer.observe(document.body, {
  childList: true,         // Watch for added/removed elements
  subtree: true,           // Watch the entire subtree
  attributes: true,        // Watch attribute changes
  attributeFilter: ['aria-label', 'aria-disabled'],
});

// Method 2: setInterval — polling fallback every 800ms
setInterval(onDomChange, 800);
```

| | MutationObserver | setInterval |
|---|---|---|
| When it fires | Immediately on DOM change | Every 800ms regardless |
| CPU cost | Zero when idle | Small but constant |
| Risk | Can miss non-DOM changes | Never misses, but delayed |
| Why both? | Fast response | Catch anything observer missed |

---

### 5.3 Monkey-Patching and Prototype Interception

Monkey-patching means modifying an existing function or object at runtime to add behavior.

```js
const originalPlay = HTMLMediaElement.prototype.play;

HTMLMediaElement.prototype.play = function () {
  capturedMedia.add(this);                        // Our addition
  return originalPlay.apply(this, arguments);     // Original behavior preserved
};
```

**Function.prototype.apply(thisArg, args)**
- thisArg = the this context (the media element that called .play())
- arguments = passes through all original arguments unchanged

**Why prototype patching?** Because ALL audio and video elements inherit from HTMLMediaElement. Patching the prototype means our code intercepts EVERY media element, even those created dynamically later.

**CRITICAL: Always call the original function!** If you don't, Spotify audio will break.

---

### 5.4 Debouncing

A debounce function prevents rapid-fire calls from triggering the same action many times:

```js
function debounce(fn, delay) {
  let timerId = null;
  return function (...args) {
    clearTimeout(timerId);                          // Cancel previous timer
    timerId = setTimeout(() => fn(...args), delay); // Schedule new one
  };
}
```

Without debounce: DOM mutation fires react() 30 times, clicks skip 30 times.
With 200ms debounce: All mutations coalesce into ONE call after the burst settles.

---

### 5.5 The Fallback Chain Pattern

A robust pattern: try the best option first, degrade gracefully if it fails.

```
tryClickSkip()         -> Best UX (ad gone instantly)
      | fails?
trySpeedUpViaInject()  -> Good UX (ad over in ~1.9s)
      | fails?
tryMuteViaInject()     -> OK (hear nothing, but ad runs)
      | fails?
tryMuteViaUI()         -> Last resort UI interaction
      | fails?
tryReloadSkip()        -> Nuclear: page reload (slow, loses player state)
```

Each step:
1. Returns true on success, false on failure
2. Sets _activeAction so revert() knows what to undo
3. Is protected by try/catch to prevent one failure from crashing everything

---

### 5.6 Cross-World Communication via CustomEvent

Content scripts and main-world scripts share window. They pass messages via CustomEvent:

```js
// content.js (isolated world) -> inject.js (main world)
window.dispatchEvent(new CustomEvent('__stupefy_cmd', {
  detail: { action: 'speedup' }
}));

// inject.js listens in main world
window.addEventListener('__stupefy_cmd', (e) => {
  const action = e.detail?.action;
  // handle it...
});

// inject.js -> content.js (response)
window.dispatchEvent(new CustomEvent('__stupefy_status', {
  detail: { ok: true, action: 'speedup', elements: 3 }
}));
```

Use double underscores and a unique prefix to avoid conflicts with Spotify events.

---

### 5.7 SPA Navigation Handling

Spotify is a React single-page application. When you click pages, the URL changes but the page never reloads. Chrome injected our content script once and it keeps running.

**The solution:** Patch history.pushState:

```js
const originalPushState = history.pushState.bind(history);
history.pushState = function (...args) {
  originalPushState(...args);  // Call real pushState first
  onNavigate();                // Then run our cleanup
};

window.addEventListener('popstate', onNavigate); // Back/forward buttons
```

onNavigate() resets adIsPlaying = false and calls ReactionModule.revert() to clean up.

---

### 5.8 Extension Context Invalidation

When you reload an extension during development, Chrome injects a NEW content script but the OLD one keeps running with a DEAD chrome.runtime. Any chrome.* call throws "Extension context invalidated".

**The fix:**

```js
function isContextValid() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    return false;
  }
}
```

Always check this before making chrome.* calls in long-running content scripts.

---

## 6. Architecture and Data Flow

```
open.spotify.com tab
        |
  inject.js (MAIN world, document_start)
  - Patches .play() on HTMLMediaElement.prototype
  - Tracks all media elements in capturedMedia Set
  - Speed enforcer loop (50ms) fights Spotify rate resets
  - Listens: window event '__stupefy_cmd'
        |
        | CustomEvent (__stupefy_cmd / __stupefy_status)
        |
  content.js (ISOLATED world, document_idle)
  - DetectionModule: MutationObserver + setInterval(800ms)
  - ReactionModule: tryClickSkip -> trySpeedUp -> tryMute -> tryReload
  - StatsTracker: sends AD_HANDLED to background
  - UIOverlay: shows toast notifications
        |
        | chrome.runtime.sendMessage({ type: 'AD_HANDLED' })
        |
  background.js (Service Worker)
  - Updates statsToday and statsTotal in chrome.storage.local
  - Updates chrome.action badge text
  - Handles GET_STATS for popup
  - Handles SET_SETTINGS from popup
        |
        | chrome.runtime.sendMessage / chrome.tabs.sendMessage
        |
  popup.js + popup.html
  - Toggle enable/disable
  - Change mode (auto / mute / speed)
  - Display daily stats count
```

### Message Routing Summary

| From | To | API | Message Types |
|---|---|---|---|
| content.js | background.js | chrome.runtime.sendMessage | AD_HANDLED |
| popup.js | background.js | chrome.runtime.sendMessage | GET_STATS, SET_SETTINGS |
| popup.js | content.js | chrome.tabs.sendMessage | SET_ENABLED, SET_MODE, PING |
| background.js | popup.js | sendResponse(data) | stats data |
| content.js | inject.js | CustomEvent on window | __stupefy_cmd |
| inject.js | content.js | CustomEvent on window | __stupefy_status |

---

## 7. API Reference Cheatsheet

### HTMLMediaElement API

```js
el.playbackRate       // 1 = normal, 16 = very fast (read/write)
el.muted              // true/false (read/write)
el.volume             // 0.0 to 1.0 (read/write)
el.paused             // is it paused? (read-only)
el.ended              // has it finished? (read-only)
el.duration           // total length in seconds (read-only)
el.currentTime        // seconds into the track (read/write)
el.src                // source URL (read/write)
el.defaultPlaybackRate // default rate for new content (read/write)
```

### Chrome Extension APIs Used

```js
// Storage
chrome.storage.local.get(['key1', 'key2'], callback)
chrome.storage.local.set({ key: value }, callback)
chrome.storage.local.remove('key', callback)

// Messaging
chrome.runtime.sendMessage(message, callback)         // to background
chrome.runtime.onMessage.addListener(handler)
chrome.tabs.sendMessage(tabId, message, callback)     // to content script
chrome.tabs.query({ active: true, currentWindow: true }, callback)

// Badge
chrome.action.setBadgeText({ text: 'string' })
chrome.action.setBadgeBackgroundColor({ color: '#hex' })

// Lifecycle
chrome.runtime.onInstalled.addListener(details => {})
chrome.runtime.getURL('relative/path')               // -> chrome-extension://...
chrome.tabs.create({ url: 'someUrl' })

// Context check
chrome.runtime.id          // undefined if context is invalidated
chrome.runtime.lastError   // error from last API call
```

### DOM APIs Used

```js
// Observation
new MutationObserver(callback)
observer.observe(element, { childList, subtree, attributes, attributeFilter })

// DOM query
document.querySelector(selector)
document.querySelectorAll(selector)
element.getAttribute('aria-label')
element.textContent

// Events
window.addEventListener('__stupefy_cmd', handler)
window.dispatchEvent(new CustomEvent('name', { detail: {...} }))

// Navigation
history.pushState        // monkey-patched to detect SPA navigation
window.addEventListener('popstate', cb)   // back/forward buttons
window.location.pathname // current URL path
```

---

## 8. Common Gotchas and Edge Cases

### 1. Spotify uses video for audio
Spotify uses Encrypted Media Extensions (EME/Widevine) which requires a video element even for audio-only playback. Always query 'video, audio' — not just 'audio'.

### 2. Extension context invalidation
When you reload the extension during development, the old content script keeps running with a dead chrome.runtime. Always wrap chrome.* calls with isContextValid() or try/catch.

### 3. Async sendResponse requires return true
If your onMessage handler needs async work before calling sendResponse, you MUST return true to keep the message channel open. Otherwise Chrome closes it and your response is dropped.

### 4. Popup is recreated every time
The popup opens fresh on every click. Never store anything in popup module-level variables — always read from chrome.storage.local on open.

### 5. Background worker sleeps after 30s
The MV3 service worker is ephemeral. Module-level variables reset every time it wakes up. All persistent state goes in chrome.storage.local.

### 6. The reload cooldown prevents infinite loops
tryReloadSkip() reloads the page as a last resort. Without a cooldown, it could loop: page reloads -> extension re-injects -> ad still detected -> reloads again. The _reloadSkipTime is persisted in storage to survive across reloads.

### 7. Debounce is critical with MutationObserver
A single ad starting can trigger dozens of DOM mutations (React re-renders). Without debouncing onDomChange, you'd click skip 30 times, send 30 AD_HANDLED messages, and show 30 toasts.

### 8. Speed enforcement requires a loop
Spotify's own JavaScript resets playbackRate = 1 periodically. The 50ms enforcer interval in inject.js wins the race by re-applying playbackRate = 16 faster than Spotify can reset it.

### 9. SPA navigation can leave state stuck
Spotify is a React SPA. Navigating pages does not reload the content script. handleSpaNavigation() resets adIsPlaying proactively on navigation.

---

## 9. How to Rebuild This From Scratch

### Step 1: Project skeleton
Create folder structure and manifest.json. Test that Chrome can load it as an unpacked extension.

### Step 2: Basic content script
Add src/content.js with a simple console.log. Verify it appears in the browser console on open.spotify.com.

### Step 3: Ad detection
Implement DetectionModule.detectAd() with Signal 1 (aria-label). Add a setInterval polling loop.

### Step 4: Simple mute reaction
Add ReactionModule.tryMuteViaUI() and call it when an ad is detected. Verify you cannot hear ads.

### Step 5: Toast notification
Implement UIOverlay.showToast(). Inject the CSS style and the toast div.

### Step 6: State tracking (onAdStart / onAdEnd)
Add the adIsPlaying boolean. Call onAdStart() and onAdEnd() on state transitions. Add revert logic.

### Step 7: Debounce
Wrap onDomChange in the debounce() function. Observe how it smooths out rapid-fire triggers.

### Step 8: MutationObserver
Add startObserver() alongside the interval. Now you get both instant response and a polling fallback.

### Step 9: Background service worker
Create src/background.js. Add chrome.runtime.onInstalled, the message handler, and handleAdHandled() with badge updates.

### Step 10: Stats tracking
Add StatsTracker.increment() in content.js. Wire up the AD_HANDLED message to the background.

### Step 11: Popup UI
Create popup.html, popup.css, and popup.js. Show the daily stats count. Wire up the enable/disable toggle.

### Step 12: Mode select
Add the mode dropdown to the popup. Implement SET_MODE message handling in content.js. Update ReactionModule.react() to respect state.mode.

### Step 13: inject.js — Main world injection
Add inject.js to manifest.json with "world": "MAIN". Implement prototype patching of HTMLMediaElement.prototype.play.

### Step 14: Speed-up via inject
Implement the __stupefy_cmd event listener in inject.js. Add trySpeedUpViaInject() in content.js.

### Step 15: Speed enforcer loop
Add the 50ms setInterval enforcer in inject.js to fight Spotify rate resets.

### Step 16: Revert logic
Implement the revert command in inject.js and ReactionModule.revert() in content.js.

### Step 17: Skip button click
Add tryClickSkip() with multiple CSS selector fallbacks. Put it at the top of the fallback chain.

### Step 18: Reload skip (safety net)
Add tryReloadSkip() with a 5-second cooldown. Persist _reloadSkipTime in storage to survive the reload.

### Step 19: SPA navigation handler
Add handleSpaNavigation(). Patch history.pushState and listen for popstate.

### Step 20: Extension context validation
Add isContextValid() and safeSendMessage(). Guard all chrome.* calls in the content script.

### Step 21: Onboarding page
Create src/onboard/onboard.html and .css. Open it via chrome.tabs.create() on first install.

---

## Congratulations!

You now understand every line of Stupefy! — from manifest declarations to monkey-patching browser prototypes to fighting an SPA navigation model.

**Key takeaways:**
- Chrome extensions have two isolated JavaScript worlds that communicate via CustomEvent
- MV3 service workers are ephemeral — use chrome.storage.local for persistence
- Prototype patching lets you intercept ALL instances of an object, past and future
- Debouncing is critical when using MutationObserver to prevent burst-firing
- Robust systems use fallback chains — try best, degrade gracefully

**Next things to explore:**
- Adding chrome.storage.sync to sync settings across devices
- Using chrome.declarativeNetRequest for network-level ad blocking (MV3 way)
- Building an options page with detailed stats graphs
- Adding Spotify Desktop support via native messaging

---

*Built with love as a learning project. Inspired by https://github.com/clairefro/blockify*
