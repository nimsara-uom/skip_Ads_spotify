// ============================================================
// background.js — Service Worker
// ============================================================
// In Manifest V3, there are NO persistent background pages.
// Instead, Chrome runs a "service worker" — it wakes up on
// events (like a message from content.js) and goes back to
// sleep when idle. This is more memory-efficient.
//
// Right now this is a stub. We'll add badge + message
// handling in later commits.
// ============================================================

console.log('[AdVanish] Background service worker started.');
