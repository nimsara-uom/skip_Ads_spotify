# AdVanish for Spotify ⚡

> A Chrome extension (Manifest V3) that detects Spotify Web Player ads and handles them via a **skip → speed-up → mute** fallback chain. Built as a learning project with 25+ intentional, educational commits.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-F7DF1E?logo=javascript&logoColor=black)
![No Build Step](https://img.shields.io/badge/No%20Build%20Step-✓-brightgreen)

---

## ⚠️ ToS Notice

Spotify's Terms of Service prohibit ad-blocking tools. **This project is built purely for educational purposes** — to learn Chrome extension development, DOM observation, and browser APIs. Use it responsibly and at your own risk. This is not intended for commercial distribution.

---

## How It Works

```
open.spotify.com tab
        │
        ▼
  content.js (injected)
        │
  DetectionModule
  ├── MutationObserver  ← fires on DOM changes (zero CPU when idle)
  └── setInterval       ← 800ms polling fallback
        │
        ▼ ad detected?
  ReactionModule (respects user's mode setting)
  ├── tryClickSkip()    ← best: ad gone instantly
  ├── trySpeedUp()      ← good: 16x speed, ~1.5s duration
  └── fallbackMute()    ← ok: silent until ad ends
        │
        ▼
  StatsTracker  ──→  background.js  ──→  chrome.storage.local
                                    ──→  chrome.action badge
        │
        ▼
  UIOverlay  → Toast: "⚡ Ad handled in 1.2s"
```

### Ad Detection Signals (priority order)

| # | Signal | Stability |
|---|---|---|
| 1 | `[data-testid="now-playing-widget"][aria-label="Advertisement"]` | 🟢 Most stable |
| 2 | Subtitle text contains "Advertisement" | 🟡 Moderate |
| 3 | `document.title` starts with "Advertisement" | 🔴 Brittle |

---

## Architecture

```
manifest.json              ← Extension config (MV3)
src/
├── content.js             ← Injected into open.spotify.com
│     DetectionModule      ← Is an ad playing?
│     ReactionModule       ← Handle it (skip/speed/mute)
│     StatsTracker         ← Count handled ads
│     UIOverlay            ← Show toast notification
├── background.js          ← Service worker
│     onInstalled          ← First-install setup
│     onMessage            ← Badge + storage updates
├── popup/
│     popup.html/css/js    ← Extension toolbar popup
└── onboard/
      onboard.html/css     ← First-install welcome page
icons/
├── icon16.png
├── icon48.png
└── icon128.png
findings.md                ← DOM recon documentation
```

---

## Installation (Load Unpacked)

1. Clone this repo:
   ```bash
   git clone https://github.com/nimsara-uom/skip_Ads_spotify.git
   ```

2. Open Chrome and go to `chrome://extensions`

3. Enable **Developer mode** (toggle in top-right corner)

4. Click **Load unpacked** and select the repo folder (the one containing `manifest.json`)

5. The AdVanish icon appears in your toolbar. Open `open.spotify.com` and wait for an ad.

---

## Features

- ⚡ **Auto-skip** skippable ads via simulated button click
- ⏩ **Speed-up** non-skippable ads to 16x (finishes in ~1.5s)
- 🔇 **Mute** fallback if audio element is inaccessible
- 🔄 **Auto-revert** — restores normal playback the instant the ad ends
- 📊 **Daily stats** — count visible on extension badge
- 🎛️ **Mode select** — Auto / Speed / Mute-only
- 🔔 **Toast notification** — visual confirmation each ad is handled
- 🎉 **Onboarding page** — shown on first install

---

## What I Learned (25 Commits, 10 Key Concepts)

| Concept | Where used |
|---|---|
| Manifest V3 structure | `manifest.json` |
| Content script isolated world | `content.js` header |
| `MutationObserver` API | `startObserver()` |
| `HTMLMediaElement` API | `trySpeedUp()`, `fallbackMute()` |
| Debouncing | `debounce()` utility |
| State machines | `ReactionModule._activeAction` |
| `chrome.storage.local` | `StatsTracker`, `init()` |
| Extension message passing | `chrome.runtime.sendMessage` |
| `chrome.action` badge | `background.js` |
| SPA navigation (pushState) | `handleSpaNavigation()` |

---

## Limitations

| Limitation | Notes |
|---|---|
| Web Player only | Desktop app is out of reach for content scripts |
| Spotify may reset `playbackRate` | Their JS checks and resets it; we poll to counteract |
| DOM markers can change | Built on multiple signals + `data-testid` which is relatively stable |
| Non-skippable video ads | Speed-up still works; skip button click has no effect |
| Localized Spotify | "Advertisement" text varies by locale; we prefer `aria-label` |

---

## Project Structure by Commit Phase

| Phase | Commits | Topic |
|---|---|---|
| 1 | 1–3 | Manifest, popup shell, DOM recon |
| 2 | 4–8 | DetectionModule (Observer + polling) |
| 3 | 9–14 | ReactionModule (skip/speed/mute chain) |
| 4 | 15–17 | Stats & chrome.storage messaging |
| 5 | 18–21 | Toast UI & popup wiring |
| 6 | 22–25 | Badge, onboarding, SPA nav, README |

---

## Tech Stack

- **Manifest V3** Chrome Extension
- **Vanilla JS** — no build step, no dependencies
- `chrome.storage.local` for persistence
- `chrome.runtime` message passing
- `MutationObserver` + `setInterval` for detection
- `HTMLMediaElement` API for playback control

---

*Built for [Contest Name] · Educational project · Not for commercial use*
