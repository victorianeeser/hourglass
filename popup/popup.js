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
const LIVE_SCREENS = new Set(['dashboard', 'clients', 'switch']);

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

function go(name, params = {}) {
  current = { name, params };
  render();
}

function render() {
  liveTexts = [];
  app.replaceChildren(screens[current.name](current.params));
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

// The frame every screen shares: header, error line, scrolling body, footer.
function screen({ title, back, logo = false, links = [], body = [], footer = null }) {
  const header = el('div', { className: 'header' },
    back ? el('button', { className: 'back', ariaLabel: 'Back', onclick: back }, '←') : null,
    logo ? el('img', { className: 'logo', src: LOGO_URL, alt: '' }) : null,
    el('h1', {}, title),
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
    el('button', { className: 'link', onclick: () => go('soon', { title: 'Entries' }) }, 'Entries'),
    el('button', { className: 'link', onclick: () => go('clients') }, 'Clients'),
  ];

  // First run: nothing to track yet
  if (clients.length === 0 && !state.timer) {
    return screen({
      title: 'Hourglass',
      logo: true,
      links,
      body: [el('div', { className: 'empty' },
        el('div', { className: 'empty-circle' }),
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
      el('button', { className: 'btn btn-outline btn-half', onclick: () => go('soon', { title: 'Add past time' }) }, 'Add past time'),
      el('button', { className: 'btn btn-outline btn-half', onclick: () => go('soon', { title: 'Export' }) }, 'Export CSV'),
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

  return el('div', { className: 'card' },
    el('div', { className: 'card-top' },
      dot(client.color),
      el('strong', { className: 'grow' }, client.name),
      running ? null : el('span', { className: 'paused-label' }, 'Paused'),
      el('span', { className: 'tag' }, t.task),
    ),
    t.note ? el('p', { className: 'small muted' }, t.note) : null,
    el('div', { className: 'card-clock' },
      liveText(() => data.formatDuration(data.sessionMs(state.timer)), { className: running ? 'clock' : 'clock paused' }),
      canSwitch ? el('button', { className: 'btn btn-outline btn-pill', onclick: () => go('switch') }, 'Switch client →') : null,
    ),
    running
      ? el('button', { className: 'btn btn-pause btn-block', onclick: () => act(data.pauseTimer) }, 'Pause')
      : el('button', { className: 'btn btn-go btn-block', onclick: () => act(data.resumeTimer) }, 'Resume'),
    el('button', { className: 'btn btn-stop btn-block', onclick: () => act(data.stopTimer) }, 'Stop'),
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
  return el('div', { className: 'rows' }, ...clients.map((c) =>
    el('div', { className: 'row' },
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

// ---------- Placeholder for screens in later layers ----------

function soonScreen({ title }) {
  return screen({
    title,
    back: () => go('dashboard'),
    body: [el('p', { className: 'small muted' }, 'Coming in a later layer.')],
  });
}

const screens = {
  dashboard: dashboardScreen,
  start: startScreen,
  switch: switchScreen,
  clients: clientsScreen,
  client: clientScreen,
  soon: soonScreen,
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
