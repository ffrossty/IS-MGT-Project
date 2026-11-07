'use strict';
const { runBackup } = require('../src/lib/backup');
runBackup('cli').then((b) => console.log('Backup created:', b.name, `${(b.size / 1024).toFixed(0)} KB`)).catch((e) => { console.error(e); process.exit(1); });
