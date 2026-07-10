// ============================================================
// content.js — The Main Content Script
// ============================================================
// Chrome INJECTS this file into every open.spotify.com tab.
// It runs in an ISOLATED WORLD — same DOM as the page, but
// a completely separate JavaScript environment. Spotify's own
// React code cannot access our variables, and we cannot access
// theirs. This is a security boundary Chrome enforces.
//
// We'll build up this file commit-by-commit.
// ============================================================

console.log('[AdVanish] Content script injected into Spotify.');
