/*
 * Copyright 2026 Yannes Jabboury. Alle Rechte vorbehalten. All rights reserved.
 */
'use strict';

const CACHE_APP_SHELL = 'jobtracker-app-shell-v6';

// Every asset the app needs is now same-origin (idb-keyval/lucide/chart.js/fonts are
// vendored under vendor/, see index.html and app.css) - no CDN cache/origin list needed
// anymore. xlsx.full.min.js is deliberately NOT precached here: it's lazy-loaded only
// when CSV/Excel import is actually used (see _ensureXLSX() in app.js), and picks up a
// cache entry the same way as any other same-origin request the first time that happens.
const APP_SHELL_URLS = [
  '/', '/index.html', '/app.css', '/app.js', '/ui.js', '/manifest.json',
  '/vendor/idb-keyval/idb-keyval.js',
  '/vendor/lucide/lucide.min.js',
  '/vendor/chart.js/chart.umd.min.js',
  '/vendor/fonts/outfit-latin-300-normal.woff2',
  '/vendor/fonts/outfit-latin-400-normal.woff2',
  '/vendor/fonts/outfit-latin-500-normal.woff2',
  '/vendor/fonts/outfit-latin-600-normal.woff2',
  '/vendor/fonts/outfit-latin-700-normal.woff2',
  '/vendor/fonts/outfit-latin-800-normal.woff2',
  '/vendor/fonts/jetbrains-mono-latin-400-normal.woff2',
  '/vendor/fonts/jetbrains-mono-latin-500-normal.woff2',
];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_APP_SHELL)
      .then(cache => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  const current = [CACHE_APP_SHELL];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !current.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.origin === self.location.origin) { event.respondWith(cacheFirstAppShell(request)); return; }
});

async function cacheFirstAppShell(request) {
  const cached = await caches.match(request, { cacheName: CACHE_APP_SHELL, ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) { const c = await caches.open(CACHE_APP_SHELL); c.put(request, response.clone()); }
    return response;
  } catch {
    if (request.mode === 'navigate') {
      const fallback = await caches.match('/index.html', { cacheName: CACHE_APP_SHELL });
      if (fallback) return fallback;
    }
    return new Response('Offline', { status: 503 });
  }
}

// ── Message Handler ───────────────────────────────────────────────────────────
// Receives SHOW_NOTIFICATION from client. Checks user settings stored in
// localStorage (passed via message) before showing.
self.addEventListener('message', event => {
  if (event.data?.type !== 'SHOW_NOTIFICATION') return;
  const { title, body, tag, icon, badge, data } = event.data;
  event.waitUntil(
    self.registration.showNotification(title || 'JobTracker', {
      body:      body  || '',
      icon:      icon  || '/icons/icon-192.png',
      badge:     badge || '/icons/icon-96.png',
      tag:       tag   || 'jt-notif',
      renotify:  true,
      data:      data  || { url: '/' },
    })
  );
});

// ── Notification Click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Push (server-sent, future use) ───────────────────────────────────────────
self.addEventListener('push', event => {
  const d = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(d.title || 'JobTracker', {
      body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-96.png',
      data: d.url ? { url: d.url } : {},
    })
  );
});

// ── Background Sync (stub) ────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-applications') event.waitUntil(Promise.resolve());
});
