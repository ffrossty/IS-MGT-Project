'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');
const T = require('./time');

/** Online, consistent SQLite backup (safe while the app is running). */
async function runBackup(label = 'auto') {
  const p = T.localParts(Date.now());
  const name = `rental-${p.y}${T.pad(p.m)}${T.pad(p.d)}-${T.pad(p.h)}${T.pad(p.mi)}-${label}.db`;
  const dest = path.join(config.backupDir, name);
  await db.backup(dest);
  prune();
  return { name, size: fs.statSync(dest).size };
}

function list() {
  return fs.readdirSync(config.backupDir).filter((f) => f.endsWith('.db'))
    .map((f) => ({ name: f, ...(({ size, mtimeMs }) => ({ size, mtime: mtimeMs }))(fs.statSync(path.join(config.backupDir, f))) }))
    .sort((a, b) => b.mtime - a.mtime);
}

function prune() {
  const files = list();
  for (const f of files.slice(Math.max(config.backupKeep, 1))) fs.rmSync(path.join(config.backupDir, f.name), { force: true });
}

function lastBackupAt() {
  const f = list()[0];
  return f ? f.mtime : 0;
}

module.exports = { runBackup, list, lastBackupAt };
