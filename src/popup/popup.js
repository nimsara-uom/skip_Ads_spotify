// ============================================================
// popup.js — Stupefy! Premium Popup Logic
// ============================================================
// Popup lifecycle reminder:
//   - Re-opens fresh each time the user clicks the icon.
//   - Always read state from chrome.storage, never local vars.
// ============================================================

'use strict';

// ── DOM refs ─────────────────────────────────────────────────
const toggleEl      = document.getElementById('enabled-toggle');
const statsEl       = document.getElementById('stats-count');
const statsTotalEl  = document.getElementById('stats-total');
const statusCard    = document.getElementById('status-card');
const statusTitle   = document.getElementById('status-title');
const statusSub     = document.getElementById('status-sub');
const statusBadge   = document.getElementById('status-badge');
const pills         = document.querySelectorAll('.pill');
const modeHint      = document.getElementById('mode-hint');
const openSpotifyBtn = document.getElementById('open-spotify-btn');

let currentMode = 'auto';

const MODE_HINTS = {
  auto:  'Skip → speed-up → mute fallback chain',
  mute:  'Audio is muted for the entire ad duration',
  speed: 'Ad plays at 16× speed (near-instant)',
};

// ── Init: load state when popup opens ────────────────────────
document.addEventListener('DOMContentLoaded', async () => {

  // 1. Fetch stats + settings from background
  const data = await sendToBackground({ type: 'GET_STATS' });

  if (data) {
    const enabled = data.enabled !== false;
    toggleEl.checked = enabled;
    currentMode = data.mode ?? 'auto';

    // Animate counters from 0 → actual value
    animateCount(statsEl,      0, data.statsToday  ?? 0);
    animateCount(statsTotalEl, 0, data.statsTotal  ?? 0);

    setActivePill(currentMode);
    updateStatusUI(enabled);
  }

  // 2. Ping content script to see if an ad is currently playing
  const ping = await sendToContentScript({ type: 'PING' });
  if (ping?.adIsPlaying) {
    setAdActiveUI(true);
  }
});


// ── Toggle: enable / disable ──────────────────────────────────
toggleEl.addEventListener('change', async () => {
  const enabled = toggleEl.checked;
  await sendToBackground({ type: 'SET_SETTINGS', payload: { enabled } });
  await sendToContentScript({ type: 'SET_ENABLED', value: enabled });
  updateStatusUI(enabled);
});


// ── Mode Pills ────────────────────────────────────────────────
pills.forEach(pill => {
  pill.addEventListener('click', async () => {
    const mode = pill.dataset.mode;
    if (mode === currentMode) return;
    currentMode = mode;
    setActivePill(mode);
    await sendToBackground({ type: 'SET_SETTINGS', payload: { mode } });
    await sendToContentScript({ type: 'SET_MODE', value: mode });
  });
});


// ── Open Spotify button ───────────────────────────────────────
openSpotifyBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://open.spotify.com' });
});


// ── UI Helpers ────────────────────────────────────────────────
function setActivePill(mode) {
  pills.forEach(p => p.classList.toggle('active', p.dataset.mode === mode));
  modeHint.textContent = MODE_HINTS[mode] ?? '';
}

function updateStatusUI(enabled) {
  if (!enabled) {
    statusCard.className = 'status-card disabled';
    statusTitle.textContent = 'Paused';
    statusSub.textContent   = 'Extension is disabled';
    statusBadge.textContent = 'Off';
    statusBadge.style.cssText = `
      background: rgba(136,136,136,0.1);
      color: var(--muted);
      border-color: rgba(136,136,136,0.2);
    `;
  } else {
    statusCard.className = 'status-card';
    statusTitle.textContent = 'Ready';
    statusSub.textContent   = 'Watching for ads…';
    statusBadge.textContent = 'Active';
    statusBadge.style.cssText = '';
  }
}

function setAdActiveUI(active) {
  if (!active) return;
  statusCard.className    = 'status-card ad-active';
  statusTitle.textContent = 'Ad Detected!';
  statusSub.textContent   = 'Handling right now…';
  statusBadge.textContent = 'Blocking';
  statusBadge.style.cssText = `
    background: rgba(241,94,94,0.12);
    color: #f15e5e;
    border-color: rgba(241,94,94,0.3);
  `;
}


// ── Animated counter ──────────────────────────────────────────
function animateCount(el, from, to) {
  if (from === to) { el.textContent = to; return; }
  const duration = 650;
  const start    = performance.now();

  const step = (now) => {
    const t        = Math.min((now - start) / duration, 1);
    const eased    = 1 - Math.pow(1 - t, 3);  // ease-out cubic
    el.textContent = Math.round(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else        el.classList.add('bump');
  };

  requestAnimationFrame(step);
  el.addEventListener('animationend', () => el.classList.remove('bump'), { once: true });
}


// ── Messaging helpers ─────────────────────────────────────────
function sendToBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Stupefy! popup] bg error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

function sendToContentScript(message) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) { resolve(null); return; }
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response);
      });
    });
  });
}
