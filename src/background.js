
// In Manifest V3
//   1. EPHEMERAL
//   2. NO DOM: 
//   3. USE chrome

'use strict';

const LOG = '[Stupefy! BG]';


// We use this to set up default values in storage AND to open
// the onboarding page for new users.
chrome.runtime.onInstalled.addListener((details) => {
  console.log(LOG, 'onInstalled:', details.reason);

  if (details.reason === 'install') {
    // Set default settings on fresh install
    chrome.storage.local.set({
      enabled: true,
      mode: 'auto',
      statsToday: 0,
      statsTotal: 0,
      lastDate: todayStr(),
    });
    console.log(LOG, 'Default settings initialized');

    /
    // It converts a relative extension path to a full chrome-extension:// URL.
    const onboardUrl = chrome.runtime.getURL('src/onboard/onboard.html');
    chrome.tabs.create({ url: onboardUrl });
    console.log(LOG, 'Onboarding tab opened:', onboardUrl);
  }
});


// ── Message Handler ───────────────────────────────────────────


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
