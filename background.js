// background.js
// The service worker. For now it only keeps the toolbar icon in sync with the timer:
//   - the badge shows the running time (e.g. 0:42): green while running, amber while paused
//   - hovering the icon says who you're billing
// It never starts or changes timers on its own (manual timers only).
//
// Chrome puts this worker to sleep when it's idle, so instead of a ticking
// interval it sets an alarm for the exact moment the badge's minute changes.

import * as data from './shared/data.js';

const BADGE_ALARM = 'badge-tick';

async function updateBadge() {
  const state = await data.getState();
  const t = state.timer;
  await chrome.alarms.clear(BADGE_ALARM);

  if (!t) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Hourglass · no timer running' });
    return;
  }

  const client = data.findClient(state, t.clientId);
  const ms = data.sessionMs(t);
  const running = t.status === 'running';

  await chrome.action.setBadgeText({ text: data.formatBadge(ms) });
  await chrome.action.setBadgeBackgroundColor({ color: running ? '#3DBE6B' : '#F2A93B' }); // --running / --idle
  await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await chrome.action.setTitle({
    title: `Hourglass · ${running ? 'Billing' : 'Paused'} ${client.name} · ${t.task} · ${data.formatHours(ms)}`,
  });

  if (running) {
    // Wake up again right when the minute on the badge changes.
    const msToNextMinute = 60000 - (ms % 60000);
    chrome.alarms.create(BADGE_ALARM, { when: Date.now() + msToNextMinute + 50 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) updateBadge();
});

// Any change to the timer (from the popup, or later the pill) refreshes the badge.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.timer || changes.clients)) updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
