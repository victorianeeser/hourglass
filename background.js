// background.js
// The service worker. It keeps the toolbar icon in sync with the timer and announces
// when a countdown ends:
//   - the badge shows the time (e.g. 0:42): green while running, amber when paused or past zero
//   - hovering the icon says who you're billing
//   - a countdown reaching zero shows a Chrome notification; the timer keeps tracking
// It never starts or changes timers on its own (manual timers only).
//
// Chrome puts this worker to sleep when it's idle, so instead of a ticking
// interval it sets an alarm for the exact moment the badge's text changes
// (each second under a minute, otherwise each minute).

import * as data from './shared/data.js';

const BADGE_ALARM = 'badge-tick';
const COUNTDOWN_ALARM = 'countdown-done';

async function updateBadge() {
  const state = await data.getState();
  const t = state.timer;
  await chrome.alarms.clear(BADGE_ALARM);
  await chrome.alarms.clear(COUNTDOWN_ALARM);

  if (!t) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Hourglass · no timer running' });
    return;
  }

  const client = data.findClient(state, t.clientId);
  const ms = data.sessionMs(t);
  const running = t.status === 'running';

  const needsAttention = !running || data.isOvertime(t);

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
  chrome.notifications.create('hourglass-countdown', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: "Time's up",
    message: `Your timer for ${client.name} finished. Hourglass keeps tracking until you stop it.`,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM || alarm.name === COUNTDOWN_ALARM) updateBadge();
});

// Any change to the timer (from the popup, or later the pill) refreshes the badge.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.timer || changes.clients)) updateBadge();
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
