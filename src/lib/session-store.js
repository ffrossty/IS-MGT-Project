'use strict';
const session = require('express-session');
const { db } = require('../db');

/** express-session store backed by the app's SQLite database. */
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.qGet = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.qSet = db.prepare('INSERT INTO sessions(sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires');
    this.qDel = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.qTouch = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()), 3600000).unref();
  }

  static exp(sess) { return sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000; }

  get(sid, cb) { try { const r = this.qGet.get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); } }
  set(sid, sess, cb) { try { this.qSet.run(sid, JSON.stringify(sess), SqliteStore.exp(sess)); cb && cb(null); } catch (e) { cb && cb(e); } }
  destroy(sid, cb) { try { this.qDel.run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, sess, cb) { try { this.qTouch.run(SqliteStore.exp(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); } }
}

module.exports = SqliteStore;
