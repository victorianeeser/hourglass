// shared/data.js
// Every read and write of saved data goes through this file, so the popup
// (and later the background worker and the pill) all behave the same way.
//
// Everything lives in chrome.storage.local:
//   clients:      [{ id, name, color, rate, archived? }]
//   entries:      [{ id, clientId, task, note, start, end, rate }]   (times are ms timestamps)
//   timer:        null, or { status: 'running' | 'paused', clientId, task, note, start, carriedMs }
//   lastClientId: the client used most recently (preselected next time)
//
// We store timestamps, never a running count: elapsed time is always
// "now - start", so it stays correct even if Chrome puts the extension to sleep.
//
// Pausing closes the current stretch of time as a finished entry.
// Resuming starts a new stretch for the same client, task and note.
// That keeps every entry a simple start → end with no hidden pause time.
// `carriedMs` remembers the earlier stretches so the clock can show the
// whole session (e.g. 0:40 before a pause + 0:05 after = 0:45).

export const TASKS = ['Figma', 'Canva', 'Squarespace', 'Email', 'Call', 'Other'];

// Client palette (same values as the CSS variables in CLAUDE.md)
export const CLIENT_COLORS = {
  coral: '#EE6A4D',
  peony: '#E66A9E',
  lilac: '#8F73E3',
  cobalt: '#3F6FDB',
  sky: '#45A9E0',
  lagoon: '#1E9D93',
};

const DEFAULTS = { clients: [], entries: [], timer: null, lastClientId: null };

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

// ---------- Clients ----------

export async function addClient({ name, color, rate }) {
  const { clients } = await getState();
  clients.push({ id: crypto.randomUUID(), name, color, rate });
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
    id: crypto.randomUUID(),
    clientId: t.clientId,
    task: t.task,
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

export async function startTimer({ clientId, task, note }) {
  const state = await getState();
  const now = Date.now();
  closeRunningStretch(state, now); // one timer at a time
  state.timer = { status: 'running', clientId, task, note, start: now, carriedMs: 0 };
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

export async function stopTimer() {
  const state = await getState();
  if (!state.timer) return;
  closeRunningStretch(state, Date.now());
  state.timer = null;
  await saveTimerState(state);
}

// Ends the current entry and starts a new one for another client, in one step.
// The task carries over; the note is cleared because it was about the old client.
export async function switchClient(clientId) {
  const state = await getState();
  if (!state.timer) return;
  const now = Date.now();
  closeRunningStretch(state, now);
  state.timer = {
    status: 'running',
    clientId,
    task: state.timer.task,
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

// 3725000 → "1:02:05"
export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatMoney(amount) {
  return '$' + amount.toFixed(2);
}

export function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
