// background.js
// The service worker. It keeps the toolbar icon in sync with the timer and announces
// when a countdown ends:
//   - the badge shows the time (e.g. 0:42): green while running, amber when paused or past zero
//   - hovering the icon says who you're billing
//   - a countdown reaching zero shows a Chrome notification; the timer keeps tracking
//   - coming back after 5+ minutes away asks whether to keep or discard that time
// It never starts or changes timers on its own (manual timers only).
//
// Chrome puts this worker to sleep when it's idle, so instead of a ticking
// interval it sets an alarm for the exact moment the badge's text changes
// (each second under a minute, otherwise each minute).

import * as data from './shared/data.js';

const BADGE_ALARM = 'badge-tick';
const COUNTDOWN_ALARM = 'countdown-done';
const AWAY_NOTIFICATION = 'hourglass-away';

async function updateBadge() {
  const state = await data.getState();
  const t = state.timer;
  await chrome.alarms.clear(BADGE_ALARM);
  await chrome.alarms.clear(COUNTDOWN_ALARM);
  if (!data.awayPrompt(t)) chrome.notifications.clear(AWAY_NOTIFICATION); // answered somewhere else

  if (!t) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Hourglass · no timer running' });
    return;
  }

  const client = data.findClient(state, t.clientId);
  const ms = data.sessionMs(t);
  const running = t.status === 'running';

  const needsAttention = !running || data.isOvertime(t) || Boolean(data.awayPrompt(t));

  await chrome.action.setBadgeText({ text: data.badgeText(t) });
  await chrome.action.setBadgeBackgroundColor({ color: needsAttention ? '#F2A93B' : '#3DBE6B' }); // --idle / --running
  await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await chrome.action.setTitle({
    title: `Hourglass · ${running ? 'Billing' : 'Paused'} ${client.name} · ${data.formatTasks(t)} · ${data.formatHours(ms)}`,
  });

  if (running) {
    // Wake up again right when the badge text changes.
    chrome.alarms.create(BADGE_ALARM, { when: Date.now() + data.msToNextBadgeChange(t) + 50 });

    if (data.isCountdown(t)) {
      const left = data.remainingMs(t);
      if (left > 0) chrome.alarms.create(COUNTDOWN_ALARM, { when: Date.now() + left + 50 });
      else if (!t.alerted) await announceCountdownDone(client);
    }
  }
}

// Time's up. The clock keeps tracking past zero, because only you decide when work stops.
async function announceCountdownDone(client) {
  await data.markCountdownAlerted();
  if (!data.settingsOf(await data.getState()).notifications) return; // the clock and badge still turn amber
  chrome.notifications.create('hourglass-countdown', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: "Time's up",
    message: `Your timer for ${client.name} finished. Hourglass keeps tracking until you stop it.`,
  });
}

// ---------- Idle check ----------
// chrome.idle watches the whole computer, not just Chrome. It wakes this worker when
// you've gone idle (no mouse or keyboard for 5 minutes), lock the screen, or return.

// Chrome needs the idle time set each time this worker starts, and after you change it.
async function applyIdleTime() {
  chrome.idle.setDetectionInterval(data.idleMs(await data.getState()) / 1000);
}
applyIdleTime();

chrome.idle.onStateChanged.addListener(async (idleState) => {
  const now = Date.now();
  if (idleState === 'idle') await data.markAway(now - data.idleMs(await data.getState())); // when you actually left
  else if (idleState === 'locked') await data.markAway(now);
  else if (await data.markBack(now)) await askAboutAwayTime();
});

// You're back: ask in a notification (the pill and popup show it too, from storage).
async function askAboutAwayTime() {
  const state = await data.getState();
  const away = data.awayPrompt(state.timer);
  const client = away && data.findClient(state, state.timer.clientId);
  if (!client || !data.settingsOf(state).notifications) return;
  chrome.notifications.create(AWAY_NOTIFICATION, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `You were away for ${data.formatAway(away.until - away.since)}`,
    message: `Keep this time on ${client.name}?`,
    buttons: [{ title: 'Keep time' }, { title: 'Discard' }],
    requireInteraction: true,
  });
}

chrome.notifications.onButtonClicked.addListener((id, button) => {
  if (id !== AWAY_NOTIFICATION) return;
  chrome.notifications.clear(id);
  if (button === 0) data.keepAwayTime();
  else data.discardAwayTime();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== BADGE_ALARM && alarm.name !== COUNTDOWN_ALARM) return;
  // An alarm this late means the computer was asleep, which chrome.idle can miss.
  const wait = data.idleMs(await data.getState());
  if (Date.now() - alarm.scheduledTime >= wait) {
    await data.markAway(alarm.scheduledTime);
    if ((await chrome.idle.queryState(wait / 1000)) === 'active' && (await data.markBack())) await askAboutAwayTime();
  }
  updateBadge();
});

// Any change to the timer (from the popup, or later the pill) refreshes the badge.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.timer || changes.clients)) updateBadge();
  if (area === 'local' && changes.settings) applyIdleTime();
});

// The pill's "Open dashboard" button. Content scripts can't open the popup
// themselves, so they ask here. If Chrome won't open it, show it in a tab.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'open-dashboard') openDashboard();
});

async function openDashboard() {
  try {
    await chrome.action.openPopup();
  } catch (err) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
  }
}

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  openDashboard();
});

chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
