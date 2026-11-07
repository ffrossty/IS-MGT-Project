'use strict';
// Thailand uses a fixed UTC+07:00 offset (no daylight saving time).
const TZ = 'Asia/Bangkok';
const OFFSET_MS = 7 * 3600 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Parse "YYYY-MM-DDTHH:mm" (or "YYYY-MM-DD" + "HH:mm") as Bangkok local time → epoch ms. */
function parseLocal(dateStr, timeStr) {
  let s = String(dateStr || '').trim();
  if (timeStr !== undefined) s = `${s}T${String(timeStr).trim()}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00'] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi) - OFFSET_MS;
  // reject overflow dates such as 2026-02-31
  const back = new Date(ms + OFFSET_MS);
  if (back.getUTCDate() !== +d || back.getUTCMonth() !== +mo - 1) return null;
  return ms;
}

/** Bangkok local parts of an epoch ms. */
function localParts(ms) {
  const d = new Date(ms + OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
const pad = (n) => String(n).padStart(2, '0');
function toInputDate(ms) { const p = localParts(ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
function toInputTime(ms) { const p = localParts(ms); return `${pad(p.h)}:${pad(p.mi)}`; }
function toInputDateTime(ms) { return `${toInputDate(ms)}T${toInputTime(ms)}`; }
function startOfLocalDay(ms) { const p = localParts(ms); return Date.UTC(p.y, p.m - 1, p.d) - OFFSET_MS; }

const fmtDateTime = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateLong = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

function dt(ms) { return ms == null ? '-' : `${fmtDateTime.format(ms)} น.`; }
function date(ms) { return ms == null ? '-' : fmtDate.format(ms); }
function dateLong(ms) { return ms == null ? '-' : fmtDateLong.format(ms); }
function time(ms) { return ms == null ? '-' : `${fmtTime.format(ms)} น.`; }

/**
 * Rental period: hours-based, NOT calendar-day based.
 * start 9 Nov 09:00 + 3 days = 72h → due 12 Nov 09:00.
 */
function rentalWindow(startAt, days, bufferBeforeHours = 0, bufferAfterHours = 0) {
  const hours = days * 24;
  const dueAt = startAt + hours * HOUR;
  return {
    startAt,
    days,
    hours,
    dueAt,
    blockStart: startAt - bufferBeforeHours * HOUR,
    blockEnd: dueAt + bufferAfterHours * HOUR,
  };
}

module.exports = { TZ, HOUR, DAY, OFFSET_MS, parseLocal, localParts, toInputDate, toInputTime, toInputDateTime, startOfLocalDay, dt, date, dateLong, time, rentalWindow, pad };
