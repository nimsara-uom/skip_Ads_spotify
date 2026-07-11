// ============================================================
// popup.js — Popup Logic
// ============================================================
// LESSON: Popup lifecycle
//
// The popup opens fresh EVERY time the user clicks the icon.
// It is destroyed when it loses focus (user clicks elsewhere).
// This means:
//   - You cannot store state in module-level variables here
//   - Always read state from chrome.storage.local on open
//   - Always save changes back to chrome.storage.local
//
// LESSON: chrome.tabs.sendMessage
//   To talk to content.js, the popup needs the current tab's ID:
//   chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
//     chrome.tabs.sendMessage(tab.id, { type: 'SET_ENABLED', value: true });
//   });
//   This is different from chrome.runtime.sendMessage (which goes to background).
// ============================================================

'use strict';

// DOM element references
const toggleEl    = document.getElementById('enabled-toggle');
const statsEl     = document.getElementById('stats-count');
const modeEl      = document.getElementById('mode-select');

// ── Load current state when popup opens ──────────────────────
document.addEventListener('DOMContentLoaded', async () => {

  // Read settings from background via message
  const data = await sendToBackground({ type: 'GET_STATS' });

  if (data) {
    toggleEl.checked  = data.enabled !== false; // default true
    statsEl.textContent = data.statsToday ?? 0;
    modeEl.value       = data.mode ?? 'auto';
  }
});


// ── Toggle: enable/disable the extension ─────────────────────
toggleEl.addEventListener('change', async () => {
  const enabled = toggleEl.checked;

  // Save to storage (via background)
  await sendToBackground({ type: 'SET_SETTINGS', payload: { enabled } });

  // Tell content.js in the current tab
  await sendToContentScript({ type: 'SET_ENABLED', value: enabled });
});


// ── Mode select: auto / mute / speed ─────────────────────────
modeEl.addEventListener('change', async () => {
  const mode = modeEl.value;

  await sendToBackground({ type: 'SET_SETTINGS', payload: { mode } });
  await sendToContentScript({ type: 'SET_MODE', value: mode });
});


// ── Helper: send a message to background.js ──────────────────
function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Stupefy! popup] background error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}


// ── Helper: send a message to content.js in the active tab ───
// LESSON: We must use chrome.tabs.sendMessage (not runtime.sendMessage)
// to reach a content script. We get the active tab's ID first.
function sendToContentScript(message) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) { resolve(null); return; }

      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          // Content script might not be on a Spotify tab — that's fine
          console.warn('[Stupefy! popup] content script error:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });
  });
}
