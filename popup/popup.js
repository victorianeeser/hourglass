// popup/popup.js
// Draws the popup from saved data and wires up the buttons.
// All the actual saving happens in shared/data.js.

import * as data from '../shared/data.js';

const $ = (id) => document.getElementById(id);

let state = null; // latest copy of everything in storage
let editingClientId = null; // set while the client form is editing instead of adding

// Small helper to build elements: el('button', { onclick }, 'Start')
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== ''));
  return node;
}

// Runs an action and shows any error message instead of failing silently.
async function run(action) {
  $('message').textContent = '';
  try {
    await action();
  } catch (err) {
    $('message').textContent = err.message;
  }
}

function colorDot(color) {
  return el('span', { style: `color: ${data.CLIENT_COLORS[color]}` }, '● ');
}

function clientSelect(selectedId, clients) {
  const select = el('select');
  for (const c of clients) {
    select.append(el('option', { value: c.id, selected: c.id === selectedId }, c.name));
  }
  return select;
}

// ---------- Timer ----------

function renderTimer() {
  const box = $('timer');
  box.replaceChildren();
  const t = state.timer;
  const clients = data.activeClients(state);

  // Nothing running: show the start form
  if (!t) {
    if (clients.length === 0) {
      box.append(el('p', {}, 'Add a client below to start tracking.'));
      return;
    }
    const clientSel = clientSelect(state.lastClientId, clients);
    const taskSel = el('select', {}, ...data.TASKS.map((name) => el('option', { value: name }, name)));
    const noteInput = el('input', { placeholder: 'Optional' });
    const startBtn = el('button', {
      onclick: () => run(() => data.startTimer({
        clientId: clientSel.value,
        task: taskSel.value,
        note: noteInput.value.trim(),
      })),
    }, 'Start');
    box.append(
      el('label', {}, 'Client ', clientSel),
      el('label', {}, 'Task ', taskSel),
      el('label', {}, 'Note ', noteInput),
      startBtn,
    );
    return;
  }

  // Running or paused: show who we're billing and the controls
  const client = data.findClient(state, t.clientId);
  box.append(
    el('p', {},
      colorDot(client.color),
      el('strong', {}, client.name),
      ` · ${t.task}`,
      t.note ? ` · ${t.note}` : null,
    ),
    el('p', {},
      t.status === 'running' ? 'Running ' : 'Paused ',
      el('span', { id: 'clock' }, data.formatDuration(data.sessionMs(t))),
    ),
  );

  if (t.status === 'running') {
    box.append(el('button', { onclick: () => run(data.pauseTimer) }, 'Pause'), ' ');
  } else {
    box.append(el('button', { onclick: () => run(data.resumeTimer) }, 'Resume'), ' ');
  }
  box.append(el('button', { onclick: () => run(data.stopTimer) }, 'Stop'));

  const others = clients.filter((c) => c.id !== t.clientId);
  if (others.length > 0) {
    const switchSel = clientSelect(null, others);
    box.append(el('p', {},
      'Switch to ', switchSel, ' ',
      el('button', { onclick: () => run(() => data.switchClient(switchSel.value)) }, 'Switch'),
    ));
  }
}

// Only the clock text changes every second, so typing in inputs isn't interrupted.
function tickClock() {
  const clock = $('clock');
  if (clock && state && state.timer) {
    clock.textContent = data.formatDuration(data.sessionMs(state.timer));
  }
}

// ---------- Clients ----------

function renderClients() {
  const list = $('client-list');
  list.replaceChildren();
  const clients = data.activeClients(state);
  if (clients.length === 0) list.append(el('li', {}, 'No clients yet.'));

  for (const c of clients) {
    list.append(el('li', {},
      colorDot(c.color),
      `${c.name} — ${data.formatMoney(c.rate)}/hr `,
      el('button', { onclick: () => startEditingClient(c) }, 'Edit'), ' ',
      el('button', {
        onclick: () => {
          if (confirm(`Delete ${c.name}? Their past entries are kept.`)) {
            run(() => data.deleteClient(c.id));
          }
        },
      }, 'Delete'),
    ));
  }
}

function startEditingClient(client) {
  const form = $('client-form');
  editingClientId = client.id;
  form.clientName.value = client.name;
  form.color.value = client.color;
  form.rate.value = client.rate;
  $('client-submit').textContent = 'Save client';
  $('client-cancel').hidden = false;
  form.clientName.focus();
}

function resetClientForm() {
  editingClientId = null;
  $('client-form').reset();
  $('client-submit').textContent = 'Add client';
  $('client-cancel').hidden = true;
}

function setUpClientForm() {
  const form = $('client-form');
  for (const name of Object.keys(data.CLIENT_COLORS)) {
    form.color.append(el('option', { value: name }, name));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const client = {
      name: form.clientName.value.trim(),
      color: form.color.value,
      rate: Number(form.rate.value),
    };
    if (!client.name) return;
    const id = editingClientId;
    resetClientForm();
    run(() => (id ? data.updateClient(id, client) : data.addClient(client)));
  });

  $('client-cancel').addEventListener('click', resetClientForm);
}

// ---------- Recent entries (temporary, so we can check the timer works) ----------

function renderEntries() {
  const list = $('entry-list');
  list.replaceChildren();
  const recent = [...state.entries].sort((a, b) => b.end - a.end).slice(0, 5);
  if (recent.length === 0) list.append(el('li', {}, 'No entries yet.'));

  for (const e of recent) {
    const client = data.findClient(state, e.clientId);
    list.append(el('li', {},
      colorDot(client.color),
      `${client.name} · ${e.task} · ${data.formatTime(e.start)}–${data.formatTime(e.end)} · `,
      `${data.formatDuration(data.entryMs(e))} · ${data.formatMoney(data.entryAmount(e))}`,
    ));
  }
}

// ---------- Start up ----------

async function load() {
  state = await data.getState();
  renderTimer();
  renderClients();
  renderEntries();
}

// Redraw whenever saved data changes (from this popup or anywhere else).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') load();
});

setUpClientForm();
setInterval(tickClock, 1000);
load();
