// shared/data.js
// Every read and write of saved data goes through this file, so the popup
// (and later the background worker and the pill) all behave the same way.
//
// Everything lives in chrome.storage.local:
//   clients:      [{ id, name, color, rate, note, archived? }]
//   entries:      [{ id, clientId, tasks, note, start, end, rate }]   (times are ms timestamps)
//   timer:        null, or { status: 'running' | 'paused', clientId, tasks, note, start, carriedMs }
//   (tasks is a list, e.g. ['Photoshop', 'Figma']. Older data has a single `task`; use tasksOf().)
//   (timer.targetMs, if set, makes the clock count down: it's the session time at which the
//    countdown hits zero. timer.alerted means the "time's up" notification already went out.)
//   (timer.away is { since, until } while you're away from the computer. `until` stays null
//    until you're back; once set, Hourglass asks whether to keep or discard that time.)
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

// `minutes` (optional) starts it counting down instead of up.
export async function startTimer({ clientId, tasks, note, minutes = null }) {
  checkMinutes(minutes);
  const state = await getState();
  const now = Date.now();
  closeRunningStretch(state, now); // one timer at a time
  state.timer = { status: 'running', clientId, tasks, note, start: now, carriedMs: 0, targetMs: minutes ? minutes * 60000 : null };
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
    away: null,
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

// ---------- Idle check ----------

export const IDLE_MS = 5 * 60000; // this long away before Hourglass asks

// You've gone away. Only a running timer needs watching, and only the first signal counts.
export async function markAway(since) {
  const { timer } = await getState();
  if (!timer || timer.status !== 'running' || timer.away) return;
  await chrome.storage.local.set({ timer: { ...timer, away: { since: Math.max(since, timer.start), until: null } } });
}

// You're back. Returns true if you were gone long enough to be asked.
// Shorter absences (like locking your screen for a minute) are just forgotten.
export async function markBack(now = Date.now()) {
  const { timer } = await getState();
  if (!timer || !timer.away || timer.away.until) return false;
  const longEnough = now - timer.away.since >= IDLE_MS;
  await chrome.storage.local.set({
    timer: { ...timer, away: longEnough ? { ...timer.away, until: now } : null },
  });
  return longEnough;
}

// The question waiting to be answered, or null: { since, until }
export function awayPrompt(timer) {
  return timer && timer.away && timer.away.until ? timer.away : null;
}

export async function keepAwayTime() {
  const { timer } = await getState();
  if (awayPrompt(timer)) await chrome.storage.local.set({ timer: { ...timer, away: null } });
}

// Bills up to when you left, drops the away time, and carries on from when you came back.
export async function discardAwayTime() {
  const state = await getState();
  const t = state.timer;
  const away = awayPrompt(t);
  if (!away) return;
  const length = closeRunningStretch(state, away.since);
  state.timer = { ...t, start: away.until, carriedMs: t.carriedMs + length, away: null };
  if (isCountdown(state.timer) && remainingMs(state.timer) > 0) state.timer.alerted = false; // back under the countdown
  await saveTimerState(state);
}

// 1380000 → "23 min", 3900000 → "1h 5m"
export function formatAway(ms) {
  const minutes = Math.floor(ms / 60000);
  return minutes < 60 ? `${minutes} min` : formatHours(ms);
}

function checkMinutes(minutes) {
  if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440)) {
    throw new Error('Enter a whole number of minutes, from 1 to 1440.');
  }
}

// Switch the current timer between counting up (minutes = null) and counting
// down `minutes` from right now. Billing is unaffected: only real time is logged.
export async function setCountdown(minutes) {
  checkMinutes(minutes);
  const state = await getState();
  if (!state.timer) return;
  state.timer = {
    ...state.timer,
    targetMs: minutes ? sessionMs(state.timer) + minutes * 60000 : null,
    alerted: false,
  };
  await saveTimerState(state);
}

export async function markCountdownAlerted() {
  const { timer } = await getState();
  if (timer) await chrome.storage.local.set({ timer: { ...timer, alerted: true } });
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

export function isCountdown(timer) {
  return Boolean(timer && timer.targetMs);
}

// Time left on a countdown (negative once it has passed zero)
export function remainingMs(timer, now = Date.now()) {
  return timer.targetMs - sessionMs(timer, now);
}

export function isOvertime(timer, now = Date.now()) {
  return isCountdown(timer) && remainingMs(timer, now) <= 0;
}

// What the clock shows: "0:42:10" counting up or down, "+0:03:10" past zero
export function clockText(timer, now = Date.now()) {
  if (!isCountdown(timer)) return formatDuration(sessionMs(timer, now));
  const left = remainingMs(timer, now);
  if (left > 0) return formatDuration(Math.ceil(left / 1000) * 1000); // reads 0:00:01 until it hits zero
  return '+' + formatDuration(-left);
}

// The countdown time exactly as the clock shows it (whole seconds, rounded up)
function shownLeft(left) {
  return Math.ceil(left / 1000) * 1000;
}

// The same for the toolbar badge, which fits about 4 characters. It matches the clock's
// hours and minutes, and ticks seconds under a minute so it never looks stuck:
// "0:42", ":42", "+12s", "+3m", "+2h"
export function badgeText(timer, now = Date.now()) {
  const seconds = (ms) => String(Math.floor(ms / 1000)).padStart(2, '0');
  if (!isCountdown(timer)) {
    const ms = sessionMs(timer, now);
    return ms < 60000 ? `:${seconds(ms)}` : formatBadge(ms);
  }
  const left = remainingMs(timer, now);
  if (left > 0) {
    const shown = shownLeft(left);
    return shown < 60000 ? `:${seconds(shown)}` : formatBadge(shown);
  }
  const over = -left;
  if (over < 60000) return `+${Math.floor(over / 1000)}s`;
  const minutes = Math.floor(over / 60000);
  return minutes < 60 ? `+${minutes}m` : `+${Math.floor(minutes / 60)}h`;
}

// How long until the badge text next changes
export function msToNextBadgeChange(timer, now = Date.now()) {
  const paced = (ms) => (ms < 60000 ? 1000 - (ms % 1000) : 60000 - (ms % 60000));
  if (!isCountdown(timer)) return paced(sessionMs(timer, now));
  const left = remainingMs(timer, now);
  if (left <= 0) return paced(-left);
  const shown = shownLeft(left);
  if (shown < 60000) return left % 1000 || 1000;
  // The clock drops below this minute one second after it reads exactly :00
  return left - (Math.floor(shown / 60000) * 60000 - 1000);
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
