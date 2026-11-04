// popup/popup.js
// Draws the popup one screen at a time:
//   dashboard → start timer / switch client / clients → client (new or edit)
//             → entries → edit entry / add past time · stats · export
// Every screen shares one frame (header bar, scrolling body, action bar).
// All the actual saving happens in shared/data.js.

import * as data from '../shared/data.js';
import { icon } from './icons.js';

const app = document.getElementById('app');

let state = null; // latest copy of everything in storage
let current = { name: 'dashboard', params: {} }; // which screen is showing
let liveTexts = []; // bits of text (clock, totals) refreshed every second

// Screens that only show data redraw when storage changes.
// Form screens don't, so whatever you're typing isn't wiped out.
const LIVE_SCREENS = new Set(['dashboard', 'clients', 'switch', 'entries', 'stats']);

let entriesRange = 'week'; // the Entries filter, remembered while the popup is open

// ---------- Helpers ----------

// Builds an element: el('button', { className: 'btn', onclick }, 'Start')
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
}

// DM Sans has no equal-width ("tabular") numbers, so a ticking clock would
// jiggle. Putting each digit in its own fixed-width box keeps it still.
function setDigits(node, text) {
  node.replaceChildren(...[...text].map((ch) => (/\d/.test(ch) ? el('span', { className: 'd' }, ch) : ch)));
}

// The running clock uses DM Mono, whose digits are all the same width, so
// nothing shifts as it ticks. Its colons are wide, so they stay in DM Sans.
function setClock(node, text) {
  node.replaceChildren(...text.split(/(:)/).filter(Boolean).map((part) => (part === ':' ? el('span', { className: 'colon' }, ':') : part)));
}

// Text that keeps itself up to date, e.g. the running clock.
// `digits: true` uses the fixed-width digit boxes above; `clock: true` uses setClock.
function liveText(getText, props = {}, { digits = false, clock = false } = {}) {
  const node = el('span', props);
  const update = (text) => (clock ? setClock(node, text) : digits ? setDigits(node, text) : (node.textContent = text));
  update(getText());
  liveTexts.push({ getText, update });
  return node;
}

function dot(color) {
  return el('span', { className: 'dot', style: `background: ${data.colorHex(color)}` });
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

// Rows grouped in one white card
function list(rows, emptyText = '') {
  const items = rows.filter(Boolean);
  if (items.length === 0) return emptyText ? el('div', { className: 'list' }, el('p', { className: 'empty-note' }, emptyText)) : null;
  return el('div', { className: 'list' }, ...items);
}

// "LABEL ............ right side"
function sectionHead(left, right = '') {
  return el('div', { className: 'section-head' },
    el('span', { className: 'label' }, left),
    right ? el('span', { className: 'label num' }, right) : null,
  );
}

// Segmented control: segmented([['week', 'Week'], ...], 'week', (value) => ...)
function segmented(options, value, onPick) {
  return el('div', { className: 'segmented', role: 'group' }, ...options.map(([v, label]) =>
    el('button', { ariaPressed: String(v === value), onclick: () => onPick(v) }, label),
  ));
}

// "October 2026   ‹ ›" with previous/next buttons
function periodNav({ title, sub = '', noun, onStep, canGoNext }) {
  return el('div', { className: 'period-nav' },
    el('div', { className: 'period-title' },
      el('strong', {}, title),
      sub ? el('span', { className: 'small muted num' }, sub) : null,
    ),
    el('button', { className: 'icon-btn bordered', ariaLabel: `Previous ${noun}`, title: `Previous ${noun}`, onclick: () => onStep(-1) }, icon('back', 15)),
    el('button', { className: 'icon-btn bordered', ariaLabel: `Next ${noun}`, title: `Next ${noun}`, disabled: !canGoNext, onclick: () => onStep(1) }, icon('next', 15)),
  );
}

// A dropdown of task checkboxes: tick the ones that apply.
//   look: 'field' (full-width, in forms) or 'tag' (the small tag on the timer card)
//   onChange(list): after every tick (forms keep the list in a variable)
//   onClose(list):  when the menu closes, only if something changed (the timer saves then)
// At least one task always stays ticked. The element has getTasks() for forms.
function taskDropdown(selected, { look = 'field', onChange = null, onClose = null } = {}) {
  let chosen = [...selected];
  let startedWith = [...selected];
  const wrap = el('div', { className: `task-dd look-${look}` });
  const button = el('button', {
    type: 'button',
    className: look === 'tag' ? 'tag tag-button' : 'input dd-trigger',
    ariaHasPopup: 'true',
    ariaExpanded: 'false',
    title: 'Choose tasks',
  });
  const menu = el('div', { className: 'dd-menu', role: 'menu', hidden: true });

  const drawButton = () => button.replaceChildren(el('span', { className: 'grow' }, chosen.join(', ')), icon('caret', 13));

  function drawMenu() {
    menu.replaceChildren(
      ...data.TASK_GROUPS.flatMap(([group, tasks]) => [
        el('div', { className: 'dd-group' }, group),
        ...tasks.map((task) => {
          const on = chosen.includes(task);
          return el('button', {
            type: 'button',
            className: 'dd-option',
            role: 'menuitemcheckbox',
            ariaChecked: String(on),
            onclick: () => {
              if (on && chosen.length === 1) return; // keep at least one
              chosen = on ? chosen.filter((t) => t !== task) : data.TASKS.filter((t) => t === task || chosen.includes(t));
              drawMenu();
              drawButton();
              if (onChange) onChange(chosen);
            },
          }, el('span', { className: 'checkbox' }, on ? icon('check', 12) : null), task);
        }),
      ]),
      el('button', { type: 'button', className: 'btn btn-primary btn-sm dd-done', onclick: () => close() }, 'Done'),
    );
  }

  // Clicking anywhere else, or pressing Escape, closes it
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  const escape = (e) => { if (e.key === 'Escape') close(); };

  function open() {
    startedWith = [...chosen];
    drawMenu();
    menu.hidden = false;
    button.ariaExpanded = 'true';
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
  }

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    button.ariaExpanded = 'false';
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape);
    if (onClose && chosen.join() !== startedWith.join()) onClose(chosen);
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  drawButton();
  wrap.append(button, menu);
  wrap.getTasks = () => chosen;
  return wrap;
}

// A button with an icon in front: iconButton('btn btn-primary', 'play', 'Start timer', onclick)
function iconButton(className, iconName, label, onclick, iconClass = '') {
  return el('button', { className, onclick }, icon(iconName, 15, iconClass), label);
}

function go(name, params = {}) {
  current = { name, params };
  render();
}

let lastScreen = null; // so only a new screen eases in, not every redraw of the same one

function render() {
  applyTheme();
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

// Light or dark: your saved choice, otherwise whatever the computer is set to
function currentTheme() {
  if (state.theme) return state.theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  document.documentElement.dataset.theme = currentTheme();
}

function themeToggle() {
  const dark = currentTheme() === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return el('button', {
    className: 'icon-btn',
    ariaLabel: label,
    title: label,
    onclick: () => act(() => data.setTheme(dark ? 'light' : 'dark')),
  }, icon(dark ? 'sun' : 'moon', 16));
}

function isRunning() {
  return Boolean(state.timer && state.timer.status === 'running');
}

// The big clock: "0:42" in full strength, ":10" softer
function bigClock() {
  const main = el('span');
  const seconds = el('span', { className: 'seconds' });
  const clock = el('span', { className: 'clock' }, main, seconds);
  const draw = () => {
    const text = data.clockText(state.timer);
    const cut = text.lastIndexOf(':');
    setClock(main, text.slice(0, cut));
    setClock(seconds, text.slice(cut));
    clock.classList.toggle('over', data.isOvertime(state.timer));
  };
  draw();
  liveTexts.push({ getText: () => null, update: draw });
  return clock;
}

const COUNTDOWN_PRESETS = [[15, '15m'], [30, '30m'], [60, '1h'], [120, '2h']];

// The button next to the clock: count up, or count down from now.
function countdownMenu(button) {
  const wrap = el('div', { className: 'task-dd look-tag' });
  const menu = el('div', { className: 'dd-menu dd-right', hidden: true });
  const custom = el('input', { className: 'input', type: 'number', min: '1', max: '1440', step: '1', placeholder: 'Minutes', ariaLabel: 'Minutes' });
  const pick = (minutes) => act(() => data.setCountdown(minutes));
  const counting = data.isCountdown(state.timer);

  menu.append(
    el('button', { type: 'button', className: 'dd-option', ariaChecked: String(!counting), onclick: () => pick(null) },
      el('span', { className: 'checkbox' }, counting ? null : icon('check', 12)), 'Count up'),
    el('div', { className: 'dd-group' }, counting ? 'Restart countdown from now' : 'Count down from now'),
    el('div', { className: 'chips dd-chips' }, ...COUNTDOWN_PRESETS.map(([minutes, label]) =>
      el('button', { type: 'button', className: 'chip', onclick: () => pick(minutes) }, label),
    )),
    el('div', { className: 'dd-custom' },
      custom,
      el('button', { type: 'button', className: 'btn btn-primary btn-sm', onclick: () => pick(Number(custom.value)) }, 'Set'),
    ),
  );

  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  const escape = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    menu.hidden = true;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape);
  }
  button.addEventListener('click', () => {
    if (!menu.hidden) return close();
    menu.hidden = false;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
  });

  wrap.append(button, menu);
  return wrap;
}

// The frame every screen shares: header bar, error line, scrolling body, action bar.
function screen({ title, back, logo = false, links = [], body = [], footer = null }) {
  const header = el('div', { className: 'header' },
    back ? el('button', { className: 'icon-btn', ariaLabel: 'Back', title: 'Back', onclick: back }, icon('back', 18)) : null,
    // Brand mark: the white hourglass on an ink tile, flipping while a timer runs
    logo ? el('span', { className: 'brand-mark' },
      el('img', { className: isRunning() ? 'logo flipping' : 'logo', src: LOGO_URL, alt: '' }),
    ) : null,
    el('h1', { className: logo ? 'wordmark' : '' }, title),
    links.length ? el('nav', { className: 'nav' }, ...links) : null,
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
    el('button', { className: 'nav-link', onclick: () => go('stats') }, 'Stats'),
    el('button', { className: 'nav-link', onclick: () => go('clients') }, 'Clients'),
    themeToggle(),
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
        iconButton('btn btn-primary', 'plus', 'Add client', () => go('client', { from: 'dashboard' })),
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
      // While the away question is open it takes the timer card's place,
      // so you can't stop the timer and bill the away time by accident.
      data.awayPrompt(state.timer) ? awayCard() : timerCard(),
      totals(),
      sectionHead('By client', 'This week'),
      byClientRows(),
    ],
    footer: data.awayPrompt(state.timer) ? null : [
      iconButton('btn btn-secondary btn-half', 'plus', 'Add past time', () => go('past', { from: 'dashboard' })),
      iconButton('btn btn-secondary btn-half', 'download', 'Export CSV', () => go('export')),
    ],
  });
}

// "You were away for 23 min. Keep this time on Bloom Florals?"
function awayCard() {
  const away = data.awayPrompt(state.timer);
  const client = data.findClient(state, state.timer.clientId);
  const length = data.formatAway(away.until - away.since);
  return el('div', { className: 'card live away-card', role: 'alert' },
    el('div', { className: 'client-name' }, `You were away for ${length}`),
    el('p', { className: 'small muted' }, `Keep this time on ${client.name}?`),
    el('div', { className: 'card-actions' },
      el('button', { className: 'btn btn-on-dark', onclick: () => act(data.discardAwayTime) }, `Discard ${length}`),
      el('button', { className: 'btn btn-light', onclick: () => act(data.keepAwayTime) }, 'Keep time'),
    ),
  );
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
        className: 'btn btn-primary btn-block btn-continue',
        onclick: () => actThenClose(() => data.startTimer({ clientId: last.clientId, tasks: data.tasksOf(last), note: last.note })),
      },
        icon('play', 15, 'go'),
        el('span', { className: 'grow' }, el('strong', {}, 'Continue '), `${lastClient.name} · ${data.formatTasks(last)}`),
        icon('chevron', 14),
      )
      : iconButton('btn btn-primary btn-block', 'play', 'Start timer', () => go('start'), 'go');

    return el('div', { className: 'card' },
      sectionHead('Ready to track', today),
      main,
      el('div', { className: 'chips' },
        ...data.clientsByRecent(state).slice(0, 4).map((c) =>
          el('button', { className: 'chip client-chip', title: `Start a timer for ${c.name}`, onclick: () => go('start', { clientId: c.id }) }, dot(c.color), c.name),
        ),
        el('button', { className: 'chip chip-ghost', onclick: () => go('start') }, icon('plus', 13), 'New timer'),
      ),
    );
  }

  const client = data.findClient(state, t.clientId);
  const running = t.status === 'running';
  const canSwitch = data.activeClients(state).some((c) => c.id !== t.clientId);
  const switchButton = canSwitch
    ? iconButton(`btn btn-sm ${running ? 'btn-on-dark' : 'btn-secondary'}`, 'swap', 'Switch', () => go('switch'))
    : null;

  return el('div', { className: running ? 'card live' : 'card paused' },
    // Who you're billing, and a way to switch
    el('div', { className: 'card-top' },
      dot(client.color),
      el('span', { className: 'client-name grow' }, client.name),
      switchButton,
    ),
    // Status, tasks (tap to change), and note on one line
    el('div', { className: 'card-top' },
      el('span', { className: `status-pill ${running ? 'running' : 'paused'}` },
        el('span', { className: running ? 'live-dot' : 'pause-dot' }),
        running ? 'Running' : 'Paused',
      ),
      taskDropdown(data.tasksOf(t), { look: 'tag', onClose: (tasks) => act(() => data.setTimerTasks(tasks)) }),
      t.note ? el('span', { className: 'small muted grow', title: t.note }, t.note) : null,
    ),
    el('div', { className: 'card-clock' },
      bigClock(),
      countdownMenu(el('button', {
        type: 'button',
        className: `btn btn-sm ${running ? 'btn-on-dark' : 'btn-secondary'}`,
        title: 'Count up or set a timer',
      }, icon('timer', 14), data.isOvertime(t) ? "Time's up" : data.isCountdown(t) ? 'Counting down' : 'Set timer')),
    ),
    el('div', { className: 'card-actions' },
      running
        ? iconButton('btn btn-on-dark', 'pause', 'Pause', () => act(data.pauseTimer))
        : iconButton('btn btn-primary', 'play', 'Resume', () => act(data.resumeTimer), 'go'),
      iconButton(running ? 'btn btn-light' : 'btn btn-secondary', 'stop', 'Stop', () => act(data.stopTimer)),
    ),
  );
}

// Money first (that's what this is for), hours underneath.
// The week tile has a little Sun–Sat bar chart, today in ink.
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

  // Both tiles open Stats for this week
  const openStats = () => { statsKind = 'week'; statsOffset = 0; go('stats'); };
  return el('div', { className: 'totals' },
    el('button', { className: 'total', onclick: openStats, title: 'See stats' },
      el('span', { className: 'label' }, 'Today'),
      liveText(() => data.formatMoney(today().amount), { className: 'total-value display-num' }, { digits: true }),
      liveText(() => data.formatHours(today().ms), { className: 'total-sub' }),
    ),
    el('button', { className: 'total', onclick: openStats, title: 'See stats' },
      el('span', { className: 'label' }, 'This week'),
      bars, // pinned to the corner so both tiles line up
      liveText(() => data.formatMoney(week().amount, 0), { className: 'total-value display-num' }, { digits: true }),
      liveText(() => data.formatHours(week().ms), { className: 'total-sub' }),
    ),
  );
}

function byClientRows() {
  const weekOf = (id) => data.workedBetween(state, data.startOfWeek(), Infinity, id);
  const clients = data.activeClients(state).sort((a, b) => weekOf(b.id).amount - weekOf(a.id).amount || weekOf(b.id).ms - weekOf(a.id).ms);
  const most = Math.max(1, ...clients.map((c) => weekOf(c.id).ms));
  return list(clients.map((c) =>
    el('div', {
      className: 'row share',
      style: `--c: ${data.colorHex(c.color)}; --share: ${weekOf(c.id).ms / most}`,
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
  // Preselect the tasks you last did for this client (or anyone, if they're new)
  const last = data.lastEntryFor(state, clientId) || data.lastEntry(state);
  let tasks = last ? data.tasksOf(last).filter((t) => data.TASKS.includes(t)) : [];
  if (tasks.length === 0) tasks = [data.TASKS[0]];

  const clientRows = el('div', { className: 'list' });
  const chips = el('div', { className: 'task-groups' });
  const noteInput = el('input', { className: 'input', placeholder: 'e.g. Homepage revisions', maxLength: 200 });

  // Redraw the client list and task chips to show what's picked
  function update() {
    clientRows.replaceChildren(...clients.map((c) =>
      el('button', { className: 'row', ariaPressed: String(c.id === clientId), onclick: () => { clientId = c.id; update(); } },
        dot(c.color),
        el('span', { className: 'grow' }, c.name),
        c.id === clientId ? icon('check', 15, 'check') : null,
      ),
    ));
    chips.replaceChildren(...data.TASK_GROUPS.map(([group, groupTasks]) =>
      el('div', { className: 'task-group' },
        el('span', { className: 'group-name' }, group),
        el('div', { className: 'chips' }, ...groupTasks.map((name) =>
          el('button', {
            className: 'chip',
            ariaPressed: String(tasks.includes(name)),
            // Tap to add or remove; at least one stays picked
            onclick: () => {
              if (tasks.includes(name)) { if (tasks.length > 1) tasks = tasks.filter((t) => t !== name); }
              else tasks = data.TASKS.filter((t) => t === name || tasks.includes(t));
              update();
            },
          }, name),
        )),
      ),
    ));
  }
  update();

  // Count up, or count down from a set time. The minutes box is what counts;
  // the chips just fill it in.
  let countingDown = false;
  const minutesInput = el('input', { className: 'input minutes-input', type: 'number', min: '1', max: '1440', step: '1', value: '30', ariaLabel: 'Minutes', title: 'Minutes' });
  const modeBox = el('div', { className: 'stack mode-box' });
  function drawMode() {
    const presets = COUNTDOWN_PRESETS.map(([minutes, label]) => {
      const chip = el('button', {
        className: 'chip',
        ariaPressed: String(Number(minutesInput.value) === minutes),
        onclick: () => { minutesInput.value = minutes; drawMode(); },
      }, label);
      return chip;
    });
    modeBox.replaceChildren(
      segmented([['up', 'Count up'], ['down', 'Count down']], countingDown ? 'down' : 'up', (mode) => { countingDown = mode === 'down'; drawMode(); }),
      ...(countingDown ? [el('div', { className: 'chips mode-chips' }, ...presets, minutesInput, el('span', { className: 'small muted' }, 'min'))] : []),
    );
  }
  drawMode();

  const start = () => actThenClose(() => data.startTimer({
    clientId,
    tasks,
    note: noteInput.value.trim(),
    minutes: countingDown ? Number(minutesInput.value) : null,
  }));
  noteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });

  return screen({
    title: 'Start timer',
    back: () => go('dashboard'),
    body: [
      sectionHead('Client'),
      clientRows,
      sectionHead('Tasks', 'Pick any that apply'),
      chips,
      sectionHead('Timer'),
      modeBox,
      field('Note (optional)', noteInput),
    ],
    footer: [iconButton('btn btn-primary btn-block', 'play', 'Start timer', start, 'go')],
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
      el('p', { className: 'small muted' }, `Ends the entry for ${from.name} and starts a new one, keeping the tasks (${data.formatTasks(t)}).`),
      list(others.map((c) =>
        el('button', { className: 'row', onclick: () => actThenClose(() => data.switchClient(c.id)) },
          dot(c.color),
          el('span', { className: 'grow' }, c.name),
          el('span', { className: 'meta' }, data.formatRate(c.rate)),
          icon('chevron', 14, 'chev'),
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
      list(clients.map((c) =>
        el('button', { className: 'row', onclick: () => go('client', { id: c.id, from: 'clients' }) },
          dot(c.color),
          el('span', { className: 'grow' }, c.name),
          el('span', { className: 'meta' }, data.formatRate(c.rate)),
          icon('chevron', 14, 'chev'),
        ),
      ), 'No clients yet.'),
    ],
    footer: [iconButton('btn btn-primary btn-block', 'plus', 'Add client', () => go('client', { from: 'clients' }))],
  });
}

// New client when there's no id, edit client when there is.
function clientScreen({ id, from = 'clients' }) {
  const existing = id ? data.findClient(state, id) : null;
  // Old color names (coral, lilac, sky) map onto the new rainbow
  const current = (name) => data.COLOR_ALIASES[name] || name;
  const usedColors = data.activeClients(state).map((c) => current(c.color));
  const colorNames = Object.keys(data.CLIENT_COLORS);
  // New clients get the first color nobody uses yet, so clients rarely share one
  let color = existing ? current(existing.color) : (colorNames.find((n) => !usedColors.includes(n)) || colorNames[0]);

  const nameInput = el('input', { className: 'input', placeholder: 'e.g. Bloom Florals', maxLength: 60, value: existing ? existing.name : '' });
  const rateInput = el('input', { className: 'input', type: 'number', min: '0', step: '0.01', placeholder: '$0.00', value: existing ? String(existing.rate) : '' });
  const noteInput = el('input', { className: 'input', placeholder: 'About client', maxLength: 200, value: existing ? existing.note || '' : '' });

  const swatches = el('div', { className: 'swatches' });
  function updateSwatches() {
    swatches.replaceChildren(...colorNames.map((name) =>
      el('button', {
        className: 'swatch',
        ariaLabel: name[0].toUpperCase() + name.slice(1),
        title: name[0].toUpperCase() + name.slice(1),
        ariaPressed: String(name === color),
        style: `background: ${data.colorHex(name)}`,
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
    field('Client name', nameInput),
    el('div', { className: 'field' }, el('span', {}, 'Color'), swatches),
    field('Hourly rate ($)', rateInput),
    field('Note (optional)', noteInput),
  );
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(); });
  setTimeout(() => nameInput.focus());

  return screen({
    title: existing ? 'Edit client' : 'New client',
    back: leave,
    body: [body],
    footer: [
      existing ? el('button', { className: 'btn btn-danger', onclick: remove }, 'Delete') : null,
      el('span', { className: 'spacer' }),
      el('button', { className: 'btn btn-secondary', onclick: leave }, 'Cancel'),
      el('button', { className: 'btn btn-primary', onclick: save }, existing ? 'Save' : 'Add client'),
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
    el('span', { className: 'grow' }, `${client.name} · `, el('span', { className: 'muted' }, data.formatTasks(e))),
    el('span', { className: 'meta' }, data.formatShortDuration(data.entryMs(e))),
    icon('chevron', 14, 'chev'),
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
      sectionHead(data.formatDayLabel(day), entries.length ? `${data.formatHours(total.ms)} · ${data.formatMoney(total.amount, 0)}` : ''),
      list(entries.map(entryRow), day > today ? 'Nothing yet.' : 'Nothing logged this day.'),
    );
  }

  const cells = new Map(); // day → its button, to move the "selected" ring
  const grid = el('div', { className: 'cal' },
    ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => el('span', { className: 'cal-weekday' }, d)),
  );
  // Blank cells so the 1st lands under the right weekday (weeks start Sunday)
  const blanks = new Date(calendarMonth).getDay();
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
  const nav = periodNav({
    title: new Date(calendarMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    sub: `${data.formatHours(monthTotal.ms)} · ${data.formatMoney(monthTotal.amount, 0)}`,
    noun: 'month',
    onStep: changeMonth,
    canGoNext: calendarMonth < thisMonth,
  });

  return [nav, el('div', { className: 'card cal-card' }, grid), detail];
}

function entriesScreen() {
  const ranges = ['today', 'week', 'month'];

  // "Add past time" from the calendar starts on the picked day (if it's not in the future).
  // Read when clicked, since picking a day doesn't redraw the screen.
  const pastDay = () => (entriesRange === 'month' && selectedDay !== null && selectedDay <= data.startOfToday() ? selectedDay : null);
  const footer = [iconButton('btn btn-secondary btn-block', 'plus', 'Add past time', () => go('past', { from: 'entries', day: pastDay() }))];
  const chips = segmented(
    ranges.map((name) => [name, name === 'month' ? 'Month' : data.RANGES[name]]),
    entriesRange,
    (name) => { entriesRange = name; render(); },
  );

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
    const dayTotal = data.totalOf(dayEntries);
    groups.push(
      sectionHead(data.formatDayLabel(day), `${data.formatHours(dayTotal.ms)} · ${data.formatMoney(dayTotal.amount, 0)}`),
      list(dayEntries.map(entryRow)),
    );
  }

  return screen({
    title: 'Entries',
    back: () => go('dashboard'),
    body: [
      chips,
      entries.length === 0 ? list([], 'No entries in this period.') : null,
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

  // Tasks: a checkbox dropdown, in the same groups as the Start timer chips
  const taskPicker = taskDropdown(entry ? data.tasksOf(entry) : ['Other']);

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
    tasks: taskPicker.getTasks(),
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
    el('div', { className: 'field' }, el('span', {}, 'Tasks'), taskPicker),
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
      el('button', { className: 'btn btn-danger', onclick: remove }, 'Delete'),
      el('span', { className: 'spacer' }),
      el('button', { className: 'btn btn-secondary', onclick: () => go('entries') }, 'Cancel'),
      el('button', { className: 'btn btn-primary', onclick: () => act(() => data.updateEntry(id, values()), 'entries') }, 'Save'),
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
    footer: [iconButton('btn btn-primary btn-block', 'plus', 'Add time', () => act(() => data.addEntry(values()), from))],
  });
}

// ---------- Stats ----------

let statsKind = 'week'; // 'week' | 'month' | 'year'
let statsOffset = 0; // 0 = current period, -1 = the one before, ...

function statsScreen() {
  const now = Date.now();
  const period = data.statsPeriod(statsKind, statsOffset, now);
  const pieces = data.piecesBetween(state, period.from, period.to, now);
  const total = data.sumPieces(pieces);
  const noun = { week: 'week', month: 'month', year: 'year' }[statsKind];

  // Compare with the period before. For the current period, only up to the
  // same point (Mon–Wed vs last Mon–Wed), so a half-finished week isn't unfair.
  const prev = data.statsPeriod(statsKind, statsOffset - 1, now);
  const prevTo = statsOffset === 0 ? prev.from + (now - period.from) : prev.to;
  const prevTotal = data.sumPieces(data.piecesBetween(state, prev.from, Math.min(prevTo, prev.to), now));
  let compare = null;
  if (prevTotal.amount > 0) {
    const change = Math.round(((total.amount - prevTotal.amount) / prevTotal.amount) * 100);
    const when = statsOffset === 0 ? `same time last ${noun}` : `previous ${noun}`;
    compare = el('span', { className: 'compare' },
      icon(change >= 0 ? 'up' : 'down', 12),
      `${Math.abs(change)}%`,
      el('span', {}, `vs ${when}`),
    );
  }

  const hours = total.ms / 3600000;
  const avgRate = hours > 0 ? total.amount / hours : 0;
  const days = data.groupPieces(pieces, (p) => data.startOfToday(p.start));
  const busiest = [...days].sort((a, b) => b.ms - a.ms)[0];

  const changePeriod = (step) => { statsOffset += step; render(); };

  return screen({
    title: 'Stats',
    back: () => go('dashboard'),
    body: [
      segmented([['week', 'Week'], ['month', 'Month'], ['year', 'Year']], statsKind, (kind) => { statsKind = kind; statsOffset = 0; render(); }),
      periodNav({ title: period.label, noun, onStep: changePeriod, canGoNext: statsOffset < 0 }),
      // Headline number and the chart, together in one card
      el('div', { className: 'card' },
        el('div', {},
          el('div', { className: 'label' }, 'Billed'),
          el('div', { className: 'stat-total display-num' }, data.formatMoney(total.amount)),
        ),
        el('div', { className: 'stat-sub' }, el('span', { className: 'small muted num' }, `${data.formatHours(total.ms)} tracked`), compare),
        barChart(period, pieces, now),
      ),
      el('div', { className: 'mini-stats' },
        miniStat('Avg rate', avgRate ? data.formatRate(Math.round(avgRate)) : '—'),
        miniStat('Days worked', String(days.length)),
        miniStat('Busiest day', busiest ? `${new Date(busiest.key).toLocaleDateString('en-US', { weekday: 'short' })} ${new Date(busiest.key).getDate()}` : '—',
          busiest ? data.formatHours(busiest.ms) : ''),
      ),
      pieces.length === 0 ? list([], `No time logged this ${noun}.`) : null,
      ...breakdown('By client', data.groupPieces(pieces, (p) => p.clientId), total, 'amount', (g) => {
        const client = data.findClient(state, g.key);
        return { name: client.name, color: data.colorHex(client.color), value: data.formatMoney(g.amount, 0) };
      }),
      ...breakdown('By task', data.groupPieces(data.splitByTask(pieces), (p) => p.task).sort((a, b) => b.ms - a.ms), total, 'ms', (g) => (
        { name: g.key, color: null, value: data.formatHours(g.ms) }
      )),
    ],
  });
}

function miniStat(label, value, sub = '') {
  return el('div', { className: 'mini' },
    el('span', { className: 'label' }, label),
    el('strong', {}, value),
    sub ? el('span', { className: 'small muted' }, sub) : null,
  );
}

// Money per day (or per month for a year). One series, so no legend:
// the current day/month is ink, the rest mocha. Hover or focus a bar for its numbers.
function barChart(period, pieces, now) {
  const values = period.buckets.map((b) => {
    const inBucket = pieces.filter((p) => p.start >= b.from && p.start < b.to);
    return { ...b, ...data.sumPieces(inBucket) };
  });
  const most = Math.max(1, ...values.map((v) => v.amount));
  const tip = el('div', { className: 'chart-tip', hidden: true });
  const chart = el('div', { className: 'chart' });

  const showTip = (col, v) => {
    tip.replaceChildren(el('strong', {}, v.name), el('span', {}, `${data.formatHours(v.ms)} · ${data.formatMoney(v.amount)}`));
    tip.hidden = false;
    // Center over the bar, but keep it inside the chart
    const center = col.offsetLeft + col.offsetWidth / 2;
    const left = Math.min(Math.max(center - tip.offsetWidth / 2, 0), chart.offsetWidth - tip.offsetWidth);
    tip.style.left = `${left}px`;
  };

  const bars = el('div', { className: 'chart-bars' }, ...values.map((v) => {
    const current = now >= v.from && now < v.to;
    const col = el('button', {
      className: ['chart-col', current ? 'current' : '', v.from > now ? 'future' : ''].join(' ').trim(),
      ariaLabel: `${v.name}: ${data.formatHours(v.ms)}, ${data.formatMoney(v.amount)}`,
    }, el('span', { className: 'chart-fill', style: `height: ${v.amount ? Math.max(3, (v.amount / most) * 100) : 0}%` }));
    col.addEventListener('mouseenter', () => showTip(col, v));
    col.addEventListener('focus', () => showTip(col, v));
    col.addEventListener('mouseleave', () => { tip.hidden = true; });
    col.addEventListener('blur', () => { tip.hidden = true; });
    return col;
  }));

  chart.append(
    tip,
    bars,
    el('div', { className: 'chart-axis' }, ...values.map((v) => el('span', {}, v.axis))),
  );
  return chart;
}

// "By client" / "By task": name, a bar for its share, its value and %.
// Names always sit next to the bars, so nothing depends on color alone.
// `measure` is what the bar and % compare: 'amount' ($) or 'ms' (time).
function breakdown(title, groups, total, measure, describe) {
  if (groups.length === 0) return [];
  const most = Math.max(...groups.map((g) => g[measure])) || 1;
  return [
    sectionHead(title, measure === 'amount' ? 'Billed' : 'Time'),
    el('div', { className: 'list' }, ...groups.map((g) => {
      const { name, color, value } = describe(g);
      const share = total[measure] ? Math.round((g[measure] / total[measure]) * 100) : 0;
      return el('div', { className: 'stat-row' },
        color ? el('span', { className: 'dot', style: `background: ${color}` }) : el('span'),
        el('span', { className: 'grow' }, name),
        el('span', { className: 'stat-bar' },
          el('span', { style: `width: ${(g[measure] / most) * 100}%; background: ${color || 'var(--mocha)'}` }),
        ),
        el('span', { className: 'meta money' }, value),
        el('span', { className: 'meta share' }, `${share}%`),
      );
    })),
  ];
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

  const count = el('div', { className: 'preview-count display-num' });
  const totals = el('div', { className: 'small muted num' });
  const download = el('button', { className: 'btn btn-primary btn-block' }, icon('download', 15), 'Download CSV');

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
      el('div', { className: 'card' }, el('div', {}, el('div', { className: 'label' }, 'Preview'), count, totals)),
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
  stats: statsScreen,
};

// ---------- Start up ----------

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  state = await data.getState();
  if (LIVE_SCREENS.has(current.name)) render();
});

setInterval(() => {
  for (const { getText, update } of liveTexts) update(getText());
}, 1000);

state = await data.getState();
render();
