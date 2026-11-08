/* Habits — a small personal habit tracker.
 * Everything lives in localStorage on this device. No server, no accounts.
 */
'use strict';

const STORE_KEY = 'habit-tracker.v1';
const DAY_MS = 864e5;
const COLORS = ['#3f8f6e', '#3b82f6', '#8b5cf6', '#e0559b', '#f08a24', '#e5534b', '#14a3a3', '#6b7a8f'];
const EMOJIS = ['💧', '🏃', '📚', '🧘', '💪', '🥗', '😴', '✍️', '🎸', '🧹', '💊', '🚶', '🌱', '☀️', '📵', '🦷'];
const WD_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // index 0 = Monday
const WD_LETTER = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/* ---------- Dates (all as local 'YYYY-MM-DD' keys) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const weekdayOf = (k) => (parseKey(k).getDay() + 6) % 7; // 0 = Monday
const weekStart = (k) => addDays(k, -weekdayOf(k));
// The "day" only flips at the chosen hour, so 1 am still counts as yesterday.
const todayKey = () => keyOf(new Date(Date.now() - state.settings.dayEndHour * 36e5));

/* ---------- State ---------- */
function defaultState() {
  return {
    version: 1,
    habits: [],
    log: {}, // { habitId: { 'YYYY-MM-DD': 'done' | 'skip' } } — anything else is "not done"
    settings: { dayEndHour: 3 },
    meta: { firstUse: Date.now(), lastBackup: null, backupSnoozeUntil: 0, hintSeen: false },
  };
}

function cleanHabit(h) {
  if (!h || typeof h !== 'object' || !h.id || !h.name) return null;
  const s = h.schedule || {};
  const type = ['daily', 'weekdays', 'weekly'].includes(s.type) ? s.type : 'daily';
  const days = Array.isArray(s.days) ? s.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  return {
    id: String(h.id),
    name: String(h.name).slice(0, 60),
    emoji: String(h.emoji || '✅').slice(0, 8),
    color: /^#[0-9a-f]{6}$/i.test(h.color) ? h.color : COLORS[0],
    schedule: {
      type: type === 'weekdays' && !days.length ? 'daily' : type,
      days: days.length ? days : [0, 1, 2, 3, 4],
      times: Math.min(7, Math.max(1, parseInt(s.times, 10) || 3)),
    },
    cue: String(h.cue || '').slice(0, 80),
    created: /^\d{4}-\d{2}-\d{2}$/.test(h.created) ? h.created : keyOf(new Date()),
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.habits)) throw new Error('Not a habit backup');
  const d = defaultState();
  const habits = raw.habits.map(cleanHabit).filter(Boolean);
  const log = {};
  const src = raw.log && typeof raw.log === 'object' ? raw.log : {};
  for (const h of habits) {
    log[h.id] = {};
    for (const [k, v] of Object.entries(src[h.id] || {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && (v === 'done' || v === 'skip')) log[h.id][k] = v;
    }
  }
  const hour = parseInt(raw.settings && raw.settings.dayEndHour, 10);
  return {
    version: 1,
    habits,
    log,
    settings: { dayEndHour: hour >= 0 && hour <= 6 ? hour : 3 },
    meta: { ...d.meta, ...(raw.meta || {}) },
  };
}

function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { /* storage blocked */ }
  if (!raw) return defaultState();
  try { return normalize(JSON.parse(raw)); } catch (e) {
    // Never silently throw away data: keep the unreadable copy aside.
    try { localStorage.setItem(STORE_KEY + '.unreadable-' + Date.now(), raw); } catch (_) {}
    return defaultState();
  }
}

let state = load();

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { toast('Couldn’t save — storage is full or blocked'); }
}

const byId = (id) => state.habits.find((h) => h.id === id);
const getStatus = (h, k) => (state.log[h.id] || {})[k] || null;
function setStatus(h, k, v) {
  const m = state.log[h.id] || (state.log[h.id] = {});
  if (v) m[k] = v; else delete m[k];
  save();
}

/* ---------- Habit logic ---------- */
const isWeekly = (h) => h.schedule.type === 'weekly';
const isDue = (h, k) => h.schedule.type !== 'weekdays' || h.schedule.days.includes(weekdayOf(k));

function startKey(h) {
  let start = h.created;
  for (const k of Object.keys(state.log[h.id] || {})) if (k < start) start = k;
  return start;
}

function weekCounts(h, ws) {
  let done = 0, skip = 0;
  for (let i = 0; i < 7; i++) {
    const st = getStatus(h, addDays(ws, i));
    if (st === 'done') done++; else if (st === 'skip') skip++;
  }
  return { done, skip, target: Math.min(h.schedule.times, 7 - skip) };
}

// Turns history into a list of 'success' | 'miss' | 'neutral' units.
// Daily / weekday habits: one unit per day. "N times a week": one unit per week.
function units(h, today) {
  const start = startKey(h);
  const out = [];
  if (isWeekly(h)) {
    const firstWeek = weekStart(start);
    for (let ws = firstWeek; ws <= today; ws = addDays(ws, 7)) {
      const { done, target } = weekCounts(h, ws);
      const current = addDays(ws, 6) >= today;
      if (target <= 0) out.push('neutral');
      else if (done >= target) out.push('success');
      else if (current || ws === firstWeek) out.push('neutral'); // still in progress / partial first week
      else out.push('miss');
    }
  } else {
    for (let k = start; k <= today; k = addDays(k, 1)) {
      const st = getStatus(h, k);
      if (st === 'done') out.push('success');
      else if (st === 'skip' || !isDue(h, k) || k === today) out.push('neutral');
      else out.push('miss');
    }
  }
  return out;
}

// Forgiving streak: one missed day (or week) is forgiven; missing twice in a row resets it.
function streakInfo(h) {
  const u = units(h, todayKey());
  let run = 0, best = 0, misses = 0;
  for (const r of u) {
    if (r === 'success') { run++; misses = 0; }
    else if (r === 'miss') { misses++; if (misses >= 2) run = 0; }
    if (run > best) best = run;
  }
  let last = null;
  for (let i = u.length - 1; i >= 0; i--) if (u[i] !== 'neutral') { last = u[i]; break; }
  return { current: run, best, atRisk: run > 0 && last === 'miss', unit: isWeekly(h) ? 'week' : 'day' };
}

function last30(h) {
  const today = todayKey();
  const start = startKey(h);
  let done = 0, possible = 0, eligible = 0;
  for (let i = 0; i < 30; i++) {
    const k = addDays(today, -i);
    const st = getStatus(h, k);
    if (st === 'done') done++;
    if (k < start || st === 'skip') continue;
    if (k === today && st !== 'done') continue; // today isn't over yet
    if (isWeekly(h)) eligible++;
    else if (st === 'done' || isDue(h, k)) possible++;
  }
  if (isWeekly(h)) possible = Math.round((h.schedule.times * eligible) / 7);
  return { done, possible: Math.max(possible, done) };
}

function scheduleText(h) {
  const s = h.schedule;
  if (s.type === 'daily') return 'Every day';
  if (s.type === 'weekly') return `${s.times}× a week`;
  const d = [...s.days].sort();
  if (d.join() === '0,1,2,3,4') return 'Weekdays';
  if (d.join() === '5,6') return 'Weekends';
  if (d.length === 7) return 'Every day';
  return d.map((i) => WD_SHORT[i]).join(', ');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function streakText(info) {
  if (!info.current) return 'No streak yet';
  return `${info.current}-${info.unit} streak`;
}

/* ---------- Helpers ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
function firstGrapheme(str) {
  str = (str || '').trim();
  if (!str) return '';
  if (window.Intl && Intl.Segmenter) {
    for (const { segment } of new Intl.Segmenter().segment(str)) return segment;
  }
  return Array.from(str)[0];
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const CHECK_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <circle class="ring" cx="16" cy="16" r="14"/>
  <circle class="fill" cx="16" cy="16" r="15"/>
  <path class="tick" d="M10 16.5l4 4 8-8.5"/>
  <path class="dash" d="M11 16h10"/>
</svg>`;

/* ---------- Views ---------- */
let currentTab = 'today';
const view = $('#view');

function render(opts = {}) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === currentTab));
  if (currentTab === 'today') renderToday(opts.justDone);
  else if (currentTab === 'habits') renderHabits();
  else renderSettings();
  refreshDetailSheets();
}

function habitCard(h, today, extraClass = '') {
  const st = getStatus(h, today);
  const info = streakInfo(h);
  const l30 = last30(h);
  let stats;
  if (st === 'skip') stats = 'Rest day — your streak is safe';
  else if (isWeekly(h)) {
    const wc = weekCounts(h, weekStart(today));
    stats = `${wc.done} of ${wc.target} this week · ${streakText(info)}`;
  } else {
    stats = l30.possible
      ? `${streakText(info)} · ${l30.done} of ${l30.possible} in last 30 days`
      : 'New habit — today is day one';
  }
  if (info.atRisk && st !== 'done' && st !== 'skip') stats += ' · <span class="risk">don’t miss twice</span>';
  const cls = st === 'done' ? 'done' : st === 'skip' ? 'skip' : '';
  return `<button class="habit-card ${cls} ${extraClass}" style="--c:${h.color}" data-action="toggle" data-id="${h.id}"
      aria-pressed="${st === 'done'}" aria-label="${esc(h.name)}${st === 'done' ? ', done' : st === 'skip' ? ', rest day' : ''}">
    <span class="hc-emoji">${esc(h.emoji)}</span>
    <span class="hc-text">
      <span class="hc-name" style="display:block">${esc(h.name)}</span>
      ${h.cue ? `<span class="hc-cue" style="display:block">After I ${esc(h.cue)}</span>` : ''}
      <span class="hc-stats" style="display:block">${stats}</span>
    </span>
    <span class="hc-check">${CHECK_SVG}</span>
  </button>`;
}

function needsBackup() {
  if (!state.habits.length) return false;
  const now = Date.now();
  if (now < (state.meta.backupSnoozeUntil || 0)) return false;
  return now - (state.meta.lastBackup || state.meta.firstUse || now) > 7 * DAY_MS;
}

function renderToday(justDone) {
  const today = todayKey();
  const dateLabel = parseKey(today).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const main = [], other = [];
  for (const h of state.habits) {
    if (isWeekly(h)) {
      const wc = weekCounts(h, weekStart(today));
      const metAlready = wc.done >= wc.target && getStatus(h, today) !== 'done';
      (metAlready ? other : main).push(h);
    } else (isDue(h, today) || getStatus(h, today) ? main : other).push(h);
  }
  const counted = main.filter((h) => getStatus(h, today) !== 'skip');
  const doneCount = counted.filter((h) => getStatus(h, today) === 'done').length;
  const pct = counted.length ? Math.round((doneCount / counted.length) * 100) : 0;

  let html = `<header class="page-head">
    <div><div class="eyebrow">${esc(dateLabel)}</div><h1>Today</h1></div>
    <button class="icon-btn" data-action="new" aria-label="Add habit">${ICON_PLUS}</button>
  </header>`;

  if (needsBackup()) {
    const ago = state.meta.lastBackup ? `Your last backup was ${plural(Math.floor((Date.now() - state.meta.lastBackup) / DAY_MS), 'day')} ago.` : 'You haven’t backed up yet.';
    html += `<div class="banner"><p><strong>Time for a backup?</strong> ${ago}</p>
      <button class="btn-ghost" data-action="snooze-backup">Later</button>
      <button class="btn-sm" data-action="export">Back up</button></div>`;
  }

  if (!state.habits.length) {
    html += `<div class="empty"><div class="big">🌱</div><h2>Start with one small habit</h2>
      <p>Pick something easy enough that you can’t say no.</p>
      <button class="btn inline" data-action="new">Add a habit</button></div>`;
    view.innerHTML = html;
    return;
  }

  if (counted.length) html += `<div class="progress-line" aria-label="${doneCount} of ${counted.length} done"><i style="width:${pct}%"></i></div>`;
  html += `<div class="list">${main.map((h) => habitCard(h, today)).join('')}</div>`;
  if (!main.length) html += `<p class="hint">Nothing scheduled today. Enjoy the rest.</p>`;
  else if (counted.length && doneCount === counted.length) html += `<p class="all-done">All done for today ✓</p>`;

  if (other.length) {
    html += `<div class="section-label">Not due today</div>
      <div class="list">${other.map((h) => habitCard(h, today, 'muted')).join('')}</div>`;
  }
  if (!state.meta.hintSeen) {
    html += `<p class="hint">Tip: press and hold a habit for rest day, history and edit.<button data-action="hint-ok">Got it</button></p>`;
  }
  view.innerHTML = html;

  if (justDone) {
    const card = view.querySelector(`.habit-card[data-id="${CSS.escape(justDone)}"]`);
    if (card) celebrate(card);
  }
}

function celebrate(card) {
  card.classList.add('just-done');
  const burst = document.createElement('span');
  burst.className = 'burst';
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const r = 22 + Math.random() * 12;
    const dot = document.createElement('i');
    dot.style.setProperty('--dx', `${Math.cos(a) * r}px`);
    dot.style.setProperty('--dy', `${Math.sin(a) * r}px`);
    burst.appendChild(dot);
  }
  $('.hc-check', card).appendChild(burst);
  setTimeout(() => { burst.remove(); card.classList.remove('just-done'); }, 800);
}

function miniStrip(h) {
  const today = todayKey();
  let s = '';
  for (let i = 13; i >= 0; i--) {
    const k = addDays(today, -i);
    const st = getStatus(h, k);
    s += `<i class="${st || (!isDue(h, k) ? 'off' : '')}"></i>`;
  }
  return `<span class="mini-strip">${s}</span>`;
}

function renderHabits() {
  let html = `<header class="page-head">
    <div><div class="eyebrow">${plural(state.habits.length, 'habit')}</div><h1>Habits</h1></div>
    <button class="icon-btn" data-action="new" aria-label="Add habit">${ICON_PLUS}</button>
  </header>`;
  if (!state.habits.length) {
    html += `<div class="empty"><div class="big">📋</div><h2>No habits yet</h2><p>Add one to see its history here.</p>
      <button class="btn inline" data-action="new">Add a habit</button></div>`;
  } else {
    html += '<div class="list">' + state.habits.map((h) => {
      const info = streakInfo(h);
      return `<button class="row-card" style="--c:${h.color}" data-action="detail" data-id="${h.id}">
        <span class="hc-emoji">${esc(h.emoji)}</span>
        <span class="hc-text">
          <span class="hc-name" style="display:block">${esc(h.name)}</span>
          <span class="hc-stats" style="display:block">${esc(scheduleText(h))} · ${streakText(info)}</span>
          ${miniStrip(h)}
        </span>
        <span class="chev">›</span>
      </button>`;
    }).join('') + '</div>';
  }
  view.innerHTML = html;
}

function hourLabel(h) { return h === 0 ? 'Midnight' : `${h}:00 am`; }

function renderSettings() {
  const lb = state.meta.lastBackup;
  const lbText = lb ? `Last backup ${new Date(lb).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Never backed up';
  const opts = [0, 1, 2, 3, 4, 5, 6].map((h) => `<option value="${h}" ${h === state.settings.dayEndHour ? 'selected' : ''}>${hourLabel(h)}</option>`).join('');
  view.innerHTML = `<header class="page-head"><div><div class="eyebrow">Habits</div><h1>Settings</h1></div></header>
    <div class="section-label">Day</div>
    <div class="group">
      <label class="group-row"><span>Day ends at</span>
        <select class="select" data-change="day-end">${opts}</select></label>
    </div>
    <p class="group-note">Checking off after midnight but before this time still counts for the previous day.</p>

    <div class="section-label">Backup</div>
    <div class="group">
      <button class="group-row action" data-action="export"><span>Export backup (JSON)</span></button>
      <button class="group-row action" data-action="import"><span>Import from backup…</span></button>
    </div>
    <p class="group-note">${lbText}. Your data lives only on this phone — save a backup to Files or iCloud Drive every week or so.</p>

    <div class="section-label">How streaks work</div>
    <div class="group"><div class="group-row"><div>
      <div>Never miss twice</div>
      <div class="sub">One missed day is forgiven. A streak only resets if you miss two scheduled days in a row (two weeks for “times a week” habits). Rest days never count against you.</div>
    </div></div></div>`;
}

/* ---------- Sheets ---------- */
const sheetsEl = $('#sheets');

function openSheet(inner, { tall = false, attrs = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet ${tall ? 'tall' : ''}" role="dialog" aria-modal="true" ${attrs}>${inner}</div>`;
  sheetsEl.appendChild(wrap);
  wrap.getBoundingClientRect(); // force layout so the slide-in animates
  wrap.classList.add('open');
  return wrap;
}

function closeSheet() {
  const open = [...sheetsEl.children].filter((w) => !w.classList.contains('closing'));
  const wrap = open[open.length - 1];
  if (!wrap) return;
  wrap.classList.add('closing');
  wrap.classList.remove('open');
  setTimeout(() => wrap.remove(), 320);
}

function openActions(h) {
  const st = getStatus(h, todayKey());
  openSheet(`<div class="actions">
    <div class="group">
      <div class="title">${esc(h.emoji)} ${esc(h.name)}</div>
      <button class="group-row" data-action="skip-today" data-id="${h.id}">${st === 'skip' ? 'Undo rest day' : 'Rest day (skip today)'}</button>
      <button class="group-row" data-action="detail" data-id="${h.id}">Progress & history</button>
      <button class="group-row" data-action="edit" data-id="${h.id}">Edit habit</button>
    </div>
    <div class="group cancel"><button class="group-row" data-action="close-sheet">Cancel</button></div>
  </div>`);
}

/* Detail sheet with heatmap */
const HM_WEEKS = 20;

function heatmapHTML(h) {
  const today = todayKey();
  const start = startKey(h);
  const first = addDays(weekStart(today), -7 * (HM_WEEKS - 1));
  let months = '', cells = '', lastMonth = -1;
  for (let w = 0; w < HM_WEEKS; w++) {
    const colStart = addDays(first, w * 7);
    const m = parseKey(colStart).getMonth();
    months += `<span>${m !== lastMonth && w < HM_WEEKS - 1 ? parseKey(colStart).toLocaleDateString(undefined, { month: 'short' }) : ''}</span>`;
    lastMonth = m;
    for (let d = 0; d < 7; d++) {
      const k = addDays(first, w * 7 + d);
      if (k > today) { cells += '<span class="hm-cell future"></span>'; continue; }
      const st = getStatus(h, k);
      let cls = st || '';
      if (!st) {
        if (!isDue(h, k)) cls = 'off';
        else if (!isWeekly(h) && k >= start && k < today) cls = 'miss';
      }
      if (k === today) cls += ' today';
      const label = parseKey(k).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      cells += `<button class="hm-cell ${cls}" data-action="hm" data-id="${h.id}" data-k="${k}" aria-label="${label}: ${st === 'done' ? 'done' : st === 'skip' ? 'rest day' : 'not done'}"></button>`;
    }
  }
  const dayLabels = WD_LETTER.map((l, i) => `<span>${i % 2 === 0 ? l : ''}</span>`).join('');
  return `<div class="hm" style="--c:${h.color}">
    <span></span>
    <div class="hm-months" style="grid-template-columns:repeat(${HM_WEEKS},minmax(0,1fr))">${months}</div>
    <div class="hm-days">${dayLabels}</div>
    <div class="hm-grid" style="grid-template-columns:repeat(${HM_WEEKS},minmax(0,1fr))">${cells}</div>
  </div>
  <div class="legend" style="--c:${h.color}">
    <span><i class="hm-cell done"></i>Done</span>
    <span><i class="hm-cell skip"></i>Rest day</span>
    ${isWeekly(h) ? '' : '<span><i class="hm-cell miss"></i>Missed</span>'}
    <span><i class="hm-cell off"></i>Not scheduled</span>
  </div>
  <p class="card-note">Tap any past day to change it: done → rest day → not done.</p>`;
}

function detailDynamic(h) {
  const info = streakInfo(h);
  const l30 = last30(h);
  const st = getStatus(h, todayKey());
  const u = info.unit;
  return `<div class="detail-hero" style="--c:${h.color}">
      <span class="hc-emoji">${esc(h.emoji)}</span>
      <div><h3>${esc(h.name)}</h3><p>${esc(scheduleText(h))}${h.cue ? ` · After I ${esc(h.cue)}` : ''}</p></div>
    </div>
    <div class="stats">
      <div class="stat"><b>${info.current}</b><span>${u} streak${info.atRisk ? '<br><span class="risk">missed 1 — don’t miss twice</span>' : ''}</span></div>
      <div class="stat"><b>${info.best}</b><span>best streak</span></div>
      <div class="stat"><b>${l30.done}<small style="font-size:14px;color:var(--text-3);font-weight:600"> / ${l30.possible}</small></b><span>last 30 days</span></div>
    </div>
    <div class="card">${heatmapHTML(h)}</div>
    <div style="margin-top:16px">
      <button class="btn secondary" data-action="skip-today" data-id="${h.id}">${st === 'skip' ? 'Undo rest day' : 'Take a rest day today'}</button>
    </div>`;
}

function openDetail(h) {
  openSheet(`<header class="sheet-head">
      <button class="link" data-action="close-sheet">Close</button><h2></h2>
      <button class="link right" data-action="edit" data-id="${h.id}">Edit</button>
    </header>
    <div class="sheet-body"><div class="detail-dyn">${detailDynamic(h)}</div></div>`, { tall: true, attrs: `data-detail="${h.id}"` });
}

function refreshDetailSheets() {
  document.querySelectorAll('.sheet[data-detail]').forEach((s) => {
    const h = byId(s.dataset.detail);
    const dyn = $('.detail-dyn', s);
    if (h && dyn) dyn.innerHTML = detailDynamic(h);
  });
}

/* Add / edit sheet */
function openEditor(h) {
  const isNew = !h;
  const d = h || { emoji: EMOJIS[0], name: '', color: COLORS[state.habits.length % COLORS.length], schedule: { type: 'daily', days: [0, 1, 2, 3, 4], times: 3 }, cue: '' };
  const s = d.schedule;
  const wrap = openSheet(`<header class="sheet-head">
      <button class="link" data-action="close-sheet">Cancel</button>
      <h2>${isNew ? 'New habit' : 'Edit habit'}</h2>
      <button class="link right" data-action="save-habit">Save</button>
    </header>
    <div class="sheet-body">
      <form class="habit-form" data-id="${isNew ? '' : d.id}" autocomplete="off">
        <div class="name-row">
          <input class="text-input emoji-input" name="emoji" value="${esc(d.emoji)}" aria-label="Emoji" maxlength="8">
          <input class="text-input" name="name" value="${esc(d.name)}" placeholder="e.g. Drink a glass of water" maxlength="60" aria-label="Habit name" enterkeyhint="done">
        </div>
        <div class="emoji-suggest">${EMOJIS.map((e) => `<button type="button" data-action="pick-emoji" data-e="${e}">${e}</button>`).join('')}</div>

        <label class="field-label">Color</label>
        <div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch ${c === d.color ? 'selected' : ''}" style="--sw:${c}" data-action="pick-color" data-color="${c}" aria-label="Color ${c}"></button>`).join('')}</div>

        <label class="field-label">Schedule</label>
        <div class="segmented">
          ${[['daily', 'Every day'], ['weekdays', 'Some days'], ['weekly', 'X a week']].map(([t, l]) =>
            `<button type="button" class="${s.type === t ? 'selected' : ''}" data-action="sched-type" data-type="${t}">${l}</button>`).join('')}
        </div>
        <div class="sched-extra" data-for="weekdays" ${s.type === 'weekdays' ? '' : 'hidden'}>
          <div class="days">${WD_SHORT.map((n, i) => `<button type="button" class="day-chip ${s.days.includes(i) ? 'selected' : ''}" data-action="pick-day" data-day="${i}" aria-label="${n}">${n.slice(0, 2)}</button>`).join('')}</div>
        </div>
        <div class="sched-extra" data-for="weekly" ${s.type === 'weekly' ? '' : 'hidden'}>
          <div class="stepper">
            <button type="button" data-action="times" data-delta="-1" aria-label="Fewer">−</button>
            <span class="val">${s.times}</span>
            <button type="button" data-action="times" data-delta="1" aria-label="More">+</button>
            <span class="unit">times a week, any days</span>
          </div>
        </div>

        <label class="field-label">Cue (optional)</label>
        <div class="cue-row"><span>After I</span>
          <input class="text-input" name="cue" value="${esc(d.cue)}" placeholder="pour my morning coffee" maxlength="80" enterkeyhint="done">
        </div>
        <p class="form-error" aria-live="polite"></p>
        ${isNew ? '' : `<div style="margin-top:28px"><button type="button" class="btn danger-text" data-action="delete-habit" data-id="${d.id}">Delete habit</button></div>`}
      </form>
    </div>`, { tall: true });
  const form = $('form', wrap);
  form.dataset.type = s.type;
  form.addEventListener('submit', (e) => { e.preventDefault(); saveHabit(form); });
  if (isNew) setTimeout(() => form.elements.name.focus(), 350);
}

function saveHabit(form) {
  const err = $('.form-error', form);
  const name = form.elements.name.value.trim();
  if (!name) { err.textContent = 'Give your habit a name.'; form.elements.name.focus(); return; }
  const type = form.dataset.type;
  const days = [...form.querySelectorAll('.day-chip.selected')].map((b) => +b.dataset.day);
  if (type === 'weekdays' && !days.length) { err.textContent = 'Pick at least one day.'; return; }
  const color = ($('.swatch.selected', form) || {}).dataset?.color || COLORS[0];
  const times = +$('.stepper .val', form).textContent;
  const cue = form.elements.cue.value.trim().replace(/^after i\s+/i, '');
  const emoji = firstGrapheme(form.elements.emoji.value) || '✅';
  const id = form.dataset.id;
  const existing = id && byId(id);
  const habit = cleanHabit({
    id: id || uid(), name, emoji, color, cue,
    schedule: { type, days: days.length ? days : [0, 1, 2, 3, 4], times },
    created: existing ? existing.created : todayKey(),
  });
  if (existing) Object.assign(existing, habit);
  else { state.habits.push(habit); state.log[habit.id] = {}; }
  save();
  closeSheet();
  render();
  toast(existing ? 'Saved' : 'Habit added');
}

/* ---------- Backup ---------- */
function markBackedUp() {
  state.meta.lastBackup = Date.now();
  state.meta.backupSnoozeUntil = 0;
  save();
  render();
}

async function exportData() {
  const payload = { app: 'habits', exportedAt: new Date().toISOString(), ...state };
  const json = JSON.stringify(payload, null, 2);
  const name = `habits-backup-${todayKey()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  // iPhone: the share sheet lets you "Save to Files" (iCloud Drive) or AirDrop it.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Habits backup' });
      markBackedUp();
      toast('Backup saved');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  markBackedUp();
  toast('Backup downloaded');
}

const importInput = $('#import-file');
importInput.addEventListener('change', async () => {
  const f = importInput.files && importInput.files[0];
  importInput.value = '';
  if (!f) return;
  try {
    const next = normalize(JSON.parse(await f.text()));
    const msg = `Replace your current data (${plural(state.habits.length, 'habit')}) with this backup (${plural(next.habits.length, 'habit')})? This can’t be undone.`;
    if (!confirm(msg)) return;
    next.meta.lastBackup = next.meta.lastBackup || Date.now();
    next.meta.firstUse = Math.min(next.meta.firstUse || Date.now(), state.meta.firstUse || Date.now());
    state = next;
    save();
    render();
    toast('Backup restored');
  } catch (e) {
    toast('That file doesn’t look like a Habits backup');
  }
});

/* ---------- Events ---------- */
function toggleToday(h) {
  const today = todayKey();
  const st = getStatus(h, today);
  if (st === 'done') { setStatus(h, today, null); render(); }
  else { setStatus(h, today, 'done'); render({ justDone: h.id }); }
}

const actions = {
  tab: (el) => { currentTab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  toggle: (el) => { const h = byId(el.dataset.id); if (h) toggleToday(h); },
  new: () => openEditor(null),
  'close-sheet': () => closeSheet(),
  detail: (el) => {
    const h = byId(el.dataset.id); if (!h) return;
    if (el.closest('.actions')) closeSheet();
    openDetail(h);
  },
  edit: (el) => {
    const h = byId(el.dataset.id); if (!h) return;
    if (el.closest('.actions')) closeSheet();
    openEditor(h);
  },
  'skip-today': (el) => {
    const h = byId(el.dataset.id); if (!h) return;
    const k = todayKey();
    const wasSkip = getStatus(h, k) === 'skip';
    setStatus(h, k, wasSkip ? null : 'skip');
    if (el.closest('.actions')) closeSheet();
    render();
    toast(wasSkip ? 'Rest day removed' : 'Rest day — streak is safe');
  },
  hm: (el) => {
    const h = byId(el.dataset.id); if (!h) return;
    const k = el.dataset.k;
    const st = getStatus(h, k);
    setStatus(h, k, st === 'done' ? 'skip' : st === 'skip' ? null : 'done');
    render();
  },
  'pick-emoji': (el) => { $('.emoji-input', el.closest('form')).value = el.dataset.e; },
  'pick-color': (el) => {
    el.parentElement.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('selected', s === el));
  },
  'sched-type': (el) => {
    const form = el.closest('form');
    form.dataset.type = el.dataset.type;
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b === el));
    form.querySelectorAll('.sched-extra').forEach((x) => { x.hidden = x.dataset.for !== el.dataset.type; });
  },
  'pick-day': (el) => el.classList.toggle('selected'),
  times: (el) => {
    const v = $('.stepper .val', el.closest('form'));
    v.textContent = Math.min(6, Math.max(1, +v.textContent + +el.dataset.delta));
  },
  'save-habit': (el) => saveHabit($('form', el.closest('.sheet'))),
  'delete-habit': (el) => {
    const h = byId(el.dataset.id); if (!h) return;
    if (!confirm(`Delete “${h.name}” and all its history?`)) return;
    state.habits = state.habits.filter((x) => x.id !== h.id);
    delete state.log[h.id];
    save();
    // close editor and any detail sheet for this habit
    [...sheetsEl.children].forEach(() => closeSheet());
    render();
    toast('Habit deleted');
  },
  export: () => exportData(),
  import: () => importInput.click(),
  'snooze-backup': () => { state.meta.backupSnoozeUntil = Date.now() + 2 * DAY_MS; save(); render(); },
  'hint-ok': () => { state.meta.hintSeen = true; save(); render(); },
};

// Long-press a habit card → quick actions (rest day, history, edit).
let pressTimer = null, pressStart = null, suppressClick = false;
document.addEventListener('pointerdown', (e) => {
  suppressClick = false;
  const card = e.target.closest('.habit-card');
  if (!card) return;
  pressStart = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    suppressClick = true;
    const h = byId(card.dataset.id);
    if (h) openActions(h);
  }, 480);
});
const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
document.addEventListener('pointerup', cancelPress);
document.addEventListener('pointercancel', cancelPress);
document.addEventListener('pointermove', (e) => {
  if (pressTimer && pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
});
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.habit-card')) e.preventDefault(); });

document.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; if (e.target.closest('.habit-card')) { e.preventDefault(); return; } }
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  if (el.dataset.action !== 'pick-emoji' && el.closest('form')) e.preventDefault();
  actions[el.dataset.action](el, e);
});

document.addEventListener('change', (e) => {
  if (e.target.dataset.change === 'day-end') {
    state.settings.dayEndHour = +e.target.value;
    save();
    render();
    toast(`Days now end at ${hourLabel(state.settings.dayEndHour).toLowerCase()}`);
  }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// Re-render when the logical day rolls over or the app comes back to the foreground.
let lastDay = todayKey();
function checkDay() {
  const t = todayKey();
  if (t !== lastDay) { lastDay = t; render(); }
}
setInterval(checkDay, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkDay(); render(); } });
// Pick up changes made in another tab.
window.addEventListener('storage', (e) => { if (e.key === STORE_KEY) { state = load(); render(); } });

/* ---------- Boot ---------- */
try { if (!localStorage.getItem(STORE_KEY)) save(); } catch (e) { /* storage blocked */ }
render();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
