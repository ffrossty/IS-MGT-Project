'use strict';
const orders = require('./orders');
const sheets = require('./sheets');
const backup = require('./backup');

function start() {
  const tick = async () => {
    try { orders.runExpiryJob(); } catch (e) { console.error('[jobs] expiry', e); }
    try { await orders.runReturnReminders(); } catch (e) { console.error('[jobs] return reminders', e); }
    try { await sheets.processQueue(); } catch (e) { console.error('[jobs] sheets', e); }
    try {
      if (Date.now() - backup.lastBackupAt() > 24 * 3600 * 1000) {
        const b = await backup.runBackup('daily');
        console.log('[jobs] backup created', b.name);
      }
    } catch (e) { console.error('[jobs] backup', e); }
  };
  setTimeout(tick, 3000).unref();
  setInterval(tick, 60 * 1000).unref();
}

module.exports = { start };
