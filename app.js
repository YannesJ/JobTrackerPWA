/*
 * Copyright 2026 Yannes Jabboury. Alle Rechte vorbehalten. All rights reserved.
 */

'use strict';

// ─── idb-keyval Store ─────────────────────────────────────────────────────────
const { createStore, get: idbGet, set: idbSet, del: idbDel,
        entries: idbEntries, clear: idbClear } = idbKeyval;

// idb-keyval's createStore() opens its DB lazily and independently per store, with no
// explicit version number. When several stores share one DB name, only whichever store
// happens to be used FIRST actually gets its object store created - IndexedDB no-ops
// onupgradeneeded on every later open() that doesn't request a version bump, so any
// object store added afterwards silently fails ("object store was not found") the first
// time it's used. All object stores this app needs must therefore be created together,
// in one upgrade pass, before any of the createStore() instances below are first used.
// Version must be bumped whenever a store is added - existing users' DBs are
// already sitting at whatever version they were first created with, and
// indexedDB.open() only fires onupgradeneeded when the requested version is
// HIGHER than the current one. Opening at the same version again (e.g. "1"
// forever) silently skips existing installs, leaving new stores missing for
// them specifically - this bumped version 1→2 is what actually back-fills
// 'events' (and 'reminders', for anyone the original bug affected) for
// people who used the app before this store existed.
const IDB_VERSION = 2;
const IDB_STORE_NAMES = ['applications', 'reminders', 'events'];
const idbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('jobtracker', IDB_VERSION);
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
// `kind` sagt der Statistik (Dashboard), wie eine - ggf. umbenannte oder frei
// erfundene - Kategorie zu zählen ist, unabhängig vom (änderbaren) Namen.
const STATUS_KINDS = [
  { key: 'open',      label: 'Offen' },
  { key: 'interview', label: 'Interview' },
  { key: 'accepted',  label: 'Zusage' },
  { key: 'rejected',  label: 'Absage' },
  { key: 'other',     label: 'Neutral' },
];
const DEFAULT_STATUSES = [
  { name: 'Offen',     color: '#3b82f6', kind: 'open' },
  { name: 'Interview', color: '#f59e0b', kind: 'interview' },
  { name: 'Absage',    color: '#ef4444', kind: 'rejected' },
  { name: 'Zusage',    color: '#22c55e', kind: 'accepted' },
];
// Für Alt-Daten ohne `kind` (vor diesem Feature gespeichert): an einem der
// Standardnamen erkennen, sonst neutral - besser als eine falsche Statistik.
function _inferStatusKind(name) {
  return DEFAULT_STATUSES.find(s => s.name === name)?.kind || 'other';
}
// Normalisiert einen (z.B. aus localStorage oder einem JSON-/CSV-Import stammenden)
// Statuskatalog auf ein sicheres Format: gültiger Name, gültige Hex-Farbe, gültiges
// Zähl-Kind - jeweils mit Fallback statt fehlerhafte/fehlende Werte durchzureichen.
function sanitizeStatuses(list) {
  return list
    .filter(s => s && typeof s.name === 'string' && s.name.trim())
    .map(s => ({
      name:  s.name.trim(),
      color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : (DEFAULT_STATUSES.find(d => d.name === s.name)?.color || '#8888a8'),
      kind:  STATUS_KINDS.some(k => k.key === s.kind) ? s.kind : _inferStatusKind(s.name),
    }));
}
function loadStatuses() {
  try {
    const stored = JSON.parse(localStorage.getItem('jt-statuses') || 'null');
    if (Array.isArray(stored) && stored.length) return sanitizeStatuses(stored);
  } catch { /* ignore malformed data */ }
  return DEFAULT_STATUSES.map(s => ({ ...s }));
}
function saveStatuses() {
  localStorage.setItem('jt-statuses', JSON.stringify(State.statuses));
}
function getStatusKind(name) {
  return State.statuses.find(s => s.name === name)?.kind || 'other';
}
function updateStatusKind(idx, kind) {
  const s = State.statuses[idx];
  if (!s || !STATUS_KINDS.some(k => k.key === kind)) return;
  s.kind = kind;
  saveStatuses();
  if (document.getElementById('page-dashboard')?.classList.contains('active')) renderDashboard();
}
function getStatusColor(name) {
  return State.statuses.find(s => s.name === name)?.color || '#8888a8';
}
// Status-Filter: welche Status-Kategorien im Tabellen-/Kanban-Filter ausgeblendet
// sind. Gespeichert werden nur die ausgeblendeten Namen (nicht die sichtbaren),
// damit neu angelegte Kategorien automatisch sichtbar bleiben.
function loadStatusFilterHidden() {
  try {
    const stored = JSON.parse(localStorage.getItem('jt-status-filter-hidden') || 'null');
    if (Array.isArray(stored)) return new Set(stored);
  } catch { /* ignore malformed data */ }
  return new Set();
}
function saveStatusFilterHidden() {
  localStorage.setItem('jt-status-filter-hidden', JSON.stringify([...State.statusFilterHidden]));
}
// Index der Kategorie in State.statuses - dient als stabiler CSS-Hook (s-<i>).
// Unbekannte/gelöschte Status fallen auf Slot 0 zurück, statt die Anzeige zu brechen.
function statusSlot(name) {
  const idx = State.statuses.findIndex(s => s.name === name);
  return idx >= 0 ? idx : 0;
}

// ─── Tabellenspalten (Bewerbungen-Ansicht) ─────────────────────────────────────
// Muss vor `State` stehen, da State.tableColumns beim Erstellen bereits
// loadTableColumns() aufruft. Firma und die Aktionen-Spalte bleiben fest sichtbar;
// alles hier ist per Klick auf den "Spalten"-Button ein-/ausblendbar. Notizen ist
// neu und startet standardmäßig aus, damit sich die Tabelle für Bestandsnutzer
// nicht plötzlich anders anfühlt.
const TABLE_COLUMNS = [
  { key: 'position',        label: 'Position' },
  { key: 'status',          label: 'Status' },
  { key: 'source',          label: 'Quelle' },
  { key: 'applicationDate', label: 'Datum' },
  { key: 'expectedSalary',  label: 'Gehalt' },
  { key: 'priority',        label: 'Priorität' },
  { key: 'notes',           label: 'Notizen' },
  { key: 'nextEvent',       label: 'Nächster Termin' },
];
const DEFAULT_TABLE_COLUMNS = {
  position: true, status: true, source: true, applicationDate: true,
  expectedSalary: true, priority: false, notes: false, nextEvent: false,
};
function loadTableColumns() {
  try {
    const stored = JSON.parse(localStorage.getItem('jt-table-columns') || 'null');
    if (stored && typeof stored === 'object') return { ...DEFAULT_TABLE_COLUMNS, ...stored };
  } catch { /* ignore malformed data */ }
  return { ...DEFAULT_TABLE_COLUMNS };
}
function saveTableColumns() {
  localStorage.setItem('jt-table-columns', JSON.stringify(State.tableColumns));
}
function toggleTableColumn(key) {
  State.tableColumns[key] = !State.tableColumns[key];
  saveTableColumns();
  applyTableColumnVisibility();
  // Die mobile Kartenliste liest State.tableColumns direkt beim Rendern (keine
  // CSS-Attribut-Abkürzung wie bei der Desktop-Tabelle) - braucht daher ein Re-Render.
  if (window.matchMedia('(max-width: 640px)').matches) renderTable();
}
// Setzt die versteckten Spalten als ein Attribut auf .table-wrap statt pro Zelle
// einzeln zu toggeln - eine CSS-Regel pro Spalte (siehe app.css) reicht damit aus.
function applyTableColumnVisibility() {
  const wrap = document.querySelector('.table-wrap');
  if (!wrap) return;
  wrap.dataset.hideCols = TABLE_COLUMNS.filter(c => !State.tableColumns[c.key]).map(c => c.key).join(' ');
}

// ─── Kanban-Karten-Felder (Bewerbungen-Ansicht) ────────────────────────────────
// Analog zu TABLE_COLUMNS: Firma, Position und der Status-Button bleiben fest auf
// jeder Karte sichtbar, alles hier ist per "Karten"-Button ein-/ausblendbar.
// "source" ist neu (stand vorher nie auf der Karte) und startet daher aus.
const KANBAN_CARD_FIELDS = [
  { key: 'source',   label: 'Quelle' },
  { key: 'date',     label: 'Datum' },
  { key: 'salary',   label: 'Gehalt' },
  { key: 'priority', label: 'Priorität' },
  { key: 'contact',  label: 'Ansprechpartner' },
  { key: 'note',     label: 'Notiz-Vorschau' },
  { key: 'events',   label: 'Ereigniszähler' },
];
const DEFAULT_KANBAN_CARD_FIELDS = {
  source: false, date: true, salary: true, priority: true,
  contact: true, note: true, events: true,
};
function loadKanbanCardFields() {
  try {
    const stored = JSON.parse(localStorage.getItem('jt-kanban-fields') || 'null');
    if (stored && typeof stored === 'object') return { ...DEFAULT_KANBAN_CARD_FIELDS, ...stored };
  } catch { /* ignore malformed data */ }
  return { ...DEFAULT_KANBAN_CARD_FIELDS };
}
function saveKanbanCardFields() {
  localStorage.setItem('jt-kanban-fields', JSON.stringify(State.kanbanCardFields));
}
function toggleKanbanCardField(key) {
  State.kanbanCardFields[key] = !State.kanbanCardFields[key];
  saveKanbanCardFields();
  renderKanban();
}
function toggleKanbanFieldsMenu(e) {
  e.stopPropagation();
  document.querySelectorAll('.columns-popover').forEach(p => p.remove());

  const popover = document.createElement('div');
  popover.className = 'columns-popover';
  popover.innerHTML = `
    <div class="columns-popover-title">Karteninfos anzeigen</div>
    ${KANBAN_CARD_FIELDS.map(c => `
      <label class="columns-popover-item">
        <input type="checkbox" ${State.kanbanCardFields[c.key] ? 'checked' : ''} onchange="toggleKanbanCardField('${c.key}')" />
        ${escHtml(c.label)}
      </label>
    `).join('')}
  `;

  const btn  = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  popover.style.position   = 'fixed';
  popover.style.visibility = 'hidden';
  document.body.appendChild(popover);

  const popRect    = popover.getBoundingClientRect();
  const margin     = 8;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpward = spaceBelow < popRect.height + margin && rect.top > popRect.height + margin;
  const left = Math.min(Math.max(rect.right - popRect.width, margin), window.innerWidth - popRect.width - margin);
  popover.style.left       = `${left}px`;
  popover.style.top        = `${openUpward ? rect.top - popRect.height - 4 : rect.bottom + 4}px`;
  popover.style.visibility = '';

  setTimeout(() => {
    const cleanup = () => {
      popover.remove();
      document.removeEventListener('click', onDocClick, true);
      window.removeEventListener('scroll', cleanup, true);
      window.removeEventListener('resize', cleanup);
    };
    const onDocClick = (ev) => {
      if (btn.contains(ev.target) || popover.contains(ev.target)) return;
      cleanup();
    };
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', cleanup, true);
    window.addEventListener('resize', cleanup);
  }, 0);
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
// Befüllt Status-<select>-Elemente (Formular) mit den aktuellen Kategorien und
// aktualisiert den Status-Filter-Button (Mehrfachauswahl, siehe toggleStatusFilterMenu).
function renderStatusSelectOptions() {
  const optsHtml = State.statuses.map(s => `<option value="${escAttr(s.name)}">${escHtml(s.name)}</option>`).join('');

  const formSel = document.getElementById('f-status');
  if (formSel) {
    const prev = formSel.value;
    formSel.innerHTML = optsHtml;
    formSel.value = State.statuses.some(s => s.name === prev) ? prev : (State.statuses[0]?.name || '');
  }

  // Ausgeblendete Kategorien, die es nicht mehr gibt (gelöscht/umbenannt), entfernen
  const validNames = new Set(State.statuses.map(s => s.name));
  let changed = false;
  for (const hidden of [...State.statusFilterHidden]) {
    if (!validNames.has(hidden)) { State.statusFilterHidden.delete(hidden); changed = true; }
  }
  if (changed) saveStatusFilterHidden();

  updateStatusFilterLabel();
}

function updateStatusFilterLabel() {
  const label = document.getElementById('filter-status-label');
  const btn   = document.getElementById('filter-status-btn');
  if (!label || !btn) return;

  const total   = State.statuses.length;
  const visible = State.statuses.filter(s => !State.statusFilterHidden.has(s.name));
  const hiddenCount = total - visible.length;

  if (hiddenCount === 0) label.textContent = 'Alle Status';
  else if (visible.length === 0) label.textContent = 'Kein Status';
  else if (visible.length <= 2) label.textContent = visible.map(s => s.name).join(', ');
  else label.textContent = `${visible.length} von ${total} Status`;

  btn.classList.toggle('active', hiddenCount > 0);
}

// ─── Status-Filter (Mehrfachauswahl, Popover) ──────────────────────────────────
function toggleStatusFilterOption(name) {
  if (State.statusFilterHidden.has(name)) State.statusFilterHidden.delete(name);
  else State.statusFilterHidden.add(name);
  saveStatusFilterHidden();
  updateStatusFilterLabel();
  applyFilters();
}

function setAllStatusFilters(showAll) {
  State.statusFilterHidden = showAll ? new Set() : new Set(State.statuses.map(s => s.name));
  saveStatusFilterHidden();
  updateStatusFilterLabel();
  applyFilters();
  document.querySelectorAll('.status-filter-popover').forEach(p => p.remove());
}

function toggleStatusFilterMenu(e) {
  e.stopPropagation();
  document.querySelectorAll('.status-filter-popover').forEach(p => p.remove());

  const popover = document.createElement('div');
  popover.className = 'columns-popover status-filter-popover';
  popover.innerHTML = `
    <div class="columns-popover-title" style="display:flex;align-items:center;justify-content:space-between">
      <span>Status anzeigen</span>
      <button type="button" class="btn btn-ghost btn-xs" style="text-transform:none;letter-spacing:0;font-weight:600" onclick="setAllStatusFilters(${State.statusFilterHidden.size > 0})">${State.statusFilterHidden.size > 0 ? 'Alle' : 'Keine'}</button>
    </div>
    ${State.statuses.map(s => `
      <label class="columns-popover-item">
        <input type="checkbox" ${State.statusFilterHidden.has(s.name) ? '' : 'checked'} onchange="toggleStatusFilterOption('${escJs(s.name)}')" />
        ${escHtml(s.name)}
      </label>
    `).join('')}
  `;

  // Fixed-positioniert & an <body> gehängt (wie beim Spalten-Popover), rechtsbündig
  // zum Button, damit es bei einem rechts sitzenden Button nicht rechts abgeschnitten wird.
  const btn  = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  popover.style.position   = 'fixed';
  popover.style.visibility = 'hidden';
  document.body.appendChild(popover);

  const popRect    = popover.getBoundingClientRect();
  const margin     = 8;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpward = spaceBelow < popRect.height + margin && rect.top > popRect.height + margin;
  const left = Math.min(Math.max(rect.left, margin), window.innerWidth - popRect.width - margin);
  popover.style.left       = `${left}px`;
  popover.style.top        = `${openUpward ? rect.top - popRect.height - 4 : rect.bottom + 4}px`;
  popover.style.visibility = '';

  setTimeout(() => {
    const cleanup = () => {
      popover.remove();
      document.removeEventListener('click', onDocClick, true);
      window.removeEventListener('scroll', cleanup, true);
      window.removeEventListener('resize', cleanup);
    };
    const onDocClick = (ev) => {
      if (btn.contains(ev.target) || popover.contains(ev.target)) return;
      cleanup();
    };
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', cleanup, true);
    window.addEventListener('resize', cleanup);
  }, 0);
}

// ─── App State ────────────────────────────────────────────────────────────────
const State = {
  all:     [],
  filtered:[],
  view:    'table',
  sort:    { col: 'applicationDate', dir: 'desc' },
  // Sortierung je Kanban-Spalte (Datum/Firma/... oder 'custom' nach Drag&Drop-Umsortierung)
  kanbanSort: loadKanbanSort(),
  theme:  localStorage.getItem('jt-theme') || 'light',
  skin:   localStorage.getItem('jt-skin') || 'neon',
  salaryBlur: localStorage.getItem('jt-salary-blur') === '1',
  // Persisted settings
  settings: loadSettings(),
  // Individuell konfigurierbare Status-Kategorien
  statuses: loadStatuses(),
  // Im Status-Filter (Tabelle/Kanban) ausgeblendete Kategorien
  statusFilterHidden: loadStatusFilterHidden(),
  // Welche optionalen Tabellenspalten sichtbar sind
  tableColumns: loadTableColumns(),
  // Welche optionalen Infos auf Kanban-Karten sichtbar sind
  kanbanCardFields: loadKanbanCardFields(),
  // Kalender-Termine
  events: [],
  calendarMonth: (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })(),
};

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem('jt-settings') || 'null');
    const defaults = {
      weeklyGoal:   5,
      pushEnabled:  false,   // master toggle - default OFF
      badgeEnabled: false,   // app badge - default OFF
      weeklySummary: false,  // weekly digest - default OFF
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

// Kanban-Sortierung je Statusspalte: { col, dir } für eine Sortierspalte, oder
// { col:'custom', dir:'asc', order:[id,...] } nach manuellem Umsortieren per
// Drag&Drop innerhalb einer Spalte (siehe _applyKanbanDrop()).
function loadKanbanSort() {
  try {
    const stored = JSON.parse(localStorage.getItem('jt-kanban-sort') || 'null');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
  } catch { /* ignore malformed data */ }
  return {};
}
function saveKanbanSort() {
  localStorage.setItem('jt-kanban-sort', JSON.stringify(State.kanbanSort));
}
// Normalisiert einen (aus einem JSON-/CSV-Import stammenden) Kanban-Sortierkatalog:
// nur Einträge mit gültigem Statusnamen/Spalte behalten, `order` (falls vorhanden)
// auf ein Array von String-IDs beschränkt.
function sanitizeKanbanSort(obj) {
  const out = {};
  for (const [status, ks] of Object.entries(obj || {})) {
    if (!status || !ks || typeof ks.col !== 'string') continue;
    const entry = { col: ks.col, dir: ks.dir === 'desc' ? 'desc' : 'asc' };
    if (ks.col === 'custom') entry.order = Array.isArray(ks.order) ? ks.order.filter(id => typeof id === 'string') : [];
    out[status] = entry;
  }
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uuid() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}
function nowISO()  { return new Date().toISOString(); }
// YYYY-MM-DD aus den LOKALEN Datumsfeldern - anders als toISOString() (UTC-basiert)
// verschiebt das den Tag nicht in Zeitzonen abseits von UTC (z.B. Kalender-Zellen).
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '-';
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
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit' });
}
function fmtEuro(n) {
  if (!n) return '-';
  return new Intl.NumberFormat('de-DE', { style:'currency', currency:'EUR', maximumFractionDigits:0 }).format(n);
}
function fmtEuroShort(n) {
  if (!n) return '-';
  if (n >= 1000) return (n/1000).toFixed(0) + 'k €';
  return n + ' €';
}
const STAR_ICON_PATH = 'M12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2';
/** 1-3 Sterne als Markup, gefüllt bis n. Leer/0/null -> '', außer alwaysShow ist
    gesetzt (Detailansicht: Priorität dort immer als setzbare Bewertung erkennbar,
    auch unbefüllt - Tabelle/Kanban sollen dagegen nur befüllte Werte zeigen).
    Mit id werden die Sterne klickbar (Detailansicht: Priorität per Klick setzen). */
function starsHTML(n, size = 12, alwaysShow = false, id = null) {
  n = Number(n) || 0;
  if (!n && !alwaysShow) return '';
  let out = '';
  for (let i = 1; i <= 3; i++) {
    const on  = i <= n;
    const svg = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${on ? '#f59e0b' : 'none'}" stroke="${on ? '#f59e0b' : 'var(--text-muted)'}" stroke-width="2"><path d="${STAR_ICON_PATH}Z"/></svg>`;
    out += id
      ? `<button type="button" class="priority-star-btn" onclick="event.stopPropagation();setPriority('${escJs(id)}',${i})" title="Priorität ${i}/3 setzen" aria-label="Priorität ${i}/3 setzen">${svg}</button>`
      : svg;
  }
  return `<span class="priority-stars" title="Priorität: ${n}/3">${out}</span>`;
}
/** Priorität per Sternklick setzen (Detailansicht) - Klick auf den bereits
    aktiven höchsten Stern setzt zurück auf 0. */
async function setPriority(id, n) {
  const a = State.all.find(x => x.id === id);
  if (!a) return;
  a.priority = (a.priority === n) ? 0 : n;
  await saveApp(a);
  if (!document.getElementById('detail-modal').classList.contains('hidden')) openDetail(id);
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
// `opts.actionLabel` + `opts.onAction` add a clickable action (z.B. "Rückgängig")
// to the toast; clicking it cancels the auto-dismiss and runs the callback.
function toast(msg, type = 'info', opts = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = msg;
  el.appendChild(text);

  const dismiss = () => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 280);
  };

  if (opts.actionLabel && opts.onAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    btn.onclick = () => { clearTimeout(timer); opts.onAction(); dismiss(); };
    el.appendChild(btn);
  }

  root.appendChild(el);
  const timer = setTimeout(dismiss, opts.actionLabel ? 5000 : 2800);
}

// ─── Theme ────────────────────────────────────────────────────────────────────
const SVG_SUN  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const SVG_MOON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SVG_MONITOR = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
const SVG_EYE     = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const SVG_EYE_OFF = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a20.3 20.3 0 0 1 4.22-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a20.3 20.3 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// ─── Sidebar collapse (desktop) ─────────────────────────────────────────────────
function toggleSidebar() {
  const collapsed = document.getElementById('app').classList.toggle('sidebar-collapsed');
  localStorage.setItem('jt-sidebar-collapsed', collapsed ? '1' : '0');
}

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
    b.style.color         = isActive ? 'var(--text-on-accent)' : '';
    b.style.borderColor   = isActive ? 'var(--accent)'      : '';
    b.style.boxShadow     = isActive ? '0 2px 8px rgb(var(--accent-rgb)/.35)' : '';
  });

  // Redraw charts if dashboard visible
  if (document.getElementById('page-dashboard')?.classList.contains('active')) {
    renderCharts();
  }
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (State.theme === 'system') applyTheme('system');
});

// ─── Skin (Farbschema-Stil, unabhängig von Hell/Dunkel) ────────────────────────
// Neue Stile: hier einen Eintrag ergänzen + passenden [data-skin="…"]-Block in app.css.
const SKINS = [
  { key: 'original', label: 'Original' },
  { key: 'neon',     label: 'Neon' },
];
function renderSkinButtons() {
  const el = document.getElementById('skin-settings-buttons');
  if (!el) return;
  el.innerHTML = SKINS.map(s => `
    <button data-skin-btn="${s.key}" class="btn btn-ghost btn-sm" onclick="applySkin('${s.key}')">${escHtml(s.label)}</button>
  `).join('');
  document.querySelectorAll('[data-skin-btn]').forEach(b => {
    const isActive = b.dataset.skinBtn === State.skin;
    b.style.background  = isActive ? 'var(--accent)'         : '';
    b.style.color        = isActive ? 'var(--text-on-accent)' : '';
    b.style.borderColor  = isActive ? 'var(--accent)'         : '';
  });
}
function applySkin(skin) {
  if (!SKINS.some(s => s.key === skin)) skin = SKINS[0].key;
  State.skin = skin;
  localStorage.setItem('jt-skin', skin);
  document.documentElement.setAttribute('data-skin', skin);

  document.querySelectorAll('[data-skin-btn]').forEach(b => {
    const isActive = b.dataset.skinBtn === skin;
    b.style.background  = isActive ? 'var(--accent)'         : '';
    b.style.color        = isActive ? 'var(--text-on-accent)' : '';
    b.style.borderColor  = isActive ? 'var(--accent)'         : '';
  });

  if (document.getElementById('page-dashboard')?.classList.contains('active')) {
    renderCharts();
  }
}

// ─── Gehalts-Sichtschutz ────────────────────────────────────────────────────────
// Blendet alle Gehaltsangaben (.jt-money) per CSS-Filter aus, z.B. um die
// Bewerbungsliste vor anderen zu zeigen, ohne das eigene Wunschgehalt preiszugeben.
function applySalaryBlur(active) {
  State.salaryBlur = active;
  localStorage.setItem('jt-salary-blur', active ? '1' : '0');
  document.documentElement.classList.toggle('blur-salary', active);
  document.querySelectorAll('[data-salary-blur-btn]').forEach(b => {
    const iconOnly = b.dataset.salaryBlurBtn === 'icon';
    const icon = active ? SVG_EYE_OFF : SVG_EYE;
    b.innerHTML = iconOnly ? icon : `${icon} ${active ? 'Gehalt einblenden' : 'Gehalt verbergen'}`;
    b.title = active ? 'Gehaltsangaben einblenden' : 'Gehaltsangaben vor Blicken schützen';
    if (iconOnly) b.setAttribute('aria-label', b.title);
    b.classList.toggle('active', active);
  });
}
function toggleSalaryBlur() {
  applySalaryBlur(!State.salaryBlur);
}

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

// ─── Demo-Daten für neue, leere Installationen ─────────────────────────────────
// Läuft nur EIN einziges Mal überhaupt, gesteuert über das jt-demo-seeded-Flag,
// und schreibt nur, wenn zu diesem Zeitpunkt noch gar keine Bewerbung existiert.
// Bestehende Nutzer mit eigenen Daten sind dadurch sicher, und zwar dauerhaft:
// Das Flag wird gesetzt, BEVOR geprüft wird ob leer geschrieben werden darf - ein
// späteres Leeren der Liste (z.B. "Alle Daten löschen") lässt die Demo-Daten also
// nicht wieder auftauchen, weil dieser Check dann schon "erledigt" ist.
async function maybeSeedDemoData() {
  if (localStorage.getItem('jt-demo-seeded')) return;
  localStorage.setItem('jt-demo-seeded', '1');
  if (State.all.length > 0) return;

  const daysAgo    = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return localDateStr(d); };
  const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };
  const demoNote   = 'Demo-Eintrag - kann jederzeit gelöscht werden.';

  const demoApps = [
    {
      id: uuid(), company: 'Blaupause Software GmbH', position: 'Frontend Developer (React)',
      status: 'Interview', source: 'LinkedIn', expectedSalary: 62000,
      applicationDate: daysAgo(21), platformLink: '', documentLink: '', rejectionReason: '',
      contactName: '', contactPhone: '', contactEmail: '', notes: demoNote,
      history: [
        { status: 'Offen',     timestamp: isoDaysAgo(21) },
        { status: 'Interview', timestamp: isoDaysAgo(9), note: 'Erstes Gespräch mit dem Tech-Lead, sehr angenehm.' },
      ],
      createdAt: isoDaysAgo(21), updatedAt: isoDaysAgo(9),
    },
    {
      id: uuid(), company: 'Nordwind Logistik AG', position: 'Werkstudent Logistik & Disposition',
      status: 'Offen', source: 'Indeed', expectedSalary: null,
      applicationDate: daysAgo(6), platformLink: '', documentLink: '', rejectionReason: '',
      contactName: '', contactPhone: '', contactEmail: '', notes: demoNote,
      history: [{ status: 'Offen', timestamp: isoDaysAgo(6) }],
      createdAt: isoDaysAgo(6), updatedAt: isoDaysAgo(6),
    },
    {
      id: uuid(), company: 'Havelperle Consulting', position: 'Junior Consultant',
      status: 'Absage', source: 'StepStone', expectedSalary: 48000,
      applicationDate: daysAgo(48), platformLink: '', documentLink: '', rejectionReason: 'Stelle wurde intern besetzt',
      contactName: '', contactPhone: '', contactEmail: '', notes: demoNote,
      history: [
        { status: 'Offen',     timestamp: isoDaysAgo(48) },
        { status: 'Interview', timestamp: isoDaysAgo(35) },
        { status: 'Absage',    timestamp: isoDaysAgo(24), note: 'Absage per E-Mail erhalten.' },
      ],
      createdAt: isoDaysAgo(48), updatedAt: isoDaysAgo(24),
    },
    {
      id: uuid(), company: 'Rheinbogen Technik GmbH', position: 'Ausbildung Fachinformatiker Anwendungsentwicklung',
      status: 'Zusage', source: 'Empfehlung', expectedSalary: null,
      applicationDate: daysAgo(70), platformLink: '', documentLink: '', rejectionReason: '',
      contactName: 'Frau Keller (Personalabteilung)', contactPhone: '', contactEmail: '', notes: demoNote,
      history: [
        { status: 'Offen',     timestamp: isoDaysAgo(70) },
        { status: 'Interview', timestamp: isoDaysAgo(55) },
        { status: 'Zusage',    timestamp: isoDaysAgo(40), note: 'Vertrag unterschrieben, Start im September.' },
      ],
      createdAt: isoDaysAgo(70), updatedAt: isoDaysAgo(40),
    },
  ];

  for (const app of demoApps) await idbSet(app.id, app, DB);
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

/** Nächster anstehender Termin (heute oder später) zu einer Bewerbung, sonst null. */
function nextEventForApp(appId) {
  const todayStr = localDateStr(new Date());
  const upcoming = State.events
    .filter(e => e.appId === appId && e.date >= todayStr)
    .sort((a, b) => `${a.date} ${a.time || '99:99'}`.localeCompare(`${b.date} ${b.time || '99:99'}`));
  return upcoming[0] || null;
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
  if (tab === 'settings')   { renderSettingsNotifications(); renderStatusSettings(); renderSkinButtons(); checkBackupReminder(); }
  if (tab === 'jobsearch')   _jsRestorePortalSelection();
  lucide.createIcons();
}

// ─── Filters & Sort ───────────────────────────────────────────────────────────
function applyFilters() {
  const search = document.getElementById('filter-search')?.value?.toLowerCase() || '';
  const source = document.getElementById('filter-source')?.value || '';

  State.filtered = State.all.filter(a => {
    if (State.statusFilterHidden.has(a.status)) return false;
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
    if (col === 'expectedSalary' || col === 'priority') { va = Number(va) || 0; vb = Number(vb) || 0; }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

function sortKanbanCol(status, col, dir) {
  if (col === 'custom') {
    // Beim manuellen Umschalten auf "Eigene Reihenfolge" die aktuell angezeigte
    // Reihenfolge als Ausgangspunkt übernehmen, statt die Karten springen zu lassen.
    const order = sortAppsForKanban(State.filtered.filter(a => a.status === status), status).map(a => a.id);
    State.kanbanSort[status] = { col: 'custom', dir: 'asc', order };
  } else {
    State.kanbanSort[status] = { col, dir };
  }
  saveKanbanSort();
  // Close any open popover
  document.querySelectorAll('.sort-popover').forEach(p => p.remove());
  renderView();
}

function sortAppsForKanban(apps, status) {
  const ks = State.kanbanSort[status] || { col: 'applicationDate', dir: 'desc' };
  if (ks.col === 'custom') {
    const order = ks.order || [];
    // Karten ohne (noch) bekannte Position - z.B. neu angelegt oder frisch in diese
    // Spalte verschoben - landen stabil ans Ende, in ihrer bisherigen Reihenfolge.
    return [...apps].sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }
  const { col, dir } = ks;
  return [...apps].sort((a, b) => {
    let va = a[col] ?? '', vb = b[col] ?? '';
    if (col === 'applicationDate') { va = new Date(va); vb = new Date(vb); }
    if (col === 'expectedSalary' || col === 'priority') { va = Number(va) || 0; vb = Number(vb) || 0; }
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
let _kanbanDropIndex = null; // Einfüge-Index (unter Karten der Zielspalte), von der Drop-Anzeige
let _kanbanDropIndicatorEl = null;

function onDragStart(e, id) {
  dragId = id;
  e.target.closest('.kanban-card')?.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
  _updateKanbanDropIndicator(e.currentTarget, e.clientY);
}
function onDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}
async function onDrop(e, newStatus) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (!dragId) return;
  await _applyKanbanDrop(dragId, newStatus, _kanbanDropIndex);
}
// Läuft nach onDrop (bei erfolgreichem Ablegen) ODER als einzige Reaktion bei
// abgebrochenem Drag (z.B. Esc, außerhalb jeder Spalte losgelassen) - dragend
// feuert laut Spec in beiden Fällen, daher genügt ein zentraler Aufräum-Handler.
function onDragEnd(e) {
  e.target.closest('.kanban-card')?.classList.remove('dragging');
  document.querySelectorAll('.kanban-col-body.drag-over').forEach(el => el.classList.remove('drag-over'));
  _clearKanbanDropIndicator();
  dragId = null;
}

// Zeigt eine schmale Einfüge-Linie an der Position, an der die gezogene Karte
// beim Loslassen landen würde - berechnet aus der Fingerposition/Mausposition
// relativ zur vertikalen Mitte jeder (anderen) Karte in der Zielspalte.
function _updateKanbanDropIndicator(colEl, clientY) {
  const cards = [...colEl.querySelectorAll('.kanban-card')].filter(c => c.dataset.id !== dragId);
  let idx = cards.length, before = null;
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { idx = i; before = cards[i]; break; }
  }
  _kanbanDropIndex = idx;
  if (!_kanbanDropIndicatorEl) {
    _kanbanDropIndicatorEl = document.createElement('div');
    _kanbanDropIndicatorEl.className = 'kanban-drop-indicator';
  }
  if (before) colEl.insertBefore(_kanbanDropIndicatorEl, before);
  else colEl.appendChild(_kanbanDropIndicatorEl);
}
function _clearKanbanDropIndicator() {
  _kanbanDropIndicatorEl?.remove();
  _kanbanDropIndex = null;
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
  if (col) { col.classList.add('drag-over'); _updateKanbanDropIndicator(col, t.clientY); }
  _lastDropTarget = col || null;
}

async function onTouchEnd(e) {
  if (!_touchClone) return;
  _touchClone.remove(); _touchClone = null;
  _touchSrc?.classList.remove('dragging');

  if (_lastDropTarget) {
    _lastDropTarget.classList.remove('drag-over');
    const newStatus = _lastDropTarget.dataset.status;
    if (newStatus && dragId) await _applyKanbanDrop(dragId, newStatus, _kanbanDropIndex);
    _lastDropTarget = null;
  }
  _clearKanbanDropIndicator();
  dragId = null; _touchSrc = null;
}

// Wendet einen Kanban-Drop an: ändert bei Bedarf den Status (Spaltenwechsel) und
// setzt die Zielspalte immer auf "Eigene Reihenfolge" mit der Karte an der per
// Drop-Anzeige markierten Position - manuelles Umsortieren soll nicht von der
// nächsten Sortierung (z.B. nach Datum) sofort wieder verworfen werden.
async function _applyKanbanDrop(id, newStatus, insertIndex) {
  const app = State.all.find(a => a.id === id);
  if (!app) return;

  const existing = sortAppsForKanban(State.filtered.filter(a => a.status === newStatus), newStatus)
    .map(a => a.id).filter(cid => cid !== id);
  const idx = insertIndex == null ? existing.length : Math.min(insertIndex, existing.length);
  existing.splice(idx, 0, id);
  State.kanbanSort[newStatus] = { col: 'custom', dir: 'asc', order: existing };
  saveKanbanSort();

  if (app.status !== newStatus) {
    const oldStatus  = app.status;
    const oldHistory = app.history ? [...app.history] : [];
    app.status  = newStatus;
    app.history = [...(app.history || []), { status: newStatus, timestamp: nowISO() }];
    await saveApp(app); // rendert die Spalten neu (mit bereits aktualisierter Reihenfolge)
    toast(`Status → ${newStatus}`, 'success', {
      actionLabel: 'Rückgängig',
      onAction: () => undoStatusChange(id, oldStatus, oldHistory),
    });
  } else {
    renderView();
  }
}

// Setzt Status + Verlauf einer Bewerbung auf einen zuvor gemerkten Stand zurück
// - genutzt vom "Rückgängig"-Toast-Button nach Drag&Drop/Schnell-Statuswechsel.
async function undoStatusChange(id, oldStatus, oldHistory) {
  const app = State.all.find(a => a.id === id);
  if (!app) return;
  app.status  = oldStatus;
  app.history = oldHistory;
  await saveApp(app);
  toast(`Status → ${oldStatus}`, 'info');
  if (!document.getElementById('detail-modal').classList.contains('hidden')) {
    openDetail(id);
  }
}

// ─── Form ─────────────────────────────────────────────────────────────────────
function openForm(id) {
  const app = id ? State.all.find(a => a.id === id) : null;
  document.getElementById('form-title').textContent = app ? 'Bearbeiten' : 'Neue Bewerbung';
  // Reset here (not just after submit) so an abandoned duplicateApp() attempt can't
  // leak into a later, unrelated "+ Neu" form and suppress its duplicate warning.
  delete document.getElementById('app-form').dataset.skipDupeWarning;
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
  document.getElementById('f-priority').value  = app?.priority || 0;
  renderFormPriorityStars(app?.priority || 0);
  const noteField = document.getElementById('f-history-note');
  if (noteField) noteField.value = '';
  // Show history note field only when editing (existing entry)
  document.getElementById('f-history-note-group')?.classList.toggle('hidden', !app);
  toggleRejectionField();
  showModal('form-modal');
  setTimeout(() => document.getElementById('f-company').focus(), 220);
}

function closeForm() { hideModal('form-modal'); }

/** Sterne-Auswahl im Formular: nochmal auf denselben Stern klicken setzt auf 0 zurück. */
function setFormPriority(n) {
  const input = document.getElementById('f-priority');
  const current = Number(input.value) || 0;
  const next = current === n ? 0 : n;
  input.value = next;
  renderFormPriorityStars(next);
}
function renderFormPriorityStars(n) {
  n = Number(n) || 0;
  document.querySelectorAll('#f-priority-picker .star-btn').forEach(btn => {
    btn.classList.toggle('filled', Number(btn.dataset.star) <= n);
  });
}

/** Öffnet das leere Formular vorausgefüllt als Kopie einer bestehenden Bewerbung -
 *  praktisch für Serienbewerbungen bei ähnlichen Rollen/Portalen. Speichert als neuer
 *  Eintrag (f-id bleibt leer), Status/Datum starten frisch statt den alten Stand zu übernehmen. */
function duplicateApp(id) {
  const app = State.all.find(a => a.id === id);
  if (!app) return;
  openForm();
  document.getElementById('form-title').textContent = 'Bewerbung duplizieren';
  document.getElementById('f-company').value       = app.company || '';
  document.getElementById('f-position').value      = app.position || '';
  document.getElementById('f-source').value        = app.source || '';
  document.getElementById('f-salary').value        = app.expectedSalary || '';
  document.getElementById('f-platform').value      = app.platformLink || '';
  document.getElementById('f-docs').value          = app.documentLink || '';
  document.getElementById('f-contact-name').value  = app.contactName || '';
  document.getElementById('f-contact-phone').value = app.contactPhone || '';
  document.getElementById('f-contact-email').value = app.contactEmail || '';
  document.getElementById('f-priority').value = app.priority || 0;
  renderFormPriorityStars(app.priority || 0);
  document.getElementById('app-form').dataset.skipDupeWarning = '1';
  toast('Als Vorlage übernommen - Datum und Status bitte prüfen', 'info');
}

function toggleRejectionField() {
  const show = getStatusKind(document.getElementById('f-status').value) === 'rejected';
  document.getElementById('f-rejection-group').classList.toggle('hidden', !show);
}

async function submitForm(e) {
  e.preventDefault();
  const id = document.getElementById('f-id').value || uuid();
  const existing = State.all.find(a => a.id === id);
  const newStatus = document.getElementById('f-status').value;
  const company   = document.getElementById('f-company').value.trim();
  const position  = document.getElementById('f-position').value.trim();

  // Duplicate check: same company + position already exists (different id).
  // Skipped once right after duplicateApp() - the user just explicitly chose to
  // create a same-company/position copy, so re-warning them about that exact thing
  // would just be a confusing echo of the button they clicked.
  const form = document.getElementById('app-form');
  const skipDupeWarning = form.dataset.skipDupeWarning === '1';
  delete form.dataset.skipDupeWarning;
  if (!existing && !skipDupeWarning) {
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
    priority:        Number(document.getElementById('f-priority').value) || null,
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

  // Research buttons - set onclick with current data
  const btnEmployer = document.getElementById('d-research-employer');
  const btnSalary   = document.getElementById('d-research-salary');
  if (btnEmployer) btnEmployer.onclick = (e) => { e.stopPropagation(); searchEmployer(a.company); };
  if (btnSalary)   btnSalary.onclick   = (e) => { e.stopPropagation(); searchSalary(a.position, a.source); };

  // Bell - manual reminder
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
  const starsEl = document.getElementById('d-priority-stars');
  if (starsEl) starsEl.innerHTML = starsHTML(a.priority, 13, true, id);

  // Reminder - settings-based threshold per status
  const lastTs    = a.history?.slice(-1)[0]?.timestamp || a.applicationDate;
  const threshold = State.settings?.staleThreshold?.[a.status] ?? (getStatusKind(a.status) === 'open' ? 14 : 0);
  const isStale   = threshold > 0 && daysSince(lastTs) > threshold;
  const remEl     = document.getElementById('d-reminder');
  if (remEl) {
    remEl.classList.toggle('hidden', !isStale);
    if (isStale) remEl.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      ${daysSince(lastTs)} Tage keine Änderung`;
  }

  // Details
  document.getElementById('d-source').textContent    = a.source || '-';
  document.getElementById('d-date').textContent      = fmtDateTime(a.applicationDate);
  document.getElementById('d-salary').textContent    = fmtEuro(a.expectedSalary);
  document.getElementById('d-rejection').textContent = a.rejectionReason || '-';

  // Contact
  const contactSec = document.getElementById('d-contact-section');
  if (a.contactName || a.contactPhone || a.contactEmail) {
    contactSec.classList.remove('hidden');
    document.getElementById('d-contact-name').textContent  = a.contactName  || '-';
    document.getElementById('d-contact-phone').textContent = a.contactPhone || '-';
    document.getElementById('d-contact-email').textContent = a.contactEmail || '-';
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
  document.getElementById('d-edit-btn').onclick = () => { closeDetail(); openForm(id); };
  document.getElementById('d-more-btn').onclick = (e) => toggleDetailMoreMenu(e, id);
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

// ─── Job finden: mehrere Jobportale gleichzeitig durchsuchen ───────────────────
// Google-Suche mit site:-Filter, für Portale ohne dokumentiertes/verlässliches
// eigenes Such-URL-Schema (z.B. reine Matching-Apps ohne klassische Trefferliste).
function _siteSearch(domain, q, l) {
  return `https://www.google.com/search?q=${encodeURIComponent(`site:${domain} ${q}${l ? ' ' + l : ''}`)}`;
}

const JOB_PORTALS = {
  indeed:         (q, l) => `https://de.indeed.com/jobs?q=${encodeURIComponent(q)}${l ? `&l=${encodeURIComponent(l)}` : ''}`,
  stepstone:      (q, l) => `https://www.stepstone.de/jobs/${encodeURIComponent(q)}${l ? `/in-${encodeURIComponent(l)}` : ''}`,
  linkedin:       (q, l) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}${l ? `&location=${encodeURIComponent(l)}` : ''}`,
  arbeitsagentur: (q, l) => `https://www.arbeitsagentur.de/jobsuche/suche?was=${encodeURIComponent(q)}${l ? `&wo=${encodeURIComponent(l)}` : ''}`,
  xing:           (q, l) => `https://www.xing.com/jobs/search?keywords=${encodeURIComponent(q)}${l ? `&location=${encodeURIComponent(l)}` : ''}`,
  instaffo:       (q, l) => _siteSearch('instaffo.com', q, l),
  truffls:        (q, l) => _siteSearch('truffls.com', q, l),
  workwise:       (q, l) => _siteSearch('workwise.io', q, l),
  ruhr24jobs:     (q, l) => _siteSearch('jobs.ruhr24.de', q, l),
  interamt:       (q, l) => _siteSearch('interamt.de', q, l),
  getinit:        (q, l) => _siteSearch('get-in-it.de', q, l),
  karrierebund:   (q, l) => _siteSearch('karriere.bund.de', q, l),
  zuhausejobs:    (q, l) => _siteSearch('zuhausejobs.com', q, l),
  euremotejobs:   (q, l) => _siteSearch('euremotejobs.com', q, l),
  google:         (q, l) => `https://www.google.com/search?q=${encodeURIComponent(`${q}${l ? ' ' + l : ''} Stellenangebote`)}`,
};

function _jsReadQuery() {
  const query    = document.getElementById('js-query')?.value.trim() || '';
  const location = document.getElementById('js-location')?.value.trim() || '';
  if (!query) toast('Bitte einen Jobtitel oder Suchbegriff eingeben.', 'warning');
  return { query, location };
}

function _jsSelectedPortals() {
  return Array.from(document.querySelectorAll('.jobportal-check:checked')).map(el => el.value);
}

function _jsSaveSelectedPortals() {
  localStorage.setItem('jt-job-portals', JSON.stringify(_jsSelectedPortals()));
}

/** Restore checked state from localStorage (default: all checked) - called when the page opens */
function _jsRestorePortalSelection() {
  const saved = JSON.parse(localStorage.getItem('jt-job-portals') || 'null');
  if (!Array.isArray(saved)) return;
  document.querySelectorAll('.jobportal-check').forEach(el => { el.checked = saved.includes(el.value); });
}

function toggleAllJobPortals() {
  const boxes = document.querySelectorAll('.jobportal-check');
  const allChecked = Array.from(boxes).every(el => el.checked);
  boxes.forEach(el => { el.checked = !allChecked; });
  _jsSaveSelectedPortals();
}

function openSelectedJobSearches() {
  const { query, location } = _jsReadQuery();
  if (!query) return;
  const selected = _jsSelectedPortals();
  if (!selected.length) { toast('Bitte mindestens ein Portal auswählen.', 'warning'); return; }
  selected.forEach(portal => window.open(JOB_PORTALS[portal](query, location), '_blank', 'noopener,noreferrer'));
}

async function confirmDelete(id) {
  const a = State.all.find(x => x.id === id);
  if (!a) return;
  const ok = await showConfirm(
    'Bewerbung löschen?',
    `"${a.company} - ${a.position}" wird unwiderruflich entfernt.`,
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
    return `<div class="sort-popover-item${isActive?' active':''}" onclick="applyQuickStatus('${escJs(id)}','${escJs(s)}')">
      <span style="width:16px;flex-shrink:0;opacity:${isActive?1:0}">${SVG_CHECK}</span>
      <span class="badge ${statusClass(s)}" style="font-size:.65rem;padding:.1rem .45rem">${escHtml(s)}</span>
    </div>`;
  }).join('');

  // Fixed-positioned & appended to <body> instead of nested in the table/card DOM:
  // the table wrapper uses overflow:hidden (rounded corners) and its scroll container
  // forces overflow-y:auto too, which clipped the popover whenever it opened near an
  // edge. Positioning it in viewport coordinates escapes that clipping entirely.
  const btn  = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  popover.style.position   = 'fixed';
  popover.style.visibility = 'hidden';
  document.body.appendChild(popover);

  const popRect     = popover.getBoundingClientRect();
  const margin      = 8;
  const spaceBelow  = window.innerHeight - rect.bottom;
  const openUpward  = spaceBelow < popRect.height + margin && rect.top > popRect.height + margin;
  const left = Math.min(
    Math.max(rect.right - popRect.width, margin),
    window.innerWidth - popRect.width - margin
  );
  popover.style.left       = `${left}px`;
  popover.style.top        = `${openUpward ? rect.top - popRect.height - 4 : rect.bottom + 4}px`;
  popover.style.right      = 'auto';
  popover.style.visibility = '';

  // Close on outside click, scroll or resize (listeners self-clean on the next such
  // event even if the popover was already removed elsewhere, e.g. via applyQuickStatus).
  setTimeout(() => {
    const cleanup = () => {
      popover.remove();
      document.removeEventListener('click', onDocClick, true);
      window.removeEventListener('scroll', cleanup, true);
      window.removeEventListener('resize', cleanup);
    };
    const onDocClick = (ev) => {
      if (btn.contains(ev.target) || popover.contains(ev.target)) return;
      cleanup();
    };
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', cleanup, true);
    window.addEventListener('resize', cleanup);
  }, 0);
}

// ─── Custom Confirm Dialog (replaces window.confirm - works in iOS PWA) ───────
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
    if (status) status.textContent = 'Nicht geschützt - Daten können gelöscht werden';
    if (sideWarn) sideWarn.classList.remove('hidden');
  }
}

async function requestPersistence() {
  if (!navigator.storage?.persist) { toast('API nicht unterstützt', 'warning'); return; }
  const granted = await navigator.storage.persist();
  await checkPersistence();
  toast(granted ? 'Speicherschutz aktiviert ✓' : 'Nicht gewährt (Browsereinstellung)', granted ? 'success' : 'warning');
}

// ─── Backup-Erinnerung ──────────────────────────────────────────────────────────
// Alle Daten liegen nur lokal (siehe Info-Seite) - ohne eigenes Zutun gibt es kein
// Netz. Nach BACKUP_REMINDER_DAYS Tagen ohne Export/Google-Drive-Sync erscheint ein
// dezenter Hinweis in der Sidebar, der zu Einstellungen → Offline-Backup verlinkt.
const BACKUP_REMINDER_DAYS = 30;

function markBackupDone() {
  localStorage.setItem('jt-last-backup', nowISO());
  checkBackupReminder();
}

function checkBackupReminder() {
  let last = localStorage.getItem('jt-last-backup');
  if (!last) {
    // Noch nie ein Backup gemacht: Zähler ab jetzt starten statt sofort zu warnen -
    // sonst würde ein brandneuer Nutzer schon beim ersten Laden angemeckert.
    last = nowISO();
    localStorage.setItem('jt-last-backup', last);
  }
  const days    = daysSince(last);
  const overdue = State.all.length > 0 && days > BACKUP_REMINDER_DAYS;

  const warnEl = document.getElementById('backup-warn');
  if (warnEl) warnEl.classList.toggle('hidden', !overdue);

  const statusEl = document.getElementById('backup-status-text');
  if (statusEl) {
    statusEl.textContent = days === 0 ? 'Letztes Backup: heute'
      : days === 1 ? 'Letztes Backup: gestern'
      : `Letztes Backup: vor ${days} Tagen`;
  }
  const dotEl = document.getElementById('backup-status-dot');
  if (dotEl) dotEl.className = `persist-dot ${overdue ? 'warn' : 'ok'}`;
}

async function exportData() {
  const pairs = await idbEntries(DB);
  const data  = pairs.map(([,v]) => v);
  if (!data.length) { toast('Keine Daten zum Exportieren', 'info'); return; }
  // Statuskategorien (Name, Farbe, Zähl-Kind) und die Kanban-Sortierung (inkl. per
  // Drag&Drop gesetzter "Eigener Reihenfolge") gehören mit in den Export, sonst sieht
  // das Kanban-Board auf einem anderen Gerät nach dem Import anders aus/sortiert sich
  // anders als auf dem Ursprungsgerät.
  const payload = { applications: data, statuses: State.statuses, kanbanSort: State.kanbanSort };
  const blob  = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href = url;
  a.download = `jobtracker-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
  markBackupDone();
  toast(`${data.length} Einträge exportiert`, 'success');
}

async function exportCSV() {
  const pairs = await idbEntries(DB);
  const data  = pairs.map(([,v]) => v);
  if (!data.length) { toast('Keine Daten zum Exportieren', 'info'); return; }

  // Statusfarbe/-typ werden pro Zeile mitexportiert (statt in einer separaten Sektion),
  // da CSV/Excel nur eine flache Tabelle kennt - so bringt jede Zeile ihre eigene
  // Statusdefinition mit und der Import kann daraus den Statuskatalog rekonstruieren.
  const cols = ['Firma','Position','Status','Statusfarbe','Statustyp','Statusreihenfolge','Kartenposition','Quelle','Datum','Gehalt','Priorität','Absagegrund','Ansprechpartner','Telefon','E-Mail','Stellenanzeige','Unterlagen','Notizen'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = data.map(a => {
    // Kartenposition (1-basierter Index innerhalb der per Drag&Drop gesetzten "Eigenen
    // Reihenfolge" der Statusspalte) nur befüllen, wenn diese Spalte tatsächlich manuell
    // sortiert ist - sonst soll der Import dort keine erzwungene Reihenfolge anlegen.
    const ks = State.kanbanSort[a.status];
    const cardPos = ks?.col === 'custom' ? ks.order?.indexOf(a.id) : -1;
    return [
      esc(a.company), esc(a.position), esc(a.status), esc(getStatusColor(a.status)),
      // Statusreihenfolge (1-basierter Index in State.statuses) wird mitexportiert, weil
      // sonst beim Import nur die Reihenfolge des ersten Auftretens in den Zeilen übrig
      // bliebe - die stimmt i.A. nicht mit der konfigurierten Kanban-Spaltenreihenfolge
      // überein, sobald z.B. der erste Eintrag zufällig einen späten Status hat.
      esc(STATUS_KINDS.find(k => k.key === getStatusKind(a.status))?.label || ''),
      esc(State.statuses.findIndex(s => s.name === a.status) + 1 || ''),
      esc(cardPos > -1 ? cardPos + 1 : ''), esc(a.source),
      esc(a.applicationDate), esc(a.expectedSalary ?? ''), esc(a.priority || ''), esc(a.rejectionReason),
      esc(a.contactName), esc(a.contactPhone), esc(a.contactEmail),
      esc(a.platformLink), esc(a.documentLink), esc(a.notes),
    ].join(';');
  });

  const csv  = '\uFEFF' + [cols.join(';'), ...rows].join('\r\n'); // BOM for Excel
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const el   = document.createElement('a');
  el.href = url; el.download = `jobtracker-${new Date().toISOString().slice(0,10)}.csv`;
  el.click(); URL.revokeObjectURL(url);
  markBackupDone();
  toast(`${data.length} Einträge als CSV exportiert`, 'success');
}

// Spalten\u00FCberschriften (Zeile 1, Gro\u00DF-/Kleinschreibung egal), die beim CSV/Excel-Import
// erkannt werden. Nur "Firma" ist Pflicht \u2014 alle anderen Spalten sind optional und
// unbekannte Spalten werden einfach ignoriert. Auch f\u00FCr den Info-Popover verwendet.
const IMPORT_COL_MAP = {
  firma:'company', position:'position', status:'status', quelle:'source',
  datum:'applicationDate', gehalt:'expectedSalary', priorität:'priority',
  absagegrund:'rejectionReason',
  ansprechpartner:'contactName', telefon:'contactPhone', 'e-mail':'contactEmail',
  stellenanzeige:'platformLink', unterlagen:'documentLink', notizen:'notes',
};
// Zusatzspalten, die keine Felder der Bewerbung selbst sind, sondern die Statuskategorie
// (Farbe/Zähl-Kind) beschreiben, aus der die Zeile stammt - siehe exportCSV().
const IMPORT_STATUS_COL_MAP = { statusfarbe:'color', statustyp:'kindLabel', statusreihenfolge:'order', kartenposition:'cardPos' };

function parseDelimitedLine(line, delim) {
  const result = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inQ) { inQ = true; }
    else if (ch === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; }
    else if (ch === '"' && inQ) { inQ = false; }
    else if (ch === delim && !inQ) { result.push(cur); cur = ''; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

// xlsx.full.min.js (~880KB, vendored under vendor/xlsx/) is only needed for .xlsx/.xls
// import, so it isn't part of the initial page load - it's fetched on demand here, the
// same lazy-load pattern _gdEnsureLibs() uses for the Google Drive libraries.
let _xlsxReady = null;
function _ensureXLSX() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (_xlsxReady) return _xlsxReady;
  _xlsxReady = new Promise((resolve, reject) => {
    const src = 'vendor/xlsx/xlsx.full.min.js';
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload  = resolve;
    s.onerror = () => { _xlsxReady = null; reject(new Error('Excel-Bibliothek konnte nicht geladen werden')); };
    document.head.appendChild(s);
  });
  return _xlsxReady;
}

// Liest eine CSV/TSV- oder echte .xlsx/.xls-Datei ein und gibt sie einheitlich als
// Array von Zeilen (je ein Array von Zellwerten, Zeile 0 = Kopfzeile) zur\u00FCck.
async function parseSpreadsheetRows(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    await _ensureXLSX();
    const buf   = await file.arrayBuffer();
    const wb    = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // dateNF sorgt daf\u00FCr, dass echte Datumszellen als YYYY-MM-DD ankommen, egal
    // welches Anzeigeformat die Excel-Datei selbst f\u00FCr die Spalte nutzt.
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' });
  }
  const text  = await file.text();
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter(l => l.trim());
  const delim = name.endsWith('.tsv') ? '\t' : ';';
  return lines.map(line => parseDelimitedLine(line, delim));
}

// Gibt { apps, statuses } zurück: `statuses` ist der aus den (optionalen) Spalten
// Statusfarbe/Statustyp/Statusreihenfolge rekonstruierte Statuskatalog, ein Eintrag
// je eindeutigem Statusnamen, sortiert nach Statusreihenfolge (Kanban-Spaltenreihenfolge) -
// mit Fallback auf die Reihenfolge des ersten Auftretens, falls diese Spalte fehlt
// (z.B. bei einer von Hand angelegten CSV-Datei).
function spreadsheetRowsToApplications(rows) {
  if (rows.length < 2) throw new Error('Keine Daten gefunden');
  const header = rows[0].map(h => String(h ?? '').replace(/^"|"$/g, '').trim().toLowerCase());

  const imported = [];
  const statusDefs = new Map(); // name -> { name, color, kind, order }
  const cardPositions = []; // { id, status, pos } - aus der Kartenposition-Spalte (custom Kanban-Reihenfolge)
  for (let i = 1; i < rows.length; i++) {
    const vals = rows[i];
    if (!vals || !vals.length) continue;
    const app = { id: uuid(), createdAt: nowISO(), updatedAt: nowISO(), history: [] };
    const statusMeta = {};
    header.forEach((h, idx) => {
      const field = IMPORT_COL_MAP[h];
      const statusField = IMPORT_STATUS_COL_MAP[h];
      if (statusField) { statusMeta[statusField] = String(vals[idx] ?? '').trim(); return; }
      if (!field) return;
      let val = String(vals[idx] ?? '');
      if (field === 'expectedSalary') val = Number(val.replace(/[^0-9]/g,'')) || null;
      else if (field === 'priority') val = Math.min(3, Math.max(0, Number(val.replace(/[^0-9]/g,'')) || 0)) || null;
      else val = val.trim() || null;
      app[field] = val;
    });
    if (!app.company) continue;
    app.status = app.status || State.statuses[0]?.name || 'Offen';
    app.history.push({ status: app.status, timestamp: nowISO() });
    imported.push(app);

    if (!statusDefs.has(app.status)) {
      const color = /^#[0-9a-f]{6}$/i.test(statusMeta.color || '') ? statusMeta.color : null;
      const kind  = STATUS_KINDS.find(k => k.label === statusMeta.kindLabel)?.key || null;
      const order = Number(statusMeta.order);
      statusDefs.set(app.status, {
        name: app.status,
        color: color || getStatusColor(app.status),
        kind:  kind  || getStatusKind(app.status),
        // Statuskategorien ohne (gültige) Reihenfolge-Spalte landen hinter denen mit
        // Angabe, in der Reihenfolge ihres ersten Auftretens (Map-Einfügereihenfolge).
        order: Number.isFinite(order) && order > 0 ? order : 1000 + statusDefs.size,
      });
    }

    const cardPos = Number(statusMeta.cardPos);
    if (Number.isFinite(cardPos) && cardPos > 0) cardPositions.push({ id: app.id, status: app.status, pos: cardPos });
  }
  const statuses = [...statusDefs.values()].sort((a, b) => a.order - b.order)
    .map(({ order, ...s }) => s);

  // Kanban-"Eigene Reihenfolge" je Status nur anlegen, wenn diese Spalte beim Export
  // tatsächlich manuell sortiert war (siehe exportCSV()) - sonst fehlt die Kartenposition
  // und die Spalte behält ihre normale Sortierung (Datum/Firma/...).
  const kanbanSort = {};
  const byStatus = new Map();
  for (const cp of cardPositions) {
    if (!byStatus.has(cp.status)) byStatus.set(cp.status, []);
    byStatus.get(cp.status).push(cp);
  }
  for (const [status, list] of byStatus) {
    kanbanSort[status] = { col: 'custom', dir: 'asc', order: list.sort((a, b) => a.pos - b.pos).map(c => c.id) };
  }

  return { apps: imported, statuses, kanbanSort };
}

// \u2500\u2500\u2500 Import-Format-Hinweis (Popover) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function toggleImportInfo(e) {
  e.stopPropagation();
  document.querySelectorAll('.import-info-popover').forEach(p => p.remove());

  const colLabels = Object.keys(IMPORT_COL_MAP)
    .map(col => col === 'firma' ? 'Firma*' : col.charAt(0).toUpperCase() + col.slice(1))
    .join(', ');

  const popover = document.createElement('div');
  popover.className = 'import-info-popover';
  popover.innerHTML = `
    <div class="import-info-title">Erwartetes Spaltenformat</div>
    <p>Erste Zeile = \u00DCberschriften (Gro\u00DF-/Kleinschreibung egal). Erkannt werden: ${escHtml(colLabels)}. Nur <strong>Firma*</strong> ist Pflicht, unbekannte Spalten werden ignoriert.</p>
    <p>Alles bleibt lokal in deinem Browser \u2013 beim Import wird nichts hochgeladen oder \u00FCbertragen.</p>
  `;

  // Fixed-positioniert & an <body> geh\u00E4ngt (wie beim Status-Popover), damit es nicht
  // von der Karte darunter abgeschnitten oder komisch versetzt dargestellt wird.
  const btn  = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  popover.style.position   = 'fixed';
  popover.style.visibility = 'hidden';
  document.body.appendChild(popover);

  const popRect    = popover.getBoundingClientRect();
  const margin     = 8;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpward = spaceBelow < popRect.height + margin && rect.top > popRect.height + margin;
  const left = Math.min(Math.max(rect.left, margin), window.innerWidth - popRect.width - margin);
  popover.style.left       = `${left}px`;
  popover.style.top        = `${openUpward ? rect.top - popRect.height - 4 : rect.bottom + 4}px`;
  popover.style.visibility = '';

  setTimeout(() => {
    const cleanup = () => {
      popover.remove();
      document.removeEventListener('click', onDocClick, true);
      window.removeEventListener('scroll', cleanup, true);
      window.removeEventListener('resize', cleanup);
    };
    const onDocClick = (ev) => {
      if (btn.contains(ev.target) || popover.contains(ev.target)) return;
      cleanup();
    };
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', cleanup, true);
    window.addEventListener('resize', cleanup);
  }, 0);
}

// ─── Tabellenspalten-Auswahl (Popover) ─────────────────────────────────────────
function toggleColumnsMenu(e) {
  e.stopPropagation();
  document.querySelectorAll('.columns-popover').forEach(p => p.remove());

  const popover = document.createElement('div');
  popover.className = 'columns-popover';
  popover.innerHTML = `
    <div class="columns-popover-title">Spalten anzeigen</div>
    ${TABLE_COLUMNS.map(c => `
      <label class="columns-popover-item">
        <input type="checkbox" ${State.tableColumns[c.key] ? 'checked' : ''} onchange="toggleTableColumn('${c.key}')" />
        ${escHtml(c.label)}
      </label>
    `).join('')}
  `;

  // Fixed-positioniert & an <body> gehängt (wie beim Import-Info-Popover), rechtsbündig
  // zum Button, damit es bei einem rechts sitzenden Button nicht rechts abgeschnitten wird.
  const btn  = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  popover.style.position   = 'fixed';
  popover.style.visibility = 'hidden';
  document.body.appendChild(popover);

  const popRect    = popover.getBoundingClientRect();
  const margin     = 8;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpward = spaceBelow < popRect.height + margin && rect.top > popRect.height + margin;
  const left = Math.min(Math.max(rect.right - popRect.width, margin), window.innerWidth - popRect.width - margin);
  popover.style.left       = `${left}px`;
  popover.style.top        = `${openUpward ? rect.top - popRect.height - 4 : rect.bottom + 4}px`;
  popover.style.visibility = '';

  setTimeout(() => {
    const cleanup = () => {
      popover.remove();
      document.removeEventListener('click', onDocClick, true);
      window.removeEventListener('scroll', cleanup, true);
      window.removeEventListener('resize', cleanup);
    };
    const onDocClick = (ev) => {
      if (btn.contains(ev.target) || popover.contains(ev.target)) return;
      cleanup();
    };
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', cleanup, true);
    window.addEventListener('resize', cleanup);
  }, 0);
}

// ─── Aktionsmenü-Popover (Mobile Karten / Desktop-Tabelle / Detailansicht) ─────
// Gemeinsame Positionierungs-/Lifecycle-Logik für die "⋯"-Menüs, die die
// selteneren Zeilen-/Kartenaktionen hinter einem Button verstecken.
function openActionPopover(anchorBtn, itemsHtml) {
  document.querySelectorAll('.card-menu-popover').forEach(p => p.remove());

  const popover = document.createElement('div');
  popover.className = 'sort-popover card-menu-popover';
  popover.innerHTML = itemsHtml;

  const rect = anchorBtn.getBoundingClientRect();
  popover.style.position   = 'fixed';
  popover.style.visibility = 'hidden';
  document.body.appendChild(popover);

  const popRect    = popover.getBoundingClientRect();
  const margin     = 8;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpward = spaceBelow < popRect.height + margin && rect.top > popRect.height + margin;
  const left = Math.min(Math.max(rect.right - popRect.width, margin), window.innerWidth - popRect.width - margin);
  popover.style.left       = `${left}px`;
  popover.style.top        = `${openUpward ? rect.top - popRect.height - 4 : rect.bottom + 4}px`;
  popover.style.right      = 'auto';
  popover.style.visibility = '';

  setTimeout(() => {
    const cleanup = () => {
      popover.remove();
      document.removeEventListener('click', onDocClick, true);
      window.removeEventListener('scroll', cleanup, true);
      window.removeEventListener('resize', cleanup);
    };
    const onDocClick = (ev) => {
      if (anchorBtn.contains(ev.target) || popover.contains(ev.target)) return;
      cleanup();
    };
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', cleanup, true);
    window.addEventListener('resize', cleanup);
  }, 0);
}
function closeCardMenu() {
  document.querySelectorAll('.card-menu-popover').forEach(p => p.remove());
}

// ─── Karten-/Zeilen-Aktionsmenü (Bearbeiten/Duplizieren/Löschen hinter "⋯") ───
// Mobile Karten und die Desktop-Tabelle verstecken ihre Zeilenaktionen gleich
// hinter diesem Menü statt sie als einzelne Icons nebeneinander zu zeigen.
function toggleCardMenu(e, id) {
  e.stopPropagation();
  openActionPopover(e.currentTarget, `
    <div class="sort-popover-item" onclick="event.stopPropagation();closeCardMenu();openForm('${escJs(id)}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      Bearbeiten
    </div>
    <div class="sort-popover-item" onclick="event.stopPropagation();closeCardMenu();duplicateApp('${escJs(id)}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Duplizieren
    </div>
    <div class="sort-popover-item card-menu-item-danger" onclick="event.stopPropagation();closeCardMenu();confirmDelete('${escJs(id)}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      Löschen
    </div>
  `);
}

// ─── Detailansicht-Aktionsmenü (Duplizieren/Löschen hinter "⋯") ───────────────
// Bearbeiten bleibt als eigener Button sichtbar, nur die selteneren Aktionen
// wandern hinter das Menü.
function toggleDetailMoreMenu(e, id) {
  e.stopPropagation();
  openActionPopover(e.currentTarget, `
    <div class="sort-popover-item" onclick="event.stopPropagation();closeCardMenu();closeDetail();duplicateApp('${escJs(id)}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Duplizieren
    </div>
    <div class="sort-popover-item card-menu-item-danger" onclick="event.stopPropagation();closeCardMenu();closeDetail();confirmDelete('${escJs(id)}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      Löschen
    </div>
  `);
}

async function importCSV(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const rows = await parseSpreadsheetRows(file);
    const { apps, statuses, kanbanSort } = spreadsheetRowsToApplications(rows);
    if (!apps.length) throw new Error('Keine gültigen Zeilen gefunden');
    await idbClear(DB);
    for (const app of apps) await idbSet(app.id, app, DB);
    // Statuskatalog (Namen, Farben, Zähl-Kind) aus den Statusfarbe-/Statustyp-Spalten
    // übernehmen, damit importierte Einträge auf diesem Gerät genauso aussehen wie
    // beim Export - siehe exportCSV()/spreadsheetRowsToApplications().
    if (statuses.length) {
      State.statuses = sanitizeStatuses(statuses); saveStatuses();
      injectStatusStyles(); renderStatusSelectOptions();
      if (document.getElementById('page-settings')?.classList.contains('active')) renderStatusSettings();
    }
    // Eigene Kanban-Kartenreihenfolge aus der Kartenposition-Spalte übernehmen (nur für
    // Spalten, die beim Export tatsächlich manuell sortiert waren - siehe exportCSV()).
    if (Object.keys(kanbanSort).length) {
      State.kanbanSort = sanitizeKanbanSort(kanbanSort); saveKanbanSort();
    }
    await loadAll();
    toast(`${apps.length} Einträge importiert ✓`, 'success');
  } catch (err) {
    toast('Import fehlgeschlagen: ' + err.message, 'error');
  }
  e.target.value = '';
}
async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    // Neues Format: { applications, statuses, kanbanSort }. Altes Format (vor diesem
    // Feature exportiert): einfaches Array von Bewerbungen ohne Statuskatalog.
    const data       = Array.isArray(parsed) ? parsed : parsed.applications;
    const statuses   = Array.isArray(parsed) ? null   : parsed.statuses;
    const kanbanSort = Array.isArray(parsed) ? null   : parsed.kanbanSort;
    if (!Array.isArray(data)) throw new Error('Ungültiges Format');
    await idbClear(DB);
    for (const app of data) await idbSet(app.id, app, DB);
    if (Array.isArray(statuses) && statuses.length) {
      State.statuses = sanitizeStatuses(statuses); saveStatuses();
      injectStatusStyles(); renderStatusSelectOptions();
      if (document.getElementById('page-settings')?.classList.contains('active')) renderStatusSettings();
    }
    // Eigene Kanban-Kartenreihenfolge (falls die exportierende Version das Feature
    // schon kannte) 1:1 übernehmen - anders als bei CSV bleiben die Bewerbungs-IDs
    // beim JSON-Import erhalten, die gespeicherten Reihenfolgen passen also direkt.
    if (kanbanSort && typeof kanbanSort === 'object' && !Array.isArray(kanbanSort)) {
      State.kanbanSort = sanitizeKanbanSort(kanbanSort); saveKanbanSort();
    }
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
    toast('Benachrichtigungen in Systemeinstellungen blockiert - dort freigeben.', 'warning');
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
  } catch { /* SW unavailable - silently skip */ }
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
    if (followUpDays > 0 && ['open', 'interview'].includes(getStatusKind(app.status)) && days >= followUpDays) count++;
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
          `„${app.position}" - ${daysSt} Tage im Status ${app.status}`,
          `stale-${app.id}`, app.id
        );
      }
    }

    // Global follow-up: fires for Offen/Interview if no response in followUpDays
    if (followUpDays > 0 && ['open', 'interview'].includes(getStatusKind(app.status)) && daysSt >= followUpDays) {
      const fuKey = `jt-followup-${app.id}`;
      if (localStorage.getItem(fuKey) !== today) {
        localStorage.setItem(fuKey, today);
        fireNotification(
          `📬 Nachfassen empfohlen: ${app.company}`,
          `${app.position} - seit ${daysSt} Tagen keine Reaktion`,
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
  if (['accepted', 'rejected'].includes(getStatusKind(app.status))) await deleteReminder(app.id);
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
      fireNotification(`🔔 Erinnerung: ${app.company}`, r.note || `${app.position} - geplant für heute`, `reminder-${r.id}`, r.appId);
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
  const offene = State.all.filter(a => getStatusKind(a.status) === 'open').length;
  const interviews = State.all.filter(a => getStatusKind(a.status) === 'interview').length;
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
    .map(a => `<option value="${a.id}">${escHtml(a.company)} - ${escHtml(a.position)}</option>`).join('');
  sel.innerHTML = `<option value="">- keine Verknüpfung -</option>` + opts;
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
        <div class="notif-master-sub">${!supported ? 'Nicht unterstützt' : denied ? 'Blockiert - in Systemeinstellungen freigeben' : granted ? (masterOn ? 'Aktiv' : 'Erlaubt, aber deaktiviert') : 'Erlaubnis noch nicht erteilt'}</div>
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
function toggleStatusSettings() {
  const expand = document.getElementById('status-settings-expand');
  const btn    = document.getElementById('status-settings-toggle-btn');
  if (!expand) return;
  const open = expand.classList.toggle('open');
  const label = btn?.childNodes[btn.childNodes.length - 1];
  if (label) label.textContent = open ? ' Fertig' : ' Bearbeiten';
}
function renderStatusSettings() {
  const el = document.getElementById('status-settings-body');
  if (!el) return;
  el.innerHTML = `
    <p class="status-kind-hint">
      „Zählt als" bestimmt, wie eine Kategorie in die Dashboard-Statistiken einfließt
      (z.B. Interview-Rate, offene Bewerbungen) - unabhängig vom Namen.
    </p>
    <div class="status-manage-list">
      ${State.statuses.map((s, i) => {
        const count = State.all.filter(a => a.status === s.name).length;
        return `
        <div class="status-manage-item">
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
          </div>
          <div class="status-manage-row status-kind-row">
            <label class="status-kind-label">
              Zählt als
              <select class="form-select status-kind-select" onchange="updateStatusKind(${i}, this.value)">
                ${STATUS_KINDS.map(k => `<option value="${k.key}" ${s.kind === k.key ? 'selected' : ''}>${k.label}</option>`).join('')}
              </select>
            </label>
            <span class="status-count" title="${count} Bewerbung${count === 1 ? '' : 'en'} mit diesem Status">${count}</span>
          </div>
        </div>`;
      }).join('')}
    </div>
    <form class="status-add-row" onsubmit="return addStatus(event)">
      <input type="color" id="new-status-color" class="status-color-input" value="#c8e02e" title="Farbe" />
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
  State.statuses.push({ name, color: colorEl.value, kind: 'other' });
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
  saveKanbanSort();

  if (State.statusFilterHidden.has(oldName)) {
    State.statusFilterHidden.delete(oldName);
    State.statusFilterHidden.add(newName);
    saveStatusFilterHidden();
  }

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
  saveKanbanSort();

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
// Client ID + API Key come from https://console.cloud.google.com/apis/credentials and
// are entered by the user via the credentials modal (openGoogleDriveCredentialsModal()),
// not hardcoded here - app.js ships static to every user, so a value baked in at build
// time would leak into the public source and only work for one Google Cloud project.
const GD_LS_CLIENT_ID = 'jt-gd-client-id';
const GD_LS_API_KEY   = 'jt-gd-api-key';
function gdGetClientId() { return localStorage.getItem(GD_LS_CLIENT_ID) || ''; }
function gdGetApiKey()   { return localStorage.getItem(GD_LS_API_KEY) || ''; }

const GD_SCOPE       = 'https://www.googleapis.com/auth/drive.appdata';
const GD_BACKUP_NAME = 'backup.json';
const GD_DISCOVERY   = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';

// Internal state
let _gdTokenClient = null;   // GSI token client
let _gdAccessToken = null;   // current access token
let _gdInitialized = false;  // GAPI client loaded

/** Entry point called from UI button */
async function syncToGoogleDrive() {
  if (!gdGetClientId() || !gdGetApiKey()) {
    openGoogleDriveCredentialsModal();
    return;
  }
  _gdUpdateBtn('loading');
  try {
    await _gdEnsureLibs();
    await _gdEnsureToken();
    await _gdRunSync();
    markBackupDone();
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
              await gapi.client.init({ apiKey: gdGetApiKey(), discoveryDocs: [GD_DISCOVERY] });
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
        client_id: gdGetClientId(),
        scope: GD_SCOPE,
        callback: (resp) => {
          if (resp.error) {
            _gdAccessToken = null;
            reject(new Error(resp.error === 'access_denied' ? 'CANCELLED' : resp.error));
          } else {
            _gdAccessToken = resp.access_token;
            // Token expires - clear after expiry so next call re-authenticates
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
    // Effectively identical - just confirm
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

/** Open the credentials modal, prefilled with whatever is currently stored */
function openGoogleDriveCredentialsModal() {
  document.getElementById('gd-client-id-input').value = gdGetClientId();
  document.getElementById('gd-api-key-input').value = gdGetApiKey();
  showModal('gd-credentials-modal');
}

/** Save Client ID + API Key from the modal, then immediately (re)try the sync */
function saveGoogleDriveCredentials() {
  const clientId = document.getElementById('gd-client-id-input').value.trim();
  const apiKey   = document.getElementById('gd-api-key-input').value.trim();
  if (!clientId || !apiKey) {
    toast('Bitte Client ID und API Key eingeben.', 'warning');
    return;
  }
  localStorage.setItem(GD_LS_CLIENT_ID, clientId);
  localStorage.setItem(GD_LS_API_KEY, apiKey);
  // Force gapi/GSI to pick up the new values instead of reusing a client built from old ones
  _gdInitialized  = false;
  _gdTokenClient  = null;
  _gdAccessToken  = null;
  hideModal('gd-credentials-modal');
  toast('Google Drive Zugangsdaten gespeichert ✓', 'success');
  syncToGoogleDrive();
}

/** Remove stored credentials (e.g. to switch Google Cloud projects) */
function clearGoogleDriveCredentials() {
  localStorage.removeItem(GD_LS_CLIENT_ID);
  localStorage.removeItem(GD_LS_API_KEY);
  _gdInitialized  = false;
  _gdTokenClient  = null;
  _gdAccessToken  = null;
  document.getElementById('gd-client-id-input').value = '';
  document.getElementById('gd-api-key-input').value = '';
  const status = document.getElementById('gd-status');
  if (status) status.innerHTML = '';
  hideModal('gd-credentials-modal');
  toast('Google Drive Zugangsdaten entfernt', 'info');
}

function syncToDropbox() { toast('Dropbox Sync - Coming Soon', 'info'); }

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
  const oldStatus  = app.status;
  const oldHistory = app.history ? [...app.history] : [];
  app.status  = newStatus;
  app.history = [...(app.history || []), { status: newStatus, timestamp: nowISO() }];
  schedulePushIfEnabled(app, newStatus);
  await saveApp(app);
  toast(`Status → ${newStatus}`, 'success', {
    actionLabel: 'Rückgängig',
    onAction: () => undoStatusChange(id, oldStatus, oldHistory),
  });
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

// ─── Onboarding-Slider ──────────────────────────────────────────────────────────
// Zeigt eine kurze 3-Schritte-Einführung, aber nur beim allerersten Besuch auf
// einem wirklich leeren, neuen Gerät. isReturningUser kommt als Snapshot aus dem
// Init (vor jedem Schreibzugriff erfasst) und fängt zusammen mit vorhandenen
// Bewerbungen praktisch jeden Bestandsnutzer ab, sodass niemand das Popup
// überraschend nach einem Update zu sehen bekommt.
let _obStep = 0;
function maybeShowOnboarding(isReturningUser) {
  if (localStorage.getItem('jt-onboarding-seen')) { setTimeout(_maybeShowInstallModal, 900); return; }
  if (isReturningUser) {
    localStorage.setItem('jt-onboarding-seen', '1'); // Bestandsnutzer: still merken, nie zeigen
    setTimeout(_maybeShowInstallModal, 900);
    return;
  }
  _obStep = 0;
  _obGoTo(0);
  showModal('onboarding-modal');
}

function _obGoTo(step) {
  _obStep = step;
  document.querySelectorAll('.onboarding-slide').forEach(el => el.classList.toggle('active', Number(el.dataset.obSlide) === step));
  document.querySelectorAll('.onboarding-dot').forEach(el => el.classList.toggle('active', Number(el.dataset.obDot) === step));
  const isLast = step === document.querySelectorAll('.onboarding-slide').length - 1;
  document.getElementById('ob-next-btn').textContent = isLast ? "Los geht's" : 'Weiter';
}

function _obNext() {
  const total = document.querySelectorAll('.onboarding-slide').length;
  if (_obStep >= total - 1) { _obFinish(); return; }
  _obGoTo(_obStep + 1);
}

function _obFinish() {
  localStorage.setItem('jt-onboarding-seen', '1');
  hideModal('onboarding-modal');
  setTimeout(_maybeShowInstallModal, 900);
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
  // Snapshot BEFORE applyTheme()/applySkin()/applySalaryBlur() below write their own
  // localStorage keys on every load - otherwise a brand-new visitor would already look
  // like a "returning user" by the time maybeShowOnboarding() checks these further down.
  const _isReturningUser = !!(
    localStorage.getItem('jt-theme') || localStorage.getItem('jt-skin') ||
    localStorage.getItem('jt-salary-blur') || localStorage.getItem('jt-demo-seeded') ||
    localStorage.getItem('jt-install-dismissed') || localStorage.getItem('jt-sidebar-collapsed') ||
    localStorage.getItem('jt-statuses') || localStorage.getItem('jt-settings') ||
    localStorage.getItem('jt-job-portals') || localStorage.getItem('jt-gd-client-id')
  );

  applyTheme(State.theme);
  applySkin(State.skin);
  applySalaryBlur(State.salaryBlur);
  if (localStorage.getItem('jt-sidebar-collapsed') === '1') {
    document.getElementById('app').classList.add('sidebar-collapsed');
  }
  injectStatusStyles();
  renderStatusSelectOptions();
  try {
    await idbReady; // sicherstellen, dass alle IndexedDB-Stores angelegt sind, bevor sie genutzt werden
  } catch (err) {
    console.error('[idbReady]', err); // z.B. blockiert durch einen anderen offenen Tab mit alter DB-Version
  }
  await loadAll();
  // Capture BEFORE maybeSeedDemoData() runs - it fills State.all with 4 demo entries
  // on a genuinely empty install, which would otherwise make that exact visitor look
  // like they already had data by the time the onboarding check below runs.
  const _hadDataBeforeSeed = State.all.length > 0;
  try {
    await maybeSeedDemoData();
  } catch (err) {
    console.error('[maybeSeedDemoData]', err); // Demo-Daten sind optional, dürfen den Start nicht blockieren
  }
  await loadAll();
  try {
    await loadEvents();
  } catch (err) {
    console.error('[loadEvents]', err); // Kalender bleibt leer statt die ganze Init-Kette zu blockieren
  }
  navigate('dashboard');
  await checkPersistence();
  checkBackupReminder();
  handleShareTarget();
  renderSettingsNotifications();
  renderStatusSettings();
  renderSkinButtons();
  lucide.createIcons();
  // Onboarding (once ever, brand-new visitors only) runs first; the install prompt
  // follows only once that's dismissed, so the two never stack on top of each other.
  setTimeout(() => maybeShowOnboarding(_isReturningUser || _hadDataBeforeSeed), 700);
  // Stale reminder check
  checkStaleReminders();
  checkManualReminders();
  checkWeeklySummary();
  setInterval(checkStaleReminders, 60 * 60 * 1000);
  setInterval(checkManualReminders, 60 * 60 * 1000);
})();
