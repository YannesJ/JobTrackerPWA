/*
 * Copyright 2026 Yannes Jabboury. Alle Rechte vorbehalten. All rights reserved.
 */
'use strict';

const CACHE_APP_SHELL = 'jobtracker-app-shell-v8';

// ── Pfade ────────────────────────────────────────────────────────────────────
// ALLE Pfade hier sind relativ und werden gegen registration.scope aufgelöst.
// Das ist kein Stil, sondern Notwendigkeit: die App liegt unter
// https://<user>.github.io/JobTrackerPWA/, nicht auf einer eigenen Domain. Absolute
// Pfade wie '/app.css' zeigten dort auf die Wurzel von github.io, cache.addAll()
// bekam 404, das install-Event schlug fehl - und der Service Worker wurde nie aktiv.
// Die App hatte dadurch seit jeher gar keinen Offline-Betrieb.
const SCOPE = self.registration.scope;
const url = (p) => new URL(p, SCOPE).toString();

// Code der App: darf sich mit jedem Deploy ändern, wird deshalb network-first
// ausgeliefert (siehe unten).
const APP_CODE = ['./', './index.html', './app.css', './app.js', './ui.js', './manifest.json'];

// Unveränderliche Beigaben: Bibliotheken und Schriften ändern sich nur, wenn eine
// neue Datei mit neuem Namen dazukommt - hier ist cache-first richtig.
// xlsx.full.min.js fehlt bewusst: es wird nur beim CSV/Excel-Import nachgeladen
// (siehe _ensureXLSX() in app.js) und landet dann beim ersten Mal von selbst im Cache.
const APP_ASSETS = [
  './vendor/idb-keyval/idb-keyval.js',
  './vendor/lucide/lucide.min.js',
  './vendor/chart.js/chart.umd.min.js',
  './vendor/fonts/outfit-latin-300-normal.woff2',
  './vendor/fonts/outfit-latin-400-normal.woff2',
  './vendor/fonts/outfit-latin-500-normal.woff2',
  './vendor/fonts/outfit-latin-600-normal.woff2',
  './vendor/fonts/outfit-latin-700-normal.woff2',
  './vendor/fonts/outfit-latin-800-normal.woff2',
  './vendor/fonts/roboto-mono-latin-wght-normal.woff2',
];
const APP_SHELL_URLS = [...APP_CODE, ...APP_ASSETS];

const isAppCode = (request) => APP_CODE.some(p => url(p) === request.url);

// ── Install ──────────────────────────────────────────────────────────────────
// Bewusst KEIN cache.addAll(): das ist alles-oder-nichts, eine einzige nicht
// erreichbare Datei lässt die komplette Installation scheitern. Genau das ist hier
// jahrelang passiert. Einzeln laden und Fehler tolerieren - lieber ein Shell mit
// einer fehlenden Schrift als gar kein Service Worker.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP_SHELL);
    await Promise.allSettled(APP_SHELL_URLS.map(p => cache.add(url(p))));
    await self.skipWaiting();
  })());
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
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Navigationen und App-Code immer zuerst aus dem Netz. Das ist der Unterschied
  // zwischen "ein Update erreicht die Nutzer beim nächsten Besuch" und "die Nutzer
  // hängen bis zur nächsten Cache-Version auf einem alten Stand fest". Bei einer App,
  // die praktisch nur über die URL genutzt wird, wäre Letzteres ein echtes Risiko:
  // ein fehlerhaftes Deploy ließe sich aus der Ferne kaum noch geradebiegen.
  if (request.mode === 'navigate' || isAppCode(request)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_APP_SHELL);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request, { cacheName: CACHE_APP_SHELL, ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await caches.match(url('./index.html'), { cacheName: CACHE_APP_SHELL });
      if (fallback) return fallback;
    }
    return new Response('Offline', { status: 503 });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: CACHE_APP_SHELL, ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) { const c = await caches.open(CACHE_APP_SHELL); c.put(request, response.clone()); }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// ── Notausstieg ──────────────────────────────────────────────────────────────
// Sollte dieser Service Worker jemals Ärger machen, lässt sich das aus der Ferne
// abstellen: den Inhalt dieser Datei durch die folgenden Zeilen ersetzen und
// deployen. Browser prüfen sw.js bei jeder Navigation (und mindestens alle 24h)
// am Cache vorbei, die Abmeldung erreicht die Geräte also von selbst.
//
//   self.addEventListener('install', () => self.skipWaiting());
//   self.addEventListener('activate', e => e.waitUntil((async () => {
//     await caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))));
//     await self.registration.unregister();
//     const cs = await self.clients.matchAll({ type: 'window' });
//     cs.forEach(c => c.navigate(c.url));
//   })()));

// ── Message Handler ───────────────────────────────────────────────────────────
// Receives SHOW_NOTIFICATION from client.
self.addEventListener('message', event => {
  if (event.data?.type !== 'SHOW_NOTIFICATION') return;
  const { title, body, tag, icon, badge, data } = event.data;
  event.waitUntil(
    self.registration.showNotification(title || 'JobTracker', {
      body:      body  || '',
      icon:      icon  || url('./icons/icon-192.png'),
      badge:     badge || url('./icons/icon-96.png'),
      tag:       tag   || 'jt-notif',
      renotify:  true,
      data:      data  || { url: SCOPE },
    })
  );
});

// ── Notification Click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || SCOPE;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Ein bereits offenes Fenster der App bekommt den Fokus, auch wenn seine URL
      // nicht zeichengleich ist (Query-Parameter, Hash) - vorher wurde bei jedem
      // Unterschied ein zusätzliches Fenster geöffnet.
      for (const client of list) {
        if (client.url.startsWith(SCOPE) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

// ── Push (server-sent, future use) ───────────────────────────────────────────
self.addEventListener('push', event => {
  const d = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(d.title || 'JobTracker', {
      body: d.body || '', icon: url('./icons/icon-192.png'), badge: url('./icons/icon-96.png'),
      data: d.url ? { url: d.url } : {},
    })
  );
});

// ── Background Sync (stub) ────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-applications') event.waitUntil(Promise.resolve());
});
