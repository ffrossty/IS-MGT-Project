'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

// Verify file signature (magic bytes) — the browser-supplied mimetype alone can't be trusted.
function sniff(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(12);
  fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.slice(0, 3).toString() === 'GIF') return 'image/gif';
  return null;
}

function imageUploader(subdir, { maxMb = 8 } = {}) {
  const dir = path.join(config.uploadDir, subdir);
  const storage = multer.diskStorage({
    destination: dir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ALLOWED[file.mimetype] || '.bin'}`),
  });
  return multer({
    storage,
    limits: { fileSize: maxMb * 1024 * 1024, files: 12 },
    fileFilter: (req, file, cb) => (ALLOWED[file.mimetype] ? cb(null, true) : cb(new Error('รองรับเฉพาะไฟล์รูปภาพ JPG, PNG, WEBP, GIF'))),
  });
}

/** Remove uploaded files that don't have a valid image signature. Returns valid files. */
function verifyImages(files) {
  const ok = [];
  for (const f of files || []) {
    if (sniff(f.path)) ok.push(f); else fs.rmSync(f.path, { force: true });
  }
  return ok;
}

function removeFile(subdir, filename) {
  if (!filename || filename.includes('/') || filename.includes('..')) return;
  fs.rmSync(path.join(config.uploadDir, subdir, filename), { force: true });
}

module.exports = { imageUploader, verifyImages, removeFile };
