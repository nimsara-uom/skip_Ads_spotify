# findings.md — Spotify Web Player DOM Recon

> **Purpose:** Document the DOM markers that indicate an ad is playing.
> These findings drive the `DetectionModule` in `src/content.js`.
> Treat this as living documentation — update as Spotify changes their UI.

---

## How to Do Your Own Recon

1. Open `open.spotify.com` in Chrome (free tier account needed)
2. Open DevTools: `F12` → **Elements** tab
3. Wait for an ad to play
4. Use the **inspector** (cursor icon top-left of DevTools) to click on parts of the player bar
5. Look for attributes, class names, and text content that change between ads and music

---

## Key DOM Markers Found

### 1. The Player Bar Footer

The entire bottom player bar is inside:
```
div[data-testid="now-playing-bar"]
```
Spotify uses `data-testid` attributes heavily — these are more stable than class names (which are often minified/hashed and change every deployment).

### 2. Ad Indicator: Advertisement Label

During ads, a text element appears in the "now playing" area:
```html
<!-- During music: -->
<div data-testid="context-item-info-subtitles">
  <a>Artist Name</a>
</div>

<!-- During ads: the subtitles area shows "Advertisement" -->
<div data-testid="context-item-info-subtitles">
  <span>Advertisement</span>
</div>
```
**Signal:** `document.querySelector('[data-testid="context-item-info-subtitles"]')?.textContent` includes "Advertisement".

### 3. Ad Indicator: Skip Button State

During a skippable ad, a skip button appears:
```html
<button data-testid="skip-forward-button" aria-disabled="false">
```
During music, the skip-forward button is for track skipping and behaves differently.
During non-skippable ads, `aria-disabled="true"`.

**Signal:** Look for `[data-testid="skip-forward-button"]` AND the "Advertisement" text together.

### 4. Ad Indicator: Page Title

Spotify sets `document.title` to something like:
```
"Advertisement - Spotify"   ← during ad
"Song Name - Artist - Spotify"  ← during music
```
**Signal:** `document.title.startsWith("Advertisement")` (brittle but useful as secondary check).

### 5. The Audio Element

```javascript
// In DevTools console on open.spotify.com:
document.querySelector('audio')
// → Returns an HTMLAudioElement, or null if using Web Audio API
```
**Finding:** Spotify DOES expose a standard `<audio>` element for most ads and music playback on the web player. The `src` attribute during ads often points to a CDN with "audio-ak.spotify.com" in the URL.

**Important:** `playbackRate` IS writable on this element. Setting it to `16` during an ad effectively skips it in ~1 second (though you'll hear a chipmunk-speed voice briefly).

```javascript
const audio = document.querySelector('audio');
audio.playbackRate = 16; // speeds up to 16x
audio.muted = true;      // or just mute it
```

### 6. Spotify's Own Ad Class (Less Stable)

```html
<div class="Root__now-playing-bar">
  <!-- During ads this div gets an extra attribute: -->
  <div data-testid="now-playing-widget" aria-label="Advertisement">
```
`aria-label="Advertisement"` on `[data-testid="now-playing-widget"]` is a clean, accessible signal.

---

## Detection Priority (Most → Least Reliable)

| Priority | Signal | Why |
|---|---|---|
| 🥇 1st | `[data-testid="now-playing-widget"][aria-label="Advertisement"]` | Aria labels are accessibility-standard, stable |
| 🥈 2nd | Subtitles text contains "Advertisement" | Text-based, can break if Spotify localizes |
| 🥉 3rd | `document.title` starts with "Advertisement" | Brittle, Spotify can change this easily |
| 4th | Audio `src` contains ad CDN domain | Only works if audio element is accessible |

---

## Audio Element Access

```javascript
const audio = document.querySelector('audio');
console.log(audio?.src);          // CDN URL
console.log(audio?.playbackRate); // 1 normally
console.log(audio?.muted);        // false normally

// These are WRITABLE:
audio.playbackRate = 16;  // ✅ works
audio.muted = true;       // ✅ works
audio.currentTime = audio.duration; // ⚠️ sometimes blocked by DRM
```

---

## Limitations & Edge Cases

- **Non-skippable audio ads:** `aria-label="Advertisement"` still fires, but there's no skip button to click — we fall back to speed-up or mute.
- **Video ads:** Spotify occasionally serves video ads. The `<video>` element has the same `playbackRate`/`muted` API. `[data-testid]` signals still work.
- **Localized Spotify:** "Advertisement" text may be in a different language if Spotify detects user locale. Rely on `aria-label` over text when possible.
- **SPA navigation:** Spotify is a React single-page app. Navigating between pages does NOT reload the content script. We need to handle `pushState` manually (Commit 24).

---

## DevTools Snippet for Live Testing

Paste this in the DevTools Console while on open.spotify.com to test detection:

```javascript
function detectAd() {
  // Check 1: aria-label (most reliable)
  const widget = document.querySelector('[data-testid="now-playing-widget"]');
  if (widget?.getAttribute('aria-label') === 'Advertisement') return true;

  // Check 2: subtitle text
  const subtitle = document.querySelector('[data-testid="context-item-info-subtitles"]');
  if (subtitle?.textContent?.includes('Advertisement')) return true;

  // Check 3: page title
  if (document.title.startsWith('Advertisement')) return true;

  return false;
}

// Run every second to watch state changes:
setInterval(() => console.log('Ad playing?', detectAd()), 1000);
```
