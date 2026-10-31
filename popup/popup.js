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
    // Brand mark: the white hourglass on an ink tile, flipping while a timer runs
    logo ? el('span', { className: 'brand-mark' },
      el('img', { className: isRunning() ? 'logo flipping' : 'logo', src: LOGO_URL, alt: '' }),
    ) : null,
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
    el('button', { className: 'nav-link', onclick: () => go('entries') }, 'Entries'),
    el('button', { className: 'nav-link', onclick: () => go('clients') }, 'Clients'),
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
    // Order matters: the thing you do (start or control a timer) first,
    // then what it earned you, then where the week went.
    body: [
      timerCard(),
      totals(),
      el('div', { className: 'section-head' },
        el('span', { className: 'label' }, 'By client'),
        el('span', { className: 'label' }, 'This week'),
      ),
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
    // Nothing running. The most likely next move is picking up the last job,
    // so that's the big button; any other client is one chip away.
    const last = data.lastEntry(state);
    const lastClient = last && data.findClient(state, last.clientId);
    const canContinue = lastClient && !lastClient.archived;
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

    const main = canContinue
      ? el('button', {
        className: 'btn btn-go btn-block btn-continue',
        onclick: () => actThenClose(() => data.startTimer({ clientId: last.clientId, task: last.task, note: last.note })),
      },
        el('span', { className: 'play' }),
        el('span', { className: 'grow' }, el('strong', {}, 'Continue '), `${lastClient.name} · ${last.task}`),
      )
      : el('button', { className: 'btn btn-go btn-block', onclick: () => go('start') }, el('span', { className: 'play' }), 'Start timer');

    return el('div', { className: 'card hero' },
      el('div', { className: 'section-head' },
        el('span', { className: 'label' }, 'Ready to track'),
        el('span', { className: 'label' }, today),
      ),
      main,
      el('div', { className: 'chips' },
        ...data.clientsByRecent(state).slice(0, 4).map((c) =>
          el('button', { className: 'chip client-chip', onclick: () => go('start', { clientId: c.id }) }, dot(c.color), c.name),
        ),
        el('button', { className: 'chip chip-ghost', onclick: () => go('start') }, '+ New timer'),
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

// Money first (that's what this is for), hours underneath.
// The week tile has a little Mon–Sun bar chart, today in ink.
function totals() {
  const today = () => data.workedBetween(state, data.startOfToday(), Infinity);
  const week = () => data.workedBetween(state, data.startOfWeek(), Infinity);

  const weekStart = data.startOfWeek();
  const todayStart = data.startOfToday();
  const days = Array.from({ length: 7 }, (_, i) => {
    const from = data.addDays(weekStart, i);
    return { from, ms: data.workedBetween(state, from, data.addDays(from, 1)).ms };
  });
  const most = Math.max(1, ...days.map((d) => d.ms));
  const bars = el('div', { className: 'week-bars', ariaHidden: 'true' }, ...days.map((d) =>
    el('span', {
      className: d.from === todayStart ? 'bar today' : d.from > todayStart ? 'bar future' : 'bar',
      style: `--h: ${Math.max(8, (d.ms / most) * 100)}%`,
    }),
  ));

  return el('div', { className: 'totals' },
    el('div', { className: 'total' },
      el('span', { className: 'label' }, 'Today'),
      liveText(() => data.formatMoney(today().amount), { className: 'total-value' }),
      liveText(() => data.formatHours(today().ms), { className: 'total-sub' }),
    ),
    el('div', { className: 'total' },
      el('div', { className: 'section-head' }, el('span', { className: 'label' }, 'This week'), bars),
      liveText(() => data.formatMoney(week().amount, 0), { className: 'total-value' }),
      liveText(() => data.formatHours(week().ms), { className: 'total-sub' }),
    ),
  );
}

function byClientRows() {
  const weekOf = (id) => data.workedBetween(state, data.startOfWeek(), Infinity, id);
  const clients = data.activeClients(state).sort((a, b) => weekOf(b.id).ms - weekOf(a.id).ms);
  const most = Math.max(1, ...clients.map((c) => weekOf(c.id).ms));
  return el('div', { className: 'rows' }, ...clients.map((c) =>
    el('div', {
      className: 'row share',
      style: `--c: ${data.CLIENT_COLORS[c.color]}; --share: ${(weekOf(c.id).ms / most) * 100}%`,
    },
      dot(c.color),
      el('span', { className: 'grow' }, c.name),
      liveText(() => data.formatMoney(weekOf(c.id).amount, 0), { className: 'meta money' }),
      liveText(() => data.formatHours(weekOf(c.id).ms), { className: 'meta hours' }),
    ),
  ));
}

// ---------- Start timer ----------

// Opened from a client chip on the dashboard, `clientId` comes preselected.
function startScreen({ clientId: chosen } = {}) {
  const clients = data.activeClients(state);
  const valid = (id) => clients.some((c) => c.id === id);
  let clientId = valid(chosen) ? chosen : valid(state.lastClientId) ? state.lastClientId : clients[0].id;
  // Preselect the task you last did for this client (or anyone, if they're new)
  const last = data.lastEntryFor(state, clientId) || data.lastEntry(state);
  let task = last && data.TASKS.includes(last.task) ? last.task : data.TASKS[0];

  const clientRows = el('div', { className: 'rows' });
  const chips = el('div', { className: 'task-groups' });
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
    chips.replaceChildren(...data.TASK_GROUPS.map(([group, tasks]) =>
      el('div', { className: 'task-group' },
        el('span', { className: 'group-name' }, group),
        el('div', { className: 'chips' }, ...tasks.map((name) =>
          el('button', {
            className: 'chip',
            ariaPressed: String(name === task),
            style: `--chip-color: ${color}`,
            onclick: () => { task = name; update(); },
          }, name),
        )),
      ),
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

let calendarMonth = null; // first day of the month the calendar shows
let selectedDay = null; // the day picked in the calendar

function entryRow(e) {
  const client = data.findClient(state, e.clientId);
  return el('button', { className: 'row', onclick: () => go('entry', { id: e.id }) },
    dot(client.color),
    el('span', { className: 'grow' }, `${client.name} · ${e.task}`),
    el('span', { className: 'meta' }, data.formatShortDuration(data.entryMs(e))),
  );
}

// Month view: a calendar where each day is shaded by how much you worked,
// with dots for the clients. Hover a day to peek at it; click to pick it.
// That day's entries show underneath.
function calendarView() {
  const thisMonth = data.startOfMonth();
  if (calendarMonth === null) calendarMonth = thisMonth;
  const monthEnd = data.addMonths(calendarMonth, 1);
  const today = data.startOfToday();
  const inMonth = (day) => day >= calendarMonth && day < monthEnd;
  if (selectedDay === null || !inMonth(selectedDay)) selectedDay = inMonth(today) ? today : calendarMonth;

  const monthEntries = data.entriesBetween(state, calendarMonth, monthEnd);
  const byDay = new Map();
  for (const e of monthEntries) {
    const day = data.startOfToday(e.start);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const busiest = Math.max(1, ...[...byDay.values()].map((list) => data.totalOf(list).ms));
  const monthTotal = data.totalOf(monthEntries);

  // The selected (or hovered) day's entries, morning to evening
  const detail = el('div', { className: 'day-detail' });
  function showDay(day) {
    const entries = [...(byDay.get(day) || [])].sort((a, b) => a.start - b.start);
    const total = data.totalOf(entries);
    detail.replaceChildren(
      el('div', { className: 'section-head' },
        el('span', { className: 'label' }, data.formatDayLabel(day)),
        el('span', { className: 'label' }, entries.length ? `${data.formatHours(total.ms)} · ${data.formatMoney(total.amount, 0)}` : ''),
      ),
      entries.length
        ? el('div', { className: 'rows' }, ...entries.map(entryRow))
        : el('p', { className: 'small muted' }, day > today ? 'Nothing yet.' : 'Nothing logged this day.'),
    );
  }

  const cells = new Map(); // day → its button, to move the "selected" ring
  const grid = el('div', { className: 'cal' },
    ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => el('span', { className: 'cal-weekday' }, d)),
  );
  // Blank cells so the 1st lands under the right weekday (weeks start Monday)
  const blanks = (new Date(calendarMonth).getDay() + 6) % 7;
  for (let i = 0; i < blanks; i++) grid.append(el('span'));

  for (let day = calendarMonth; day < monthEnd; day = data.addDays(day, 1)) {
    const entries = byDay.get(day) || [];
    const total = data.totalOf(entries);
    // Up to 3 dots, biggest client first
    const perClient = new Map();
    for (const e of entries) perClient.set(e.clientId, (perClient.get(e.clientId) || 0) + data.entryMs(e));
    const topClients = [...perClient.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const level = total.ms ? 12 + (total.ms / busiest) * 58 : 0; // how dark the day is, in %
    const date = new Date(day).getDate();
    const summary = entries.length
      ? `${data.formatDayLabel(day)}: ${data.formatHours(total.ms)} · ${data.formatMoney(total.amount)}`
      : `${data.formatDayLabel(day)}: nothing logged`;

    const classes = ['cal-day'];
    if (day === today) classes.push('today');
    if (day > today) classes.push('future');
    if (level > 45) classes.push('dark');
    if (day === selectedDay) classes.push('selected');

    const cell = el('button', {
      className: classes.join(' '),
      style: `--level: ${level}%`,
      ariaLabel: summary,
      title: summary,
      onmouseenter: () => showDay(day),
      onfocus: () => showDay(day),
      onclick: () => {
        cells.get(selectedDay)?.classList.remove('selected');
        selectedDay = day;
        cell.classList.add('selected');
        showDay(day);
      },
    },
      el('span', { className: 'day-num' }, String(date)),
      el('span', { className: 'day-dots' }, ...topClients.map(([id]) => dot(data.findClient(state, id).color))),
    );
    cells.set(day, cell);
    grid.append(cell);
  }
  // Leaving the calendar goes back to the picked day
  grid.addEventListener('mouseleave', () => showDay(selectedDay));
  showDay(selectedDay);

  const changeMonth = (step) => {
    calendarMonth = data.addMonths(calendarMonth, step);
    selectedDay = null;
    render();
  };
  const nav = el('div', { className: 'cal-nav' },
    el('div', { className: 'cal-title' },
      el('strong', {}, new Date(calendarMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })),
      el('span', { className: 'small muted' }, `${data.formatHours(monthTotal.ms)} · ${data.formatMoney(monthTotal.amount, 0)}`),
    ),
    el('button', { className: 'cal-arrow', ariaLabel: 'Previous month', onclick: () => changeMonth(-1) }, '‹'),
    el('button', { className: 'cal-arrow', ariaLabel: 'Next month', disabled: calendarMonth >= thisMonth, onclick: () => changeMonth(1) }, '›'),
  );

  return [nav, grid, detail];
}

function entriesScreen() {
  const ranges = ['today', 'week', 'month'];

  // "Add past time" from the calendar starts on the picked day (if it's not in the future).
  // Read when clicked, since picking a day doesn't redraw the screen.
  const pastDay = () => (entriesRange === 'month' && selectedDay !== null && selectedDay <= data.startOfToday() ? selectedDay : null);
  const footer = [el('button', { className: 'btn btn-outline btn-block', onclick: () => go('past', { from: 'entries', day: pastDay() }) }, 'Add past time')];
  const chips = el('div', { className: 'chips' }, ...ranges.map((name) =>
    el('button', {
      className: 'chip',
      ariaPressed: String(name === entriesRange),
      onclick: () => { entriesRange = name; render(); },
    }, name === 'month' ? 'Month' : data.RANGES[name]),
  ));

  if (entriesRange === 'month') {
    return screen({ title: 'Entries', back: () => go('dashboard'), body: [chips, ...calendarView()], footer });
  }

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
      el('div', { className: 'rows' }, ...dayEntries.map(entryRow)),
    );
  }

  return screen({
    title: 'Entries',
    back: () => go('dashboard'),
    body: [
      chips,
      entries.length === 0 ? el('p', { className: 'small muted' }, 'No entries in this period.') : null,
      ...groups,
    ],
    footer,
  });
}

// ---------- Edit entry and Add past time share one form ----------

// Builds the form fields. `entry` is the entry being edited, or null for past time.
// `day` (optional) is the date past time should start on.
function entryForm(entry, day = null) {
  const clients = data.activeClients(state);
  const current = entry && data.findClient(state, entry.clientId);
  if (current && current.archived) clients.unshift(current); // a deleted client's old entry

  const clientOptions = clients.map((c) => [c.id, c.name]);
  if (!entry) clientOptions.unshift(['', 'Choose client']);
  const clientSel = select(clientOptions, entry ? entry.clientId : '');

  // Task dropdown in the same groups as the Start timer chips
  const selectedTask = entry ? entry.task : 'Other';
  const taskSel = el('select', { className: 'input' }, ...data.TASK_GROUPS.map(([group, tasks]) =>
    el('optgroup', { label: group }, ...tasks.map((t) => el('option', { value: t, selected: t === selectedTask }, t))),
  ));
  if (!data.TASKS.includes(selectedTask)) {
    taskSel.append(el('option', { value: selectedTask, selected: true }, selectedTask)); // an old tag no longer in the list
  }

  // Past time defaults to the hour that just ended, on the quarter hour
  const now = Date.now();
  const roundedNow = now - (now % (15 * 60000));
  const start = entry ? entry.start : roundedNow - 3600000;
  const end = entry ? entry.end : roundedNow;

  const dateInput = el('input', { className: 'input', type: 'date', value: data.toDateInput(day ?? start), max: data.toDateInput(now) });
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

function pastScreen({ from = 'dashboard', day = null }) {
  if (data.activeClients(state).length === 0) return clientScreen({ from });
  const { fields, values } = entryForm(null, day);
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
