// Minimal, no-op service worker. It exists purely so Android Chrome's PWA
// installability check (which requires a registered SW with a fetch
// handler — desktop Chrome doesn't enforce this, hence "install works on
// desktop but not Android") is satisfied. It does NOT cache anything; every
// request passes straight through to the network, so it can't reintroduce
// the stale-cache bug that led to service workers being killed off before.
self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
// Page loads are left to the browser: a failed pass-through navigation renders a blank window.
self.addEventListener('fetch', (e) => { if (e.request.mode !== 'navigate') e.respondWith(fetch(e.request)); });
