/*
 * Copyright 2024 Job Application Tracker Contributors
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// ─── Chart instances ──────────────────────────────────────────────────────────
const Charts = {};

function isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}
function chartColors() {
  return {
    grid:   isDark() ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    text:   isDark() ? '#55556a' : '#9898b2',
    font:   "'Outfit', sans-serif",
  };
}
function destroyChart(id) { if (Charts[id]) { Charts[id].destroy(); delete Charts[id]; } }

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard() {
  const apps = State.all;
  const total      = apps.length;
  const interviews = apps.filter(a => a.status === 'Interview').length;
  const zusagen    = apps.filter(a => a.status === 'Zusage').length;
  const offene     = apps.filter(a => a.status === 'Offen').length;
  const absagen    = apps.filter(a => a.status === 'Absage').length;
  const interviewRate = total ? Math.round(((interviews + zusagen) / total) * 100) : 0;

  const responseTimes = apps
    .filter(a => a.history?.length > 1)
    .map(a => {
      const t0 = new Date(a.history[0].timestamp);
      const t1 = new Date(a.history[1].timestamp);
      return Math.max(0, Math.round((t1 - t0) / 86400000));
    });
  const avgResponse = responseTimes.length
    ? Math.round(responseTimes.reduce((a,b)=>a+b,0) / responseTimes.length)
    : null;

  // ── Weekly goal progress ─────────────────────────────────────────────────
  const goal = State.settings.weeklyGoal || 5;
  const now  = new Date();
  const dayOfWeek = now.getDay() || 7; // Mon=1…Sun=7
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - dayOfWeek + 1);
  weekStart.setHours(0, 0, 0, 0);
  const thisWeek = apps.filter(a => {
    const d = new Date(a.applicationDate);
    return d >= weekStart;
  }).length;
  const pct  = Math.min(100, Math.round((thisWeek / goal) * 100));
  const done = thisWeek >= goal;

  const goalEl = document.getElementById('goal-progress');
  if (goalEl) {
    goalEl.innerHTML = `
      <div class="goal-header">
        <div class="goal-label">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Wochenziel
        </div>
        <div class="goal-value">
          <span style="font-weight:700;color:${done?'var(--status-acc-fg)':'var(--text-primary)'}">${thisWeek}</span>
          <span style="color:var(--text-muted)">/ ${goal}</span>
          <button class="goal-edit-btn" onclick="openGoalEditor()" title="Ziel anpassen">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </div>
      <div class="goal-bar-track">
        <div class="goal-bar-fill${done?' goal-bar-done':''}" style="width:${pct}%"></div>
      </div>
      <div class="goal-sub">${done ? '🎉 Ziel diese Woche erreicht!' : `Noch ${goal - thisWeek} Bewerbung${goal - thisWeek !== 1 ? 'en' : ''} bis zum Ziel`}</div>
    `;
  }

  // KPI Cards
  document.getElementById('kpi-grid').innerHTML = [
    { label:'Gesamt',         value: total,
      sub: `${offene} offen · ${absagen} Absage${absagen!==1?'n':''}`,
      icon:'file-text',   color:'#6366f1', bg:'rgba(99,102,241,.1)' },
    { label:'Interview-Rate', value: interviewRate+'%',
      sub: `${interviews + zusagen} von ${total} erreichten`,
      icon:'trending-up', color:'#22c55e', bg:'rgba(34,197,94,.1)'  },
    { label:'Interviews',     value: interviews,
      sub: `${zusagen} Zusage${zusagen!==1?'n':''}`,
      icon:'users',       color:'#f59e0b', bg:'rgba(245,158,11,.1)' },
    { label:'Ø Antwort',     value: avgResponse !== null ? avgResponse+'d' : '–',
      sub:'bis 1. Statuswechsel',
      icon:'clock',       color:'#ec4899', bg:'rgba(236,72,153,.1)' },
  ].map(k => `
    <div class="kpi-card">
      <div class="kpi-icon" style="background:${k.bg}">
        <i data-lucide="${k.icon}" style="width:15px;height:15px;color:${k.color}"></i>
      </div>
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');

  // Salary stats
  const salaries = apps.map(a => a.expectedSalary).filter(Boolean);
  const avgSalary = salaries.length ? Math.round(salaries.reduce((a,b)=>a+b,0)/salaries.length) : null;
  const minSalary = salaries.length ? Math.min(...salaries) : null;
  const maxSalary = salaries.length ? Math.max(...salaries) : null;

  document.getElementById('salary-grid').innerHTML = [
    { label:'Ø Gehalt',  value: fmtEuro(avgSalary) },
    { label:'Min – Max', value: salaries.length ? `${fmtEuro(minSalary)} – ${fmtEuro(maxSalary)}` : '–' },
    { label:'Top Gehalt',value: fmtEuro(maxSalary) },
  ].map(s => `
    <div class="salary-card">
      <div class="salary-label">${s.label}</div>
      <div class="salary-value">${s.value}</div>
    </div>`).join('');

  lucide.createIcons();
  renderCharts();
}

function openGoalEditor() {
  const cur = State.settings.weeklyGoal || 5;
  const el  = document.getElementById('goal-editor');
  if (!el) return;
  el.classList.toggle('hidden');
  const inp = document.getElementById('goal-input');
  if (inp) { inp.value = cur; inp.focus(); inp.select(); }
}

function saveGoalEditor() {
  const val = Number(document.getElementById('goal-input')?.value) || 5;
  updateWeeklyGoal(val);
  document.getElementById('goal-editor')?.classList.add('hidden');
  toast(`Wochenziel: ${Math.max(1,Math.min(50,val))} Bewerbungen ✓`, 'success');
}

function renderCharts() {
  const c = chartColors();
  const apps = State.all;

  // ── Weekly Bar Chart ──────────────────────────────────────────────────────
  const weekKeys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    weekKeys.push(getWeekKey(d.toISOString()));
  }
  const weekCounts = Object.fromEntries(weekKeys.map(k => [k, 0]));
  apps.forEach(a => {
    const k = getWeekKey(a.applicationDate);
    if (k in weekCounts) weekCounts[k]++;
  });
  const weekLabels = weekKeys.map(k => 'KW' + k.split('-W')[1]);
  const weekData   = weekKeys.map(k => weekCounts[k]);

  destroyChart('weekly');
  const wCtx = document.getElementById('chart-weekly')?.getContext('2d');
  if (wCtx) {
    const grad = wCtx.createLinearGradient(0, 0, 0, 180);
    grad.addColorStop(0,   isDark() ? 'rgba(99,102,241,.7)' : 'rgba(99,102,241,.8)');
    grad.addColorStop(1,   isDark() ? 'rgba(99,102,241,.2)' : 'rgba(99,102,241,.3)');
    Charts.weekly = new Chart(wCtx, {
      type: 'bar',
      data: { labels: weekLabels, datasets: [{ data: weekData, backgroundColor: grad, borderRadius: 5, borderSkipped: false }] },
      options: baseBarOpts(c),
    });
  }

  // ── Rejection Pie ─────────────────────────────────────────────────────────
  const rejMap = {};
  apps.filter(a => a.status === 'Absage').forEach(a => {
    const r = a.rejectionReason?.trim() || 'Kein Grund';
    rejMap[r] = (rejMap[r]||0) + 1;
  });
  const pieWrap = document.getElementById('chart-rejection-wrap');
  destroyChart('rejection');
  if (!Object.keys(rejMap).length) {
    if (pieWrap) pieWrap.innerHTML = `<p style="font-size:.82rem;color:var(--text-muted);text-align:center;padding-top:3rem">Keine Absagen vorhanden</p>`;
  } else {
    if (pieWrap) pieWrap.innerHTML = `<canvas id="chart-rejection"></canvas>`;
    const pCtx = document.getElementById('chart-rejection')?.getContext('2d');
    if (pCtx) {
      const palette = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#8b5cf6','#ec4899','#14b8a6','#6366f1','#84cc16'];
      Charts.rejection = new Chart(pCtx, {
        type: 'doughnut',
        data: {
          labels: Object.keys(rejMap),
          datasets: [{
            data: Object.values(rejMap),
            backgroundColor: palette.slice(0, Object.keys(rejMap).length),
            borderWidth: 2,
            borderColor: isDark() ? '#111118' : '#ffffff',
            hoverOffset: 6,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '65%',
          plugins: {
            legend: {
              position: 'right',
              labels: { color: c.text, font: { family: c.font, size: 11 }, boxWidth: 11, padding: 9 }
            },
            tooltip: tooltipStyle(),
          },
        },
      });
    }
  }

  // ── Source Grouped Bar ────────────────────────────────────────────────────
  const srcMap = {};
  apps.forEach(a => {
    const s = a.source || 'Unbekannt';
    if (!srcMap[s]) srcMap[s] = { total:0, interview:0, zusage:0 };
    srcMap[s].total++;
    if (a.status === 'Interview') srcMap[s].interview++;
    if (a.status === 'Zusage')    { srcMap[s].interview++; srcMap[s].zusage++; } // Zusage counts as interview too
  });
  const srcLabels = Object.keys(srcMap);
  destroyChart('source');
  const sCtx = document.getElementById('chart-source')?.getContext('2d');
  if (sCtx) {
    if (!srcLabels.length) {
      sCtx.canvas.parentElement.innerHTML = `<p style="font-size:.82rem;color:var(--text-muted);text-align:center;padding-top:3rem">Keine Quellen erfasst</p>`;
    } else {
      Charts.source = new Chart(sCtx, {
        type: 'bar',
        data: {
          labels: srcLabels,
          datasets: [
            { label:'Interviews',  data: srcLabels.map(s=>srcMap[s].interview), backgroundColor: isDark()?'rgba(251,191,36,.75)':'rgba(245,158,11,.8)',  borderRadius: 4, borderSkipped: false },
            { label:'Zusagen',     data: srcLabels.map(s=>srcMap[s].zusage),   backgroundColor: isDark()?'rgba(74,222,128,.75)':'rgba(34,197,94,.8)',   borderRadius: 4, borderSkipped: false },
          ],
        },
        options: {
          ...baseBarOpts(c),
          plugins: {
            ...baseBarOpts(c).plugins,
            legend: { labels: { color: c.text, font: { family: c.font, size: 11 }, boxWidth: 11, padding: 10 } },
            tooltip: {
              ...tooltipStyle(),
              callbacks: {
                afterBody: (items) => {
                  const src  = srcLabels[items[0].dataIndex];
                  const tot  = srcMap[src].total;
                  const rate = tot ? Math.round((srcMap[src].interview / tot) * 100) : 0;
                  return `Interview-Rate: ${rate}% (${tot} Bewerbungen)`;
                },
              },
            },
          },
        },
      });
    }
  }
}

function baseBarOpts(c) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: tooltipStyle(),
    },
    scales: {
      x: {
        grid: { color: c.grid, drawBorder: false },
        ticks: { color: c.text, font: { family: c.font, size: 10 } },
      },
      y: {
        grid: { color: c.grid, drawBorder: false },
        ticks: { color: c.text, font: { family: c.font, size: 10 }, precision: 0 },
        beginAtZero: true,
      },
    },
  };
}

function tooltipStyle() {
  const dark = isDark();
  return {
    backgroundColor: dark ? 'rgba(30,30,45,0.95)' : 'rgba(15,15,25,0.92)',
    titleColor: dark ? '#f0f0fa' : '#f0f0fa',
    bodyColor:  dark ? '#8888a8' : '#9898b2',
    borderColor: 'rgba(99,102,241,.3)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 10,
    titleFont: { family: "'Outfit', sans-serif", size: 12, weight: '700' },
    bodyFont:  { family: "'Outfit', sans-serif", size: 11 },
  };
}

// ─── Table / Mobile-Card List ─────────────────────────────────────────────────
const MOBILE_SORT_OPTIONS = [
  { col:'applicationDate', dir:'desc', label:'Neueste zuerst' },
  { col:'applicationDate', dir:'asc',  label:'Älteste zuerst' },
  { col:'company',         dir:'asc',  label:'Firma A–Z' },
  { col:'company',         dir:'desc', label:'Firma Z–A' },
  { col:'status',          dir:'asc',  label:'Status' },
  { col:'expectedSalary',  dir:'desc', label:'Gehalt ↓' },
  { col:'expectedSalary',  dir:'asc',  label:'Gehalt ↑' },
];

function toggleMobileSortMenu(e) {
  e.stopPropagation();
  document.querySelectorAll('.sort-popover').forEach(p => p.remove());
  const btn = e.currentTarget;
  const popover = document.createElement('div');
  popover.className = 'sort-popover sort-popover--mobile';
  const SVG_CHECK = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  popover.innerHTML = MOBILE_SORT_OPTIONS.map(o => {
    const isActive = o.col === State.sort.col && o.dir === State.sort.dir;
    return `<div class="sort-popover-item${isActive ? ' active' : ''}"
      onclick="setMobileSort('${o.col}','${o.dir}')">
      <span style="width:16px;flex-shrink:0;opacity:${isActive ? 1 : 0}">${SVG_CHECK}</span>
      ${o.label}
    </div>`;
  }).join('');
  btn.parentElement.appendChild(popover);
}

function setMobileSort(col, dir) {
  State.sort = { col, dir };
  document.querySelectorAll('.sort-popover').forEach(p => p.remove());
  sortApps();
  renderTable();
}

function renderTable() {
  document.getElementById('view-table').classList.remove('hidden');
  document.getElementById('view-kanban').classList.add('hidden');

  const empty    = document.getElementById('table-empty');
  const isMobile = window.matchMedia('(max-width: 640px)').matches;

  if (!State.filtered.length) {
    if (document.getElementById('table-body')) document.getElementById('table-body').innerHTML = '';
    const listEl = document.getElementById('app-list');
    if (listEl) listEl.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  // ── Mobile card list ────────────────────────────────────────────────────────
  if (isMobile) {
    document.getElementById('table-body').innerHTML = '';
    const list = document.getElementById('app-list');

    // Current sort label for button
    const curSort = MOBILE_SORT_OPTIONS.find(o => o.col === State.sort.col && o.dir === State.sort.dir);
    const sortLabel = curSort?.label || 'Sortierung';

    const SVG_SORT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4"/><path d="M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>`;

    list.innerHTML = `
      <div class="list-sort-bar">
        <span class="list-count">${State.filtered.length} Einträge</span>
        <div style="position:relative">
          <button class="list-sort-btn" onclick="toggleMobileSortMenu(event)">
            ${SVG_SORT}
            <span>${sortLabel}</span>
          </button>
        </div>
      </div>
      <div class="list-cards">
        ${State.filtered.map(a => {
          const lastTs  = a.history?.slice(-1)[0]?.timestamp || a.applicationDate;
          const threshold_t = State.settings?.staleThreshold?.[a.status] ?? (a.status === 'Offen' ? 14 : 0);
          const stale   = threshold_t > 0 && daysSince(lastTs) > threshold_t;
          const dateStr = fmtDateTime(a.applicationDate);
          return `
          <div class="app-card" onclick="openDetail('${a.id}')">
            <div class="app-card-accent s-${statusSlot(a.status)}"></div>
            <div class="app-card-body">
              <div class="app-card-top">
                <div class="app-card-company">
                  ${stale ? '<span class="kanban-stale-dot" title="Offen &gt;14 Tage"></span>' : ''}
                  ${escHtml(a.company)}
                </div>
                <span class="badge ${statusClass(a.status)} app-card-badge">${escHtml(a.status)}</span>
              </div>
              <div class="app-card-position">${escHtml(a.position)}</div>
              <div class="app-card-meta">
                ${a.source ? `<span class="app-card-chip">${escHtml(a.source)}</span>` : ''}
                <span class="app-card-chip app-card-chip--mono">${dateStr}</span>
                ${a.expectedSalary ? `<span class="app-card-chip app-card-chip--accent">${fmtEuroShort(a.expectedSalary)}</span>` : ''}
              </div>
            </div>
            <div class="app-card-actions" onclick="event.stopPropagation()">
              <div style="position:relative">
                <button class="btn btn-icon btn-sm" onclick="showStatusMenu(event,'${a.id}')" title="Status ändern" style="color:var(--accent)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
              </div>
              <button class="btn btn-icon btn-sm" onclick="openForm('${a.id}')" title="Bearbeiten">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="btn btn-icon btn-sm" onclick="confirmDelete('${a.id}')" title="Löschen" style="color:var(--text-muted)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              </button>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    return;
  }

  // ── Desktop table ───────────────────────────────────────────────────────────
  document.getElementById('app-list').innerHTML = '';
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = State.filtered.map(a => {
    const lastTs = a.history?.slice(-1)[0]?.timestamp || a.applicationDate;
    const threshold_d = State.settings?.staleThreshold?.[a.status] ?? (a.status === 'Offen' ? 14 : 0);
    const stale  = threshold_d > 0 && daysSince(lastTs) > threshold_d;
    return `<tr onclick="openDetail('${a.id}')">
      <td class="td-primary">
        ${stale ? '<span class="kanban-stale-dot" title="Offen seit &gt;14 Tagen"></span>' : ''}
        ${escHtml(a.company)}
      </td>
      <td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(a.position)}</td>
      <td>
        <div style="position:relative;display:inline-flex;" data-status-anchor>
          <button class="status-pill" onclick="showStatusMenu(event,'${a.id}')" title="Status ändern">
            <span class="badge ${statusClass(a.status)}" style="pointer-events:none">${escHtml(a.status)}</span>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;opacity:.6"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
        </div>
      </td>
      <td class="hide-md td-mono" style="font-size:0.78rem">${escHtml(a.source||'–')}</td>
      <td class="hide-md td-mono" style="font-size:0.78rem">${fmtDateTime(a.applicationDate)}</td>
      <td class="hide-md td-mono" style="font-size:0.78rem">${fmtEuro(a.expectedSalary)}</td>
      <td onclick="event.stopPropagation()">
        <div class="table-actions">
          <button class="btn btn-icon btn-sm" onclick="openForm('${a.id}')" title="Bearbeiten"><i data-lucide="edit-2" style="width:14px;height:14px"></i></button>
          <button class="btn btn-icon btn-sm" onclick="confirmDelete('${a.id}')" title="Löschen" style="color:var(--text-muted)"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
  lucide.createIcons();
  updateSortHeaders();
}

// ─── Kanban ───────────────────────────────────────────────────────────────────
// Spalten ergeben sich aus den individuell konfigurierbaren Status-Kategorien.
function getKanbanCols() {
  return State.statuses.map(s => ({ status: s.name, dot: s.color, label: s.name }));
}

const KANBAN_SORT_OPTIONS = [
  { col:'applicationDate', dir:'desc', label:'Neueste zuerst' },
  { col:'applicationDate', dir:'asc',  label:'Älteste zuerst' },
  { col:'company',         dir:'asc',  label:'Firma A–Z' },
  { col:'company',         dir:'desc', label:'Firma Z–A' },
  { col:'expectedSalary',  dir:'desc', label:'Gehalt ↓' },
  { col:'expectedSalary',  dir:'asc',  label:'Gehalt ↑' },
];

function renderKanban() {
  document.getElementById('view-table').classList.add('hidden');
  document.getElementById('view-kanban').classList.remove('hidden');

  const board = document.getElementById('kanban-board');
  board.innerHTML = getKanbanCols().map(({ status, dot, label }) => {
    const colApps = sortAppsForKanban(State.filtered.filter(a => a.status === status), status);
    const ks = State.kanbanSort[status] || { col: 'applicationDate', dir: 'desc' };
    const currentSortLabel = KANBAN_SORT_OPTIONS.find(o => o.col===ks.col && o.dir===ks.dir)?.label || 'Sortierung';

    const cards = colApps.map(a => {
      const lastTs    = a.history?.slice(-1)[0]?.timestamp || a.applicationDate;
      const threshold = State.settings.staleThreshold?.[status] ?? (status === 'Offen' ? 14 : 0);
      const stale     = threshold > 0 && daysSince(lastTs) > threshold;
      const eventCount = a.history?.length || 0;
      // Get the most recent history note to show as preview
      const lastNote = [...(a.history||[])].reverse().find(h => h.note)?.note || '';

      return `<div class="kanban-card s-${statusSlot(status)}"
        draggable="true"
        data-id="${a.id}"
        ondragstart="onDragStart(event,'${a.id}')"
        ontouchstart="onTouchStart(event,'${a.id}')"
        ontouchmove="onTouchMove(event)"
        ontouchend="onTouchEnd(event)"
        onclick="openDetail('${a.id}')"
        style="touch-action:none">
        <!-- Drag handle + content -->
        <div class="kc-layout">
          <div class="kc-handle" title="Ziehen zum Verschieben" onclick="event.stopPropagation()">
            <svg width="10" height="14" viewBox="0 0 10 16" fill="currentColor"><circle cx="3" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/><circle cx="3" cy="6" r="1.2"/><circle cx="7" cy="6" r="1.2"/><circle cx="3" cy="10" r="1.2"/><circle cx="7" cy="10" r="1.2"/><circle cx="3" cy="14" r="1.2"/><circle cx="7" cy="14" r="1.2"/></svg>
          </div>
          <div class="kc-body">
            <div class="kc-top">
              <span class="kc-company">
                ${stale ? '<span class="kanban-stale-dot" title="Lange keine Änderung"></span>' : ''}
                ${escHtml(a.company)}
              </span>
              ${(a.contactName || a.contactEmail) ? `
                <span class="kc-person" title="${escHtml(a.contactName||a.contactEmail)}">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </span>` : ''}
            </div>
            <div class="kc-position">${escHtml(a.position)}</div>
            <div class="kc-meta">
              <span class="kc-date">${fmtDateShort(a.applicationDate)}</span>
              ${a.expectedSalary ? `<span class="kc-salary">${fmtEuroShort(a.expectedSalary)}</span>` : ''}
            </div>
            ${lastNote ? `<div class="kc-note-pill">${escHtml(lastNote)}</div>` : ''}
            <div class="kc-bottom">
              ${eventCount > 0 ? `<span class="kc-events">${eventCount} Ereignis${eventCount !== 1 ? 'se' : ''}</span>` : ''}
              <div style="position:relative;margin-left:auto" data-status-anchor>
                <button class="kc-status-btn" onclick="showStatusMenu(event,'${a.id}')" title="Status ändern">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    return `<div>
      <div class="kanban-col-header">
        <div class="kanban-col-title">
          <span class="kanban-col-dot" style="background:${escAttr(dot)}"></span>
          ${escHtml(label)}
          <span class="kanban-col-count">${colApps.length}</span>
        </div>
        <div style="position:relative">
          <button class="kanban-sort-btn" onclick="toggleKanbanSortMenu(event,'${escJs(status)}')" title="Sortierung">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="5 12 12 5 19 12"/><line x1="12" y1="19" x2="12" y2="5" style="display:none"/></svg>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4"/><path d="M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
            <span class="sort-label">${currentSortLabel}</span>
          </button>
        </div>
      </div>
      <div class="kanban-col kanban-col-body"
        data-status="${escAttr(status)}"
        ondragover="onDragOver(event)"
        ondrop="onDrop(event,'${escJs(status)}')"
        ondragleave="onDragLeave(event)">
        ${cards || `<div style="padding:1rem 0.5rem;text-align:center;font-size:0.75rem;color:var(--text-muted)">Keine Einträge</div>`}
      </div>
    </div>`;
  }).join('');
  lucide.createIcons();
}

function toggleKanbanSortMenu(e, status) {
  e.stopPropagation();
  // Remove existing popovers
  document.querySelectorAll('.sort-popover').forEach(p => p.remove());

  const btn = e.currentTarget;
  const ks  = State.kanbanSort[status] || { col: 'applicationDate', dir: 'desc' };
  const popover = document.createElement('div');
  popover.className = 'sort-popover';
  const SVG_CHECK = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  popover.innerHTML = KANBAN_SORT_OPTIONS.map(o => {
    const isActive = o.col===ks.col && o.dir===ks.dir;
    return `<div class="sort-popover-item${isActive?' active':''}" onclick="sortKanbanCol('${escJs(status)}','${o.col}','${o.dir}')">
      <span style="width:16px;flex-shrink:0;opacity:${isActive?1:0}">${SVG_CHECK}</span>
      ${o.label}
    </div>`;
  }).join('');

  btn.parentElement.appendChild(popover);
}

// ─── Kalender ─────────────────────────────────────────────────────────────────
const CALENDAR_WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function renderCalendar() {
  renderCalendarGrid();
  renderUpcomingEvents();
  populateEventAppSelect();
}

function renderCalendarGrid() {
  const grid = document.getElementById('calendar-grid');
  const label = document.getElementById('calendar-month-label');
  if (!grid) return;

  const base  = State.calendarMonth;
  const year  = base.getFullYear(), month = base.getMonth();
  if (label) label.textContent = base.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

  const firstOfMonth = new Date(year, month, 1);
  const startOffset  = (firstOfMonth.getDay() + 6) % 7; // Woche beginnt Montag
  const daysInMonth   = new Date(year, month + 1, 0).getDate();
  const totalCells    = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const gridStart      = new Date(year, month, 1 - startOffset);
  const todayStr        = localDateStr(new Date());

  const eventsByDate = {};
  State.events.forEach(e => { (eventsByDate[e.date] ||= []).push(e); });

  let html = CALENDAR_WEEKDAYS.map(d => `<div class="calendar-weekday">${d}</div>`).join('');

  for (let i = 0; i < totalCells; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const dStr      = localDateStr(d);
    const inMonth   = d.getMonth() === month;
    const isToday   = dStr === todayStr;
    const dayEvents = (eventsByDate[dStr] || []).slice().sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    const shown     = dayEvents.slice(0, 3);
    const more      = dayEvents.length - shown.length;

    html += `<div class="calendar-cell${inMonth ? '' : ' out-month'}${isToday ? ' today' : ''}" onclick="openEventModal('${dStr}')">
      <div class="calendar-cell-num">${d.getDate()}</div>
      <div class="calendar-cell-events">
        ${shown.map(ev => {
          const app  = ev.appId ? State.all.find(a => a.id === ev.appId) : null;
          const cls  = `s-${app ? statusSlot(app.status) : 0}`;
          const text = app ? app.company : ev.title;
          const tip  = (ev.time ? ev.time + ' · ' : '') + ev.title;
          return `<div class="calendar-event-pill badge-dyn ${cls}" onclick="event.stopPropagation();openEventModal('${dStr}','${ev.id}')" title="${escAttr(tip)}">
            ${ev.time ? `<span class="calendar-event-time">${escHtml(ev.time)}</span>` : ''}${escHtml(text)}
          </div>`;
        }).join('')}
        ${more > 0 ? `<div class="calendar-more">+${more} weitere</div>` : ''}
      </div>
    </div>`;
  }

  grid.innerHTML = html;
}

function renderUpcomingEvents() {
  const el = document.getElementById('upcoming-events');
  if (!el) return;
  const todayStr = localDateStr(new Date());
  const upcoming = State.events
    .filter(e => e.date >= todayStr)
    .sort((a, b) => `${a.date} ${a.time || '99:99'}`.localeCompare(`${b.date} ${b.time || '99:99'}`))
    .slice(0, 12);

  if (!upcoming.length) {
    el.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);padding:0.5rem 0.25rem">Keine anstehenden Termine.</p>`;
    return;
  }

  el.innerHTML = upcoming.map(ev => {
    const app       = ev.appId ? State.all.find(a => a.id === ev.appId) : null;
    const cls       = `s-${app ? statusSlot(app.status) : 0}`;
    const isToday   = ev.date === todayStr;
    const dateLabel = isToday ? 'Heute' : fmtDateShort(ev.date);
    return `<div class="upcoming-item" onclick="openEventModal('${ev.date}','${ev.id}')">
      <div class="stc-dot ${cls}"></div>
      <div class="upcoming-body">
        <div class="upcoming-title">${escHtml(ev.title)}</div>
        ${app ? `<div class="upcoming-sub">${escHtml(app.company)} – ${escHtml(app.position)}</div>` : ''}
      </div>
      <div class="upcoming-date${isToday ? ' upcoming-date--today' : ''}">${dateLabel}${ev.time ? ` · ${escHtml(ev.time)}` : ''}</div>
    </div>`;
  }).join('');
}

// Hide/show columns based on viewport; re-render table at mobile breakpoint
const mq_sm = window.matchMedia('(max-width: 640px)');
const mq_md = window.matchMedia('(max-width: 900px)');
function applyCssHideClasses() {
  document.querySelectorAll('.hide-sm').forEach(el => el.style.display = mq_sm.matches ? 'none' : '');
  document.querySelectorAll('.hide-md').forEach(el => el.style.display = mq_md.matches ? 'none' : '');
  // Switch table ↔ card-list when crossing 640px
  if (State.view === 'table' && document.getElementById('page-applications')?.classList.contains('active')) {
    renderTable();
  }
}
mq_sm.addEventListener('change', applyCssHideClasses);
mq_md.addEventListener('change', applyCssHideClasses);
window.addEventListener('load', applyCssHideClasses);
