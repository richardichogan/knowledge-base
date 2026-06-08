// Self-destructing service worker — unregisters itself immediately.
// This clears any stale SW cached from a previous deployment.
self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(self.registration.unregister());
});
