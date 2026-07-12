# Stupefy! ⚡

> A Chrome extension (Manifest V3) that detects Spotify Web Player ads and handles them via a **skip → speed-up → mute** fallback chain. Built as a learning project with 25+ intentional, educational commits.

> 📖 **New here? Start with [LEARNING.md](./LEARNING.md)** — it explains every concept, the correct order to read the source files, and how to rebuild this from scratch.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-F7DF1E?logo=javascript&logoColor=black)
![No Build Step](https://img.shields.io/badge/No%20Build%20Step-✓-brightgreen)

---

## ⚠️ ToS Notice

Spotify's Terms of Service prohibit ad-blocking tools. **This project is built purely for educational purposes** — to learn Chrome extension development, DOM observation, and browser APIs. Use it responsibly and at your own risk.

---

## How It Works

```text
open.spotify.com tab
        │
        ▼
  content.js (injected)
        │
  DetectionModule (MutationObserver + 800ms polling)
        │
        ▼ ad detected?
  ReactionModule (skip → speed-up 16x → mute)
        │
        ▼
  StatsTracker  ──→  background.js  ──→  chrome.storage
        │
        ▼
  UIOverlay  → Toast: "⚡ Ad handled in 1.2s"
```

### Ad Detection Signals
| # | Signal | Stability |
|---|---|---|
| 1 | `[data-testid="now-playing-widget"][aria-label="Advertisement"]` | 🟢 Most stable |
| 2 | Subtitle text contains "Advertisement" | 🟡 Moderate |
| 3 | `document.title` starts with "Advertisement" | 🔴 Brittle |

---

## Installation (Load Unpacked)

1. Clone this repo: `git clone https://github.com/nimsara-uom/skip_Ads_spotify.git`
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. Open `open.spotify.com` and start listening.

---

## Features

- ⚡ **Auto-skip** skippable ads via simulated button click.
- ⏩ **Speed-up** non-skippable ads to 16x (finishes in ~1.5s).
- 🔇 **Mute** fallback if audio element is inaccessible.
- 🔄 **Auto-revert** — restores playback the instant the ad ends.
- 📊 **Daily stats** — count visible on extension badge.
- 🎛️ **Mode select** — Auto / Speed / Mute-only.
- 🔔 **Toast notification** — visual confirmation of ad handling.
- 🎉 **Onboarding page** — shown on first install.

---

## Limitations

| Limitation | Notes |
|---|---|
| Web Player only | Desktop app is inaccessible to content scripts |
| Spotify may reset speed | JS checks reset `playbackRate`; we poll to counteract |
| DOM changes | Built on multiple signals; `data-testid` is most reliable |
| Localization | "Advertisement" text varies; `aria-label` is preferred |

---

## Tech Stack

- **Manifest V3** Chrome Extension
- **Vanilla JS** (No build step)
- `chrome.storage.local` persistence
- `MutationObserver` + `HTMLMediaElement` API

---

## This is inspired by 
- **https://github.com/clairefro/blockify
- Huge thanks to **clairefro**