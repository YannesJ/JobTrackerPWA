/*
 * Copyright 2024 Job Application Tracker Contributors
 * Licensed under the Apache License, Version 2.0
 */
'use strict';

const CACHE_APP_SHELL = 'jobtracker-app-shell-v4';
const CACHE_CDN       = 'jobtracker-cdn-v3';

const APP_SHELL_URLS = ['/', '/index.html', '/app.css', '/app.js', '/ui.js', '/manifest.json'];
const CDN_ORIGINS    = ['https://unpkg.com','https://cdn.jsdelivr.net','https://fonts.googleapis.com','https://fonts.gstatic.com'];

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
  const current = [CACHE_APP_SHELL, CACHE_CDN];
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
  if (CDN_ORIGINS.some(o => request.url.startsWith(o))) { event.respondWith(networkFirstCDN(request)); return; }
  if (url.origin === self.location.origin)               { event.respondWith(cacheFirstAppShell(request)); return; }
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

async function networkFirstCDN(request) {
  const cache = await caches.open(CACHE_CDN);
  try {
    const response = await fetchWithTimeout(request, 5000);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response('CDN offline', { status: 503 });
  }
}

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(r => { clearTimeout(t); resolve(r); }).catch(e => { clearTimeout(t); reject(e); });
  });
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
