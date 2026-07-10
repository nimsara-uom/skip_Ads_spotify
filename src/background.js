// ============================================================
// background.js — Service Worker
// ============================================================
// LESSON: MV3 Service Workers
//
// In Manifest V3, the background "page" is replaced by a
// SERVICE WORKER. Key differences from a normal background page:
//
//   1. EPHEMERAL: Chrome starts it when needed, terminates it
//      after ~30s of inactivity. It does NOT run continuously.
//      Don't store state in module-level variables — it'll be
//      lost when the worker sleeps.
//
//   2. NO DOM: Service workers have no window, no document.
//      You can't do document.querySelector() here.
//
//   3. USE chrome.storage: For persistence, always use
//      chrome.storage.local (or chrome.storage.sync).
//
// This file handles:
//   - Receiving messages from content.js to update badge
//   - Initializing storage on first install
// ============================================================

'use strict';

const LOG = '[AdVanish BG]';

// ── First Install ─────────────────────────────────────────────
// chrome.runtime.onInstalled fires when the extension is:
//   - Installed for the first time (reason: 'install')
//   - Updated to a new version  (reason: 'update')
//   - Chrome itself is updated  (reason: 'chrome_update')
//
// We use this to set up default values in storage AND to open
// the onboarding page for new users.
chrome.runtime.onInstalled.addListener((details) => {
  console.log(LOG, 'onInstalled:', details.reason);

  if (details.reason === 'install') {
    // Set default settings on fresh install
    chrome.storage.local.set({
      enabled:    true,
      mode:       'auto',
      statsToday: 0,
      statsTotal: 0,
      lastDate:   todayStr(),
    });
    console.log(LOG, 'Default settings initialized');

    // LESSON: chrome.tabs.create() — open a new tab from the service worker
    // chrome.extension.getURL() (old) is now chrome.runtime.getURL() in MV3.
    // It converts a relative extension path to a full chrome-extension:// URL.
    const onboardUrl = chrome.runtime.getURL('src/onboard/onboard.html');
    chrome.tabs.create({ url: onboardUrl });
    console.log(LOG, 'Onboarding tab opened:', onboardUrl);
  }
});


// ── Message Handler ───────────────────────────────────────────
// LESSON: chrome.runtime.onMessage
//
// This is how scripts in different contexts talk to each other:
//   content.js      → chrome.runtime.sendMessage({ type: 'AD_HANDLED' })
//   background.js   → chrome.runtime.onMessage.addListener(handler)
//
// The handler receives: (message, sender, sendResponse)
//   message      → the object sent by the other script
//   sender       → info about who sent it (tab ID, URL, etc.)
//   sendResponse → call this to reply synchronously
//
// To reply ASYNCHRONOUSLY (after an await), return true from the handler.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG, 'Message received:', message.type);

  switch (message.type) {

    // content.js tells us an ad was handled → update badge
    case 'AD_HANDLED':
      handleAdHandled();
      sendResponse({ ok: true });
      break;

    // popup asks for current stats → fetch from storage and reply
    case 'GET_STATS':
      chrome.storage.local.get(['statsToday', 'statsTotal', 'enabled', 'mode'],
        (data) => sendResponse(data)
      );
      return true; // ← IMPORTANT: return true for async sendResponse

    // popup changed settings → save to storage
    case 'SET_SETTINGS':
      chrome.storage.local.set(message.payload, () => {
        sendResponse({ ok: true });
      });
      return true;

    default:
      console.warn(LOG, 'Unknown message type:', message.type);
  }
});


// ── Badge Update ──────────────────────────────────────────────
// LESSON: chrome.action.setBadgeText
//
// The badge is the small colored label on the extension icon.
// We show the daily ad count there.
// Max ~4 characters visible before it gets cut off.

async function handleAdHandled() {
  // Read current stats
  const data = await chrome.storage.local.get(['statsToday', 'statsTotal', 'lastDate']);

  // Reset daily counter if it's a new day
  const today = todayStr();
  const statsToday = data.lastDate === today ? (data.statsToday || 0) + 1 : 1;
  const statsTotal = (data.statsTotal || 0) + 1;

  // Save back
  await chrome.storage.local.set({ statsToday, statsTotal, lastDate: today });

  // Update badge
  chrome.action.setBadgeText({ text: String(statsToday) });
  chrome.action.setBadgeBackgroundColor({ color: '#1DB954' }); // Spotify green
  console.log(LOG, `Badge updated: ${statsToday} today, ${statsTotal} total`);
}


// ── Helpers ───────────────────────────────────────────────────
// Returns today's date as "YYYY-MM-DD" for daily counter resets
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
