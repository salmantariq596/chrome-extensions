// MEXC Quick Trade — background: Windows/Mac notifications for the bot's alerts.
// The panel sends { mq: 'notify', level, title, message }; a click on the notification brings the MEXC bot window to the front.
const tabOf = {};
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || m.mq !== 'notify') return;
  const id = 'qt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  if (sender.tab) tabOf[id] = { tab: sender.tab.id, win: sender.tab.windowId };
  chrome.notifications.create(id, {
    type: 'basic', iconUrl: 'icon128.png', title: String(m.title || 'Quick Trade'), message: String(m.message || ''),
    priority: m.level === 'crit' ? 2 : m.level === 'warn' ? 1 : 0, requireInteraction: m.level === 'crit',
  }, () => { void chrome.runtime.lastError; reply({ ok: true }); });
  return true;
});
chrome.notifications.onClicked.addListener(id => {
  const t = tabOf[id];
  if (t) {
    chrome.tabs.update(t.tab, { active: true }, () => void chrome.runtime.lastError);
    chrome.windows.update(t.win, { focused: true }, () => void chrome.runtime.lastError);
  }
  chrome.notifications.clear(id);
});
