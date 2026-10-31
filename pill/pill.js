// pill/pill.js
// Content script: the floating pill shown on every webpage while a timer exists
// (running or paused). Click it to open a small card with Pause, Stop,
// "Switch to" and "Open dashboard".
//
// Everything lives inside a closed Shadow DOM, so the website's CSS can't
// change how the pill looks, and the pill's CSS can't leak into the website.
// It reads the timer straight from storage and calls the same functions as
// the popup (shared/data.js), so the two always agree.

(async () => {
  const data = await import(chrome.runtime.getURL('shared/data.js'));

  // DM Sans under its own name, so it can't clash with a site's own fonts
  try {
    const font = new FontFace('Hourglass DM Sans', `url(${chrome.runtime.getURL('fonts/DMSans-Variable.ttf')})`, { weight: '100 1000' });
    document.fonts.add(font);
    font.load().catch(() => {}); // if a site blocks it, the fallback font is used
  } catch (err) {
    // FontFace unavailable: fall back quietly
  }

  const CSS = `
    :host {
      --cream: #F6F3EE; --paper: #FFFFFF; --sand: #EAE4DA; --line: #DDD6CB;
      --muted: #6E6862; --ink: #161412; --on-ink: #FFFFFF; --mocha: #6E5A54;
      --running: #3DBE6B; --idle: #F2A93B; --delete: #D9482B;
    }
    * { box-sizing: border-box; margin: 0; }
    .wrap {
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font-family: 'Hourglass DM Sans', 'DM Sans', system-ui, sans-serif;
      font-size: 13px; line-height: 1.3; color: var(--ink);
      -webkit-font-smoothing: antialiased;
    }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:focus-visible, .pill:focus-visible { outline: 2px solid var(--mocha); outline-offset: 2px; }

    /* The pill: dark while running, light while paused */
    .pill {
      height: 36px; max-width: 280px; padding: 0 5px 0 14px;
      display: flex; align-items: center; gap: 8px;
      border-radius: 999px; background: var(--ink); color: var(--on-ink);
      box-shadow: 0 4px 16px rgba(22, 20, 18, 0.18);
      cursor: pointer; user-select: none;
    }
    .pill.paused { background: var(--paper); color: var(--ink); border: 1px solid var(--line); }
    .name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .clock { flex: none; font-weight: 500; font-variant-numeric: tabular-nums; }
    .status { flex: none; font-size: 12px; color: var(--muted); }
    .icon {
      flex: none; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
      display: grid; place-items: center; background: transparent;
    }
    .icon:hover { background: rgba(255, 255, 255, 0.14); }
    .paused .icon:hover { background: var(--sand); }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }

    /* The card that opens upward when you click the pill */
    .card {
      width: 280px; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
      background: var(--paper); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 8px 28px rgba(22, 20, 18, 0.16);
    }
    .card[hidden] { display: none; }
    .card-name { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
    .big-clock { font-size: 28px; font-weight: 600; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
    .tag {
      flex: none; height: 22px; padding: 0 9px;
      display: inline-flex; align-items: center;
      border: 1px solid var(--line); border-radius: 999px; font-size: 12px; font-weight: 500;
    }
    /* Same calm buttons as the popup: ink primary, white secondary */
    .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .btn {
      height: 32px; border: 1px solid transparent; border-radius: 6px; font-weight: 600;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    }
    .btn svg { flex: none; }
    .btn-primary { background: var(--ink); color: var(--on-ink); }
    .btn-primary:hover { background: #2C2925; }
    .btn-primary .go { color: var(--running); }
    .btn-secondary { background: var(--paper); border-color: var(--line); color: var(--ink); }
    .btn-secondary:hover { background: #F3EFE8; border-color: #CFC6B8; }
    .label {
      margin-top: 2px; font-size: 10px; font-weight: 600;
      letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted);
    }
    .list {
      display: flex; flex-direction: column; max-height: 180px; overflow-y: auto;
      border: 1px solid var(--line); border-radius: 10px;
    }
    .row {
      width: 100%; height: 36px; padding: 0 10px;
      display: flex; align-items: center; gap: 8px;
      border: 0; background: none; text-align: left;
    }
    .row + .row { border-top: 1px solid #EEE9E1; }
    .row:hover { background: #F3EFE8; }
    .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chev { color: #B3AA9E; display: flex; }
    .link {
      height: 32px; border: 0; border-radius: 6px; background: none; font-weight: 600;
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    }
    .link:hover { background: #F3EFE8; }

    @media print { .wrap { display: none; } }
  `;

  const PAUSE_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor"/><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor"/></svg>';
  const PLAY_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>';
  const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
  const CHEVRON_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 17l5-5-5-5"/></svg>';

  // An inline icon from one of the strings above
  function svg(markup, className = '') {
    const span = document.createElement('span');
    span.className = className;
    span.style.display = 'flex';
    span.innerHTML = markup;
    return span;
  }

  // A custom element name no website will style, reset to defaults and pinned to the corner
  const host = document.createElement('hourglass-pill');
  // (!important so even a site's "* { ... !important }" rules can't reach it)
  host.style.cssText = 'all: initial !important; position: fixed !important; right: 24px !important; bottom: 24px !important; z-index: 2147483647 !important;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="card" hidden></div><div class="pill" role="button" tabindex="0"></div></div>`;
  const card = root.querySelector('.card');
  const pill = root.querySelector('.pill');

  let state = null;
  let open = false; // is the card showing?
  let clocks = []; // clock elements to refresh every second

  // Same element helper as the popup
  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
    return node;
  }

  function dot(color) {
    return el('span', { className: 'dot', style: `background: ${data.colorHex(color)}` });
  }

  function clock(className) {
    const node = el('span', { className }, data.formatDuration(data.sessionMs(state.timer)));
    clocks.push(node);
    return node;
  }

  // The extension was reloaded or removed: this copy of the pill can't do anything anymore.
  function extensionGone() {
    return !chrome.runtime || !chrome.runtime.id;
  }

  async function run(action) {
    try {
      await action(); // storage changes, and the listener below redraws
    } catch (err) {
      if (extensionGone()) host.remove();
      else console.warn('Hourglass:', err.message);
    }
  }

  function setOpen(value) {
    open = value;
    render();
  }

  function render() {
    clocks = [];
    const t = state && state.timer;
    const client = t && data.findClient(state, t.clientId);
    if (!t || !client) {
      open = false;
      host.remove(); // nothing running: no pill
      return;
    }
    if (!host.isConnected) document.documentElement.append(host);

    const running = t.status === 'running';
    const toggle = running ? data.pauseTimer : data.resumeTimer;

    pill.className = running ? 'pill' : 'pill paused';
    pill.ariaLabel = `Hourglass: ${running ? 'billing' : 'paused'} ${client.name}. Click for options.`;
    pill.ariaExpanded = String(open);
    const iconButton = el('button', {
      className: 'icon',
      ariaLabel: running ? 'Pause' : 'Resume',
      title: running ? 'Pause' : 'Resume',
      onclick: (e) => { e.stopPropagation(); run(toggle); },
    });
    iconButton.innerHTML = running ? PAUSE_ICON : PLAY_ICON;
    pill.replaceChildren(...[
      dot(client.color),
      el('span', { className: 'name' }, client.name),
      clock('clock'),
      running ? null : el('span', { className: 'status' }, 'Paused'),
      iconButton,
    ].filter(Boolean));

    card.hidden = !open;
    if (!open) return;

    const others = data.activeClients(state).filter((c) => c.id !== t.clientId);
    card.replaceChildren(...[
      el('div', { className: 'card-name' },
        dot(client.color),
        el('span', { className: 'grow' }, client.name),
        el('span', { className: 'tag' }, t.task),
      ),
      clock('big-clock'),
      el('div', { className: 'btns' },
        running
          ? el('button', { className: 'btn btn-secondary', onclick: () => run(toggle) }, svg(PAUSE_ICON), 'Pause')
          : el('button', { className: 'btn btn-primary', onclick: () => run(toggle) }, svg(PLAY_ICON, 'go'), 'Resume'),
        el('button', { className: running ? 'btn btn-primary' : 'btn btn-secondary', onclick: () => run(data.stopTimer) }, svg(STOP_ICON), 'Stop'),
      ),
      others.length ? el('div', { className: 'label' }, 'Switch to') : null,
      others.length ? el('div', { className: 'list' }, ...others.map((c) =>
        el('button', { className: 'row', onclick: () => { open = false; run(() => data.switchClient(c.id)); } },
          dot(c.color),
          el('span', { className: 'grow' }, c.name),
          svg(CHEVRON_ICON, 'chev'),
        ),
      )) : null,
      el('button', {
        className: 'link',
        onclick: () => {
          setOpen(false);
          chrome.runtime.sendMessage({ type: 'open-dashboard' }).catch(() => {});
        },
      }, 'Open dashboard', svg(CHEVRON_ICON, 'chev')),
    ].filter(Boolean));
  }

  // Click or press Enter/Space on the pill to open or close the card
  pill.addEventListener('click', () => setOpen(!open));
  pill.addEventListener('keydown', (e) => {
    if (e.target === pill && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(!open);
    }
  });

  // Close the card when clicking anywhere else on the page, or pressing Escape
  document.addEventListener('click', (e) => {
    if (open && !e.composedPath().includes(host)) setOpen(false);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') setOpen(false);
  });

  // Redraw whenever the timer or clients change (from the popup, another tab, or here)
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !(changes.timer || changes.clients)) return;
    state = await data.getState();
    render();
  });

  const ticker = setInterval(() => {
    if (extensionGone()) {
      clearInterval(ticker);
      host.remove();
      return;
    }
    if (!state || !state.timer) return;
    if (!host.isConnected) document.documentElement.append(host); // some sites rebuild the page
    const text = data.formatDuration(data.sessionMs(state.timer));
    for (const node of clocks) node.textContent = text;
  }, 1000);

  state = await data.getState();
  render();
})();
