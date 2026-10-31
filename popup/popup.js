// popup/popup.js
// Draws the popup one screen at a time, matching the Figma Low-fi page:
//   dashboard → start timer / switch client / clients → client (new or edit)
// All the actual saving happens in shared/data.js.

import * as data from '../shared/data.js';

const app = document.getElementById('app');

let state = null; // latest copy of everything in storage
let current = { name: 'dashboard', params: {} }; // which screen is showing
let liveTexts = []; // bits of text (clock, totals) refreshed every second

// Screens that only show data redraw when storage changes.
// Form screens don't, so whatever you're typing isn't wiped out.
const LIVE_SCREENS = new Set(['dashboard', 'clients', 'switch', 'entries']);

let entriesRange = 'week'; // the Entries filter, remembered while the popup is open

// ---------- Helpers ----------

// Builds an element: el('button', { className: 'btn', onclick }, 'Start')
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
}

// Text that keeps itself up to date, e.g. the running clock.
function liveText(getText, props = {}) {
  const node = el('span', props, getText());
  liveTexts.push({ node, getText });
  return node;
}

function dot(color) {
  return el('span', { className: 'dot', style: `background: ${data.CLIENT_COLORS[color]}` });
}

// A dropdown: select([[value, label], ...], selectedValue)
function select(options, selected) {
  return el('select', { className: 'input' }, ...options.map(([value, label]) =>
    el('option', { value, selected: value === selected }, label),
  ));
}

function field(label, input) {
  return el('label', { className: 'field' }, el('span', {}, label), input);
}

function go(name, params = {}) {
  current = { name, params };
  render();
}

let lastScreen = null; // so only a new screen eases in, not every redraw of the same one

function render() {
  liveTexts = [];
  const node = screens[current.name](current.params);
  if (current.name !== lastScreen) node.classList.add('enter');
  lastScreen = current.name;
  app.replaceChildren(node);
}

// Runs a save, reloads data, then moves to `nextScreen` (or redraws).
// Errors show at the top of the screen instead of failing silently.
// Returns true if the save worked.
async function act(action, nextScreen) {
  try {
    await action();
    state = await data.getState();
    if (nextScreen) go(nextScreen);
    else render();
    return true;
  } catch (err) {
    const message = app.querySelector('.message');
    if (message) message.textContent = err.message;
    return false;
  }
}

// After starting or switching a timer, close the popup so you can get to work.
// The badge on the toolbar icon shows it's running.
async function actThenClose(action) {
  if (await act(action, 'dashboard')) window.close();
}

const LOGO_URL = new URL('../icons/logo.png', import.meta.url).href;

function isRunning() {
  return Boolean(state.timer && state.timer.status === 'running');
}

// The big clock: "0:42" in full strength, ":10" softer
function bigClock() {
  const part = (which) => () => {
    const [h, m, s] = data.formatDuration(data.sessionMs(state.timer)).split(':');
    return which === 'main' ? `${h}:${m}` : `:${s}`;
  };
  return el('span', { className: 'clock' }, liveText(part('main')), liveText(part('seconds'), { className: 'seconds' }));
}

// The frame every screen shares: header, error line, scrolling body, footer.
function screen({ title, back, logo = false, links = [], body = [], footer = null }) {
  const header = el('div', { className: 'header' },
    back ? el('button', { className: 'back', ariaLabel: 'Back', onclick: back }, '←') : null,
    logo ? el('img', { className: isRunning() ? 'logo flipping' : 'logo', src: LOGO_URL, alt: '' }) : null,
    el('h1', { className: logo ? 'wordmark' : '' }, title),
    ...links,
  );
  return el('div', { className: 'screen' },
    header,
    el('p', { className: 'message', role: 'alert' }),
    el('div', { className: 'screen-body' }, ...body),
    footer ? el('div', { className: 'screen-footer' }, ...footer) : null,
  );
}

// ---------- Dashboard ----------

function dashboardScreen() {
  const clients = data.activeClients(state);
  const links = [
    el('button', { className: 'link', onclick: () => go('entries') }, 'Entries'),
    el('button', { className: 'link', onclick: () => go('clients') }, 'Clients'),
  ];

  // First run: nothing to track yet
  if (clients.length === 0 && !state.timer) {
    return screen({
      title: 'Hourglass',
      logo: true,
      links,
      body: [el('div', { className: 'empty' },
        el('div', { className: 'empty-circle' }, el('img', { src: LOGO_URL, alt: '' })),
        el('h2', {}, 'No clients yet'),
        el('p', {}, 'Add a client to start tracking billable time.'),
        el('button', { className: 'btn btn-go', onclick: () => go('client', { from: 'dashboard' }) }, 'Add client'),
      )],
    });
  }

  return screen({
    title: 'Hourglass',
    logo: true,
    links,
    body: [
      timerCard(),
      totals(),
      el('div', { className: 'label' }, 'By client · This week'),
      byClientRows(),
    ],
    footer: [
      el('button', { className: 'btn btn-outline btn-half', onclick: () => go('past', { from: 'dashboard' }) }, 'Add past time'),
      el('button', { className: 'btn btn-outline btn-half', onclick: () => go('export') }, 'Export CSV'),
    ],
  });
}

function timerCard() {
  const t = state.timer;

  if (!t) {
    const last = data.lastEntry(state);
    const lastClient = last && data.findClient(state, last.clientId);
    // One tap to pick up where you left off (same client, task and note)
    const canContinue = lastClient && !lastClient.archived;
    return el('div', { className: 'card' },
      el('div', { className: 'label' }, 'No timer running'),
      el('button', { className: 'btn btn-go btn-block', onclick: () => go('start') }, 'Start timer'),
      el('div', { className: 'card-top' },
        el('span', { className: 'small muted grow' }, last ? `Last: ${lastClient.name} · ${last.task}` : 'Last: No logs yet'),
        canContinue ? el('button', {
          className: 'link link-accent',
          onclick: () => actThenClose(() => data.startTimer({ clientId: last.clientId, task: last.task, note: last.note })),
        }, 'Continue →') : null,
      ),
    );
  }

  const client = data.findClient(state, t.clientId);
  const running = t.status === 'running';
  const canSwitch = data.activeClients(state).some((c) => c.id !== t.clientId);

  return el('div', { className: running ? 'card live' : 'card paused' },
    el('div', { className: `label status ${running ? 'running' : 'paused'}` },
      el('span', { className: running ? 'live-dot' : 'pause-mark' }),
      running ? 'Running' : 'Paused',
    ),
    el('div', { className: 'card-top' },
      dot(client.color),
      el('strong', { className: 'grow' }, client.name),
      el('span', { className: 'tag' }, t.task),
    ),
    t.note ? el('p', { className: 'small muted' }, t.note) : null,
    el('div', { className: 'card-clock' },
      bigClock(),
      canSwitch ? el('button', { className: 'btn btn-outline btn-pill', onclick: () => go('switch') }, 'Switch client →') : null,
    ),
    el('div', { className: 'pair' },
      running
        ? el('button', { className: 'btn btn-pause', onclick: () => act(data.pauseTimer) }, 'Pause')
        : el('button', { className: 'btn btn-go', onclick: () => act(data.resumeTimer) }, 'Resume'),
      el('button', { className: 'btn btn-stop', onclick: () => act(data.stopTimer) }, 'Stop'),
    ),
  );
}

function totals() {
  const today = () => data.workedBetween(state, data.startOfToday(), Infinity);
  const week = () => data.workedBetween(state, data.startOfWeek(), Infinity);
  return el('div', { className: 'totals' },
    el('div', { className: 'total' },
      el('span', { className: 'label' }, 'Today'),
      liveText(() => data.formatHours(today().ms), { className: 'total-value' }),
    ),
    el('div', { className: 'total' },
      el('span', { className: 'label' }, 'This week'),
      liveText(() => {
        const w = week();
        return `${data.formatHours(w.ms)} · ${data.formatMoney(w.amount, 0)}`;
      }, { className: 'total-value' }),
    ),
  );
}

function byClientRows() {
  const weekMs = (id) => data.workedBetween(state, data.startOfWeek(), Infinity, id).ms;
  const clients = data.activeClients(state).sort((a, b) => weekMs(b.id) - weekMs(a.id));
  const most = Math.max(1, ...clients.map((c) => weekMs(c.id)));
  return el('div', { className: 'rows' }, ...clients.map((c) =>
    el('div', {
      className: 'row share',
      style: `--c: ${data.CLIENT_COLORS[c.color]}; --share: ${(weekMs(c.id) / most) * 100}%`,
    },
      dot(c.color),
      el('span', { className: 'grow' }, c.name),
      liveText(() => data.formatHours(weekMs(c.id)), { className: 'meta' }),
    ),
  ));
}

// ---------- Start timer ----------

function startScreen() {
  const clients = data.activeClients(state);
  const last = data.lastEntry(state);
  let clientId = clients.some((c) => c.id === state.lastClientId) ? state.lastClientId : clients[0].id;
  let task = last ? last.task : data.TASKS[0];

  const clientRows = el('div', { className: 'rows' });
  const chips = el('div', { className: 'chips' });
  const noteInput = el('input', { className: 'input', placeholder: 'e.g. Homepage revisions', maxLength: 200 });

  // Redraw the client list and task chips to show what's picked.
  // The picked task chip uses the picked client's color, as in Figma.
  function update() {
    const color = data.CLIENT_COLORS[data.findClient(state, clientId).color];
    clientRows.replaceChildren(...clients.map((c) =>
      el('button', { className: 'row', ariaPressed: String(c.id === clientId), onclick: () => { clientId = c.id; update(); } },
        dot(c.color),
        el('span', { className: 'grow' }, c.name),
        c.id === clientId ? dot(c.color) : null,
      ),
    ));
    chips.replaceChildren(...data.TASKS.map((name) =>
      el('button', {
        className: 'chip',
        ariaPressed: String(name === task),
        style: `--chip-color: ${color}`,
        onclick: () => { task = name; update(); },
      }, name),
    ));
  }
  update();

  const start = () => actThenClose(
    () => data.startTimer({ clientId, task, note: noteInput.value.trim() }),
  );
  noteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });

  return screen({
    title: 'Start timer',
    back: () => go('dashboard'),
    body: [
      el('div', { className: 'label' }, 'Client'),
      clientRows,
      el('div', { className: 'label' }, 'Task'),
      chips,
      el('label', { className: 'field' }, el('span', {}, 'Note (optional)'), noteInput),
    ],
    footer: [el('button', { className: 'btn btn-go btn-block', onclick: start }, 'Start timer')],
  });
}

// ---------- Switch client ----------

function switchScreen() {
  const t = state.timer;
  if (!t) return dashboardScreen(); // timer was stopped somewhere else
  const from = data.findClient(state, t.clientId);
  const others = data.activeClients(state).filter((c) => c.id !== t.clientId);

  return screen({
    title: 'Switch client',
    back: () => go('dashboard'),
    body: [
      el('p', { className: 'small muted' }, `Ends the entry for ${from.name} and starts a new one, keeping the task (${t.task}).`),
      el('div', { className: 'rows' }, ...others.map((c) =>
        el('button', { className: 'row', onclick: () => actThenClose(() => data.switchClient(c.id)) },
          dot(c.color),
          el('span', { className: 'grow' }, c.name),
          el('span', { className: 'meta' }, data.formatRate(c.rate)),
        ),
      )),
    ],
  });
}

// ---------- Clients ----------

function clientsScreen() {
  const clients = data.activeClients(state);
  return screen({
    title: 'Clients',
    back: () => go('dashboard'),
    body: [
      clients.length === 0 ? el('p', { className: 'small muted' }, 'No clients yet.') : null,
      el('div', { className: 'rows' }, ...clients.map((c) =>
        el('button', { className: 'row', onclick: () => go('client', { id: c.id, from: 'clients' }) },
          dot(c.color),
          el('span', { className: 'grow' }, c.name),
          el('span', { className: 'meta' }, data.formatRate(c.rate)),
        ),
      )),
    ],
    footer: [el('button', { className: 'btn btn-go btn-block', onclick: () => go('client', { from: 'clients' }) }, 'Add client')],
  });
}

// New client when there's no id, edit client when there is.
function clientScreen({ id, from = 'clients' }) {
  const existing = id ? data.findClient(state, id) : null;
  const usedColors = data.activeClients(state).map((c) => c.color);
  const colorNames = Object.keys(data.CLIENT_COLORS);
  let color = existing ? existing.color : (colorNames.find((n) => !usedColors.includes(n)) || colorNames[0]);

  const nameInput = el('input', { className: 'input', placeholder: 'e.g. Bloom Florals', maxLength: 60, value: existing ? existing.name : '' });
  const rateInput = el('input', { className: 'input', type: 'number', min: '0', step: '0.01', placeholder: '$0.00', value: existing ? String(existing.rate) : '' });
  const noteInput = el('input', { className: 'input', placeholder: 'About client', maxLength: 200, value: existing ? existing.note || '' : '' });

  const swatches = el('div', { className: 'swatches' });
  function updateSwatches() {
    swatches.replaceChildren(...colorNames.map((name) =>
      el('button', {
        className: 'swatch',
        ariaLabel: name,
        title: name,
        ariaPressed: String(name === color),
        style: `background: ${data.CLIENT_COLORS[name]}`,
        onclick: () => { color = name; updateSwatches(); },
      }),
    ));
  }
  updateSwatches();

  const leave = () => go(from);

  const save = () => {
    const name = nameInput.value.trim();
    const rate = Number(rateInput.value);
    const message = app.querySelector('.message');
    if (!name) { message.textContent = 'Enter a client name.'; nameInput.focus(); return; }
    if (rateInput.value === '' || !(rate >= 0)) { message.textContent = 'Enter an hourly rate (0 or more).'; rateInput.focus(); return; }
    const client = { name, color, rate, note: noteInput.value.trim() };
    act(() => (existing ? data.updateClient(id, client) : data.addClient(client)), from);
  };

  const remove = () => {
    if (confirm(`Delete ${existing.name}? Their past entries are kept.`)) {
      act(() => data.deleteClient(id), 'clients');
    }
  };

  const body = el('div', { className: 'stack' },
    el('label', { className: 'field' }, el('span', {}, 'Client name'), nameInput),
    el('div', { className: 'label' }, 'Color'),
    swatches,
    el('label', { className: 'field' }, el('span', {}, 'Hourly rate ($)'), rateInput),
    el('label', { className: 'field' }, el('span', {}, 'Note (optional)'), noteInput),
  );
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(); });
  setTimeout(() => nameInput.focus());

  return screen({
    title: existing ? 'Edit client' : 'New client',
    back: leave,
    body: [body],
    footer: [
      existing ? el('button', { className: 'btn btn-delete-text', onclick: remove }, 'Delete') : null,
      el('span', { className: 'spacer' }),
      el('button', { className: 'btn btn-outline', onclick: leave }, 'Cancel'),
      el('button', { className: 'btn btn-go', onclick: save }, 'Save'),
    ],
  });
}

// ---------- Entries ----------

function entriesScreen() {
  const ranges = ['today', 'week', 'month'];
  const { from, to } = data.dateRange(entriesRange);
  const entries = data.entriesBetween(state, from, to);

  // Group by day, newest day first (entries are already newest first)
  const days = new Map();
  for (const e of entries) {
    const day = data.startOfToday(e.start);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(e);
  }

  const groups = [];
  for (const [day, dayEntries] of days) {
    groups.push(
      el('div', { className: 'label' }, data.formatDayLabel(day)),
      el('div', { className: 'rows' }, ...dayEntries.map((e) => {
        const client = data.findClient(state, e.clientId);
        return el('button', { className: 'row', onclick: () => go('entry', { id: e.id }) },
          dot(client.color),
          el('span', { className: 'grow' }, `${client.name} · ${e.task}`),
          el('span', { className: 'meta' }, data.formatShortDuration(data.entryMs(e))),
        );
      })),
    );
  }

  return screen({
    title: 'Entries',
    back: () => go('dashboard'),
    body: [
      el('div', { className: 'chips' }, ...ranges.map((name) =>
        el('button', {
          className: 'chip',
          ariaPressed: String(name === entriesRange),
          onclick: () => { entriesRange = name; render(); },
        }, data.RANGES[name]),
      )),
      entries.length === 0 ? el('p', { className: 'small muted' }, 'No entries in this period.') : null,
      ...groups,
    ],
    footer: [el('button', { className: 'btn btn-outline btn-block', onclick: () => go('past', { from: 'entries' }) }, 'Add past time')],
  });
}

// ---------- Edit entry and Add past time share one form ----------

// Builds the form fields. `entry` is the entry being edited, or null for past time.
function entryForm(entry) {
  const clients = data.activeClients(state);
  const current = entry && data.findClient(state, entry.clientId);
  if (current && current.archived) clients.unshift(current); // a deleted client's old entry

  const clientOptions = clients.map((c) => [c.id, c.name]);
  if (!entry) clientOptions.unshift(['', 'Choose client']);
  const clientSel = select(clientOptions, entry ? entry.clientId : '');

  const tasks = data.TASKS.includes(entry && entry.task) || !entry ? data.TASKS : [...data.TASKS, entry.task];
  const taskSel = select(tasks.map((t) => [t, t]), entry ? entry.task : 'Other');

  // Past time defaults to the hour that just ended, on the quarter hour
  const now = Date.now();
  const roundedNow = now - (now % (15 * 60000));
  const start = entry ? entry.start : roundedNow - 3600000;
  const end = entry ? entry.end : roundedNow;

  const dateInput = el('input', { className: 'input', type: 'date', value: data.toDateInput(start), max: data.toDateInput(now) });
  const startInput = el('input', { className: 'input', type: 'time', value: data.toTimeInput(start) });
  const endInput = el('input', { className: 'input', type: 'time', value: data.toTimeInput(end) });
  const noteInput = el('input', { className: 'input', placeholder: entry ? 'Note' : 'e.g. Paper sketches for logo', maxLength: 200, value: entry ? entry.note || '' : '' });

  const values = () => ({
    clientId: clientSel.value,
    task: taskSel.value,
    note: noteInput.value.trim(),
    ...data.timesFromInputs(dateInput.value, startInput.value, endInput.value),
  });

  // "1h 20m · $100.00", updated as you type
  const duration = el('strong');
  function updateDuration() {
    const v = values();
    const client = data.findClient(state, v.clientId);
    const rate = entry && v.clientId === entry.clientId ? entry.rate : client ? client.rate : 0;
    const ms = v.end - v.start;
    duration.textContent = ms > 0 ? `${data.formatHours(ms)} · ${data.formatMoney((ms / 3600000) * rate)}` : '—';
  }
  for (const input of [clientSel, dateInput, startInput, endInput]) input.addEventListener('input', updateDuration);
  updateDuration();

  const fields = el('div', { className: 'stack' },
    field('Client', clientSel),
    field('Task', taskSel),
    field('Date', dateInput),
    el('div', { className: 'pair' }, field('Start', startInput), field('End', endInput)),
    el('div', { className: 'duration' }, el('span', { className: 'label' }, 'Duration'), duration),
    field(entry ? 'Note' : 'Note (optional)', noteInput),
  );
  return { fields, values };
}

function entryScreen({ id }) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return entriesScreen();
  const { fields, values } = entryForm(entry);

  const remove = () => {
    if (confirm('Delete this entry?')) act(() => data.deleteEntry(id), 'entries');
  };

  return screen({
    title: 'Edit entry',
    back: () => go('entries'),
    body: [fields],
    footer: [
      el('button', { className: 'btn btn-delete-text', onclick: remove }, 'Delete'),
      el('span', { className: 'spacer' }),
      el('button', { className: 'btn btn-go', onclick: () => act(() => data.updateEntry(id, values()), 'entries') }, 'Save'),
    ],
  });
}

function pastScreen({ from = 'dashboard' }) {
  if (data.activeClients(state).length === 0) return clientScreen({ from });
  const { fields, values } = entryForm(null);
  return screen({
    title: 'Add past time',
    back: () => go(from),
    body: [fields],
    footer: [el('button', { className: 'btn btn-go btn-block', onclick: () => act(() => data.addEntry(values()), from) }, 'Add time')],
  });
}

// ---------- Export CSV ----------

function exportScreen() {
  const rangeOptions = [...Object.entries(data.RANGES), ['custom', 'Custom dates']];
  const rangeSel = select(rangeOptions, 'week');

  // Clients still in use, plus deleted ones that have entries
  const withEntries = new Set(state.entries.map((e) => e.clientId));
  const clients = state.clients.filter((c) => !c.archived || withEntries.has(c.id));
  const clientSel = select([['', 'All clients'], ...clients.map((c) => [c.id, c.archived ? `${c.name} (deleted)` : c.name])], '');

  const today = data.toDateInput(Date.now());
  const fromInput = el('input', { className: 'input', type: 'date', value: today, max: today });
  const toInput = el('input', { className: 'input', type: 'date', value: today, max: today });
  const customDates = el('div', { className: 'pair', hidden: true }, field('From', fromInput), field('To', toInput));

  const count = el('div', { className: 'preview-count' });
  const totals = el('div', { className: 'muted' });
  const download = el('button', { className: 'btn btn-go btn-block' }, 'Download CSV');

  // The chosen period as timestamps; custom "To" includes that whole day
  function period() {
    if (rangeSel.value !== 'custom') return data.dateRange(rangeSel.value);
    const from = new Date(`${fromInput.value}T00:00`).getTime();
    const to = data.addDays(new Date(`${toInput.value}T00:00`).getTime(), 1);
    return { from, to };
  }

  function chosenEntries() {
    const { from, to } = period();
    return data.entriesBetween(state, from, to, clientSel.value || null);
  }

  function update() {
    customDates.hidden = rangeSel.value !== 'custom';
    const entries = chosenEntries();
    const total = data.totalOf(entries);
    count.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
    totals.textContent = `${data.formatHours(total.ms)} · ${data.formatMoney(total.amount)}`;
    download.disabled = entries.length === 0;
  }
  for (const input of [rangeSel, clientSel, fromInput, toInput]) input.addEventListener('input', update);
  update();

  download.addEventListener('click', () => {
    const entries = chosenEntries();
    const csv = data.entriesToCsv(state, entries);
    // File name like hourglass-2026-10-27-to-2026-11-02-bloom-florals.csv
    const times = entries.map((e) => e.start);
    const client = data.findClient(state, clientSel.value);
    const name = [
      'hourglass',
      data.toDateInput(Math.min(...times)),
      'to',
      data.toDateInput(Math.max(...times)),
      client ? client.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null,
    ].filter(Boolean).join('-');
    // A data: link (not a blob) so the download still works if the popup closes for a save dialog.
    // The ﻿ mark tells Excel the file is UTF-8 so accents and emoji survive.
    const link = el('a', { href: 'data:text/csv;charset=utf-8,' + encodeURIComponent('﻿' + csv), download: `${name}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
  });

  return screen({
    title: 'Export',
    back: () => go('dashboard'),
    body: [
      field('Date range', rangeSel),
      customDates,
      field('Client', clientSel),
      el('div', { className: 'card' }, el('div', { className: 'label' }, 'Preview'), count, totals),
    ],
    footer: [download],
  });
}

const screens = {
  dashboard: dashboardScreen,
  start: startScreen,
  switch: switchScreen,
  clients: clientsScreen,
  client: clientScreen,
  entries: entriesScreen,
  entry: entryScreen,
  past: pastScreen,
  export: exportScreen,
};

// ---------- Start up ----------

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  state = await data.getState();
  if (LIVE_SCREENS.has(current.name)) render();
});

setInterval(() => {
  for (const { node, getText } of liveTexts) node.textContent = getText();
}, 1000);

state = await data.getState();
render();
