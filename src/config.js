'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: process.env.DOTENV_PATH || path.join(__dirname, '..', '.env'), quiet: true });

const root = path.join(__dirname, '..');
const resolve = (p, def) => path.resolve(root, p || def);

function readServiceAccount() {
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
  let key = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const jsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  if (jsonPath) {
    try {
      const j = JSON.parse(fs.readFileSync(resolve(jsonPath), 'utf8'));
      email = j.client_email || email;
      key = j.private_key || key;
    } catch (e) {
      console.warn('[config] Cannot read GOOGLE_SERVICE_ACCOUNT_JSON_PATH:', e.message);
    }
  }
  if (key.includes('...')) key = '';
  return { email, key };
}

const env = process.env.NODE_ENV || 'development';
const sa = readServiceAccount();

const config = {
  env,
  isProd: env === 'production',
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret',
  dataDir: resolve(process.env.DATA_DIR, './data'),
  uploadDir: resolve(process.env.UPLOAD_DIR, './uploads'),
  backupDir: resolve(process.env.BACKUP_DIR, './backups'),
  backupKeep: parseInt(process.env.BACKUP_KEEP || '14', 10),
  devLogin: env !== 'production' && String(process.env.DEV_LOGIN_ENABLED).toLowerCase() === 'true',
  line: {
    loginChannelId: process.env.LINE_LOGIN_CHANNEL_ID || '',
    loginChannelSecret: process.env.LINE_LOGIN_CHANNEL_SECRET || '',
    messagingToken: process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN || '',
    oaBasicId: process.env.LINE_OA_BASIC_ID || '',
  },
  adminLineIds: (process.env.ADMIN_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    sheetName: process.env.GOOGLE_SHEETS_SHEET_NAME || 'Orders',
    serviceEmail: sa.email,
    privateKey: sa.key,
  },
};

config.lineLoginConfigured = !!(config.line.loginChannelId && config.line.loginChannelSecret);
config.lineMessagingConfigured = !!config.line.messagingToken;
config.sheetsConfigured = !!(config.sheets.spreadsheetId && config.sheets.serviceEmail && config.sheets.privateKey);

if (config.isProd && config.sessionSecret === 'dev-insecure-secret') {
  throw new Error('SESSION_SECRET must be set in production');
}

for (const d of [config.dataDir, config.uploadDir, path.join(config.uploadDir, 'products'),
  path.join(config.uploadDir, 'slips'), path.join(config.uploadDir, 'settings'), config.backupDir]) {
  fs.mkdirSync(d, { recursive: true });
}

module.exports = config;
