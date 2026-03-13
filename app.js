/*
 * Copyright 2024 Job Application Tracker Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// ─── idb-keyval Store ─────────────────────────────────────────────────────────
const { createStore, get: idbGet, set: idbSet, del: idbDel,
        entries: idbEntries, clear: idbClear } = idbKeyval;
const DB = createStore('jobtracker', 'applications');

// ─── App State ────────────────────────────────────────────────────────────────
const State = {
  all:     [],     // all applications
  filtered:[],     // after filter/sort
  view:    'table',
  sort:    { col: 'applicationDate', dir: 'desc' },
  kanbanSort: {    // per-column sort state
    Offen:     { col: 'applicationDate', dir: 'desc' },
    Interview: { col: 'applicationDate', dir: 'desc' },
    Absage:    { col: 'applicationDate', dir: 'desc' },
    Zusage:    { col: 'applicationDate', dir: 'desc' },
  },
  theme:  localStorage.getItem('jt-theme') || 'system',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uuid() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}
function nowISO()  { return new Date().toISOString(); }
function fmtDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '–';
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
function statusClass(s) {
  const m = { Offen:'open', Interview:'interview', Absage:'absage', Zusage:'zusage' };
  return `badge-${m[s] || 'open'}`;
}
function tlClass(s) {
  const m = { Offen:'tl-open', Interview:'tl-interview', Absage:'tl-absage', Zusage:'tl-zusage' };
  return m[s] || 'tl-open';
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
}

async function saveApp(app) {
  app.updatedAt = nowISO();
  await idbSet(app.id, app, DB);
  await loadAll();
}

async function deleteApp(id) {
  await idbDel(id, DB);
  await loadAll();
  toast('Bewerbung gelöscht', 'info');
}

// ─── Router ───────────────────────────────────────────────────────────────────
function navigate(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('[data-nav]').forEach(el => el.classList.remove('active'));
  document.getElementById(`page-${tab}`)?.classList.add('active');
  document.querySelectorAll(`[data-nav="${tab}"]`).forEach(el => el.classList.add('active'));
  if (tab === 'dashboard') renderDashboard();
  if (tab === 'applications') renderView();
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
    if (search && !`${a.company} ${a.position} ${a.notes||''}`.toLowerCase().includes(search)) return false;
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
  if (el) el.textContent = `${State.filtered.length} von ${State.all.length} Einträgen`;
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
  document.getElementById('f-id').value       = app?.id || '';
  document.getElementById('f-company').value  = app?.company || '';
  document.getElementById('f-position').value = app?.position || '';
  document.getElementById('f-status').value   = app?.status || 'Offen';
  document.getElementById('f-source').value   = app?.source || '';
  document.getElementById('f-salary').value   = app?.expectedSalary || '';
  document.getElementById('f-date').value     = app?.applicationDate?.slice(0,10) || new Date().toISOString().slice(0,10);
  document.getElementById('f-platform').value = app?.platformLink || '';
  document.getElementById('f-docs').value     = app?.documentLink || '';
  document.getElementById('f-rejection').value= app?.rejectionReason || '';
  document.getElementById('f-notes').value    = app?.notes || '';
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
  const history = existing?.history ? [...existing.history] : [];
  const lastStatus = history.length ? history[history.length-1].status : null;
  if (!existing) history.push({ status: newStatus, timestamp: nowISO() });
  else if (lastStatus !== newStatus) history.push({ status: newStatus, timestamp: nowISO() });

  const app = {
    id,
    company:         document.getElementById('f-company').value.trim(),
    position:        document.getElementById('f-position').value.trim(),
    status:          newStatus,
    source:          document.getElementById('f-source').value.trim(),
    expectedSalary:  Number(document.getElementById('f-salary').value) || null,
    applicationDate: document.getElementById('f-date').value,
    platformLink:    document.getElementById('f-platform').value.trim(),
    documentLink:    document.getElementById('f-docs').value.trim(),
    rejectionReason: document.getElementById('f-rejection').value.trim(),
    notes:           document.getElementById('f-notes').value.trim(),
    history,
    createdAt:  existing?.createdAt || nowISO(),
    updatedAt:  nowISO(),
  };
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

  const badge = document.getElementById('d-status-badge');
  badge.textContent = a.status;
  badge.className   = `badge ${statusClass(a.status)}`;

  // Reminder
  const lastTs = a.history?.slice(-1)[0]?.timestamp || a.applicationDate;
  document.getElementById('d-reminder').classList.toggle('hidden', !(a.status === 'Offen' && daysSince(lastTs) > 14));

  // Details
  document.getElementById('d-source').textContent    = a.source || '–';
  document.getElementById('d-date').textContent      = fmtDateTime(a.applicationDate);
  document.getElementById('d-salary').textContent    = fmtEuro(a.expectedSalary);
  document.getElementById('d-rejection').textContent = a.rejectionReason || '–';

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
    'Alle Bewerbungen werden unwiderruflich entfernt. Diese Aktion kann nicht rückgängig gemacht werden.',
    'Löschen', 'danger'
  );
  if (!ok) return;
  await idbClear(DB);
  await loadAll();
  toast('Alle Daten gelöscht', 'info');
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

// ─── PWA Install Prompt ───────────────────────────────────────────────────────
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // Show our custom banner after a short delay
  setTimeout(showInstallBanner, 2000);
});

function showInstallBanner() {
  // Don't show if already installed
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

function showIOSInstallModal() {
  showModal('ios-install-modal');
}

// On iOS (no beforeinstallprompt), show manual instructions after first visit
window.addEventListener('load', () => {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isIOS && !isStandalone && !localStorage.getItem('jt-install-dismissed')) {
    setTimeout(() => {
      const el = document.getElementById('install-banner');
      if (el) { el.classList.remove('hidden'); el.classList.add('visible'); }
    }, 2500);
  }
});

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
  await loadAll();
  navigate('dashboard');
  await checkPersistence();
  handleShareTarget();
  lucide.createIcons();
})();
