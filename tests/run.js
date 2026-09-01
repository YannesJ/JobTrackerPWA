#!/usr/bin/env node
/*
 * Copyright 2026 Yannes Jabboury. Alle Rechte vorbehalten. All rights reserved.
 *
 * Zero-dependency smoke test suite. Runs with plain `node tests/run.js` -
 * no npm install, no test framework, nothing to download. It loads app.js
 * and ui.js into a minimal mocked browser environment (vm module) and
 * checks pure logic (formatting, sorting comparators, portal URL builders,
 * table-column persistence) plus a few structural invariants across the
 * repo's files that are easy to silently break while editing (every
 * TABLE_COLUMNS entry has a matching CSS rule, every icon/manifest file
 * referenced actually exists on disk, no stray em/en dashes).
 *
 * This does not replace real browser testing (rendering, click handlers,
 * IndexedDB persistence) - it only guards the logic that's cheap to check
 * without a browser, so regressions there show up before a commit rather
 * than during a manual click-through.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

// app.js's own Init IIFE keeps running in the background inside the mocked vm context
// after the tests below are done - real app startup code awaiting idbReady/loadAll/etc
// that isn't mocked deeply enough to finish cleanly. Whether that surfaces as a crash
// depends on exactly when it happens to throw relative to this file's own async work,
// which is timing-fragile - guard it globally instead of chasing every possible gap.
process.on('unhandledRejection', () => {});

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ name, err });
  }
}

// For the (few) async helpers - e.g. the gzip round trip, which genuinely needs to
// await CompressionStream/DecompressionStream. Queued and awaited together right
// before the final report (see bottom of file) instead of making every test async.
const pendingAsync = [];
function asyncTest(name, fn) {
  pendingAsync.push(
    fn().then(() => { passed++; }).catch((err) => { failed++; failures.push({ name, err }); })
  );
}

// ─── Minimal mocked browser environment ────────────────────────────────────
function makeMockElement() {
  const el = {
    _children: [],
    classList: {
      _set: new Set(),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      toggle(c, force) { force === undefined ? (this._set.has(c) ? this._set.delete(c) : this._set.add(c)) : (force ? this._set.add(c) : this._set.delete(c)); },
      contains(c) { return this._set.has(c); },
    },
    dataset: {},
    style: {},
    attributes: {},
    children: [],
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { this._children.push(child); return child; },
    remove() {},
    click() {},
    focus() {}, select() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
  };
  return el;
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

function makeIdbKeyval() {
  const stores = new Map();
  const keyOf = (store) => (store && store._name) || 'default';
  const bucket = (store) => {
    const k = keyOf(store);
    if (!stores.has(k)) stores.set(k, new Map());
    return stores.get(k);
  };
  return {
    createStore: (dbName, storeName) => ({ _name: `${dbName}::${storeName}` }),
    get: async (key, store) => bucket(store).get(key),
    set: async (key, val, store) => { bucket(store).set(key, val); },
    del: async (key, store) => { bucket(store).delete(key); },
    entries: async (store) => Array.from(bucket(store).entries()),
    clear: async (store) => { bucket(store).clear(); },
  };
}

function makeIndexedDB() {
  return {
    open() {
      const req = { result: { close() {}, objectStoreNames: { contains: () => true }, createObjectStore() {} } };
      queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
      return req;
    },
  };
}

function loadAppContext() {
  const documentMock = {
    documentElement: makeMockElement(),
    body: makeMockElement(),
    getElementById: () => makeMockElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeMockElement(),
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    console,
    document: documentMock,
    // No serviceWorker/storage keys at all (not just undefined) - app.js guards these
    // with `'serviceWorker' in navigator`, which is true for an explicit undefined value.
    navigator: { userAgent: 'node-test' },
    localStorage: makeLocalStorage(),
    indexedDB: makeIndexedDB(),
    idbKeyval: makeIdbKeyval(),
    crypto: globalThis.crypto,
    // Used by the QR device-sync gzip/text-encoding helpers - real Node globals, same
    // pattern as `crypto` above, so those helpers can be exercised end-to-end below.
    CompressionStream, DecompressionStream, Response, TextEncoder, TextDecoder,
    location: { search: '', href: 'http://localhost/' },
    URLSearchParams,
    URL,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Intl,
    Notification: undefined,
    // matchMedia is called at app.js/ui.js TOP LEVEL (not just inside functions), so it
    // has to exist as a bare global before the scripts run, not nested under a separate
    // "window" object that then gets swapped out.
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    innerWidth: 1400, innerHeight: 900,
    visualViewport: null,
    addEventListener() {}, removeEventListener() {},
    // app.js's own Init IIFE (see note near process.exit() below) reaches into
    // rendering code that reads CSS custom properties - stub just enough for that
    // not to throw, same spirit as the lucide/Chart stubs a few lines down.
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox; // app.js/ui.js reference window.* and bare globals interchangeably
  vm.createContext(sandbox);

  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'ui.js'), 'utf8');
  // lucide/Chart aren't vendored into this mock (no rendering under test) - stub just
  // enough of their surface for app.js/ui.js top-level code not to throw.
  sandbox.lucide = { createIcons() {} };
  sandbox.Chart = class { destroy() {} update() {} static register() {} };

  try {
    vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
  } catch (err) {
    throw new Error(`app.js failed to load in the mock environment: ${err.message}`);
  }
  try {
    vm.runInContext(uiSrc, sandbox, { filename: 'ui.js' });
  } catch (err) {
    throw new Error(`ui.js failed to load in the mock environment: ${err.message}`);
  }

  // Top-level `const`/`let` in app.js/ui.js (TABLE_COLUMNS, State, JOB_PORTALS, ...) live
  // in the context's shared lexical scope, not as properties of the sandbox object - a
  // vm.runInContext quirk (same as separate <script> tags sharing one realm's top-level
  // scope in a browser). Pull the names this suite needs onto the sandbox explicitly so
  // the tests below can read them as ctx.NAME.
  const exported = vm.runInContext(
    `({ TABLE_COLUMNS, DEFAULT_TABLE_COLUMNS, State, JOB_PORTALS, DEFAULT_STATUSES,
        fmtEuro, fmtEuroShort, daysSince, escHtml, escJs, uuid, starsHTML, loadTableColumns,
        nextEventForApp, localDateStr,
        STATUS_KINDS, sanitizeStatuses, sanitizeKanbanSort, mergeStatusCatalog,
        statusSlot, getStatusColor, getStatusKind, sortAppsForKanban,
        _kanbanDropPosition, _applyKanbanDrop,
        parseDelimitedText, buildCsvRows, spreadsheetRowsToApplications,
        normalizeImportedApps, isSafeLinkHref,
        mergeApps, _qrSummarizeMerge, _qrChecksum, _qrBuildChunks, _qrParseChunk,
        _qrBuildSyncPayload, _qrReadSyncPayload,
        _gzipBytes, _gunzipBytes })`,
    sandbox
  );
  Object.assign(sandbox, exported);
  return sandbox;
}

let ctx;
test('app.js and ui.js load without throwing in a mocked environment', () => {
  ctx = loadAppContext();
});

if (ctx) {
  // ─── Formatting helpers ───────────────────────────────────────────────────
  test('fmtEuro formats a number as EUR currency', () => {
    assert.match(ctx.fmtEuro(65000), /65.000/);
    assert.strictEqual(ctx.fmtEuro(0), '-');
    assert.strictEqual(ctx.fmtEuro(null), '-');
  });

  test('fmtEuroShort abbreviates thousands', () => {
    assert.strictEqual(ctx.fmtEuroShort(65000), '65k €');
    assert.strictEqual(ctx.fmtEuroShort(500), '500 €');
  });

  test('daysSince computes whole days and handles missing input', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    assert.strictEqual(ctx.daysSince(tenDaysAgo), 10);
    assert.strictEqual(ctx.daysSince(null), Infinity);
  });

  test('escHtml escapes HTML-significant characters', () => {
    assert.strictEqual(ctx.escHtml('<b>"Test" & Co</b>'), '&lt;b&gt;&quot;Test&quot; &amp; Co&lt;/b&gt;');
  });

  test('uuid produces a well-formed, unique id each call', () => {
    const a = ctx.uuid();
    const b = ctx.uuid();
    assert.match(a, /^[0-9a-f-]{20,}$/i);
    assert.notStrictEqual(a, b);
  });

  // ─── Priority stars ────────────────────────────────────────────────────────
  test('starsHTML returns nothing for unset priority, N stars for 1-3', () => {
    assert.strictEqual(ctx.starsHTML(0), '');
    assert.strictEqual(ctx.starsHTML(null), '');
    for (const n of [1, 2, 3]) {
      const html = ctx.starsHTML(n);
      const svgCount = (html.match(/<svg/g) || []).length;
      const filledCount = (html.match(/fill="#f59e0b"/g) || []).length;
      assert.strictEqual(svgCount, 3, `expected 3 star glyphs for priority ${n}`);
      assert.strictEqual(filledCount, n, `expected ${n} filled stars for priority ${n}`);
    }
  });

  test('starsHTML with alwaysShow renders 3 outline stars even when unset (detail view)', () => {
    for (const n of [0, null]) {
      const html = ctx.starsHTML(n, 12, true);
      assert.strictEqual((html.match(/<svg/g) || []).length, 3);
      assert.strictEqual((html.match(/fill="#f59e0b"/g) || []).length, 0);
    }
  });

  // ─── Table columns: config, persistence, and CSS-rule parity ────────────────
  test('DEFAULT_TABLE_COLUMNS has exactly the keys TABLE_COLUMNS declares', () => {
    // Array.from (this process's, not the vm realm's) so deepStrictEqual isn't comparing
    // cross-realm array instances - same values, different [[Prototype]], which
    // deepStrictEqual treats as unequal.
    const declaredKeys = Array.from(ctx.TABLE_COLUMNS, (c) => c.key).sort();
    const defaultKeys = Array.from(Object.keys(ctx.DEFAULT_TABLE_COLUMNS)).sort();
    assert.deepStrictEqual(declaredKeys, defaultKeys);
  });

  test('DEFAULT_TABLE_COLUMNS values are all booleans', () => {
    for (const [key, val] of Object.entries(ctx.DEFAULT_TABLE_COLUMNS)) {
      assert.strictEqual(typeof val, 'boolean', `${key} should be a boolean default`);
    }
  });

  test('every TABLE_COLUMNS key has a matching data-hide-cols rule in app.css', () => {
    const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');
    for (const { key } of ctx.TABLE_COLUMNS) {
      const needle = `data-hide-cols~="${key}"`;
      assert.ok(css.includes(needle), `app.css is missing a [${needle}] rule - a column was added to TABLE_COLUMNS in app.js without teaching the CSS to hide it`);
    }
  });

  test('every TABLE_COLUMNS key has a matching th[data-col] in index.html', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    for (const { key } of ctx.TABLE_COLUMNS) {
      const needle = `data-col="${key}"`;
      assert.ok(html.includes(needle), `index.html is missing a [${needle}] table header/cell for a TABLE_COLUMNS entry`);
    }
  });

  test('loadTableColumns merges stored partial selections over the defaults', () => {
    ctx.localStorage.setItem('jt-table-columns', JSON.stringify({ notes: true }));
    const merged = ctx.loadTableColumns();
    assert.strictEqual(merged.notes, true, 'stored value should win');
    assert.strictEqual(merged.status, ctx.DEFAULT_TABLE_COLUMNS.status, 'unset keys should fall back to the default');
    ctx.localStorage.removeItem('jt-table-columns');
  });

  test('loadTableColumns falls back to defaults on malformed localStorage data', () => {
    ctx.localStorage.setItem('jt-table-columns', 'not json');
    const merged = ctx.loadTableColumns();
    assert.deepStrictEqual(merged, ctx.DEFAULT_TABLE_COLUMNS);
    ctx.localStorage.removeItem('jt-table-columns');
  });

  // ─── Job portal search links ─────────────────────────────────────────────────
  test('every JOB_PORTALS entry builds a valid https URL containing the query', () => {
    const keys = Object.keys(ctx.JOB_PORTALS);
    assert.ok(keys.length >= 10, 'expected the full portal list to still be registered');
    for (const key of keys) {
      const url = ctx.JOB_PORTALS[key]('Frontend Entwickler', 'Berlin');
      assert.match(url, /^https:\/\//, `${key} did not build an https URL`);
      assert.match(url, /Frontend|Entwickler/, `${key} URL doesn't seem to include the search query`);
      // Must not throw / must return a string even without a location
      assert.strictEqual(typeof ctx.JOB_PORTALS[key]('Werkstudent'), 'string', `${key} should tolerate a missing location`);
    }
  });

  // ─── Calendar / next-event lookup ─────────────────────────────────────────────
  test('nextEventForApp returns the soonest future event for that application only', () => {
    const todayStr = ctx.localDateStr(new Date());
    const inThreeDays = ctx.localDateStr(new Date(Date.now() + 3 * 86400000));
    const inTenDays = ctx.localDateStr(new Date(Date.now() + 10 * 86400000));
    const yesterday = ctx.localDateStr(new Date(Date.now() - 86400000));
    ctx.State.events = [
      { id: '1', appId: 'app-a', date: yesterday, title: 'past, should be ignored' },
      { id: '2', appId: 'app-a', date: inTenDays, title: 'further out' },
      { id: '3', appId: 'app-a', date: inThreeDays, title: 'soonest' },
      { id: '4', appId: 'app-b', date: todayStr, title: 'different application' },
    ];
    const next = ctx.nextEventForApp('app-a');
    assert.strictEqual(next.title, 'soonest');
    assert.strictEqual(ctx.nextEventForApp('no-such-app'), null);
  });

  // ─── Demo data seeding invariants ─────────────────────────────────────────────
  test('DEFAULT_STATUSES covers every status the demo data / defaults reference', () => {
    const names = Array.from(ctx.DEFAULT_STATUSES, (s) => s.name).sort();
    assert.deepStrictEqual(names, ['Absage', 'Interview', 'Offen', 'Zusage'].sort());
  });
}

// ─── Structural checks across the repo's files (no vm needed) ──────────────
test('manifest.json is valid JSON and every icon it references exists on disk', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    const p = path.join(ROOT, icon.src);
    assert.ok(fs.existsSync(p), `manifest.json references missing icon: ${icon.src}`);
  }
});

test('every vendor/ script referenced from index.html exists and is non-empty', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const matches = [...html.matchAll(/(?:src|href)="(vendor\/[^"]+)"/g)];
  assert.ok(matches.length >= 3, 'expected at least the three vendored JS libraries to be referenced');
  for (const [, rel] of matches) {
    const p = path.join(ROOT, rel);
    assert.ok(fs.existsSync(p), `index.html references missing vendored file: ${rel}`);
    assert.ok(fs.statSync(p).size > 0, `vendored file is empty: ${rel}`);
  }
});

test('index.html has no remaining third-party CDN references', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const host of ['unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com']) {
    assert.ok(!html.includes(host), `index.html still references ${host} - a library should be vendored under vendor/ instead`);
  }
});

test('no em/en dashes in user-facing source files (project convention: use "-")', () => {
  const files = ['index.html', 'app.js', 'ui.js', 'app.css', 'README.md'];
  for (const f of files) {
    const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const hasDash = /[–—]/.test(content);
    assert.ok(!hasDash, `${f} contains an em or en dash (–/—) - replace with "-"`);
  }
});

// sw.js listet seine Dateien in zwei Gruppen: APP_CODE (network-first, aendert sich
// mit jedem Deploy) und APP_ASSETS (cache-first, unveraenderlich).
function swShellPaths() {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const group = (name) => {
    const m = sw.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
    assert.ok(m, `could not find ${name} in sw.js`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  return [...group('APP_CODE'), ...group('APP_ASSETS')];
}

test('sw.js precacht nur Dateien, die es wirklich gibt', () => {
  const urls = swShellPaths();
  assert.ok(urls.length > 5);
  for (const u of urls) {
    if (u === './') continue;
    assert.ok(fs.existsSync(path.join(ROOT, u.replace(/^\.\//, ''))),
      `sw.js precaches a URL with no matching file: ${u}`);
  }
});

// ─── QR-Geräte-Sync: mergeApps() ───────────────────────────────────────────────
if (ctx) {
  const app = (id, overrides = {}) => ({ id, company: 'X', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides });

  // ctx.mergeApps() runs inside the vm sandbox realm, so arrays/objects it *constructs*
  // (the outer Array from Array.from(byId.values()), or a fresh {a,b,c} literal) carry
  // that realm's Array/Object prototype - deepStrictEqual treats those as unequal to an
  // outwardly-identical host-realm literal even though every value matches (same
  // cross-realm quirk called out near the top of this file). Array.from(...) here is
  // this process's Array.from, rebuilding a host-realm array around the same elements.
  test('mergeApps: disjunkte IDs werden vereinigt', () => {
    const result = Array.from(ctx.mergeApps([app('a')], [app('b')], 'newest'), a => a.id).sort();
    assert.deepStrictEqual(result, ['a', 'b']);
  });

  test('mergeApps: leere eingehende Liste ist ein No-op', () => {
    const local = [app('a'), app('b')];
    assert.deepStrictEqual(Array.from(ctx.mergeApps(local, [], 'newest')), local);
  });

  test('mergeApps: leere lokale Liste übernimmt alles Eingehende', () => {
    const incoming = [app('a'), app('b')];
    assert.deepStrictEqual(Array.from(ctx.mergeApps([], incoming, 'newest')), incoming);
  });

  test('mergeApps "newest": neuerer Timestamp gewinnt, unabhängig von der Seite', () => {
    const local    = [app('a', { position: 'alt', updatedAt: '2026-01-01T00:00:00.000Z' })];
    const incoming = [app('a', { position: 'neu', updatedAt: '2026-01-02T00:00:00.000Z' })];
    assert.strictEqual(ctx.mergeApps(local, incoming, 'newest')[0].position, 'neu');
    assert.strictEqual(ctx.mergeApps(incoming, local, 'newest')[0].position, 'neu');
  });

  test('mergeApps "preferIncoming": eingehende Seite gewinnt immer, auch wenn älter', () => {
    const local    = [app('a', { position: 'lokal-neuer', updatedAt: '2026-01-05T00:00:00.000Z' })];
    const incoming = [app('a', { position: 'eingehend-aelter', updatedAt: '2026-01-01T00:00:00.000Z' })];
    assert.strictEqual(ctx.mergeApps(local, incoming, 'preferIncoming')[0].position, 'eingehend-aelter');
  });

  test('mergeApps "preferLocal": lokale Seite gewinnt immer, auch wenn älter', () => {
    const local    = [app('a', { position: 'lokal-aelter', updatedAt: '2026-01-01T00:00:00.000Z' })];
    const incoming = [app('a', { position: 'eingehend-neuer', updatedAt: '2026-01-05T00:00:00.000Z' })];
    assert.strictEqual(ctx.mergeApps(local, incoming, 'preferLocal')[0].position, 'lokal-aelter');
  });

  test('mergeApps: identischer Timestamp auf beiden Seiten ist deterministisch (Tie-Breaker)', () => {
    const local    = [app('a', { position: 'A', updatedAt: '2026-01-01T00:00:00.000Z' })];
    const incoming = [app('a', { position: 'B', updatedAt: '2026-01-01T00:00:00.000Z' })];
    const r1 = ctx.mergeApps(local, incoming, 'newest')[0].position;
    const r2 = ctx.mergeApps(local, incoming, 'newest')[0].position;
    const r3 = ctx.mergeApps(local, incoming, 'newest')[0].position;
    assert.strictEqual(r1, r2);
    assert.strictEqual(r2, r3);
  });

  test('mergeApps: fehlender/kaputter updatedAt fällt sicher zurück statt NaN-Vergleich zu brechen', () => {
    const local    = [app('a', { position: 'lokal', updatedAt: undefined, createdAt: undefined })];
    const incoming = [app('a', { position: 'eingehend', updatedAt: '2026-01-01T00:00:00.000Z' })];
    // Eingehend hat einen echten Timestamp, lokal fällt auf 0 zurück -> eingehend muss gewinnen
    assert.strictEqual(ctx.mergeApps(local, incoming, 'newest')[0].position, 'eingehend');
  });

  test('mergeApps: Löschung (Tombstone) pflanzt sich als "neuester Stand" fort', () => {
    const local    = [app('a', { updatedAt: '2026-01-01T00:00:00.000Z' })];
    const incoming = [app('a', { deletedAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z' })];
    const merged = ctx.mergeApps(local, incoming, 'newest');
    assert.strictEqual(merged[0].deletedAt, '2026-01-05T00:00:00.000Z');
  });

  test('mergeApps: unabhängige Löschung auf beiden Seiten bleibt einfach gelöscht', () => {
    const local    = [app('a', { deletedAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })];
    const incoming = [app('a', { deletedAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' })];
    assert.ok(ctx.mergeApps(local, incoming, 'newest')[0].deletedAt);
  });

  // ─── _qrSummarizeMerge ────────────────────────────────────────────────────────
  test('_qrSummarizeMerge liefert die betroffenen Einträge (nicht nur Zahlen) pro Kategorie', () => {
    const before = [
      app('a', { updatedAt: '2026-01-01T00:00:00.000Z' }),
      app('b', { updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const merged = [
      app('a', { updatedAt: '2026-01-01T00:00:00.000Z' }), // unverändert
      app('b', { deletedAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }), // gelöscht
      app('c', { updatedAt: '2026-01-02T00:00:00.000Z' }), // neu
    ];
    const summary = ctx._qrSummarizeMerge(before, merged);
    assert.deepStrictEqual(Array.from(summary.added, a => a.id), ['c']);
    assert.deepStrictEqual(Array.from(summary.updated, a => a.id), []);
    assert.deepStrictEqual(Array.from(summary.deleted, a => a.id), ['b']);
  });

  // ─── QR-Chunk-Protokoll (_qrChecksum / _qrBuildChunks / _qrParseChunk) ────────
  test('_qrChecksum ist deterministisch und erkennt ein verändertes Byte', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 9, 4, 5]);
    assert.strictEqual(ctx._qrChecksum(a), ctx._qrChecksum(a));
    assert.notStrictEqual(ctx._qrChecksum(a), ctx._qrChecksum(b));
  });

  test('_qrBuildChunks/_qrParseChunk: Round-Trip liefert die Originalbytes exakt zurück', () => {
    for (const len of [0, 1, 699, 700, 701, 2500]) {
      const original = new Uint8Array(len);
      for (let i = 0; i < len; i++) original[i] = (i * 37 + 11) % 256;
      const chunks = ctx._qrBuildChunks(original, 4242, true, 700);
      const parsedInOrder = chunks.map(c => ctx._qrParseChunk(c));
      assert.ok(parsedInOrder.every(Boolean), `len=${len}: alle Chunks sollten parsebar sein`);
      const total = parsedInOrder[0].total;
      assert.strictEqual(total, chunks.length);
      // Reassemble in beliebiger (hier: umgekehrter) Reihenfolge - simuliert Kamera-Scans
      // in nicht-linearer Reihenfolge
      const byIndex = new Map(parsedInOrder.slice().reverse().map(p => [p.index, p]));
      const reassembled = new Uint8Array(len);
      let offset = 0;
      for (let i = 0; i < total; i++) { reassembled.set(byIndex.get(i).payload, offset); offset += byIndex.get(i).payload.length; }
      assert.deepStrictEqual(Array.from(reassembled), Array.from(original), `len=${len}: reassemblierte Bytes weichen ab`);
    }
  });

  test('_qrParseChunk lehnt zu kurze/leere Buffer ab statt zu werfen', () => {
    assert.strictEqual(ctx._qrParseChunk(new Uint8Array(0)), null);
    assert.strictEqual(ctx._qrParseChunk(new Uint8Array(5)), null);
    assert.strictEqual(ctx._qrParseChunk(null), null);
  });

  test('_qrParseChunk lehnt eine falsche Protokoll-Version ab (z.B. QR eines völlig anderen Formats)', () => {
    const chunks = ctx._qrBuildChunks(new Uint8Array([1, 2, 3]), 1, false, 700);
    const corrupted = chunks[0].slice();
    corrupted[0] = 99; // fremde Version
    assert.strictEqual(ctx._qrParseChunk(corrupted), null);
  });

  test('_qrParseChunk lehnt einen Frame mit verfälschter Prüfsumme ab (simulierter Fehl-Scan)', () => {
    const chunks = ctx._qrBuildChunks(new Uint8Array([10, 20, 30, 40]), 1, false, 700);
    const corrupted = chunks[0].slice();
    corrupted[corrupted.length - 1] ^= 0xff; // letztes Payload-Byte kippen, Header/Prüfsumme bleibt
    assert.strictEqual(ctx._qrParseChunk(corrupted), null);
  });

  test('_qrBuildChunks: unterschiedliche Session-IDs zweier Sync-Vorgänge bleiben unterscheidbar', () => {
    const chunksA = ctx._qrBuildChunks(new Uint8Array([1]), 111, false, 700);
    const chunksB = ctx._qrBuildChunks(new Uint8Array([1]), 222, false, 700);
    assert.notStrictEqual(ctx._qrParseChunk(chunksA[0]).sessionId, ctx._qrParseChunk(chunksB[0]).sessionId);
  });

  // ─── gzip round trip (echtes CompressionStream/DecompressionStream aus Node) ──
  asyncTest('_gzipBytes/_gunzipBytes: Round-Trip liefert die Originalbytes exakt zurück', async () => {
    const original = new TextEncoder().encode('x'.repeat(5000) + 'Bewerbung Müller & Söhne öäü€');
    const { bytes: compressed, gzipped } = await ctx._gzipBytes(original);
    assert.ok(gzipped, 'CompressionStream sollte im Node-Test verfügbar sein');
    assert.ok(compressed.length < original.length, 'stark repetitive Daten sollten spürbar kleiner werden');
    const restored = await ctx._gunzipBytes(compressed, gzipped);
    assert.deepStrictEqual(Array.from(restored), Array.from(original));
  });
}

// ─── Escaping: Ausbruch aus Inline-Handlern ────────────────────────────────────
if (ctx) {
  test('escJs escaped & zuerst, damit HTML-Entities nicht aus dem JS-String ausbrechen', () => {
    // Attributwerte werden vom Browser HTML-entschlüsselt, BEVOR der Inhalt als JS
    // geparst wird. Bliebe & stehen, würde ein Statusname "&apos;" nach dem
    // Entschlüsseln zu ' und damit aus dem einfach gequoteten String ausbrechen.
    assert.strictEqual(ctx.escJs('&apos;'), '&amp;apos;');
    assert.ok(!/(^|[^&])&apos;/.test(ctx.escJs("&apos;+alert(1)+&apos;")));
    // Die bisherigen Zusicherungen müssen erhalten bleiben
    assert.strictEqual(ctx.escJs("O'Brien"), "O\\'Brien");
    assert.strictEqual(ctx.escJs('a\\b'), 'a\\\\b');
  });

  test('isSafeLinkHref lässt nur harmlose Schemata durch', () => {
    assert.ok(ctx.isSafeLinkHref('https://example.com/job/1'));
    assert.ok(ctx.isSafeLinkHref('http://example.com'));
    assert.ok(ctx.isSafeLinkHref('mailto:hr@example.com'));
    assert.ok(ctx.isSafeLinkHref('example.com/stelle'), 'schemalose Eingabe bleibt nutzbar');
    assert.ok(!ctx.isSafeLinkHref('javascript:alert(1)'));
    assert.ok(!ctx.isSafeLinkHref('  JaVaScRiPt:alert(1)'), 'Groß-/Kleinschreibung und Leerraum');
    assert.ok(!ctx.isSafeLinkHref('data:text/html,<script>alert(1)</script>'));
    assert.ok(!ctx.isSafeLinkHref(''));
  });
}

// ─── CSV/Excel: verlustfreier Round-Trip ───────────────────────────────────────
if (ctx) {
  const CSV_DELIM = ';';

  test('parseDelimitedText liest Zeilenumbrüche innerhalb von Anführungszeichen als EIN Feld', () => {
    const text = 'Firma;Notizen\r\n"Acme";"Zeile 1\nZeile 2"\r\n"Beta";"schlicht"';
    const rows = ctx.parseDelimitedText(text, CSV_DELIM);
    assert.strictEqual(rows.length, 3, 'Kopfzeile + 2 Datensätze');
    assert.deepStrictEqual(Array.from(rows[1]), ['Acme', 'Zeile 1\nZeile 2']);
    assert.deepStrictEqual(Array.from(rows[2]), ['Beta', 'schlicht']);
  });

  test('parseDelimitedText behandelt verdoppelte Anführungszeichen und Trennzeichen im Feld', () => {
    const rows = ctx.parseDelimitedText('"a";"sag ""hallo""";"x;y"', CSV_DELIM);
    assert.deepStrictEqual(Array.from(rows[0]), ['a', 'sag "hallo"', 'x;y']);
  });

  test('CSV-Round-Trip: Notiz mit Umbruch, Semikolon und Anführungszeichen überlebt', () => {
    const notes = 'Erste Zeile\nZweite; mit Semikolon und "Zitat"';
    ctx.State.statuses = ctx.sanitizeStatuses([{ name: 'Offen', color: '#ff00aa', kind: 'open' }]);
    ctx.State.kanbanSort = {};
    ctx.State.all = [];
    const apps = [{
      id: 'a1', company: 'Acme', position: 'Dev', status: 'Offen', source: 'LinkedIn',
      applicationDate: '2026-08-01', expectedSalary: 60000, priority: 2,
      rejectionReason: '', contactName: '', contactPhone: '', contactEmail: '',
      platformLink: '', documentLink: '', notes,
    }];
    const csv = ctx.buildCsvRows(apps).join('\r\n');
    const rows = ctx.parseDelimitedText(csv, CSV_DELIM);
    const { apps: back } = ctx.spreadsheetRowsToApplications(rows);
    assert.strictEqual(back.length, 1, 'ein Datensatz rein, einer raus');
    assert.strictEqual(back[0].notes, notes);
    assert.strictEqual(back[0].company, 'Acme');
    assert.strictEqual(back[0].expectedSalary, 60000);
    assert.strictEqual(back[0].priority, 2);
  });

  test('CSV-Export nimmt Statuskategorien OHNE Bewerbungen mit', () => {
    // Sonst schrumpft der Katalog auf dem Zielgerät auf die tatsächlich benutzten
    // Kategorien zusammen - und weil statusSlot() index-basiert ist, verschieben
    // sich dadurch sämtliche Farben, nicht nur die der fehlenden Kategorien.
    ctx.State.statuses = ctx.sanitizeStatuses([
      { name: 'Offen',     color: '#ff00aa', kind: 'open' },
      { name: 'Interview', color: '#00ccff', kind: 'interview' },
      { name: 'Absage',    color: '#123456', kind: 'rejected' },
      { name: 'Zusage',    color: '#abcdef', kind: 'accepted' },
    ]);
    ctx.State.kanbanSort = {};
    ctx.State.all = [];
    const apps = [{ id: 'a1', company: 'Acme', position: 'Dev', status: 'Offen', applicationDate: '2026-08-01' }];
    const rows = ctx.parseDelimitedText(ctx.buildCsvRows(apps).join('\r\n'), CSV_DELIM);
    const { apps: back, statuses } = ctx.spreadsheetRowsToApplications(rows);
    assert.strictEqual(back.length, 1, 'Katalogzeilen ohne Firma zählen nicht als Bewerbung');
    assert.deepStrictEqual(Array.from(statuses.map(s => s.name)), ['Offen', 'Interview', 'Absage', 'Zusage']);
    assert.deepStrictEqual(Array.from(statuses.map(s => s.color)), ['#ff00aa', '#00ccff', '#123456', '#abcdef']);
    assert.deepStrictEqual(Array.from(statuses.map(s => s.kind)), ['open', 'interview', 'rejected', 'accepted']);
  });
}

// ─── Statuskatalog zusammenführen (alle Übertragungswege) ──────────────────────
if (ctx) {
  test('mergeStatusCatalog: eingehende Farbe gewinnt, lokal-eigene Kategorien bleiben', () => {
    const local = [
      { name: 'Offen',       color: '#111111', kind: 'open' },
      { name: 'Eigene Spur', color: '#999999', kind: 'other' },
    ];
    const incoming = [
      { name: 'Offen',     color: '#ff00aa', kind: 'open' },
      { name: 'Interview', color: '#00ccff', kind: 'interview' },
    ];
    const merged = Array.from(ctx.mergeStatusCatalog(local, incoming));
    assert.deepStrictEqual(merged.map(s => s.name), ['Offen', 'Interview', 'Eigene Spur']);
    assert.strictEqual(merged[0].color, '#ff00aa', 'eingehende Farbe gewinnt');
    assert.strictEqual(merged[2].color, '#999999', 'lokal-eigene Kategorie überlebt unverändert');
  });

  test('mergeStatusCatalog: leere/ungültige Eingaben lassen den lokalen Katalog stehen', () => {
    const local = [{ name: 'Offen', color: '#111111', kind: 'open' }];
    assert.deepStrictEqual(Array.from(ctx.mergeStatusCatalog(local, [])).map(s => s.name), ['Offen']);
    assert.deepStrictEqual(Array.from(ctx.mergeStatusCatalog(local, null)).map(s => s.name), ['Offen']);
    assert.deepStrictEqual(Array.from(ctx.mergeStatusCatalog(local, [{ name: '  ' }])).map(s => s.name), ['Offen']);
  });

  test('sanitizeStatuses fängt kaputte Farben, Namen und Zähl-Kinder ab', () => {
    const out = Array.from(ctx.sanitizeStatuses([
      { name: '  Offen  ', color: 'nicht-hex', kind: 'quatsch' },
      { name: '', color: '#ffffff', kind: 'open' },
      null,
      { name: 'Neu', color: '#ABCDEF', kind: 'interview' },
    ]));
    assert.strictEqual(out.length, 2, 'namenlose und null-Einträge fliegen raus');
    assert.strictEqual(out[0].name, 'Offen', 'Name wird getrimmt');
    assert.strictEqual(out[0].color, '#3b82f6', 'unbekannte Farbe fällt auf den Standard des Namens zurück');
    assert.strictEqual(out[0].kind, 'open', 'unbekanntes kind wird aus dem Namen abgeleitet');
    assert.strictEqual(out[1].color, '#ABCDEF');
  });

  test('sanitizeKanbanSort verwirft Müll und behält gültige Einträge', () => {
    const out = ctx.sanitizeKanbanSort({
      Offen:     { col: 'custom', dir: 'asc', order: ['a', 1, null, 'b'] },
      Interview: { col: 'applicationDate', dir: 'kaputt' },
      Absage:    { col: 42 },
      Zusage:    null,
    });
    assert.deepStrictEqual(Array.from(out.Offen.order), ['a', 'b'], 'nur String-IDs bleiben');
    assert.strictEqual(out.Interview.dir, 'asc', 'ungültige Richtung fällt auf asc zurück');
    assert.ok(!('Absage' in out) && !('Zusage' in out));
  });
}

// ─── Kanban: eigene Reihenfolge ────────────────────────────────────────────────
if (ctx) {
  test('sortAppsForKanban mit col:custom hält die Reihenfolge und hängt Unbekanntes hinten an', () => {
    ctx.State.kanbanSort = { Offen: { col: 'custom', dir: 'asc', order: ['c', 'a'] } };
    const apps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const sorted = Array.from(ctx.sortAppsForKanban(apps, 'Offen')).map(a => a.id);
    assert.deepStrictEqual(sorted, ['c', 'a', 'b']);
  });
}

// ─── Kanban: Drop-Position und Leerlauf-Drops ──────────────────────────────────
if (ctx) {
  test('_kanbanDropPosition trifft bei aktivem Filter die richtige Stelle', () => {
    // Sichtbar sind nur a und d - die Drop-Anzeige zählt daher Index 1 ("vor d"),
    // in der vollständigen Spaltenreihenfolge ist das aber Position 3.
    const order = ['a', 'b', 'c', 'd'];
    assert.strictEqual(ctx._kanbanDropPosition(order, 1, { before: 'd', after: 'a' }), 3);
    assert.strictEqual(ctx._kanbanDropPosition(order, 1, { before: null, after: 'd' }), 4,
      'ohne Karte darunter zählt die Karte darüber');
    assert.strictEqual(ctx._kanbanDropPosition(order, 2, { before: null, after: null }), 2,
      'ohne Nachbarn bleibt der gezählte Index');
    assert.strictEqual(ctx._kanbanDropPosition(order, null, null), 4, 'ohne Angabe ans Ende');
  });

  asyncTest('_applyKanbanDrop lässt eine Spalte in Ruhe, wenn die Karte dort liegen bleibt', async () => {
    // Der versehentliche Langdruck auf dem Handy: Karte wird an ihrer eigenen Position
    // wieder abgelegt. Die Spalte darf dadurch NICHT auf "Eigene Reihenfolge" springen.
    ctx.State.kanbanSort = {};
    ctx.State.all = [
      { id: 'a1', status: 'Offen', applicationDate: '2026-03-01' },
      { id: 'a2', status: 'Offen', applicationDate: '2026-02-01' },
    ];
    await ctx._applyKanbanDrop('a1', 'Offen', 0, { before: 'a2', after: null });
    assert.deepStrictEqual(ctx.State.kanbanSort, {}, 'keine Sortierung gespeichert');
    assert.strictEqual(ctx.localStorage.getItem('jt-kanban-sort'), null);
  });
}

// ─── Import: Altformate müssen weiter lesbar bleiben ───────────────────────────
if (ctx) {
  test('normalizeImportedApps akzeptiert das alte reine Array-Format', () => {
    const out = Array.from(ctx.normalizeImportedApps([{ id: 'x1', company: 'Acme' }]));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'x1');
  });

  test('normalizeImportedApps vergibt fehlende IDs, statt beim Schreiben zu scheitern', () => {
    // Ohne das wirft idbSet MITTEN im Import - und zwar nachdem die DB schon
    // geleert wurde, also mit Totalverlust als Ergebnis.
    const out = Array.from(ctx.normalizeImportedApps([{ company: 'Ohne ID' }, { id: '', company: 'Leer' }]));
    assert.strictEqual(out.length, 2);
    assert.ok(out.every(a => typeof a.id === 'string' && a.id.length > 0));
    assert.notStrictEqual(out[0].id, out[1].id);
  });

  test('normalizeImportedApps wirft Einträge ohne Firma und Nicht-Objekte weg', () => {
    const out = Array.from(ctx.normalizeImportedApps([null, 'text', 42, { position: 'nur Position' }, { company: 'Gut' }]));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].company, 'Gut');
  });
}

// ─── QR-Sync: Payload trägt den Statuskatalog mit ──────────────────────────────
if (ctx) {
  test('_qrBuildSyncPayload nimmt Statuskatalog und Kanban-Sortierung mit', () => {
    const statuses = ctx.sanitizeStatuses([{ name: 'Offen', color: '#ff00aa', kind: 'open' }]);
    const payload = ctx._qrBuildSyncPayload([{ id: 'a1', company: 'Acme' }], statuses, { Offen: { col: 'custom', dir: 'asc', order: ['a1'] } });
    assert.strictEqual(payload.v, 1, 'Schemaversion bleibt 1 - zusätzliche Felder sind abwärtskompatibel');
    assert.strictEqual(payload.apps.length, 1);
    assert.strictEqual(payload.statuses[0].color, '#ff00aa');
    assert.ok(payload.kanbanSort.Offen);
  });

  test('_qrReadSyncPayload liest auch einen alten Code ohne Statuskatalog', () => {
    // Ein Gerät, das die App noch nicht neu geladen hat, sendet weiter { v:1, apps }.
    const read = ctx._qrReadSyncPayload({ v: 1, apps: [{ id: 'a1', company: 'Acme' }] });
    assert.strictEqual(read.apps.length, 1);
    assert.deepStrictEqual(Array.from(read.statuses), []);
    assert.deepStrictEqual({ ...read.kanbanSort }, {});
  });

  test('_qrReadSyncPayload lehnt fremde/kaputte Payloads ab', () => {
    assert.throws(() => ctx._qrReadSyncPayload({ v: 99, apps: [] }));
    assert.throws(() => ctx._qrReadSyncPayload({ v: 1 }));
    assert.throws(() => ctx._qrReadSyncPayload(null));
  });
}

// ─── Service Worker: Pfade müssen relativ zum Scope sein ───────────────────────
test('sw.js precacht ausschließlich relative Pfade (Deploy liegt unter /JobTrackerPWA/)', () => {
  const urls = swShellPaths();
  assert.ok(urls.length > 5);
  for (const u of urls) {
    assert.ok(!u.startsWith('/'),
      `sw.js precacht "${u}" absolut - auf GitHub Pages löst das auf die Domain-Wurzel statt auf /JobTrackerPWA/ auf, die Datei ist dort nicht erreichbar und der Service Worker installiert nie`);
  }
});

test('app.js verlinkt Icons/URLs nicht absolut auf die Domain-Wurzel', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const hits = [...src.matchAll(/'(\/(?:icons|vendor)\/[^']*)'/g)].map(m => m[1]);
  assert.deepStrictEqual(hits, [],
    `absolute Pfade in app.js gefunden: ${hits.join(', ')} - unter /JobTrackerPWA/ zeigen die ins Leere`);
});

// ─── Report ──────────────────────────────────────────────────────────────────
(async () => {
  await Promise.all(pendingAsync);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    for (const { name, err } of failures) {
      console.log(`✗ ${name}`);
      console.log(`  ${err.message}\n`);
    }
  } else {
    console.log('All checks passed.');
  }

  // app.js's own Init IIFE keeps running in the background inside the mocked vm context
  // after the (synchronous) tests above are done - it's real app startup code awaiting
  // idbReady/loadAll/etc, and it isn't mocked deeply enough to finish cleanly (no
  // getComputedStyle, no real IndexedDB). That's fine, nothing here depends on it
  // completing - but left alone it can throw asynchronously and cause a misleading
  // nonzero exit after this report already printed success. Exit explicitly now instead
  // of letting the event loop decide.
  process.exit(failed ? 1 : 0);
})();
