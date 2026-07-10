// ============================================================
// popup.js — Popup Logic (stub, wired in Phase 5)
// ============================================================
// LESSON: Popup context vs Content script context
//
// The popup runs in a SEPARATE PAGE from Spotify's tab.
// It cannot directly call functions in content.js.
// Communication happens via chrome.runtime.sendMessage() —
// the popup sends a message, the content script receives it
// and sends back a response. We'll build this in Commits 17-21.
//
// For now: just log that the popup loaded.
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  console.log('[AdVanish] Popup ready — wiring coming in Phase 5.');

  // Placeholder: show "—" in stats until wired to storage
  const count = document.getElementById('stats-count');
  if (count) count.textContent = '—';
});
