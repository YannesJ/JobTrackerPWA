/*
 * Copyright 2024 Job Application Tracker Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// ─── idb-keyval Store ─────────────────────────────────────────────────────────
const { createStore, get: idbGet, set: idbSet, del: idbDel,
        entries: idbEntries, clear: idbClear } = idbKeyval;

// idb-keyval's createStore() opens its DB lazily and independently per store, with no
// explicit version number. When several stores share one DB name, only whichever store
// happens to be used FIRST actually gets its object store created — IndexedDB no-ops
// onupgradeneeded on every later open() that doesn't request a version bump, so any
// object store added afterwards silently fails ("object store was not found") the first
// time it's used. All object stores this app needs must therefore be created together,
// in one upgrade pass, before any of the createStore() instances below are first used.
const IDB_STORE_NAMES = ['applications', 'reminders', 'events'];
const idbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('jobtracker', 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    IDB_STORE_NAMES.forEach(name => { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name); });
  };
  req.onsuccess = () => { req.result.close(); resolve(); };
  req.onerror   = () => reject(req.error);
});

const DB        = createStore('jobtracker', 'applications');
const REMINDERS = createStore('jobtracker', 'reminders'); // { id, appId, date, note }
const EVENTS    = createStore('jobtracker', 'events');    // { id, appId, date, time, title, note }

// ─── Status-Kategorien (individuell konfigurierbar) ────────────────────────────
// Muss vor `State` stehen, da State.statuses beim Erstellen bereits loadStatuses() aufruft.
const DEFAULT_STATUSES = [
  { name: 'Offen',     color: '#3b82f6' },
  { name: 'Interview', color: '#f59e0b' },
  { name: 'Absage',    color: '#ef4444' },
  { name: 'Zusage',    color: '#22c55e' },
];
function loadStatuses() {
  try {
    const stored = JSON.parse(localStorage.getItem('jt-statuses') || 'null');
    if (Array.isArray(stored) && stored.length) return stored;
  } catch { /* ignore malformed data */ }
  return DEFAULT_STATUSES.map(s => ({ ...s }));
}
function saveStatuses() {
  localStorage.setItem('jt-statuses', JSON.stringify(State.statuses));
}
function getStatusColor(name) {
  return State.statuses.find(s => s.name === name)?.color || '#8888a8';
}
// Index der Kategorie in State.statuses – dient als stabiler CSS-Hook (s-<i>).
// Unbekannte/gelöschte Status fallen auf Slot 0 zurück, statt die Anzeige zu brechen.
function statusSlot(name) {
  const idx = State.statuses.findIndex(s => s.name === name);
  return idx >= 0 ? idx : 0;
}

// ── Farbableitung: aus einer einzelnen Hex-Farbe werden Badge/Akzent-Farben
//    für Hell- und Dunkel-Theme berechnet (analog zu den bisherigen fixen Paletten) ──
function _hexToRgb(hex) {
  const h = (hex || '#8888a8').replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
  const int = parseInt(n, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}
function _rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}
function _hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}
function _clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function statusColorVars(hex) {
  const rgb = _hexToRgb(hex);
  const hsl = _rgbToHsl(rgb);
  const fgL = _hslToRgb(hsl.h, Math.max(hsl.s, 50), _clamp(hsl.l, 24, 42));
  const fgD = _hslToRgb(hsl.h, Math.max(hsl.s, 40), _clamp(hsl.l, 62, 80));
  const rgba = ({ r, g, b }, a) => `rgba(${r},${g},${b},${a})`;
  return {
    bg: rgba(rgb, .10),  fg: rgba(fgL, 1), bdr: rgba(rgb, .32),
    bgD: rgba(rgb, .16), fgD: rgba(fgD, 1), bdrD: rgba(rgb, .28),
  };
}
// Erzeugt/aktualisiert ein <style>-Tag mit einer Regel pro Status-Slot,
// damit beliebig viele individuelle Kategorien ohne feste CSS-Klassen auskommen.
function injectStatusStyles() {
  let styleEl = document.getElementById('dyn-status-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dyn-status-styles';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = State.statuses.map((s, i) => {
    const v = statusColorVars(s.color);
    return `
.badge-dyn.s-${i} { background:${v.bg}; color:${v.fg}; border-color:${v.bdr}; }
[data-theme="dark"] .badge-dyn.s-${i} { background:${v.bgD}; color:${v.fgD}; border-color:${v.bdrD}; }
.kanban-card.s-${i}::before, .app-card-accent.s-${i}, .stc-dot.s-${i} { background:${v.fg}; }
[data-theme="dark"] .kanban-card.s-${i}::before, [data-theme="dark"] .app-card-accent.s-${i}, [data-theme="dark"] .stc-dot.s-${i} { background:${v.fgD}; }
.tl-dyn.s-${i} { color:${v.fg}; }
[data-theme="dark"] .tl-dyn.s-${i} { color:${v.fgD}; }`;
  }).join('\n');
}
// Befüllt Status-<select>-Elemente (Filter + Formular) mit den aktuellen Kategorien.
function renderStatusSelectOptions() {
  const optsHtml = State.statuses.map(s => `<option value="${escAttr(s.name)}">${escHtml(s.name)}</option>`).join('');

  const filterSel = document.getElementById('filter-status');
  if (filterSel) {
    const prev = filterSel.value;
    filterSel.innerHTML = `<option value="">Alle</option>` + optsHtml;
    filterSel.value = State.statuses.some(s => s.name === prev) ? prev : '';
  }

  const formSel = document.getElementById('f-status');
  if (formSel) {
    const prev = formSel.value;
    formSel.innerHTML = optsHtml;
    formSel.value = State.statuses.some(s => s.name === prev) ? prev : (State.statuses[0]?.name || '');
  }
}

// ─── App State ────────────────────────────────────────────────────────────────
const State = {
  all:     [],
  filtered:[],
  view:    'table',
  sort:    { col: 'applicationDate', dir: 'desc' },
  kanbanSort: {
    Offen:     { col: 'applicationDate', dir: 'desc' },
    Interview: { col: 'applicationDate', dir: 'desc' },
    Absage:    { col: 'applicationDate', dir: 'desc' },
    Zusage:    { col: 'applicationDate', dir: 'desc' },
  },
  theme:  localStorage.getItem('jt-theme') || 'system',
  // Persisted settings
  settings: loadSettings(),
  // Individuell konfigurierbare Status-Kategorien
  statuses: loadStatuses(),
  // Kalender-Termine
  events: [],
  calendarMonth: (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })(),
};

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem('jt-settings') || 'null');
    const defaults = {
      weeklyGoal:   5,
      pushEnabled:  false,   // master toggle — default OFF
      badgeEnabled: false,   // app badge — default OFF
      weeklySummary: false,  // weekly digest — default OFF
      followUpDays: 0,       // auto follow-up after N days (0 = off)
      staleThreshold: { Offen: 14, Interview: 7, Absage: 0, Zusage: 0 },
      pushOnStatus:   { Offen: false, Interview: true, Absage: true, Zusage: true },
    };
    return stored ? { ...defaults, ...stored } : defaults;
  } catch { return {}; }
}

function saveSettings() {
  localStorage.setItem('jt-settings', JSON.stringify(State.settings));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uuid() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}
function nowISO()  { return new Date().toISOString(); }
// YYYY-MM-DD aus den LOKALEN Datumsfeldern – anders als toISOString() (UTC-basiert)
// verschiebt das den Tag nicht in Zeitzonen abseits von UTC (z.B. Kalender-Zellen).
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '–';
  // YYYY-MM-DD strings parse as UTC midnight → adding local time offset shows wrong time
  // Only show time when there's an actual time component (ISO with 'T')
  const hasTime = typeof iso === 'string' && iso.includes('T');
  if (!hasTime) return fmtDate(iso);
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' })
       + ', ' + d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' }) + ' Uhr';
}
function fmtDateShort(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit' });
}
function fmtEuro(n) {
  if (!n) return '–';
  return new Intl.NumberFormat('de-DE', { style:'currency', currency:'EUR', maximumFractionDigits:0 }).format(n);
}
function fmtEuroShort(n) {
  if (!n) return '–';
  if (n >= 1000) return (n/1000).toFixed(0) + 'k €';
  return n + ' €';
}
function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
function getWeekKey(iso) {
  const d = new Date(iso);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  const ys = new Date(d.getFullYear(), 0, 1);
  return `${d.getFullYear()}-W${String(Math.ceil(((d - ys) / 86400000 + 1) / 7)).padStart(2,'0')}`;
}
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return escHtml(s); }
// Escaped for use inside a single-quoted JS string literal within an inline
// on*="...('${..}')" handler (status names are free text since custom categories).
function escJs(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function statusClass(s) {
  return `badge-dyn s-${statusSlot(s)}`;
}
function tlClass(s) {
  return `tl-dyn s-${statusSlot(s)}`;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 280);
  }, 2800);
}

// ─── Theme ────────────────────────────────────────────────────────────────────
const SVG_SUN  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const SVG_MOON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SVG_MONITOR = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;

function applyTheme(theme) {
  State.theme = theme;
  localStorage.setItem('jt-theme', theme);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark);
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  // Update sidebar toggle button label
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    if (theme === 'dark')        btn.innerHTML = `${SVG_SUN} Hell`;
    else if (theme === 'light')  btn.innerHTML = `${SVG_MOON} Dunkel`;
    else                         btn.innerHTML = `${SVG_MONITOR} System`;
  }

  // Highlight active theme in Settings buttons
  document.querySelectorAll('[data-theme-btn]').forEach(b => {
    const isActive = b.dataset.themeBtn === theme;
    b.style.background    = isActive ? 'var(--accent)'      : '';
    b.style.color         = isActive ? 'white'              : '';
    b.style.borderColor   = isActive ? 'var(--accent)'      : '';
    b.style.boxShadow     = isActive ? '0 2px 8px rgb(99 102 241/.30)' : '';
  });

  // Redraw charts if dashboard visible
  if (document.getElementById('page-dashboard')?.classList.contains('active')) {
    renderCharts();
  }
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (State.theme === 'system') applyTheme('system');
});

// ─── DB CRUD ──────────────────────────────────────────────────────────────────
async function loadAll() {
  const pairs = await idbEntries(DB);
  State.all = pairs.map(([,v]) => v);
  applyFilters();
  updateCounts();
  updateBadge(); // refresh badge count whenever data changes
}

async function saveApp(app) {
  app.updatedAt = nowISO();
  await idbSet(app.id, app, DB);
  await autoCleanReminder(app);  // auto-delete reminder if Zusage/Absage
  await loadAll();
}

async function deleteApp(id) {
  await idbDel(id, DB);
  await deleteReminder(id); // remove any associated reminder
  await loadAll();
  toast('Bewerbung gelöscht', 'info');
}

// ─── Kalender-Termine ───────────────────────────────────────────────────────────
async function loadEvents() {
  const pairs = await idbEntries(EVENTS);
  State.events = pairs.map(([, v]) => v)
    .sort((a, b) => `${a.date} ${a.time || '99:99'}`.localeCompare(`${b.date} ${b.time || '99:99'}`));
}
async function saveEvent(ev) {
  ev.updatedAt = nowISO();
  await idbSet(ev.id, ev, EVENTS);
  await loadEvents();
}
async function deleteEventById(id) {
  await idbDel(id, EVENTS);
  await loadEvents();
}

// ─── Router ───────────────────────────────────────────────────────────────────
function navigate(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('[data-nav]').forEach(el => el.classList.remove('active'));
  document.getElementById(`page-${tab}`)?.classList.add('active');
  document.querySelectorAll(`[data-nav="${tab}"]`).forEach(el => el.classList.add('active'));
  if (tab === 'dashboard')    renderDashboard();
  if (tab === 'applications') renderView();
  if (tab === 'calendar')     renderCalendar();
  if (tab === 'settings')   { renderSettingsNotifications(); renderStatusSettings(); }
  lucide.createIcons();
}

// ─── Filters & Sort ───────────────────────────────────────────────────────────
function applyFilters() {
  const search = document.getElementById('filter-search')?.value?.toLowerCase() || '';
  const status = document.getElementById('filter-status')?.value || '';
  const source = document.getElementById('filter-source')?.value || '';

  State.filtered = State.all.filter(a => {
    if (status && a.status !== status) return false;
    if (source && a.source !== source) return false;
    if (search) {
      const hay = [
        a.company, a.position, a.source, a.notes,
        a.rejectionReason, a.contactName, a.contactEmail,
        a.contactPhone, a.platformLink,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
  sortApps();
  renderView();
  updateSubtitle();
  populateSourceFilter();
}

function sortApps() {
  const { col, dir } = State.sort;
  State.filtered.sort((a, b) => {
    let va = a[col] ?? '', vb = b[col] ?? '';
    if (col === 'applicationDate') { va = new Date(va); vb = new Date(vb); }
    if (col === 'expectedSalary')  { va = Number(va);   vb = Number(vb); }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

function sortKanbanCol(status, col, dir) {
  State.kanbanSort[status] = { col, dir };
  // Close any open popover
  document.querySelectorAll('.sort-popover').forEach(p => p.remove());
  renderView();
}

function sortAppsForKanban(apps, status) {
  const { col, dir } = State.kanbanSort[status] || { col: 'applicationDate', dir: 'desc' };
  return [...apps].sort((a, b) => {
    let va = a[col] ?? '', vb = b[col] ?? '';
    if (col === 'applicationDate') { va = new Date(va); vb = new Date(vb); }
    if (col === 'expectedSalary')  { va = Number(va);   vb = Number(vb); }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

function toggleSort(col) {
  if (State.sort.col === col) State.sort.dir = State.sort.dir === 'asc' ? 'desc' : 'asc';
  else { State.sort.col = col; State.sort.dir = 'asc'; }
  sortApps();
  renderTable();
  updateSortHeaders();
}

function updateSortHeaders() {
  document.querySelectorAll('th[data-col]').forEach(th => {
    th.classList.remove('sort-active');
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = '';
    if (th.dataset.col === State.sort.col) {
      th.classList.add('sort-active');
      if (arrow) arrow.textContent = State.sort.dir === 'asc' ? ' ↑' : ' ↓';
    }
  });
}

function updateSubtitle() {
  const el = document.getElementById('app-subtitle');
  if (!el) return;
  if (!State.all.length) {
    el.textContent = 'Noch keine Einträge';
  } else if (State.filtered.length === State.all.length) {
    el.textContent = `${State.all.length} Einträge`;
  } else {
    el.textContent = `${State.filtered.length} von ${State.all.length} Einträgen`;
  }
}

function populateSourceFilter() {
  const sel = document.getElementById('filter-source');
  if (!sel) return;
  const prev = sel.value;
  const sources = [...new Set(State.all.map(a => a.source).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">Alle Quellen</option>` +
    sources.map(s => `<option${s===prev?' selected':''}>${escHtml(s)}</option>`).join('');
}

function updateCounts() {
  const n = State.all.length;
  const sc = document.getElementById('nav-count-apps');
  if (sc) sc.textContent = n > 0 ? n : '';
  const mb = document.getElementById('bnav-badge');
  if (mb) { mb.textContent = n; mb.classList.toggle('visible', n > 0); }
}

// ─── View Toggle ──────────────────────────────────────────────────────────────
function setView(v) {
  State.view = v;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.view-btn[data-view="${v}"]`)?.classList.add('active');
  renderView();
}

function renderView() {
  if (State.view === 'table') renderTable();
  else renderKanban();
}

// ─── Drag & Drop (Mouse + iOS Touch) ─────────────────────────────────────────
let dragId    = null;
let _touchClone = null;
let _touchSrc   = null;
let _lastDropTarget = null;

function onDragStart(e, id) {
  dragId = id;
  e.target.closest('.kanban-card')?.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}
function onDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}
async function onDrop(e, newStatus) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (!dragId) return;
  await _applyDrop(dragId, newStatus);
  document.querySelectorAll('.kanban-card.dragging').forEach(c => c.classList.remove('dragging'));
  dragId = null;
}

// ── Touch support (iOS Safari doesn't fire drag events) ─────────────────────
function onTouchStart(e, id) {
  dragId    = id;
  _touchSrc = e.currentTarget;
  _touchSrc.classList.add('dragging');

  // Create a ghost clone that follows the finger
  _touchClone = _touchSrc.cloneNode(true);
  const r = _touchSrc.getBoundingClientRect();
  Object.assign(_touchClone.style, {
    position: 'fixed', top: r.top + 'px', left: r.left + 'px',
    width: r.width + 'px', opacity: '0.75', zIndex: '9999',
    pointerEvents: 'none', borderRadius: '12px',
    transform: 'scale(1.03)',
    transition: 'none', boxShadow: '0 8px 24px rgba(0,0,0,.25)',
  });
  document.body.appendChild(_touchClone);
}

function onTouchMove(e) {
  if (!_touchClone) return;
  e.preventDefault(); // prevent scroll
  const t = e.touches[0];
  const r = _touchSrc.getBoundingClientRect();
  _touchClone.style.top  = (t.clientY - r.height / 2) + 'px';
  _touchClone.style.left = (t.clientX - r.width  / 2) + 'px';

  // Highlight drop target under finger
  _touchClone.style.display = 'none';
  const under = document.elementFromPoint(t.clientX, t.clientY);
  _touchClone.style.display = '';
  const col = under?.closest('.kanban-col-body');
  if (_lastDropTarget && _lastDropTarget !== col) _lastDropTarget.classList.remove('drag-over');
  if (col) col.classList.add('drag-over');
  _lastDropTarget = col || null;
}

async function onTouchEnd(e) {
  if (!_touchClone) return;
  _touchClone.remove(); _touchClone = null;
  _touchSrc?.classList.remove('dragging');

  if (_lastDropTarget) {
    _lastDropTarget.classList.remove('drag-over');
    const newStatus = _lastDropTarget.dataset.status;
    if (newStatus && dragId) await _applyDrop(dragId, newStatus);
    _lastDropTarget = null;
  }
  dragId = null; _touchSrc = null;
}

async function _applyDrop(id, newStatus) {
  const app = State.all.find(a => a.id === id);
  if (app && app.status !== newStatus) {
    app.status  = newStatus;
    app.history = [...(app.history || []), { status: newStatus, timestamp: nowISO() }];
    await saveApp(app);
    toast(`Status → ${newStatus}`, 'success');
  }
}

// ─── Form ─────────────────────────────────────────────────────────────────────
function openForm(id) {
  const app = id ? State.all.find(a => a.id === id) : null;
  document.getElementById('form-title').textContent = app ? 'Bearbeiten' : 'Neue Bewerbung';
  document.getElementById('f-id').value        = app?.id || '';
  document.getElementById('f-company').value   = app?.company || '';
  document.getElementById('f-position').value  = app?.position || '';
  document.getElementById('f-status').value    = app?.status || State.statuses[0]?.name || 'Offen';
  document.getElementById('f-source').value    = app?.source || '';
  document.getElementById('f-salary').value    = app?.expectedSalary || '';
  document.getElementById('f-date').value      = app?.applicationDate?.slice(0,10) || new Date().toISOString().slice(0,10);
  document.getElementById('f-platform').value  = app?.platformLink || '';
  document.getElementById('f-docs').value      = app?.documentLink || '';
  document.getElementById('f-rejection').value = app?.rejectionReason || '';
  document.getElementById('f-contact-name').value  = app?.contactName || '';
  document.getElementById('f-contact-phone').value = app?.contactPhone || '';
  document.getElementById('f-contact-email').value = app?.contactEmail || '';
  document.getElementById('f-notes').value     = app?.notes || '';
  const noteField = document.getElementById('f-history-note');
  if (noteField) noteField.value = '';
  // Show history note field only when editing (existing entry)
  document.getElementById('f-history-note-group')?.classList.toggle('hidden', !app);
  toggleRejectionField();
  showModal('form-modal');
  setTimeout(() => document.getElementById('f-company').focus(), 220);
}

function closeForm() { hideModal('form-modal'); }

function toggleRejectionField() {
  const show = document.getElementById('f-status').value === 'Absage';
  document.getElementById('f-rejection-group').classList.toggle('hidden', !show);
}

async function submitForm(e) {
  e.preventDefault();
  const id = document.getElementById('f-id').value || uuid();
  const existing = State.all.find(a => a.id === id);
  const newStatus = document.getElementById('f-status').value;
  const company   = document.getElementById('f-company').value.trim();
  const position  = document.getElementById('f-position').value.trim();

  // Duplicate check: same company + position already exists (different id)
  if (!existing) {
    const dupe = State.all.find(a =>
      a.company.toLowerCase() === company.toLowerCase() &&
      a.position.toLowerCase() === position.toLowerCase()
    );
    if (dupe) {
      const ok = await showConfirm(
        'Mögliches Duplikat',
        `Du hast bereits eine Bewerbung bei „${dupe.company}" als „${dupe.position}" erfasst.\n\nTrotzdem speichern?`,
        'Ja, speichern', 'primary'
      );
      if (!ok) return;
    }
  }

  const history = existing?.history ? [...existing.history] : [];
  const lastStatus = history.length ? history[history.length-1].status : null;
  const historyNote = document.getElementById('f-history-note')?.value.trim() || '';
  if (!existing) {
    history.push({ status: newStatus, timestamp: nowISO(), note: historyNote || undefined });
  } else if (lastStatus !== newStatus) {
    history.push({ status: newStatus, timestamp: nowISO(), note: historyNote || undefined });
  } else if (historyNote && history.length) {
    // Same status but user added a note → append note to last entry
    history[history.length - 1] = { ...history[history.length - 1], note: historyNote };
  }

  const app = {
    id,
    company,
    position,
    status:          newStatus,
    source:          document.getElementById('f-source').value.trim(),
    expectedSalary:  Number(document.getElementById('f-salary').value) || null,
    applicationDate: document.getElementById('f-date').value,
    platformLink:    document.getElementById('f-platform').value.trim(),
    documentLink:    document.getElementById('f-docs').value.trim(),
    rejectionReason: document.getElementById('f-rejection').value.trim(),
    contactName:     document.getElementById('f-contact-name').value.trim(),
    contactPhone:    document.getElementById('f-contact-phone').value.trim(),
    contactEmail:    document.getElementById('f-contact-email').value.trim(),
    notes:           document.getElementById('f-notes').value.trim(),
    history,
    createdAt:  existing?.createdAt || nowISO(),
    updatedAt:  nowISO(),
  };

  // Fire push notification if status changed to a tracked status
  if (existing && lastStatus !== newStatus) {
    schedulePushIfEnabled(app, newStatus);
  }

  await saveApp(app);
  closeForm();
  toast(existing ? 'Aktualisiert ✓' : 'Gespeichert ✓', 'success');
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────
function openDetail(id) {
  const a = State.all.find(x => x.id === id);
  if (!a) return;

  document.getElementById('d-company').textContent  = a.company;
  document.getElementById('d-position').textContent = a.position;

  // Research buttons — set onclick with current data
  const btnEmployer = document.getElementById('d-research-employer');
  const btnSalary   = document.getElementById('d-research-salary');
  if (btnEmployer) btnEmployer.onclick = (e) => { e.stopPropagation(); searchEmployer(a.company); };
  if (btnSalary)   btnSalary.onclick   = (e) => { e.stopPropagation(); searchSalary(a.position, a.source); };

  // Bell — manual reminder
  const btnBell = document.getElementById('d-bell-btn');
  if (btnBell) {
    btnBell.onclick = (e) => { e.stopPropagation(); openReminderModal(id); };
    // Show filled bell if reminder exists
    getReminder(id).then(r => {
      if (btnBell && r) btnBell.style.color = 'var(--accent)';
      else if (btnBell) btnBell.style.color = '';
    });
  }

  const badge = document.getElementById('d-status-badge');
  badge.textContent = a.status;
  badge.className   = `badge ${statusClass(a.status)}`;

  // Reminder — settings-based threshold per status
  const lastTs    = a.history?.slice(-1)[0]?.timestamp || a.applicationDate;
  const threshold = State.settings?.staleThreshold?.[a.status] ?? (a.status === 'Offen' ? 14 : 0);
  const isStale   = threshold > 0 && daysSince(lastTs) > threshold;
  const remEl     = document.getElementById('d-reminder');
  if (remEl) {
    remEl.classList.toggle('hidden', !isStale);
    if (isStale) remEl.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      ${daysSince(lastTs)} Tage keine Änderung`;
  }

  // Details
  document.getElementById('d-source').textContent    = a.source || '–';
  document.getElementById('d-date').textContent      = fmtDateTime(a.applicationDate);
  document.getElementById('d-salary').textContent    = fmtEuro(a.expectedSalary);
  document.getElementById('d-rejection').textContent = a.rejectionReason || '–';

  // Contact
  const contactSec = document.getElementById('d-contact-section');
  if (a.contactName || a.contactPhone || a.contactEmail) {
    contactSec.classList.remove('hidden');
    document.getElementById('d-contact-name').textContent  = a.contactName  || '–';
    document.getElementById('d-contact-phone').textContent = a.contactPhone || '–';
    document.getElementById('d-contact-email').textContent = a.contactEmail || '–';
    // Make phone/email clickable
    const ph = document.getElementById('d-contact-phone');
    if (a.contactPhone) ph.innerHTML = `<a href="tel:${escAttr(a.contactPhone)}" style="color:var(--accent)">${escHtml(a.contactPhone)}</a>`;
    const em = document.getElementById('d-contact-email');
    if (a.contactEmail) em.innerHTML = `<a href="mailto:${escAttr(a.contactEmail)}" style="color:var(--accent)">${escHtml(a.contactEmail)}</a>`;
  } else {
    contactSec.classList.add('hidden');
  }

  // Quick status button
  const statusBtn = document.getElementById('d-status-btn');
  if (statusBtn) {
    statusBtn.onclick = (e) => showStatusMenu(e, id);
  }

  // Links
  const linksEl = document.getElementById('d-links');
  linksEl.innerHTML = '';
  if (a.platformLink) linksEl.innerHTML += `<a href="${escAttr(a.platformLink)}" target="_blank" rel="noopener" class="link-pill"><i data-lucide="external-link" style="width:12px;height:12px"></i>Stellenanzeige</a>`;
  if (a.documentLink) linksEl.innerHTML += `<a href="${escAttr(a.documentLink)}" target="_blank" rel="noopener" class="link-pill"><i data-lucide="folder-open" style="width:12px;height:12px"></i>Unterlagen</a>`;
  lucide.createIcons({ nodes: [linksEl] });

  // Notes
  const notesSec = document.getElementById('d-notes-section');
  notesSec.classList.toggle('hidden', !a.notes);
  document.getElementById('d-notes').textContent = a.notes || '';

  // Mailto
  const subj = encodeURIComponent(`Nachfasse: Bewerbung als ${a.position} bei ${a.company}`);
  const body = encodeURIComponent(`Sehr geehrte Damen und Herren,\n\nich habe mich am ${fmtDate(a.applicationDate)} auf die Stelle als ${a.position} beworben und möchte freundlich nachfragen, ob meine Bewerbung eingegangen ist.\n\nMit freundlichen Grüßen`);
  document.getElementById('d-followup').href = `mailto:?subject=${subj}&body=${body}`;

  // Timeline
  const tl = document.getElementById('d-timeline');
  const hist = [...(a.history || [])].reverse();
  if (!hist.length) {
    tl.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted)">Noch keine Statusänderungen.</p>`;
  } else {
    tl.innerHTML = hist.map((h, i) => `
      <div class="timeline-item">
        <div class="timeline-line-wrap">
          <div class="timeline-dot ${tlClass(h.status)}"></div>
          ${i < hist.length - 1 ? '<div class="timeline-connector"></div>' : ''}
        </div>
        <div class="timeline-content">
          <div class="timeline-status">${escHtml(h.status)}</div>
          <div class="timeline-ts">${fmtDateTime(h.timestamp)}</div>
          ${h.note ? `<div class="timeline-note">${escHtml(h.note)}</div>` : ''}
        </div>
      </div>`).join('');
  }

  // Action buttons
  document.getElementById('d-edit-btn').onclick   = () => { closeDetail(); openForm(id); };
  document.getElementById('d-delete-btn').onclick = () => { closeDetail(); confirmDelete(id); };
  showModal('detail-modal');
  lucide.createIcons();
}
function closeDetail() { hideModal('detail-modal'); }

// ─── Contextual Deep-Link Research ────────────────────────────────────────────
function searchEmployer(company) {
  if (!company) return;
  const q   = `${company} als Arbeitgeber`;
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function searchSalary(position, source) {
  if (!position) return;
  // Use source as a city/location hint if it looks like a location, otherwise omit
  const city = source && !/linkedin|indeed|xing|stepstone|monster|glassdoor|http/i.test(source)
    ? source : '';
  const q   = `Gehalt ${position} Durchschnitt${city ? ' ' + city : ''}`;
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function confirmDelete(id) {
  const a = State.all.find(x => x.id === id);
  if (!a) return;
  const ok = await showConfirm(
    'Bewerbung löschen?',
    `"${a.company} – ${a.position}" wird unwiderruflich entfernt.`,
    'Löschen', 'danger'
  );
  if (ok) deleteApp(id);
}

// ─── Quick Status Change ───────────────────────────────────────────────────────
function showStatusMenu(e, id) {
  e.stopPropagation();
  document.querySelectorAll('.status-popover').forEach(p => p.remove());
  const STATUSES = State.statuses.map(s => s.name);
  const a = State.all.find(x => x.id === id);
  if (!a) return;

  const popover = document.createElement('div');
  popover.className = 'sort-popover status-popover';
  const SVG_CHECK = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  popover.innerHTML = STATUSES.map(s => {
    const isActive = s === a.status;
    return `<div class="sort-popover-item${isActive?' active':''}" onclick="applyQuickStatus('${id}','${s}')">
      <span style="width:16px;flex-shrink:0;opacity:${isActive?1:0}">${SVG_CHECK}</span>
      <span class="badge ${statusClass(s)}" style="font-size:.65rem;padding:.1rem .45rem">${s}</span>
    </div>`;
  }).join('');

  // Find or create a positioned wrapper around the trigger button
  const btn = e.currentTarget;
  let anchor = btn.closest('[data-status-anchor]');
  if (!anchor) {
    // Wrap btn in a relative container if not already wrapped
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-status-anchor', '');
    wrapper.style.cssText = 'position:relative;display:inline-flex;';
    btn.parentNode.insertBefore(wrapper, btn);
    wrapper.appendChild(btn);
    anchor = wrapper;
  }
  anchor.appendChild(popover);

  // Close on outside click
  setTimeout(() => {
    const close = (ev) => {
      if (!anchor.contains(ev.target)) {
        popover.remove();
        document.removeEventListener('click', close, true);
      }
    };
    document.addEventListener('click', close, true);
  }, 0);
}

// ─── Custom Confirm Dialog (replaces window.confirm – works in iOS PWA) ───────
function showConfirm(title, message, okLabel = 'OK', variant = 'primary') {
  return new Promise(resolve => {
    const el = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent   = title;
    document.getElementById('confirm-message').textContent = message;
    const btn = document.getElementById('confirm-ok');
    btn.textContent  = okLabel;
    btn.className    = `btn btn-${variant}`;
    btn.onclick      = () => { hideModal('confirm-modal'); resolve(true);  };
    document.getElementById('confirm-cancel').onclick = () => { hideModal('confirm-modal'); resolve(false); };
    showModal('confirm-modal');
  });
}
function showModal(id) {
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('visible'));
}
function hideModal(id) {
  const el = document.getElementById(id);
  el.classList.remove('visible');
  setTimeout(() => el.classList.add('hidden'), 280);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function checkPersistence() {
  if (!navigator.storage?.persisted) return;
  const persisted = await navigator.storage.persisted();
  const dot    = document.getElementById('persist-dot');
  const status = document.getElementById('persist-status-text');
  const sideWarn = document.getElementById('sidebar-warn');
  const btn    = document.getElementById('persist-btn');

  if (persisted) {
    if (dot)    { dot.className = 'persist-dot ok'; }
    if (status) status.textContent = 'Speicher geschützt ✓';
    if (btn)    { btn.textContent = 'Aktiv'; btn.disabled = true; }
    if (sideWarn) sideWarn.classList.add('hidden');
  } else {
    if (dot)    { dot.className = 'persist-dot warn'; }
    if (status) status.textContent = 'Nicht geschützt – Daten können gelöscht werden';
    if (sideWarn) sideWarn.classList.remove('hidden');
  }
}

async function requestPersistence() {
  if (!navigator.storage?.persist) { toast('API nicht unterstützt', 'warning'); return; }
  const granted = await navigator.storage.persist();
  await checkPersistence();
  toast(granted ? 'Speicherschutz aktiviert ✓' : 'Nicht gewährt (Browsereinstellung)', granted ? 'success' : 'warning');
}

async function exportData() {
  const pairs = await idbEntries(DB);
  const data  = pairs.map(([,v]) => v);
  const blob  = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href = url;
  a.download = `jobtracker-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast(`${data.length} Einträge exportiert`, 'success');
}

async function exportCSV() {
  const pairs = await idbEntries(DB);
  const data  = pairs.map(([,v]) => v);
  if (!data.length) { toast('Keine Daten zum Exportieren', 'info'); return; }

  const cols = ['Firma','Position','Status','Quelle','Datum','Gehalt','Absagegrund','Ansprechpartner','Telefon','E-Mail','Stellenanzeige','Unterlagen','Notizen'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = data.map(a => [
    esc(a.company), esc(a.position), esc(a.status), esc(a.source),
    esc(a.applicationDate), esc(a.expectedSalary ?? ''), esc(a.rejectionReason),
    esc(a.contactName), esc(a.contactPhone), esc(a.contactEmail),
    esc(a.platformLink), esc(a.documentLink), esc(a.notes),
  ].join(';'));

  const csv  = '\uFEFF' + [cols.join(';'), ...rows].join('\r\n'); // BOM for Excel
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const el   = document.createElement('a');
  el.href = url; el.download = `jobtracker-${new Date().toISOString().slice(0,10)}.csv`;
  el.click(); URL.revokeObjectURL(url);
  toast(`${data.length} Einträge als CSV exportiert`, 'success');
}

async function importCSV(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text  = await file.text();
    // Strip BOM, split lines
    const clean = text.replace(/^\uFEFF/, '');
    const lines = clean.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('Keine Daten gefunden');

    const header = lines[0].split(';').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const colMap = {
      firma:'company', position:'position', status:'status', quelle:'source',
      datum:'applicationDate', gehalt:'expectedSalary', absagegrund:'rejectionReason',
      ansprechpartner:'contactName', telefon:'contactPhone', 'e-mail':'contactEmail',
      stellenanzeige:'platformLink', unterlagen:'documentLink', notizen:'notes',
    };

    const parseCSVLine = (line) => {
      const result = []; let cur = ''; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && !inQ) { inQ = true; }
        else if (ch === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; }
        else if (ch === '"' && inQ) { inQ = false; }
        else if (ch === ';' && !inQ) { result.push(cur); cur = ''; }
        else cur += ch;
      }
      result.push(cur);
      return result;
    };

    const imported = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = parseCSVLine(lines[i]);
      const app  = { id: uuid(), createdAt: nowISO(), updatedAt: nowISO(), history: [] };
      header.forEach((h, idx) => {
        const field = colMap[h];
        if (!field) return;
        let val = vals[idx] ?? '';
        if (field === 'expectedSalary') val = Number(val.replace(/[^0-9]/g,'')) || null;
        else val = val.trim() || null;
        app[field] = val;
      });
      if (!app.company) continue;
      app.status = app.status || State.statuses[0]?.name || 'Offen';
      app.history.push({ status: app.status, timestamp: nowISO() });
      imported.push(app);
    }
    if (!imported.length) throw new Error('Keine gültigen Zeilen gefunden');
    await idbClear(DB);
    for (const app of imported) await idbSet(app.id, app, DB);
    await loadAll();
    toast(`${imported.length} Einträge aus CSV importiert ✓`, 'success');
  } catch (err) {
    toast('CSV-Import fehlgeschlagen: ' + err.message, 'error');
  }
  e.target.value = '';
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('Ungültiges Format');
    await idbClear(DB);
    for (const app of data) await idbSet(app.id, app, DB);
    await loadAll();
    toast(`${data.length} Einträge importiert ✓`, 'success');
  } catch (err) {
    toast('Import fehlgeschlagen: ' + err.message, 'error');
  }
  e.target.value = '';
}

async function clearAllData() {
  const ok = await showConfirm(
    'Alle Daten löschen?',
    'Alle Bewerbungen und Erinnerungen werden unwiderruflich entfernt.',
    'Löschen', 'danger'
  );
  if (!ok) return;
  await idbClear(DB);
  await idbClear(REMINDERS);
  await loadAll();
  toast('Alle Daten gelöscht', 'info');
}

// ─── Notification & Reminder Engine ─────────────────────────────────────────
// Core principle: User in Control. All notifications default OFF.

function notifSupported() { return 'Notification' in window; }
function notifPermission() { return notifSupported() ? Notification.permission : 'denied'; }
function isPushActive()    { return State.settings.pushEnabled && notifPermission() === 'granted'; }

async function requestPushPermission() {
  if (!notifSupported()) { toast('Dein Browser unterstützt keine Benachrichtigungen.', 'warning'); return false; }
  const perm = notifPermission();
  if (perm === 'denied') {
    toast('Benachrichtigungen in Systemeinstellungen blockiert – dort freigeben.', 'warning');
    renderSettingsNotifications(); return false;
  }
  if (perm === 'granted') {
    State.settings.pushEnabled = true; saveSettings(); renderSettingsNotifications(); updateBadge(); return true;
  }
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    State.settings.pushEnabled = true; saveSettings(); renderSettingsNotifications(); updateBadge();
    toast('Benachrichtigungen aktiviert ✓', 'success'); return true;
  }
  State.settings.pushEnabled = false; saveSettings(); renderSettingsNotifications();
  toast('Erlaubnis abgelehnt.', 'warning'); return false;
}

async function toggleMasterPush(enabled) {
  if (enabled) {
    await requestPushPermission();
  } else {
    State.settings.pushEnabled = false; saveSettings(); renderSettingsNotifications(); updateBadge();
    toast('Benachrichtigungen deaktiviert', 'info');
  }
}

function fireNotification(title, body, tag, appId) {
  if (!isPushActive()) return;
  const payload = {
    title, body,
    tag:   tag   || 'jt',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-96.png',
    data:  { appId, url: '/' },
  };
  try {
    const ctrl = navigator.serviceWorker?.controller;
    if (ctrl) {
      ctrl.postMessage({ type: 'SHOW_NOTIFICATION', ...payload });
    } else {
      // Fallback: direct Notification API (SW not yet active / first load)
      new Notification(title, { body, icon: payload.icon, tag: payload.tag });
    }
  } catch { /* SW unavailable – silently skip */ }
}

function schedulePushIfEnabled(app, newStatus) {
  if (!isPushActive() || !State.settings.pushOnStatus?.[newStatus]) return;
  const titles = { Interview: `🎯 Interview bei ${app.company}`, Zusage: `🎉 Zusage von ${app.company}!`, Absage: `📭 Absage von ${app.company}`, Offen: `📋 Zurückgesetzt: ${app.company}` };
  fireNotification(titles[newStatus] || `Status: ${newStatus}`, app.position, `status-${app.id}`, app.id);
}

// ── Badge ──────────────────────────────────────────────────────────────────────
async function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  if (!State.settings.badgeEnabled) { navigator.clearAppBadge?.(); return; }
  const count = await countDueBadgeItems();
  count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge?.();
}

async function countDueBadgeItems() {
  let count = 0;
  const today = new Date().toISOString().slice(0, 10);

  // Manual reminders due today or overdue
  try {
    const p = await idbEntries(REMINDERS);
    count += p.filter(([, r]) => r.date <= today).length;
  } catch {}

  // Stale apps per threshold
  const thr = State.settings.staleThreshold || {};
  const followUpDays = State.settings.followUpDays || 0;
  State.all.forEach(app => {
    const lastTs  = app.history?.slice(-1)[0]?.timestamp || app.applicationDate;
    const days    = daysSince(lastTs);
    const t       = thr[app.status];
    if (t && days >= t) count++;
    // Follow-up due
    if (followUpDays > 0 && ['Offen', 'Interview'].includes(app.status) && days >= followUpDays) count++;
  });
  return count;
}

// ── Stale Checker + Follow-Up ─────────────────────────────────────────────────
function checkStaleReminders() {
  if (!isPushActive()) { updateBadge(); return; }
  const thr = State.settings.staleThreshold || {};
  const followUpDays = State.settings.followUpDays || 0;
  const today = new Date().toISOString().slice(0, 10);

  State.all.forEach(app => {
    const lastTs    = app.history?.slice(-1)[0]?.timestamp || app.applicationDate;
    const daysSt    = daysSince(lastTs);

    // Per-status inactivity threshold
    const threshold = thr[app.status];
    if (threshold && daysSt >= threshold) {
      const key = `jt-stale-${app.id}`;
      if (localStorage.getItem(key) !== today) {
        localStorage.setItem(key, today);
        fireNotification(
          `⏰ Nachfassen: ${app.company}`,
          `„${app.position}" — ${daysSt} Tage im Status ${app.status}`,
          `stale-${app.id}`, app.id
        );
      }
    }

    // Global follow-up: fires for Offen/Interview if no response in followUpDays
    if (followUpDays > 0 && ['Offen', 'Interview'].includes(app.status) && daysSt >= followUpDays) {
      const fuKey = `jt-followup-${app.id}`;
      if (localStorage.getItem(fuKey) !== today) {
        localStorage.setItem(fuKey, today);
        fireNotification(
          `📬 Nachfassen empfohlen: ${app.company}`,
          `${app.position} — seit ${daysSt} Tagen keine Reaktion`,
          `followup-${app.id}`, app.id
        );
      }
    }
  });
  updateBadge();
}

// ── Manual Reminder Queue ──────────────────────────────────────────────────────
async function saveReminder(appId, date, note) {
  await idbSet(`reminder-${appId}`, { id: `reminder-${appId}`, appId, date, note: note || '' }, REMINDERS);
  updateBadge();
}
async function deleteReminder(appId) {
  try { await idbDel(`reminder-${appId}`, REMINDERS); } catch {}
  updateBadge();
}
async function getReminder(appId) { try { return await idbGet(`reminder-${appId}`, REMINDERS); } catch { return null; } }

async function autoCleanReminder(app) {
  if (['Zusage', 'Absage'].includes(app.status)) await deleteReminder(app.id);
}

async function checkManualReminders() {
  if (!isPushActive()) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const pairs = await idbEntries(REMINDERS);
    for (const [, r] of pairs) {
      if (r.date > today) continue;
      const fk = `jt-rem-fired-${r.id}-${today}`;
      if (localStorage.getItem(fk)) continue;
      localStorage.setItem(fk, '1');
      const app = State.all.find(a => a.id === r.appId);
      if (!app) { await deleteReminder(r.appId); continue; }
      fireNotification(`🔔 Erinnerung: ${app.company}`, r.note || `${app.position} — geplant für heute`, `reminder-${r.id}`, r.appId);
    }
  } catch {}
  updateBadge();
}

// ── Weekly Summary ─────────────────────────────────────────────────────────────
function checkWeeklySummary() {
  if (!isPushActive() || !State.settings.weeklySummary) return;
  const key = 'jt-weekly-summary'; const today = new Date().toISOString().slice(0, 10);
  if (new Date().getDay() !== 1 || localStorage.getItem(key) === today) return;
  localStorage.setItem(key, today);
  const offene = State.all.filter(a => a.status === 'Offen').length;
  const interviews = State.all.filter(a => a.status === 'Interview').length;
  fireNotification('📋 Wöchentliche Zusammenfassung', `${State.all.length} Bewerbungen · ${offene} offen · ${interviews} im Interview`, 'weekly-summary');
}

// ── Bell / Reminder Modal ──────────────────────────────────────────────────────
async function openReminderModal(appId) {
  if (!isPushActive()) {
    const ok = await showConfirm('Benachrichtigungen nicht aktiv', 'Bitte aktiviere zuerst Benachrichtigungen in den Einstellungen.', 'Zu den Einstellungen', 'primary');
    if (ok) navigate('settings');
    return;
  }
  const existing = await getReminder(appId);
  const modal = document.getElementById('reminder-modal');
  if (!modal) return;
  document.getElementById('reminder-date').value = existing?.date || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  document.getElementById('reminder-note').value = existing?.note || '';
  document.getElementById('reminder-delete-btn').style.display = existing ? '' : 'none';
  modal.dataset.appId = appId;
  showModal('reminder-modal');
}

async function saveReminderFromModal() {
  const modal = document.getElementById('reminder-modal');
  const appId = modal?.dataset.appId;
  const date  = document.getElementById('reminder-date')?.value;
  const note  = document.getElementById('reminder-note')?.value.trim();
  if (!appId || !date) return;
  await saveReminder(appId, date, note);
  hideModal('reminder-modal');
  toast('Erinnerung gespeichert ✓', 'success');
}

async function deleteReminderFromModal() {
  const appId = document.getElementById('reminder-modal')?.dataset.appId;
  if (!appId) return;
  await deleteReminder(appId);
  hideModal('reminder-modal');
  toast('Erinnerung gelöscht', 'info');
}

// ── Kalender: Monatsnavigation ──────────────────────────────────────────────────
function changeCalendarMonth(delta) {
  const d = new Date(State.calendarMonth);
  d.setMonth(d.getMonth() + delta);
  State.calendarMonth = d;
  renderCalendar();
}
function goToCalendarToday() {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
  State.calendarMonth = d;
  renderCalendar();
}

// ── Kalender: Termin-Modal ───────────────────────────────────────────────────────
function populateEventAppSelect() {
  const sel = document.getElementById('ev-app');
  if (!sel) return;
  const prev = sel.value;
  const opts = [...State.all]
    .sort((a, b) => a.company.localeCompare(b.company))
    .map(a => `<option value="${a.id}">${escHtml(a.company)} – ${escHtml(a.position)}</option>`).join('');
  sel.innerHTML = `<option value="">– keine Verknüpfung –</option>` + opts;
  if (State.all.some(a => a.id === prev)) sel.value = prev;
}

function openEventModal(dateStr, eventId) {
  const ev = eventId ? State.events.find(e => e.id === eventId) : null;
  populateEventAppSelect();
  document.getElementById('event-modal-title').textContent = ev ? 'Termin bearbeiten' : 'Termin hinzufügen';
  document.getElementById('ev-id').value    = ev?.id || '';
  document.getElementById('ev-date').value  = ev?.date || dateStr || localDateStr(new Date());
  document.getElementById('ev-time').value  = ev?.time || '';
  document.getElementById('ev-app').value   = ev?.appId || '';
  document.getElementById('ev-title').value = ev?.title || '';
  document.getElementById('ev-note').value  = ev?.note || '';
  document.getElementById('ev-delete-btn').classList.toggle('hidden', !ev);
  showModal('event-modal');
  setTimeout(() => document.getElementById('ev-title').focus(), 220);
}
function closeEventModal() { hideModal('event-modal'); }

async function submitEvent(e) {
  e.preventDefault();
  const title = document.getElementById('ev-title').value.trim();
  const date  = document.getElementById('ev-date').value;
  if (!title || !date) return false;
  const ev = {
    id:    document.getElementById('ev-id').value || uuid(),
    date,
    time:  document.getElementById('ev-time').value || null,
    appId: document.getElementById('ev-app').value || null,
    title,
    note:  document.getElementById('ev-note').value.trim() || null,
  };
  await saveEvent(ev);
  closeEventModal();
  renderCalendar();
  toast('Termin gespeichert', 'success');
  return false;
}

async function deleteEventFromModal() {
  const id = document.getElementById('ev-id').value;
  if (!id) return;
  closeEventModal();
  const ok = await showConfirm('Termin löschen?', 'Dieser Termin wird endgültig entfernt.', 'Löschen', 'danger');
  if (!ok) return;
  await deleteEventById(id);
  renderCalendar();
  toast('Termin gelöscht', 'info');
}

// ── Settings UI ───────────────────────────────────────────────────────────────
function updatePushSetting(key, value) {
  if (key === 'pushOnStatus') {
    if (!State.settings.pushOnStatus) State.settings.pushOnStatus = {};
    State.settings.pushOnStatus[value.status] = value.checked;
  } else if (key === 'staleThreshold') {
    if (!State.settings.staleThreshold) State.settings.staleThreshold = {};
    State.settings.staleThreshold[value.status] = Number(value.days);
  } else { State.settings[key] = value; }
  saveSettings();
  if (key === 'badgeEnabled') updateBadge();
}

function renderSettingsNotifications() {
  const el = document.getElementById('notif-settings-body');
  if (!el) return;
  const supported = notifSupported();
  const perm      = notifPermission();
  const granted   = perm === 'granted';
  const denied    = perm === 'denied';
  const masterOn  = State.settings.pushEnabled && granted;

  const STATUSES = State.statuses.map(s => ({ key: s.name, label: s.name }));

  const permBanner = !supported
    ? `<div class="notif-banner notif-banner--warn">Dein Browser unterstützt keine Benachrichtigungen.</div>`
    : denied
    ? `<div class="notif-banner notif-banner--denied">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Blockiert in Systemeinstellungen. Einstellungen → Apps → JobTracker → Benachrichtigungen aktivieren.
      </div>` : '';

  el.innerHTML = `
    ${permBanner}
    <label class="notif-master-row">
      <div class="notif-master-info">
        <div class="notif-master-title">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          Benachrichtigungen
        </div>
        <div class="notif-master-sub">${!supported ? 'Nicht unterstützt' : denied ? 'Blockiert – in Systemeinstellungen freigeben' : granted ? (masterOn ? 'Aktiv' : 'Erlaubt, aber deaktiviert') : 'Erlaubnis noch nicht erteilt'}</div>
      </div>
      <input type="checkbox" class="toggle" ${masterOn ? 'checked' : ''} ${(!supported || denied) ? 'disabled' : ''} onchange="toggleMasterPush(this.checked)" />
    </label>
    ${masterOn ? `
    <div class="notif-section-divider"></div>
    <div class="notif-feature-group">
      <div class="notif-feature-label">Automatisch</div>
      <label class="notif-row">
        <div class="notif-row-info"><span>📊 Wöchentliche Zusammenfassung</span><span class="notif-row-sub">Jeden Montag morgen</span></div>
        <input type="checkbox" class="toggle" ${State.settings.weeklySummary ? 'checked' : ''} onchange="updatePushSetting('weeklySummary', this.checked)" />
      </label>
      <div class="notif-row">
        <div class="notif-row-info"><span>⏰ Nachfassen nach</span><span class="notif-row-sub">Tage ohne Reaktion (0 = aus)</span></div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          <input type="number" class="form-input" min="0" max="60" style="width:56px;text-align:center;padding:.3rem .4rem;font-size:.82rem" value="${State.settings.followUpDays || 0}" onchange="updatePushSetting('followUpDays', Number(this.value))" />
          <span style="font-size:.78rem;color:var(--text-muted);white-space:nowrap">Tage</span>
        </div>
      </div>
      <label class="notif-row">
        <div class="notif-row-info"><span>🔢 Badge am App-Icon</span><span class="notif-row-sub">Zahl für fällige Aktionen</span></div>
        <input type="checkbox" class="toggle" ${State.settings.badgeEnabled ? 'checked' : ''} onchange="updatePushSetting('badgeEnabled', this.checked)" />
      </label>
    </div>
    <div class="notif-section-divider"></div>
    <div class="notif-feature-group">
      <div class="notif-feature-label">Bei Status-Wechsel zu</div>
      ${STATUSES.map(s => `
        <label class="notif-row">
          <div style="display:flex;align-items:center;gap:8px"><span class="badge ${statusClass(s.key)}" style="font-size:.7rem">${escHtml(s.label)}</span></div>
          <input type="checkbox" class="toggle" ${State.settings.pushOnStatus?.[s.key] ? 'checked' : ''} onchange="updatePushSetting('pushOnStatus',{status:'${escJs(s.key)}',checked:this.checked})" />
        </label>`).join('')}
    </div>
    <div class="notif-section-divider"></div>
    <div class="notif-feature-group">
      <div class="notif-feature-label">Erinnerung nach Inaktivität (0 = aus)</div>
      ${STATUSES.map(s => `
        <div class="notif-row">
          <div style="display:flex;align-items:center;gap:8px"><span class="badge ${statusClass(s.key)}" style="font-size:.7rem">${escHtml(s.label)}</span></div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <input type="number" class="form-input" min="0" max="90" style="width:56px;text-align:center;padding:.3rem .4rem;font-size:.82rem" value="${State.settings.staleThreshold?.[s.key] ?? 0}" onchange="updatePushSetting('staleThreshold',{status:'${escJs(s.key)}',days:this.value})" />
            <span style="font-size:.78rem;color:var(--text-muted)">Tage</span>
          </div>
        </div>`).join('')}
    </div>` : ''}
  `;
}

// ─── Status-Kategorien verwalten (Settings) ────────────────────────────────────
function renderStatusSettings() {
  const el = document.getElementById('status-settings-body');
  if (!el) return;
  el.innerHTML = `
    <div class="status-manage-list">
      ${State.statuses.map((s, i) => `
        <div class="status-manage-row">
          <input type="color" class="status-color-input" value="${escAttr(s.color)}"
            oninput="updateStatusColor(${i}, this.value)" title="Farbe" />
          <input type="text" class="form-input status-name-input" value="${escAttr(s.name)}"
            onchange="renameStatus(${i}, this.value)" placeholder="Name" />
          <div class="status-move-btns">
            <button type="button" class="btn btn-icon btn-sm" onclick="moveStatus(${i},-1)" title="Nach oben" ${i === 0 ? 'disabled' : ''}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button type="button" class="btn btn-icon btn-sm" onclick="moveStatus(${i},1)" title="Nach unten" ${i === State.statuses.length - 1 ? 'disabled' : ''}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
          <button type="button" class="btn btn-icon btn-sm" onclick="deleteStatus(${i})" title="Kategorie löschen" ${State.statuses.length <= 1 ? 'disabled' : ''} style="color:var(--text-muted)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>`).join('')}
    </div>
    <form class="status-add-row" onsubmit="return addStatus(event)">
      <input type="color" id="new-status-color" class="status-color-input" value="#6366f1" title="Farbe" />
      <input type="text" id="new-status-name" class="form-input status-name-input" placeholder="Neue Kategorie …" required />
      <button type="submit" class="btn btn-ghost btn-sm">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Hinzufügen
      </button>
    </form>
  `;
}

function addStatus(e) {
  e.preventDefault();
  const nameEl  = document.getElementById('new-status-name');
  const colorEl = document.getElementById('new-status-color');
  const name = nameEl.value.trim();
  if (!name) return false;
  if (State.statuses.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    toast('Diese Kategorie gibt es schon', 'warning');
    return false;
  }
  State.statuses.push({ name, color: colorEl.value });
  saveStatuses();
  injectStatusStyles();
  renderStatusSettings();
  renderStatusSelectOptions();
  renderView();
  toast(`Kategorie „${name}“ hinzugefügt`, 'success');
  return false;
}

function updateStatusColor(idx, color) {
  const s = State.statuses[idx];
  if (!s) return;
  s.color = color;
  saveStatuses();
  injectStatusStyles();
}

function _renameStatusKey(obj, oldName, newName) {
  if (obj && Object.prototype.hasOwnProperty.call(obj, oldName)) {
    obj[newName] = obj[oldName];
    delete obj[oldName];
  }
}

async function renameStatus(idx, rawName) {
  const s = State.statuses[idx];
  if (!s) return;
  const newName = rawName.trim();
  const oldName = s.name;
  if (!newName || newName === oldName) { renderStatusSettings(); return; }
  if (State.statuses.some((o, i) => i !== idx && o.name.toLowerCase() === newName.toLowerCase())) {
    toast('Diese Kategorie gibt es schon', 'warning');
    renderStatusSettings();
    return;
  }

  s.name = newName;
  saveStatuses();

  // Bestehende Bewerbungen (inkl. Verlauf) auf den neuen Namen umstellen
  const affected = State.all.filter(a => a.status === oldName || a.history?.some(h => h.status === oldName));
  for (const app of affected) {
    if (app.status === oldName) app.status = newName;
    if (app.history) app.history = app.history.map(h => h.status === oldName ? { ...h, status: newName } : h);
    app.updatedAt = nowISO();
    await idbSet(app.id, app, DB);
  }

  _renameStatusKey(State.settings.staleThreshold, oldName, newName);
  _renameStatusKey(State.settings.pushOnStatus, oldName, newName);
  _renameStatusKey(State.kanbanSort, oldName, newName);
  saveSettings();

  injectStatusStyles();
  await loadAll();
  renderStatusSettings();
  renderStatusSelectOptions();
  renderView();
  renderSettingsNotifications();
  toast(`„${oldName}“ umbenannt in „${newName}“`, 'success');
}

async function deleteStatus(idx) {
  if (State.statuses.length <= 1) {
    toast('Es muss mindestens eine Kategorie geben', 'warning');
    return;
  }
  const target   = State.statuses[idx];
  const fallback = State.statuses.find((s, i) => i !== idx)?.name;
  const inUse    = State.all.filter(a => a.status === target.name);

  if (inUse.length) {
    const ok = await showConfirm(
      'Kategorie löschen?',
      `${inUse.length} Bewerbung${inUse.length === 1 ? '' : 'en'} ${inUse.length === 1 ? 'hat' : 'haben'} den Status „${target.name}“. Sie werden auf „${fallback}“ gesetzt.`,
      'Löschen', 'danger'
    );
    if (!ok) return;
    for (const app of inUse) {
      app.status    = fallback;
      app.history   = [...(app.history || []), { status: fallback, timestamp: nowISO() }];
      app.updatedAt = nowISO();
      await idbSet(app.id, app, DB);
    }
  }

  State.statuses.splice(idx, 1);
  saveStatuses();
  delete State.settings.staleThreshold?.[target.name];
  delete State.settings.pushOnStatus?.[target.name];
  delete State.kanbanSort?.[target.name];
  saveSettings();

  injectStatusStyles();
  await loadAll();
  renderStatusSettings();
  renderStatusSelectOptions();
  renderView();
  renderSettingsNotifications();
  toast(`Kategorie „${target.name}“ gelöscht`, 'info');
}

function moveStatus(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= State.statuses.length) return;
  [State.statuses[idx], State.statuses[j]] = [State.statuses[j], State.statuses[idx]];
  saveStatuses();
  injectStatusStyles();
  renderStatusSettings();
  renderStatusSelectOptions();
  renderView();
}

// ─── Google Drive Sync ────────────────────────────────────────────────────────
// Fill in your credentials from https://console.cloud.google.com/
const GD_CLIENT_ID = '';   // e.g. '123456789-abc.apps.googleusercontent.com'
const GD_API_KEY   = '';   // e.g. 'AIzaSy...'

const GD_SCOPE       = 'https://www.googleapis.com/auth/drive.appdata';
const GD_BACKUP_NAME = 'backup.json';
const GD_DISCOVERY   = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';

// Internal state
let _gdTokenClient = null;   // GSI token client
let _gdAccessToken = null;   // current access token
let _gdInitialized = false;  // GAPI client loaded

/** Entry point called from UI button */
async function syncToGoogleDrive() {
  if (!GD_CLIENT_ID || !GD_API_KEY) {
    toast('Google Drive: CLIENT_ID und API_KEY in app.js eintragen.', 'warning');
    return;
  }
  _gdUpdateBtn('loading');
  try {
    await _gdEnsureLibs();
    await _gdEnsureToken();
    await _gdRunSync();
  } catch (err) {
    if (err?.message === 'CANCELLED') {
      toast('Google Drive: Anmeldung abgebrochen.', 'info');
    } else {
      console.error('[GDrive]', err);
      toast('Google Drive Fehler: ' + (err?.message || err), 'error');
    }
  } finally {
    _gdUpdateBtn('idle');
  }
}

/** Dynamically load GSI + GAPI scripts if not yet present */
function _gdEnsureLibs() {
  return new Promise((resolve, reject) => {
    const loadScript = (src) => new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
      const s = document.createElement('script');
      s.src = src; s.async = true; s.defer = true;
      s.onload = res; s.onerror = () => rej(new Error(`Skript konnte nicht geladen werden: ${src}`));
      document.head.appendChild(s);
    });

    Promise.all([
      loadScript('https://accounts.google.com/gsi/client'),
      loadScript('https://apis.google.com/js/api.js'),
    ])
    .then(() => {
      // Wait for gapi to be ready, then load Drive client
      const waitGapi = (retries = 20) => {
        if (typeof gapi !== 'undefined') {
          gapi.load('client', async () => {
            if (!_gdInitialized) {
              await gapi.client.init({ apiKey: GD_API_KEY, discoveryDocs: [GD_DISCOVERY] });
              _gdInitialized = true;
            }
            resolve();
          });
        } else if (retries > 0) {
          setTimeout(() => waitGapi(retries - 1), 150);
        } else {
          reject(new Error('GAPI konnte nicht initialisiert werden.'));
        }
      };
      waitGapi();
    })
    .catch(reject);
  });
}

/** Obtain an access token via GSI popup; resolves when token is available */
function _gdEnsureToken() {
  return new Promise((resolve, reject) => {
    // Reuse valid token if we already have one
    if (_gdAccessToken) { resolve(); return; }

    if (!_gdTokenClient) {
      _gdTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GD_CLIENT_ID,
        scope: GD_SCOPE,
        callback: (resp) => {
          if (resp.error) {
            _gdAccessToken = null;
            reject(new Error(resp.error === 'access_denied' ? 'CANCELLED' : resp.error));
          } else {
            _gdAccessToken = resp.access_token;
            // Token expires – clear after expiry so next call re-authenticates
            setTimeout(() => { _gdAccessToken = null; }, (resp.expires_in - 30) * 1000);
            resolve();
          }
        },
        error_callback: (err) => {
          _gdAccessToken = null;
          reject(new Error(err?.type === 'popup_closed' ? 'CANCELLED' : (err?.type || 'OAuth-Fehler')));
        },
      });
    }
    // Set token on gapi client for subsequent REST calls
    _gdTokenClient.callback = (resp) => {
      if (resp.error) {
        _gdAccessToken = null;
        reject(new Error(resp.error === 'access_denied' ? 'CANCELLED' : resp.error));
      } else {
        _gdAccessToken = resp.access_token;
        gapi.client.setToken({ access_token: resp.access_token });
        setTimeout(() => { _gdAccessToken = null; _gdTokenClient = null; }, (resp.expires_in - 30) * 1000);
        resolve();
      }
    };
    gapi.client.setToken(null); // force fresh prompt
    _gdTokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

/** Core sync logic: compare, conflict-resolve, upload or download */
async function _gdRunSync() {
  // 1. Read local DB
  const localPairs = await idbEntries(DB);
  const localData  = localPairs.map(([, v]) => v);
  const localTs    = localData.length
    ? Math.max(...localData.map(a => new Date(a.updatedAt || a.createdAt || 0).getTime()))
    : 0;

  // 2. Search appDataFolder for existing backup
  const listResp = await gapi.client.drive.files.list({
    spaces: 'appDataFolder',
    fields: 'files(id,name,modifiedTime)',
    q: `name='${GD_BACKUP_NAME}'`,
  });
  const files      = listResp.result.files || [];
  const remoteFile = files[0] || null;

  // 3. No remote backup → just upload
  if (!remoteFile) {
    await _gdUpload(null, localData);
    toast('Backup auf Google Drive erstellt ✓', 'success');
    _gdUpdateStatus('synced');
    return;
  }

  // 4. Compare timestamps
  const remoteTs = new Date(remoteFile.modifiedTime).getTime();
  const diffSec  = Math.abs(localTs - remoteTs) / 1000;

  if (diffSec < 5) {
    // Effectively identical – just confirm
    toast('Google Drive Backup ist aktuell ✓', 'success');
    _gdUpdateStatus('synced');
    return;
  }

  if (localTs >= remoteTs) {
    const overwrite = await showConfirm(
      'Lokales Backup ist neuer',
      `Lokal: ${_gdFmtTs(localTs)}\nDrive: ${_gdFmtTs(remoteTs)}\n\nGoogle Drive überschreiben?`,
      'Hochladen'
    );
    if (!overwrite) { toast('Sync abgebrochen.', 'info'); return; }
    await _gdUpload(remoteFile.id, localData);
    toast('Google Drive erfolgreich überschrieben ✓', 'success');
    _gdUpdateStatus('synced');
  } else {
    const download = await showConfirm(
      'Drive-Backup ist neuer',
      `Drive: ${_gdFmtTs(remoteTs)}\nLokal: ${_gdFmtTs(localTs)}\n\nLokale Daten aus Google Drive wiederherstellen?`,
      'Herunterladen'
    );
    if (!download) { toast('Sync abgebrochen.', 'info'); return; }
    await _gdDownloadAndImport(remoteFile.id);
    toast('Lokale Daten aus Google Drive wiederhergestellt ✓', 'success');
    _gdUpdateStatus('synced');
  }
}

/** Upload localData as JSON to appDataFolder; creates or updates the file */
async function _gdUpload(existingFileId, data) {
  const body    = JSON.stringify(data, null, 2);
  const blob    = new Blob([body], { type: 'application/json' });
  const token   = _gdAccessToken;

  if (existingFileId) {
    // PATCH existing file (multipart)
    await _gdMultipartRequest(
      `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`,
      'PATCH', token, {}, blob
    );
  } else {
    // POST new file into appDataFolder
    const meta = { name: GD_BACKUP_NAME, parents: ['appDataFolder'] };
    await _gdMultipartRequest(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      'POST', token, meta, blob
    );
  }
}

/** Download file content and import into IndexedDB */
async function _gdDownloadAndImport(fileId) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${_gdAccessToken}` } }
  );
  if (!resp.ok) throw new Error(`Download fehlgeschlagen: ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error('Ungültiges Backup-Format in Google Drive.');
  await idbClear(DB);
  for (const app of data) await idbSet(app.id, app, DB);
  await loadAll();
}

/** Build and send a multipart/related request (metadata + media) */
async function _gdMultipartRequest(url, method, token, meta, mediaBlob) {
  const boundary = 'jt_boundary_' + Date.now();
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metaPart = `Content-Type: application/json\r\n\r\n${JSON.stringify(meta)}`;
  const mediaPart = `Content-Type: application/json\r\n\r\n`;

  // Combine via ArrayBuffer for binary-safe concatenation
  const enc = new TextEncoder();
  const mediaText = await mediaBlob.text();
  const body = enc.encode(
    delimiter + metaPart +
    delimiter + mediaPart + mediaText +
    closeDelimiter
  );

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** Format a timestamp for confirm dialogs */
function _gdFmtTs(ms) {
  if (!ms) return 'unbekannt';
  return new Date(ms).toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

/** Update the Drive button and status indicator in the Settings UI */
function _gdUpdateBtn(state) {
  const btn = document.getElementById('gd-sync-btn');
  if (!btn) return;
  if (state === 'loading') {
    btn.disabled = true;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:gdSpin .8s linear infinite"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg> Verbinde…`;
  } else {
    btn.disabled = false;
    btn.innerHTML = `Sync`;
  }
}

function _gdUpdateStatus(state) {
  const el = document.getElementById('gd-status');
  if (!el) return;
  if (state === 'synced') {
    el.innerHTML = `<span style="color:#22c55e;font-size:.75rem;font-weight:600;display:flex;align-items:center;gap:4px">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      Zuletzt: ${_gdFmtTs(Date.now())}
    </span>`;
  }
}

function syncToDropbox() { toast('Dropbox Sync – Coming Soon', 'info'); }

// ─── Share Target ─────────────────────────────────────────────────────────────
function handleShareTarget() {
  const p = new URLSearchParams(location.search);
  const url = p.get('url') || p.get('text');
  const action = p.get('action');
  if (url) {
    navigate('applications');
    openForm();
    setTimeout(() => { document.getElementById('f-platform').value = url; }, 200);
  }
  if (action === 'new') {
    navigate('applications');
    setTimeout(() => openForm(), 300);
  }
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeForm(); closeDetail(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); navigate('applications'); openForm(); }
});

// ─── Close popover on outside click ──────────────────────────────────────────
document.addEventListener('click', e => {
  if (!e.target.closest('.sort-popover') && !e.target.closest('.kanban-sort-btn')) {
    document.querySelectorAll('.sort-popover').forEach(p => p.remove());
  }
});

// ─── Prevent Pull-to-Refresh (iOS PWA + Chrome Android) ──────────────────────
let _startY = 0;
document.addEventListener('touchstart', e => { _startY = e.touches[0].pageY; }, { passive: true });
document.addEventListener('touchmove', e => {
  // Block pull-down only when at the very top and not inside a scrollable child
  if (window.scrollY === 0 && e.touches[0].pageY > _startY) {
    const target = e.target.closest('.modal-body, .table-scroll, .kanban-col-body, .app-list');
    if (!target) e.preventDefault();
  }
}, { passive: false });

function updateWeeklyGoal(n) {
  State.settings.weeklyGoal = Math.max(1, Math.min(50, Number(n) || 5));
  saveSettings();
  if (document.getElementById('page-dashboard')?.classList.contains('active')) renderDashboard();
}

// ─── applyQuickStatus also fires push ─────────────────────────────────────────
async function applyQuickStatus(id, newStatus) {
  document.querySelectorAll('.status-popover').forEach(p => p.remove());
  const app = State.all.find(a => a.id === id);
  if (!app || app.status === newStatus) return;
  const oldStatus = app.status;
  app.status  = newStatus;
  app.history = [...(app.history || []), { status: newStatus, timestamp: nowISO() }];
  if (oldStatus !== newStatus) schedulePushIfEnabled(app, newStatus);
  await saveApp(app);
  toast(`Status → ${newStatus}`, 'success');
  if (!document.getElementById('detail-modal').classList.contains('hidden')) {
    openDetail(id);
  }
}
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
});

function showInstallBanner() {
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  if (localStorage.getItem('jt-install-dismissed')) return;
  const el = document.getElementById('install-banner');
  if (el) { el.classList.remove('hidden'); el.classList.add('visible'); }
}

async function triggerInstall() {
  if (_deferredInstallPrompt) {
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    _deferredInstallPrompt = null;
    dismissInstallBanner();
    if (outcome === 'accepted') toast('App installiert ✓', 'success');
  }
}

function dismissInstallBanner() {
  localStorage.setItem('jt-install-dismissed', '1');
  const el = document.getElementById('install-banner');
  if (el) { el.classList.remove('visible'); setTimeout(() => el.classList.add('hidden'), 400); }
}

// Show install modal once on first ever visit (not standalone, not already dismissed)
function _maybeShowInstallModal() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                    || window.navigator.standalone === true;
  if (isStandalone) return;
  if (localStorage.getItem('jt-install-dismissed')) return;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  // On iOS: show instruction modal directly (no beforeinstallprompt available)
  if (isIOS) {
    setTimeout(() => showModal('ios-install-modal'), 1800);
    return;
  }

  // On Android/Chrome: show banner once beforeinstallprompt fires (or after delay)
  const showBanner = () => {
    if (!localStorage.getItem('jt-install-dismissed')) showInstallBanner();
  };
  if (_deferredInstallPrompt) {
    showBanner();
  } else {
    window.addEventListener('beforeinstallprompt', showBanner, { once: true });
  }
}

function dismissInstallModal() {
  localStorage.setItem('jt-install-dismissed', '1');
  hideModal('ios-install-modal');
}

// ─── Virtual Keyboard: scroll focused input into view ─────────────────────────
// On iOS/Android the virtual keyboard shrinks the viewport but doesn't fire resize.
// visualViewport API lets us react and scroll the focused element above the keyboard.
if (window.visualViewport) {
  let _kvLast = window.visualViewport.height;
  window.visualViewport.addEventListener('resize', () => {
    const vvh = window.visualViewport.height;
    const el  = document.activeElement;
    if (!el || !['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;

    // Keyboard opened (viewport shrank)
    if (vvh < _kvLast - 50) {
      // Give browser time to reflow, then scroll input into center of visible area
      setTimeout(() => {
        const rect = el.getBoundingClientRect();
        const modalBody = el.closest('.modal-body');
        if (modalBody) {
          // Scroll within modal-body so input is visible above keyboard
          const bodyRect  = modalBody.getBoundingClientRect();
          const inputBot  = rect.bottom - bodyRect.top;
          const visible   = vvh - bodyRect.top - 16; // 16px breathing room
          if (inputBot > visible) {
            modalBody.scrollTop += inputBot - visible + 24;
          }
        } else {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 120);
    }
    _kvLast = vvh;
  });

  // Also scroll on focus (handles case where keyboard is already open)
  document.addEventListener('focusin', e => {
    const el = e.target;
    if (!['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;
    if (window.visualViewport.height < window.innerHeight * 0.75) {
      // Keyboard is likely open
      setTimeout(() => {
        const rect = el.getBoundingClientRect();
        const modalBody = el.closest('.modal-body');
        if (modalBody) {
          const bodyRect = modalBody.getBoundingClientRect();
          const inputBot = rect.bottom - bodyRect.top;
          const visible  = window.visualViewport.height - bodyRect.top - 16;
          if (inputBot > visible) {
            modalBody.scrollTop += inputBot - visible + 24;
          }
        }
      }, 80);
    }
  });
}

// ─── Service Worker ───────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  applyTheme(State.theme);
  injectStatusStyles();
  renderStatusSelectOptions();
  await idbReady; // sicherstellen, dass alle IndexedDB-Stores angelegt sind, bevor sie genutzt werden
  await loadAll();
  await loadEvents();
  navigate('dashboard');
  await checkPersistence();
  handleShareTarget();
  renderSettingsNotifications();
  renderStatusSettings();
  lucide.createIcons();
  // Show install prompt once on first visit
  setTimeout(_maybeShowInstallModal, 1500);
  // Stale reminder check
  checkStaleReminders();
  checkManualReminders();
  checkWeeklySummary();
  setInterval(checkStaleReminders, 60 * 60 * 1000);
  setInterval(checkManualReminders, 60 * 60 * 1000);
})();
