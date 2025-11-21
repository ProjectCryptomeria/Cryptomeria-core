/*
 * This file is required for MSW to intercept requests in the browser.
 * In a production setup, copy the content from:
 * https://unpkg.com/msw@2.0.11/lib/mockServiceWorker.js
 */

self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  // Placeholder: does not intercept. 
  // Please replace with actual MSW worker code.
});