'use strict';
/**
 * store.js —— JSON 文件持久化（原子写入）。
 * 数据模型：
 *   works[]      项目作品（visibility: public/private，可被日记引用）
 *   entries[]    日记：私密原稿(original) + 公开派生稿(public/publicHistory) + 片段(spans)
 *                + 渠道状态(channels: search/rss/card/download) + 附件(attachments)
 *   jobs[]       异步任务队列（publish / retract / refresh-search），支持"晚到的旧任务"判定
 *   audit[]      审计日志
 */
const fs = require('fs');
const path = require('path');

const CHANNELS = ['search', 'rss', 'card', 'download'];

function emptyChannels() {
  const c = {};
  for (const name of CHANNELS) {
    c[name] = { publishedVersion: null, status: 'unpublished', artifact: null, updatedAt: null };
  }
  c.search.cache = null;        // 搜索摘要缓存（可能落后于 publishedVersion）
  c.search.cacheVersion = null;
  return c;
}

function createStore(dbPath) {
  let db;
  if (fs.existsSync(dbPath)) {
    db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } else {
    db = { seq: 0, works: [], entries: [], jobs: [], audit: [] };
  }

  function save() {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const tmp = dbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, dbPath); // 原子替换，避免半截文件
  }

  function nextId(prefix) {
    db.seq += 1;
    return `${prefix}${db.seq}`;
  }

  function audit(msg, extra) {
    db.audit.push({ ts: new Date().toISOString(), msg, ...(extra || {}) });
  }

  const findEntry = id => db.entries.find(e => e.id === id);
  const findWork = id => db.works.find(w => w.id === id);
  function findAttachment(aid) {
    for (const e of db.entries) {
      const a = (e.attachments || []).find(x => x.id === aid);
      if (a) return { entry: e, attachment: a };
    }
    return null;
  }

  return { db, save, nextId, audit, findEntry, findWork, findAttachment, CHANNELS, emptyChannels };
}

module.exports = { createStore, CHANNELS };
