// shared/data.js
// Every read and write of saved data goes through this file, so the popup
// (and later the background worker and the pill) all behave the same way.
//
// Everything lives in chrome.storage.local:
//   clients:      [{ id, name, color, rate, note, archived? }]
//   entries:      [{ id, clientId, tasks, note, start, end, rate }]   (times are ms timestamps)
//   timer:        null, or { status: 'running' | 'paused', clientId, tasks, note, start, carriedMs }
//   (tasks is a list, e.g. ['Photoshop', 'Figma']. Older data has a single `task`; use tasksOf().)
//   lastClientId: the client used most recently (preselected next time)
//   theme:        'light', 'dark', or null to follow the computer's setting
//
// We store timestamps, never a running count: elapsed time is always
// "now - start", so it stays correct even if Chrome puts the extension to sleep.
//
// Pausing closes the current stretch of time as a finished entry.
// Resuming starts a new stretch for the same client, tasks and note.
// That keeps every entry a simple start → end with no hidden pause time.
// `carriedMs` remembers the earlier stretches so the clock can show the
// whole session (e.g. 0:40 before a pause + 0:05 after = 0:45).

// Task tags, grouped so the list reads in order: making the work, then talking
// to the client, then getting paid. "Invoice" is just a tag for time spent
// invoicing; Hourglass itself still stops at the CSV.
export const TASK_GROUPS = [
  ['Design', ['Figma', 'Illustrator', 'Photoshop', 'Canva', 'Squarespace', 'Other']],
  ['Clients & admin', ['Email', 'Call', 'Invoice']],
];
export const TASKS = TASK_GROUPS.flatMap(([, tasks]) => tasks);

// Client palette: a rainbow, in order. Picked so every pair is clearly different
// (checked with a color-difference validator) and so none of them can be mistaken
// for the status colors: crimson is deeper than delete-red, lime is greener than
// paused-amber, and forest is darker than running-green.
export const CLIENT_COLORS = {
  crimson: '#A8233F',
  tangerine: '#E8781E',
  lime: '#A6AA0E',
  forest: '#2F7A2F',
  lagoon: '#119EAE',
  cobalt: '#2E4FBF',
  violet: '#9446D6',
  peony: '#EE6FA5',
};

// Names from the first palette, so older clients still get a matching color
export const COLOR_ALIASES = { coral: 'tangerine', lilac: 'violet', sky: 'lagoon' };

// A client's color name → hex (muted gray if it's somehow unknown)
export function colorHex(name) {
  return CLIENT_COLORS[name] || CLIENT_COLORS[COLOR_ALIASES[name]] || '#6E6862';
}

const DEFAULTS = { clients: [], entries: [], timer: null, lastClientId: null, theme: null };

// crypto.randomUUID only exists on https pages, and the pill also runs on plain http pages.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// The tasks on an entry or timer. Older data stored one `task`; newer stores `tasks`.
export function tasksOf(item) {
  if (item.tasks && item.tasks.length) return item.tasks;
  return item.task ? [item.task] : ['Other'];
}

// "Photoshop, Figma"
export function formatTasks(item) {
  return tasksOf(item).join(', ');
}

// ---------- Reading ----------

export async function getState() {
  return chrome.storage.local.get(DEFAULTS);
}

// Deleted clients are only hidden (archived) so old entries keep their name and rate.
export function activeClients(state) {
  return state.clients.filter((c) => !c.archived);
}

export function findClient(state, id) {
  return state.clients.find((c) => c.id === id);
}

// ---------- Settings ----------

export async function setTheme(theme) {
  await chrome.storage.local.set({ theme });
}

// ---------- Clients ----------

export async function addClient({ name, color, rate, note = '' }) {
  const { clients } = await getState();
  clients.push({ id: newId(), name, color, rate, note });
  await chrome.storage.local.set({ clients });
}

export async function updateClient(id, changes) {
  const { clients } = await getState();
  const client = clients.find((c) => c.id === id);
  if (!client) throw new Error('That client no longer exists.');
  Object.assign(client, changes);
  await chrome.storage.local.set({ clients });
}

export async function deleteClient(id) {
  const { clients, timer } = await getState();
  if (timer && timer.clientId === id) {
    throw new Error('Stop the timer for this client before deleting it.');
  }
  const client = clients.find((c) => c.id === id);
  if (client) client.archived = true;
  await chrome.storage.local.set({ clients });
}

// ---------- Timer ----------

// If the timer is running, save the stretch from its start until `now` as an entry.
// Returns the length of that stretch in ms.
function closeRunningStretch(state, now) {
  const t = state.timer;
  if (!t || t.status !== 'running') return 0;
  const length = now - t.start;
  if (length < 1000) return length; // ignore accidental double-clicks
  const client = findClient(state, t.clientId);
  state.entries.push({
    id: newId(),
    clientId: t.clientId,
    tasks: tasksOf(t),
    note: t.note,
    start: t.start,
    end: now,
    rate: client ? client.rate : 0, // rate is copied so later rate changes don't rewrite old work
  });
  return length;
}

async function saveTimerState(state) {
  await chrome.storage.local.set({
    entries: state.entries,
    timer: state.timer,
    lastClientId: state.lastClientId,
  });
}

export async function startTimer({ clientId, tasks, note }) {
  const state = await getState();
  const now = Date.now();
  closeRunningStretch(state, now); // one timer at a time
  state.timer = { status: 'running', clientId, tasks, note, start: now, carriedMs: 0 };
  state.lastClientId = clientId;
  await saveTimerState(state);
}

export async function pauseTimer() {
  const state = await getState();
  if (!state.timer || state.timer.status !== 'running') return;
  const length = closeRunningStretch(state, Date.now());
  state.timer = {
    ...state.timer,
    status: 'paused',
    start: null,
    carriedMs: state.timer.carriedMs + length,
  };
  await saveTimerState(state);
}

export async function resumeTimer() {
  const state = await getState();
  if (!state.timer || state.timer.status !== 'paused') return;
  state.timer = { ...state.timer, status: 'running', start: Date.now() };
  await saveTimerState(state);
}

// Change which tasks the running (or paused) timer is tagged with.
// It's still one piece of work for the same client, so the clock keeps going.
export async function setTimerTasks(tasks) {
  const state = await getState();
  if (!state.timer || tasks.length === 0) return;
  state.timer = { ...state.timer, tasks };
  delete state.timer.task;
  await saveTimerState(state);
}

export async function stopTimer() {
  const state = await getState();
  if (!state.timer) return;
  closeRunningStretch(state, Date.now());
  state.timer = null;
  await saveTimerState(state);
}

// Ends the current entry and starts a new one for another client, in one step.
// The tasks carry over; the note is cleared because it was about the old client.
export async function switchClient(clientId) {
  const state = await getState();
  if (!state.timer) return;
  const now = Date.now();
  closeRunningStretch(state, now);
  state.timer = {
    status: 'running',
    clientId,
    tasks: tasksOf(state.timer),
    note: '',
    start: now,
    carriedMs: 0,
  };
  state.lastClientId = clientId;
  await saveTimerState(state);
}

// ---------- Math and formatting ----------

// Total time shown on the clock for the current session.
export function sessionMs(timer, now = Date.now()) {
  if (!timer) return 0;
  const current = timer.status === 'running' ? now - timer.start : 0;
  return timer.carriedMs + current;
}

export function entryMs(entry) {
  return entry.end - entry.start;
}

export function entryAmount(entry) {
  return (entryMs(entry) / 3600000) * entry.rate;
}

// Time and money worked between two moments (optionally for one client),
// counting saved entries plus the stretch that is running right now.
export function workedBetween(state, from, to, clientId = null, now = Date.now()) {
  let ms = 0;
  let amount = 0;
  const add = (start, end, rate, entryClientId) => {
    if (clientId && entryClientId !== clientId) return;
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    if (e <= s) return;
    ms += e - s;
    amount += ((e - s) / 3600000) * rate;
  };
  for (const e of state.entries) add(e.start, e.end, e.rate, e.clientId);
  const t = state.timer;
  if (t && t.status === 'running') {
    const client = findClient(state, t.clientId);
    add(t.start, now, client ? client.rate : 0, t.clientId);
  }
  return { ms, amount };
}

// Midnight today, as a timestamp
export function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Midnight on Sunday of this week (weeks run Sunday to Saturday)
export function startOfWeek(now = Date.now()) {
  const d = new Date(startOfToday(now));
  d.setDate(d.getDate() - d.getDay()); // getDay() is 0 on Sunday
  return d.getTime();
}

// The most recently finished entry, or undefined
export function lastEntry(state) {
  return state.entries.reduce((latest, e) => (!latest || e.end > latest.end ? e : latest), undefined);
}

// The most recent entry for one client, or undefined
export function lastEntryFor(state, clientId) {
  return lastEntry({ entries: state.entries.filter((e) => e.clientId === clientId) });
}

// Clients you've worked for most recently come first; ones never used keep their order
export function clientsByRecent(state) {
  const lastUsed = (c) => (lastEntryFor(state, c.id) || { end: 0 }).end;
  return activeClients(state).sort((a, b) => lastUsed(b) - lastUsed(a));
}

// 2520000 → "0h 42m"
export function formatHours(ms) {
  const minutes = Math.floor(ms / 60000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Short enough for the toolbar badge (about 4 characters):
// 2520000 → "0:42", 37800000 → "10h"
export function formatBadge(ms) {
  const minutes = Math.floor(ms / 60000);
  const h = Math.floor(minutes / 60);
  if (h >= 10) return `${h}h`;
  return `${h}:${String(minutes % 60).padStart(2, '0')}`;
}

// 3725000 → "1:02:05"
export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// formatMoney(1075) → "$1,075.00", formatMoney(1075, 0) → "$1,075"
export function formatMoney(amount, decimals = 2) {
  return '$' + amount.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// 75 → "$75/hr", 72.5 → "$72.50/hr"
export function formatRate(rate) {
  return formatMoney(rate, Number.isInteger(rate) ? 0 : 2) + '/hr';
}

export function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// 4800000 → "1:20" (hours:minutes, for entry rows)
export function formatShortDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

// "Today", "Yesterday", or e.g. "Mon, Oct 27"
export function formatDayLabel(timestamp, now = Date.now()) {
  const day = startOfToday(timestamp);
  const today = startOfToday(now);
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  return new Date(timestamp).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---------- Entries (editing, past time) ----------

function checkEntry(entry, state) {
  if (!findClient(state, entry.clientId)) throw new Error('Choose a client.');
  if (!entry.tasks || entry.tasks.length === 0) throw new Error('Pick at least one task.');
  if (Number.isNaN(entry.start) || Number.isNaN(entry.end)) throw new Error('Enter a start and end time.');
  if (entry.end <= entry.start) throw new Error('End time must be after start time.');
  if (entry.end > Date.now() + 60000) throw new Error("That time hasn't happened yet.");
}

// For work done away from the computer (sketching, calls)
export async function addEntry({ clientId, tasks, note, start, end }) {
  const state = await getState();
  const entry = { id: newId(), clientId, tasks, note, start, end, rate: 0 };
  checkEntry(entry, state);
  entry.rate = findClient(state, clientId).rate;
  state.entries.push(entry);
  await chrome.storage.local.set({ entries: state.entries });
}

export async function updateEntry(id, changes) {
  const state = await getState();
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) throw new Error('That entry no longer exists.');
  const updated = { ...entry, ...changes };
  if (!changes.tasks) updated.tasks = tasksOf(entry); // keep older single-task entries valid
  checkEntry(updated, state);
  // Moving work to another client bills it at that client's rate
  if (updated.clientId !== entry.clientId) updated.rate = findClient(state, updated.clientId).rate;
  delete updated.task; // older entries had a single task; tasks replaces it
  Object.keys(entry).forEach((k) => delete entry[k]);
  Object.assign(entry, updated);
  await chrome.storage.local.set({ entries: state.entries });
}

export async function deleteEntry(id) {
  const { entries } = await getState();
  await chrome.storage.local.set({ entries: entries.filter((e) => e.id !== id) });
}

// Entries that started between two moments (optionally for one client), newest first
export function entriesBetween(state, from, to, clientId = null) {
  return state.entries
    .filter((e) => e.start >= from && e.start < to && (!clientId || e.clientId === clientId))
    .sort((a, b) => b.start - a.start);
}

export function totalOf(entries) {
  return entries.reduce(
    (sum, e) => ({ ms: sum.ms + entryMs(e), amount: sum.amount + entryAmount(e) }),
    { ms: 0, amount: 0 },
  );
}

// ---------- Dates ----------

// Calendar-safe (handles daylight saving changes)
export function addDays(timestamp, days) {
  const d = new Date(timestamp);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function startOfMonth(now = Date.now()) {
  const d = new Date(startOfToday(now));
  d.setDate(1);
  return d.getTime();
}

export function addMonths(timestamp, months) {
  const d = new Date(timestamp);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

// Named ranges used by the Entries and Export screens → { from, to }
export const RANGES = {
  today: 'Today',
  week: 'This week',
  lastWeek: 'Last week',
  month: 'This month',
  lastMonth: 'Last month',
  all: 'All time',
};

export function dateRange(name, now = Date.now()) {
  const today = startOfToday(now);
  const week = startOfWeek(now);
  const month = startOfMonth(now);
  switch (name) {
    case 'today': return { from: today, to: addDays(today, 1) };
    case 'week': return { from: week, to: addDays(week, 7) };
    case 'lastWeek': return { from: addDays(week, -7), to: week };
    case 'month': return { from: month, to: addMonths(month, 1) };
    case 'lastMonth': return { from: addMonths(month, -1), to: month };
    default: return { from: 0, to: Infinity };
  }
}

// ---------- Stats ----------

// Every piece of work overlapping [from, to), trimmed to fit it,
// including the stretch that is running right now.
export function piecesBetween(state, from, to, now = Date.now()) {
  const pieces = [];
  const add = (start, end, rate, clientId, tasks) => {
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    if (e <= s) return;
    pieces.push({ clientId, tasks, start: s, ms: e - s, amount: ((e - s) / 3600000) * rate });
  };
  for (const e of state.entries) add(e.start, e.end, e.rate, e.clientId, tasksOf(e));
  const t = state.timer;
  if (t && t.status === 'running') {
    const client = findClient(state, t.clientId);
    add(t.start, now, client ? client.rate : 0, t.clientId, tasksOf(t));
  }
  return pieces;
}

// For "By task": a piece tagged with several tasks is shared evenly between them,
// so the task totals still add up to the real time worked.
export function splitByTask(pieces) {
  return pieces.flatMap((p) => p.tasks.map((task) => ({ ...p, task, ms: p.ms / p.tasks.length, amount: p.amount / p.tasks.length })));
}

export function sumPieces(pieces) {
  return pieces.reduce((sum, p) => ({ ms: sum.ms + p.ms, amount: sum.amount + p.amount }), { ms: 0, amount: 0 });
}

// Totals per client or day: groupPieces(pieces, (p) => p.clientId) → [{ key, ms, amount }], biggest first
export function groupPieces(pieces, keyOf) {
  const groups = new Map();
  for (const p of pieces) {
    const key = keyOf(p);
    const g = groups.get(key) || { key, ms: 0, amount: 0 };
    g.ms += p.ms;
    g.amount += p.amount;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.amount - a.amount || b.ms - a.ms);
}

// A week, month or year (offset 0 = the current one, -1 = the one before)
// split into bars: days for a week or month, months for a year.
export function statsPeriod(kind, offset = 0, now = Date.now()) {
  const short = (ts, opts) => new Date(ts).toLocaleDateString('en-US', opts);
  if (kind === 'year') {
    const year = new Date(now).getFullYear() + offset;
    const from = new Date(year, 0, 1).getTime();
    const buckets = Array.from({ length: 12 }, (_, i) => {
      const start = new Date(year, i, 1).getTime();
      return { from: start, to: new Date(year, i + 1, 1).getTime(), axis: 'JFMAMJJASOND'[i], name: short(start, { month: 'long', year: 'numeric' }) };
    });
    return { from, to: new Date(year + 1, 0, 1).getTime(), label: String(year), buckets };
  }
  if (kind === 'month') {
    const from = addMonths(startOfMonth(now), offset);
    const to = addMonths(from, 1);
    const buckets = [];
    for (let day = from; day < to; day = addDays(day, 1)) {
      const date = new Date(day).getDate();
      buckets.push({ from: day, to: addDays(day, 1), axis: [1, 8, 15, 22, 29].includes(date) ? String(date) : '', name: short(day, { weekday: 'short', month: 'short', day: 'numeric' }) });
    }
    return { from, to, label: short(from, { month: 'long', year: 'numeric' }), buckets };
  }
  const from = addDays(startOfWeek(now), 7 * offset);
  const to = addDays(from, 7);
  const buckets = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(from, i);
    return { from: day, to: addDays(day, 1), axis: 'SMTWTFS'[i], name: short(day, { weekday: 'short', month: 'short', day: 'numeric' }) };
  });
  const last = addDays(to, -1);
  return { from, to, label: `${short(from, { month: 'short', day: 'numeric' })} – ${short(last, { month: 'short', day: 'numeric' })}`, buckets };
}

// Values for <input type="date"> ("2026-10-27") and <input type="time"> ("14:05")
const pad = (n) => String(n).padStart(2, '0');

export function toDateInput(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toTimeInput(timestamp) {
  const d = new Date(timestamp);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A date plus start and end times → { start, end } timestamps.
// An end time earlier than the start means the work ran past midnight.
export function timesFromInputs(date, startTime, endTime) {
  const start = new Date(`${date}T${startTime}`).getTime();
  let end = new Date(`${date}T${endTime}`).getTime();
  if (end < start) end = addDays(end, 1);
  return { start, end };
}

// ---------- CSV export ----------

function csvCell(value) {
  let text = String(value);
  if (/^[=+@]/.test(text)) text = "'" + text; // stop spreadsheets treating notes as formulas
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// One row per entry, oldest first, ready for a spreadsheet or invoice
export function entriesToCsv(state, entries) {
  const header = ['Date', 'Client', 'Tasks', 'Note', 'Start', 'End', 'Hours', 'Rate', 'Amount'];
  const rows = [...entries].sort((a, b) => a.start - b.start).map((e) => {
    const client = findClient(state, e.clientId);
    return [
      toDateInput(e.start),
      client ? client.name : '',
      tasksOf(e).join(', '),
      e.note || '',
      toTimeInput(e.start),
      toTimeInput(e.end),
      (entryMs(e) / 3600000).toFixed(2),
      e.rate.toFixed(2),
      entryAmount(e).toFixed(2),
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
