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
        fmtEuro, fmtEuroShort, daysSince, escHtml, uuid, starsHTML, loadTableColumns,
        nextEventForApp, localDateStr })`,
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

test('sw.js APP_SHELL_URLS only lists files that actually exist', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const match = sw.match(/APP_SHELL_URLS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, 'could not find APP_SHELL_URLS in sw.js');
  const urls = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(urls.length > 5);
  for (const url of urls) {
    if (url === '/') continue;
    const p = path.join(ROOT, url.replace(/^\//, ''));
    assert.ok(fs.existsSync(p), `sw.js precaches a URL with no matching file: ${url}`);
  }
});

// ─── Report ──────────────────────────────────────────────────────────────────
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
