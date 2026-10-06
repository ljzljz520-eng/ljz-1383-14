'use strict';
/**
 * server.js —— 实习日记审稿流程后端（零依赖，Node 原生 http）。
 * 运行：node server/server.js  （默认 8080，PORT 环境变量可改）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { seed } = require('./seed');
const R = require('./redact');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8' };

function createApp(dbPath) {
  const store = createStore(dbPath);
  seed(store);
  const { db } = store;

  // ---------- 领域逻辑 ----------
  const approvedSpans = e => e.spans.filter(s => s.status === 'approved');
  const activeSpans   = e => e.spans.filter(s => s.status !== 'dismissed');

  /** 原稿变更后重定位全部有效锚点；失败 => stale，绝不沿用旧偏移。 */
  function relocateEntrySpans(entry) {
    let anyStale = false;
    for (const s of activeSpans(entry)) {
      const pos = R.relocate(entry.original.sections[s.section] || '', s.anchor);
      if (pos) {
        s.start = pos.start; s.end = pos.end;
        if (s.status === 'stale') s.status = 'pending'; // 重新定位成功 => 回到待审，需重新批准
      } else {
        if (s.status !== 'stale') store.audit(`锚点失效: ${s.id}（${s.anchor.exact}）`, { entry: entry.id });
        s.status = 'stale';
      }
      if (s.status === 'stale') anyStale = true;
    }
    // 有已批准片段漂移 => 已批准的公开稿不再可信，回到待审
    if (anyStale && (entry.status === 'approved' || entry.status === 'published')) {
      entry.status = 'pending_review';
      store.audit(`原稿修改导致锚点漂移，条目回到待审`, { entry: entry.id });
    }
    return anyStale;
  }

  function approveBlockers(entry) {
    const b = [];
    if (entry.spans.some(s => s.status === 'pending')) b.push('存在未处理的候选片段（须逐一批准或驳回）');
    if (entry.spans.some(s => s.status === 'stale'))   b.push('存在失效锚点（须重新定位或驳回）');
    if ((entry.attachments || []).some(a => !a.metaChecked)) b.push('存在未通过元数据检查的附件');
    const w = store.findWork(entry.workId);
    if (w && w.visibility !== 'public') b.push('引用项目已转为私密');
    return b;
  }

  function excerpt(sections, n = 80) {
    return ((sections.problem || '') + ' ' + (sections.result || '')).replace(/\s+/g, ' ').trim().slice(0, n);
  }

  function buildArtifacts(entry) {
    const p = entry.public;
    const sum = excerpt(p.sections);
    return {
      search: { title: entry.title, excerpt: sum, version: p.version },
      rss: `<item><title>${entry.title}</title><link>/diary-detail.html?id=${entry.id}</link>` +
           `<description>${sum}</description><pubVersion>v${p.version}</pubVersion></item>`,
      card: { id: entry.id, title: entry.title, excerpt: sum, version: p.version,
              work: entry.workTitleSnapshot },
      download: `${entry.title}\n公开版本 v${p.version}（派生自原稿 v${p.fromOriginalVersion}）\n\n` +
        R.SECTIONS.map(k => `【${R.SECTION_LABELS[k]}】\n${p.sections[k]}`).join('\n\n') + '\n',
    };
  }

  /** 处理任务队列；晚到的旧版本发布任务直接丢弃并记审计。 */
  function runJobs() {
    const results = [];
    for (const job of db.jobs.filter(j => j.status === 'queued')) {
      const entry = store.findEntry(job.entryId);
      if (!entry) { job.status = 'dropped'; job.note = '条目不存在'; continue; }
      if (job.type === 'publish') {
        if (!entry.public || job.publicVersion !== entry.public.version) {
          job.status = 'dropped';
          job.note = `过期发布任务：任务针对公开稿 v${job.publicVersion}，当前为 v${entry.public ? entry.public.version : '-'}`;
          store.audit(job.note, { entry: entry.id });
        } else {
          const art = buildArtifacts(entry);
          for (const name of store.CHANNELS) {
            const ch = entry.channels[name];
            ch.publishedVersion = entry.public.version;
            ch.status = 'published';
            ch.artifact = art[name];
            ch.updatedAt = new Date().toISOString();
          }
          if (!entry.channels.search.cache) { // 首次发布同步建缓存；之后缓存需显式刷新
            entry.channels.search.cache = art.search;
            entry.channels.search.cacheVersion = entry.public.version;
          }
          entry.status = 'published';
          job.status = 'done';
          store.audit(`发布完成：公开稿 v${job.publicVersion} 已分发到 4 个渠道`, { entry: entry.id });
        }
      } else if (job.type === 'retract') {
        const ch = entry.channels[job.channel];
        if (ch && ch.status === 'retracting') {
          ch.status = 'retracted';
          ch.artifact = null;
          if (job.channel === 'search') { ch.cache = null; ch.cacheVersion = null; }
          ch.updatedAt = new Date().toISOString();
          store.audit(`渠道已撤回: ${job.channel}`, { entry: entry.id });
        }
        job.status = 'done';
        if (store.CHANNELS.every(n => entry.channels[n].status !== 'retracting')) {
          if (store.CHANNELS.every(n => entry.channels[n].publishedVersion === null || entry.channels[n].status === 'retracted')) {
            entry.status = 'retracted';
          }
        }
      } else if (job.type === 'refresh-search') {
        const ch = entry.channels.search;
        if (ch.status === 'published' && entry.public) {
          ch.cache = buildArtifacts(entry).search;
          ch.cacheVersion = ch.publishedVersion;
          job.status = 'done';
          store.audit(`搜索缓存已刷新到 v${ch.publishedVersion}`, { entry: entry.id });
        } else { job.status = 'dropped'; job.note = '渠道不可刷新'; }
      }
      results.push({ id: job.id, type: job.type, status: job.status, note: job.note || null });
    }
    store.save();
    return results;
  }

  function channelView(entry) {
    const out = {};
    for (const n of store.CHANNELS) {
      const ch = entry.channels[n];
      out[n] = { publishedVersion: ch.publishedVersion, status: ch.status, updatedAt: ch.updatedAt };
      if (n === 'search') {
        out[n].cacheVersion = ch.cacheVersion;
        out[n].cacheStale = ch.status === 'published' && ch.cacheVersion !== ch.publishedVersion;
      }
    }
    const total = store.CHANNELS.length;
    const retracted = store.CHANNELS.filter(n => entry.channels[n].status === 'retracted').length;
    const retracting = store.CHANNELS.some(n => entry.channels[n].status === 'retracting');
    return {
      entryStatus: entry.status,
      currentPublicVersion: entry.public ? entry.public.version : null,
      channels: out,
      retraction: retracting || entry.status === 'retracted'
        ? { retracted, total, done: retracted === total } : null,
      honesty: '本站只能撤回本站各渠道的内容；访客此前另存、截图或转载的副本不在本站控制范围内，无法承诺删除。',
    };
  }

  // ---------- HTTP 工具 ----------
  function send(res, code, obj, type = 'application/json; charset=utf-8') {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }
  const notFound = (res, msg) => send(res, 404, { error: msg || 'not found' });
  const conflict = (res, obj) => send(res, 409, obj);
  const badReq = (res, msg) => send(res, 400, { error: msg });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  // ---------- 路由 ----------
  async function handleApi(req, res, url) {
    const m = (re) => url.pathname.match(re);
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};

    // 编辑器总览
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, {
        works: db.works,
        entries: db.entries.map(e => ({
          id: e.id, title: e.title, status: e.status, workId: e.workId,
          originalVersion: e.original.version,
          publicVersion: e.public ? e.public.version : null,
          spans: e.spans.map(s => ({ id: s.id, section: s.section, exact: s.anchor.exact, author: s.author, rule: s.rule, status: s.status, note: s.note })),
          attachments: e.attachments,
          channels: channelView(e),
        })),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/audit') return send(res, 200, db.audit.slice(-100));

    // 公开列表（只暴露公开稿信息）
    if (req.method === 'GET' && url.pathname === '/api/entries') {
      const list = db.entries
        .filter(e => e.public && (e.status === 'published'))
        .map(e => ({ id: e.id, title: e.title, version: e.public.version,
          excerpt: excerpt(e.public.sections), work: e.workTitleSnapshot }));
      return send(res, 200, list);
    }

    // 条目详情（编辑视角，含私密原稿）
    let mm;
    if ((mm = m(/^\/api\/entries\/([^/]+)$/)) && req.method === 'GET') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      return send(res, 200, { ...e, channels: channelView(e) });
    }

    // 公开稿（读者视角，支持 ?v= 固定来源版本）
    if ((mm = m(/^\/api\/entries\/([^/]+)\/public$/)) && req.method === 'GET') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      const w = store.findWork(e.workId);
      if (e.status === 'retracted' || e.status === 'retracting' || (w && w.visibility !== 'public')) {
        return send(res, 410, { error: 'gone', title: e.title, ...channelView(e) });
      }
      if (!e.public || e.status !== 'published') return notFound(res, '尚未发布');
      const v = url.searchParams.get('v');
      let ver = e.public, pinned = false;
      if (v !== null) {
        const n = Number(v);
        if (e.public.version === n) { pinned = true; }
        else {
          const old = e.publicHistory.find(h => h.version === n);
          if (!old) return notFound(res, `公开版本 v${n} 不存在`);
          ver = old; pinned = true;
        }
      }
      return send(res, 200, {
        id: e.id, title: e.title, version: ver.version, pinned,
        latestVersion: e.public.version,
        sections: ver.sections, fromOriginalVersion: ver.fromOriginalVersion,
        reviewConclusion: ver.conclusion, reviewer: ver.reviewer, createdAt: ver.createdAt,
        work: { id: e.workId, title: e.workTitleSnapshot,
                visibility: w ? w.visibility : 'private',
                link: w && w.visibility === 'public' ? w.page : null },
        ...channelView(e),
      });
    }

    // 新建条目
    if (req.method === 'POST' && url.pathname === '/api/entries') {
      const w = store.findWork(body.workId);
      if (!w) return badReq(res, 'workId 无效');
      const e = {
        id: store.nextId('e'), title: body.title || '未命名日记', workId: w.id,
        workTitleSnapshot: w.title, status: 'draft',
        original: { version: 1, sections: body.sections || {}, updatedBy: body.editor || '站主', updatedAt: new Date().toISOString() },
        spans: [], public: null, publicHistory: [], channels: store.emptyChannels(),
        attachments: [], createdAt: new Date().toISOString(),
      };
      db.entries.push(e);
      store.audit(`新建条目 ${e.id}`);
      store.save();
      return send(res, 201, e);
    }

    // 修改原稿（乐观锁：baseVersion 不一致 => 409，后写者不覆盖先写者）
    if ((mm = m(/^\/api\/entries\/([^/]+)\/original$/)) && req.method === 'PUT') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      if (body.baseVersion !== e.original.version) {
        return conflict(res, { error: 'conflict', message: '原稿已被他人修改，请基于最新版本合并后重试',
          currentVersion: e.original.version, currentSections: e.original.sections,
          updatedBy: e.original.updatedBy });
      }
      e.original.sections = body.sections;
      e.original.version += 1;
      e.original.updatedBy = body.editor || '站主';
      e.original.updatedAt = new Date().toISOString();
      const drifted = relocateEntrySpans(e);
      store.audit(`原稿更新到 v${e.original.version}${drifted ? '（有锚点漂移）' : ''}`, { entry: e.id });
      store.save();
      return send(res, 200, { version: e.original.version, drifted,
        spans: e.spans.map(s => ({ id: s.id, status: s.status, start: s.start, end: s.end })) });
    }

    // 规则辅助检测
    if ((mm = m(/^\/api\/entries\/([^/]+)\/detect$/)) && req.method === 'POST') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      const hits = R.detect(e.original.sections);
      const existing = activeSpans(e);
      const added = [];
      for (const h of hits) {
        if (existing.some(s => s.section === h.section && s.start < h.end && h.start < s.end)) continue;
        const span = { id: store.nextId('s'), section: h.section,
          anchor: R.makeAnchor(e.original.sections[h.section], h.start, h.end),
          start: h.start, end: h.end, author: 'rule', rule: h.rule,
          status: 'pending', note: `规则命中：${h.ruleLabel}`, createdAt: new Date().toISOString() };
        e.spans.push(span); added.push(span);
      }
      store.save();
      return send(res, 200, { added: added.map(s => ({ id: s.id, section: s.section, exact: s.anchor.exact, rule: s.rule })) });
    }

    // 人工标注
    if ((mm = m(/^\/api\/entries\/([^/]+)\/spans$/)) && req.method === 'POST') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      const text = e.original.sections[body.section] || '';
      const start = text.indexOf(body.exact || '');
      if (!body.exact || start === -1) return badReq(res, '片段未在对应段落中找到');
      const span = { id: store.nextId('s'), section: body.section,
        anchor: R.makeAnchor(text, start, start + body.exact.length),
        start, end: start + body.exact.length, author: 'human', rule: null,
        status: 'pending', note: body.note || '', createdAt: new Date().toISOString() };
      e.spans.push(span);
      store.save();
      return send(res, 201, span);
    }

    // 片段审决：批准 / 驳回
    if ((mm = m(/^\/api\/entries\/([^/]+)\/spans\/([^/]+)\/decision$/)) && req.method === 'POST') {
      const e = store.findEntry(mm[1]);
      const s = e && e.spans.find(x => x.id === mm[2]);
      if (!s) return notFound(res);
      if (!['approve', 'dismiss'].includes(body.decision)) return badReq(res, 'decision 须为 approve/dismiss');
      if (s.status === 'stale' && body.decision === 'approve') return conflict(res, { error: 'stale', message: '锚点已失效，请先重新定位或驳回' });
      s.status = body.decision === 'approve' ? 'approved' : 'dismissed';
      s.reviewedBy = body.reviewer || '站主';
      store.save();
      return send(res, 200, s);
    }

    // 失效锚点重新定位（对当前原稿）
    if ((mm = m(/^\/api\/entries\/([^/]+)\/spans\/([^/]+)\/reanchor$/)) && req.method === 'POST') {
      const e = store.findEntry(mm[1]);
      const s = e && e.spans.find(x => x.id === mm[2]);
      if (!s) return notFound(res);
      const pos = R.relocate(e.original.sections[s.section] || '', s.anchor);
      if (!pos) return conflict(res, { error: 'unlocatable', message: '在当前原稿中无法唯一定位，请驳回该片段或修改原稿' });
      s.start = pos.start; s.end = pos.end; s.status = 'pending'; // 重新定位后必须重新批准
      store.save();
      return send(res, 200, s);
    }

    // 人工 vs 规则对比报告（规则侧现场重跑，评估"规则本身"的遗漏与误报，而非仅看已入库片段）
    if ((mm = m(/^\/api\/entries\/([^/]+)\/compare$/)) && req.method === 'GET') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      const human = e.spans.filter(s => s.author === 'human' && s.status !== 'dismissed');
      const ruleHits = R.detect(e.original.sections).map(h => ({
        section: h.section, start: h.start, end: h.end,
        anchor: { exact: h.exact }, rule: h.rule, note: `规则命中：${h.ruleLabel}`,
      }));
      const rep = R.compare(human, ruleHits);
      const fmt = s => ({ section: s.section, exact: s.anchor ? s.anchor.exact : s.exact, note: s.note || s.rule });
      return send(res, 200, {
        both: rep.both.map(p => ({ section: p.human.section, exact: p.human.anchor.exact })),
        misses: rep.misses.map(fmt),            // 人工标了、规则漏了
        falsePositives: rep.falsePositives.map(fmt), // 规则标了、人工没标
        summary: `规则与人工共同命中 ${rep.both.length} 处；规则遗漏 ${rep.misses.length} 处；规则误报 ${rep.falsePositives.length} 处。`,
      });
    }

    // 审阅结论（发布前的强制闸门）
    if ((mm = m(/^\/api\/entries\/([^/]+)\/review$/)) && req.method === 'POST') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      if (body.conclusion !== 'approve') {
        e.status = 'draft';
        store.audit(`审阅结论：退回修改（${body.note || '无说明'}）`, { entry: e.id });
        store.save();
        return send(res, 200, { status: e.status });
      }
      const blockers = approveBlockers(e);
      if (blockers.length) return conflict(res, { error: 'blocked', blockers });
      const pub = { version: (e.public ? e.public.version : 0) + 1,
        fromOriginalVersion: e.original.version,
        sections: R.derivePublic(e.original.sections, approvedSpans(e)),
        reviewer: body.reviewer || '站主', conclusion: body.note || '同意发布',
        createdAt: new Date().toISOString() };
      if (e.public) e.publicHistory.push(e.public);
      e.public = pub;
      e.status = 'approved';
      store.audit(`审阅通过，生成公开稿 v${pub.version}（源原稿 v${pub.fromOriginalVersion}）`, { entry: e.id });
      store.save();
      return send(res, 200, { public: pub });
    }

    // 发布（入队异步任务；携带期望的公开稿版本，晚到的旧任务会被丢弃）
    if ((mm = m(/^\/api\/entries\/([^/]+)\/publish$/)) && req.method === 'POST') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      if (!e.public || (e.status !== 'approved' && e.status !== 'published')) {
        return conflict(res, { error: 'not-approved', message: '须先通过审阅再发布' });
      }
      if (body.publicVersion !== e.public.version) {
        return conflict(res, { error: 'stale-task', message: `发布任务针对 v${body.publicVersion}，当前公开稿为 v${e.public.version}，任务已拒绝` });
      }
      const blockers = approveBlockers(e);
      if (blockers.length) return conflict(res, { error: 'blocked', blockers });
      const job = { id: store.nextId('j'), type: 'publish', entryId: e.id, publicVersion: e.public.version,
        createdAt: new Date().toISOString(), status: 'queued' };
      db.jobs.push(job);
      store.save();
      return send(res, 202, { job });
    }

    // 手动刷新搜索缓存（演示"缓存尚未刷新"的中间态）
    if ((mm = m(/^\/api\/entries\/([^/]+)\/refresh-search$/)) && req.method === 'POST') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      const job = { id: store.nextId('j'), type: 'refresh-search', entryId: e.id, createdAt: new Date().toISOString(), status: 'queued' };
      db.jobs.push(job); store.save();
      return send(res, 202, { job });
    }

    // 项目可见性：转私密 => 引用它的条目全部进入撤回流程
    if ((mm = m(/^\/api\/works\/([^/]+)\/visibility$/)) && req.method === 'POST') {
      const w = store.findWork(mm[1]);
      if (!w) return notFound(res);
      if (!['public', 'private'].includes(body.visibility)) return badReq(res, 'visibility 须为 public/private');
      w.visibility = body.visibility;
      store.audit(`项目「${w.title}」可见性改为 ${body.visibility}`);
      if (body.visibility === 'private') {
        for (const e of db.entries.filter(x => x.workId === w.id)) {
          let any = false;
          for (const n of store.CHANNELS) {
            const ch = e.channels[n];
            if (ch.publishedVersion !== null && ch.status === 'published') {
              ch.status = 'retracting'; any = true;
              db.jobs.push({ id: store.nextId('j'), type: 'retract', entryId: e.id, channel: n, createdAt: new Date().toISOString(), status: 'queued' });
            }
          }
          if (any) { e.status = 'retracting'; store.audit(`条目进入撤回流程`, { entry: e.id }); }
        }
      }
      store.save();
      return send(res, 200, w);
    }

    // 附件：新增 / 替换（替换后元数据检查作废）/ 元数据检查
    if ((mm = m(/^\/api\/entries\/([^/]+)\/attachments$/)) && req.method === 'POST') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      const a = { id: store.nextId('a'), filename: body.filename, metaChecked: false, metaFindings: [], replacedAt: null };
      e.attachments.push(a); store.save();
      return send(res, 201, a);
    }
    if ((mm = m(/^\/api\/attachments\/([^/]+)\/replace$/)) && req.method === 'PUT') {
      const found = store.findAttachment(mm[1]);
      if (!found) return notFound(res);
      found.attachment.filename = body.filename || found.attachment.filename;
      found.attachment.metaChecked = false;   // 换图 => 必须重新检查元数据（EXIF、拍摄地、设备号…）
      found.attachment.metaFindings = [];
      found.attachment.replacedAt = new Date().toISOString();
      store.audit(`附件已替换，元数据检查作废待重做`, { entry: found.entry.id, attachment: found.attachment.id });
      store.save();
      return send(res, 200, found.attachment);
    }
    if ((mm = m(/^\/api\/attachments\/([^/]+)\/meta-check$/)) && req.method === 'POST') {
      const found = store.findAttachment(mm[1]);
      if (!found) return notFound(res);
      found.attachment.metaChecked = !!body.ok;
      found.attachment.metaFindings = body.findings || [];
      store.save();
      return send(res, 200, found.attachment);
    }

    // 渠道状态 / 撤回进度
    if ((mm = m(/^\/api\/entries\/([^/]+)\/channels$/)) && req.method === 'GET') {
      const e = store.findEntry(mm[1]);
      if (!e) return notFound(res);
      return send(res, 200, channelView(e));
    }

    // 任务队列
    if (req.method === 'POST' && url.pathname === '/api/jobs/run') return send(res, 200, runJobs());
    if (req.method === 'GET' && url.pathname === '/api/jobs') return send(res, 200, db.jobs.slice(-50));

    // 搜索（只读缓存；缓存滞后时如实标记 stale，绝不现场用原稿重建）
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      const results = [];
      for (const e of db.entries) {
        const ch = e.channels.search;
        if (!ch.cache) continue;
        if (q && !(ch.cache.title + ch.cache.excerpt).includes(q)) continue;
        results.push({ id: e.id, title: ch.cache.title, excerpt: ch.cache.excerpt,
          cacheVersion: ch.cacheVersion, publishedVersion: ch.publishedVersion,
          stale: ch.status === 'published' && ch.cacheVersion !== ch.publishedVersion });
      }
      return send(res, 200, { results, note: '结果来自搜索摘要缓存；stale=true 表示缓存尚未刷新到已发布版本。' });
    }

    // RSS（只含已发布渠道的 artifact）
    if (req.method === 'GET' && url.pathname === '/rss.xml') {
      const items = db.entries.filter(e => e.channels.rss.status === 'published')
        .map(e => e.channels.rss.artifact).join('\n');
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n<title>灵墨创意 · 实习日记精选</title>\n${items}\n</channel></rss>`, 'application/xml; charset=utf-8');
    }

    // 摘要卡 / 下载文本（均来自已发布 artifact）
    if ((mm = m(/^\/api\/entries\/([^/]+)\/card\.json$/)) && req.method === 'GET') {
      const e = store.findEntry(mm[1]);
      if (!e || e.channels.card.status !== 'published') return notFound(res, '摘要卡未发布');
      return send(res, 200, e.channels.card.artifact);
    }
    if ((mm = m(/^\/api\/entries\/([^/]+)\/download\.txt$/)) && req.method === 'GET') {
      const e = store.findEntry(mm[1]);
      if (!e || e.channels.download.status !== 'published') return notFound(res, '下载文本未发布');
      return send(res, 200, e.channels.download.artifact, 'text/plain; charset=utf-8');
    }

    return notFound(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/rss.xml') {
        return await handleApi(req, res, url);
      }
      // 静态文件
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return notFound(res);
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      send(res, 500, { error: String(err && err.message || err) });
    }
  });

  return { server, store, runJobs };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const { server } = createApp(path.join(__dirname, 'data', 'db.json'));
  server.listen(port, () => console.log(`审稿流程服务已启动: http://localhost:${port} （审稿台 /review.html）`));
}

module.exports = { createApp };
