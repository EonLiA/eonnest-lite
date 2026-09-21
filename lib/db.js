// lib/db.js — SQLite 数据层
// 三张表：memories（长期记忆）、chat_archive（全量对话归档）、reminders（定时提醒）
// 结构承自 eonnest db.js，砍掉了歌单/纸条/共读/摘要等表

'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'eonnest.db');

let _db = null;

function getDB() {
  if (_db) return _db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id             TEXT PRIMARY KEY,
      content        TEXT NOT NULL,
      category       TEXT NOT NULL DEFAULT 'daily',
      tags           TEXT DEFAULT '[]',
      pinned         INTEGER DEFAULT 0,
      importance     REAL DEFAULT 0.5,
      hits           INTEGER DEFAULT 0,
      weight         REAL DEFAULT 100,
      lastDecayAt    TEXT,
      lastAccessedAt TEXT,
      createdAt      TEXT NOT NULL,
      updatedAt      TEXT NOT NULL,
      embedding      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mem_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_mem_pinned   ON memories(pinned);

    CREATE TABLE IF NOT EXISTS chat_archive (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      role         TEXT NOT NULL,
      content      TEXT NOT NULL,
      ts           REAL NOT NULL,
      model        TEXT,
      toolCalls    TEXT,
      inputTokens  INTEGER DEFAULT 0,
      outputTokens INTEGER DEFAULT 0,
      cacheRead    INTEGER DEFAULT 0,
      durationMs   INTEGER DEFAULT 0,
      source       TEXT DEFAULT 'chat'
    );
    CREATE INDEX IF NOT EXISTS idx_archive_ts ON chat_archive(ts);

    CREATE TABLE IF NOT EXISTS reminders (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      fireAt    REAL NOT NULL,
      content   TEXT NOT NULL,
      createdAt REAL NOT NULL,
      sent      INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_rem_fire ON reminders(sent, fireAt);
  `);
  return _db;
}

// ===== 行 → 对象 =====
function rowToMemory(r) {
  if (!r) return null;
  return {
    id: r.id,
    content: r.content,
    category: r.category,
    tags: safeJson(r.tags, []),
    pinned: !!r.pinned,
    importance: r.importance == null ? 0.5 : r.importance,
    hits: r.hits || 0,
    weight: r.weight == null ? 100 : r.weight,
    lastDecayAt: r.lastDecayAt,
    lastAccessedAt: r.lastAccessedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    embedding: r.embedding ? safeJson(r.embedding, null) : null
  };
}
function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}
function genId() {
  return 'mem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ===== 记忆 CRUD =====
function insertMemory(m) {
  const db = getDB();
  const now = new Date().toISOString();
  const id = m.id || genId();
  db.prepare(`INSERT INTO memories
    (id, content, category, tags, pinned, importance, hits, weight, lastDecayAt, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 0, 100, ?, ?, ?)`)
    .run(id, m.content, m.category || 'daily', JSON.stringify(m.tags || []),
      m.pinned ? 1 : 0, m.importance == null ? 0.5 : m.importance, now, now, now);
  return id;
}

function getMemory(id) {
  return rowToMemory(getDB().prepare('SELECT * FROM memories WHERE id = ?').get(id));
}

function updateMemory(id, patch) {
  const db = getDB();
  const cur = getMemory(id);
  if (!cur) return false;
  const next = {
    content: patch.content != null ? patch.content : cur.content,
    category: patch.category || cur.category,
    tags: patch.tags ? JSON.stringify(patch.tags) : JSON.stringify(cur.tags),
    pinned: patch.pinned != null ? (patch.pinned ? 1 : 0) : (cur.pinned ? 1 : 0),
    importance: patch.importance != null ? patch.importance : cur.importance
  };
  db.prepare(`UPDATE memories SET content=?, category=?, tags=?, pinned=?, importance=?, updatedAt=?
    ${patch.content != null ? ', embedding=NULL' : ''} WHERE id=?`)
    .run(next.content, next.category, next.tags, next.pinned, next.importance, new Date().toISOString(), id);
  return true;
}

function deleteMemory(id) {
  return getDB().prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
}

function listMemories(opts = {}) {
  const db = getDB();
  const where = [];
  const args = [];
  if (opts.category) { where.push('category = ?'); args.push(opts.category); }
  if (opts.pinned != null) { where.push('pinned = ?'); args.push(opts.pinned ? 1 : 0); }
  if (opts.date) { where.push("substr(createdAt, 1, 10) = ?"); args.push(opts.date); }
  const sql = 'SELECT * FROM memories' + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY createdAt DESC' + (opts.limit ? ' LIMIT ' + Number(opts.limit) : '');
  return db.prepare(sql).all(...args).map(rowToMemory);
}

function getPinned() {
  return getDB().prepare('SELECT * FROM memories WHERE pinned = 1 ORDER BY createdAt ASC').all().map(rowToMemory);
}
function getUnpinned() {
  return getDB().prepare('SELECT * FROM memories WHERE pinned = 0').all().map(rowToMemory);
}
function getWithEmbedding() {
  return getDB().prepare('SELECT * FROM memories WHERE embedding IS NOT NULL').all().map(rowToMemory);
}
function getWithoutEmbedding() {
  return getDB().prepare('SELECT * FROM memories WHERE embedding IS NULL').all().map(rowToMemory);
}
function countMemories() {
  const r = getDB().prepare('SELECT category, COUNT(*) AS n FROM memories GROUP BY category').all();
  const out = { total: 0 };
  for (const row of r) { out[row.category] = row.n; out.total += row.n; }
  return out;
}

// ===== 热度 / 向量 =====
function updateEmbedding(id, emb) {
  getDB().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), id);
}
function updateRecall(id, weight, hits, lastAccessedAt, lastDecayAt) {
  getDB().prepare('UPDATE memories SET weight=?, hits=?, lastAccessedAt=?, lastDecayAt=? WHERE id=?')
    .run(weight, hits, lastAccessedAt, lastDecayAt, id);
}
function updateDecay(id, weight, lastDecayAt) {
  getDB().prepare('UPDATE memories SET weight=?, lastDecayAt=? WHERE id=?').run(weight, lastDecayAt, id);
}

// ===== 对话归档 =====
function archiveMessage(role, content, ts, meta = {}) {
  getDB().prepare(`INSERT INTO chat_archive
    (role, content, ts, model, toolCalls, inputTokens, outputTokens, cacheRead, durationMs, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(role, content, ts, meta.model || null,
      meta.toolCalls ? JSON.stringify(meta.toolCalls) : null,
      meta.inputTokens || 0, meta.outputTokens || 0, meta.cacheRead || 0,
      meta.durationMs || 0, meta.source || 'chat');
}
function getLastUserTs() {
  const r = getDB().prepare("SELECT ts FROM chat_archive WHERE role='user' ORDER BY ts DESC LIMIT 1").get();
  return r ? r.ts : null;
}
function getRecentArchive(limit = 20) {
  return getDB().prepare('SELECT role, content, ts FROM chat_archive ORDER BY ts DESC LIMIT ?').all(limit).reverse();
}
function getArchiveByDate(dateStr) {
  // dateStr: YYYY-MM-DD（本地日期，按 ts 转换在调用侧处理更准确，这里给个粗略版）
  return getDB().prepare(
    "SELECT role, content, ts FROM chat_archive WHERE date(ts, 'unixepoch', 'localtime') = ? ORDER BY ts ASC"
  ).all(dateStr);
}

// ===== 提醒 =====
function addReminder(fireAt, content) {
  const r = getDB().prepare('INSERT INTO reminders (fireAt, content, createdAt) VALUES (?, ?, ?)')
    .run(fireAt, content, Date.now() / 1000);
  return r.lastInsertRowid;
}
function getDueReminders(nowSec) {
  return getDB().prepare('SELECT * FROM reminders WHERE sent = 0 AND fireAt <= ? ORDER BY fireAt ASC').all(nowSec);
}
function markReminderSent(id) {
  getDB().prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(id);
}
function listPendingReminders() {
  return getDB().prepare('SELECT * FROM reminders WHERE sent = 0 ORDER BY fireAt ASC').all();
}
function deleteReminder(id) {
  return getDB().prepare('DELETE FROM reminders WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  getDB,
  insertMemory, getMemory, updateMemory, deleteMemory, listMemories,
  getPinned, getUnpinned, getWithEmbedding, getWithoutEmbedding, countMemories,
  updateEmbedding, updateRecall, updateDecay,
  archiveMessage, getLastUserTs, getRecentArchive, getArchiveByDate,
  addReminder, getDueReminders, markReminderSent, listPendingReminders, deleteReminder
};
