// 审稿流程核心服务：原稿/公开稿分离、并发改写、漂移门禁、批准与撤回。
import { createHash } from 'node:crypto';
import { Store } from './store.js';
import { newId, now, SECTIONS, fullBodyHash } from './util.js';
import { scanContent } from './rules.js';
import { makeAnchor, relocateSpans } from './anchors.js';
import { renderForChannel } from './channels.js';

export const CHANNELS = ['web', 'search', 'rss', 'card', 'download'];

const conflict = (code, msg) => {
  const e = new Error(msg);
  e.code = code;
  return e;
};

export class Workflow {
  constructor() {
    this.db = new Store();
  }

  // ---------- 日记与四段式原稿 ----------
  createEntry(title, user) {
    const e = this.db.insert('entry', {
      id: newId('entry'), title, status: 'editing', current_rev_id: null, created_at: now(),
    });
    this.commitRevision(e.id, { problem: '', action: '', result: '', reflection: '' }, user, null);
    return e;
  }

  revisionContent(rev) {
    return Object.fromEntries(SECTIONS.map((k) => [k, rev[k]]));
  }

  // baseRevId：改写所基于的修订。两人同时保存时，后到者拿不到同一基准 -> 冲突，必须先合并。
  commitRevision(entryId, content, user, baseRevId) {
    const entry = this.db.mustGet('entry', entryId);
    if (baseRevId !== null && entry.current_rev_id && entry.current_rev_id !== baseRevId) {
      throw conflict('REVISION_CONFLICT', '原稿已被他人改写，请基于最新修订合并后再提交');
    }
    const prevRev = entry.current_rev_id ? this.db.mustGet('revision', entry.current_rev_id) : null;
    const seq = prevRev ? prevRev.seq + 1 : 1;
    const clean = Object.fromEntries(SECTIONS.map((k) => [k, content[k] ?? '']));
    const rev = this.db.insert('revision', {
      id: newId('rev'), entry_id: entryId, seq,
      ...clean, body_hash: fullBodyHash(clean), created_by: user, created_at: now(),
    });
    this.db.update('entry', entryId, { current_rev_id: rev.id });

    // 继承旧修订上的敏感片段锚点（包括已批准后再改写的情形）
    if (prevRev) {
      const prevSpans = this.db.find('sensitive_span', (s) => s.revision_id === prevRev.id && s.status !== 'dismissed');
      const rel = relocateSpans(this.revisionContent(prevRev), clean, prevSpans);
      for (const r of rel) {
        const fields = this._spanFields(r.span);
        const base = {
          ...fields,
          id: newId('span'),
          revision_id: rev.id,
          origin_span_id: r.span.id,
          origin_revision_id: r.span.revision_id,
        };
        if (r.status === 'unchanged') {
          this.db.insert('sensitive_span', { ...base, start: r.start, end: r.end, status: r.span.status });
        } else if (r.status === 'relocated') {
          // 新偏移 + 待复核：重定位成功也不自动当作已确认
          this.db.insert('sensitive_span', { ...base, start: r.start, end: r.end, status: 'active', needs_recheck: 1 });
        } else {
          // drifted：保留记录但不允许参与发布；门禁会拦住，绝不按旧偏移套用
          this.db.insert('sensitive_span', { ...base, start: -1, end: -1, status: 'drifted', drift_reason: r.reason });
        }
      }
      // 原稿改动：旧审阅结论对新修订失效；已发布的旧公开稿不受影响（继续在线直到新版批准）
      const oldTask = this.db.findOne('review_task', (t) => t.revision_id === prevRev.id && t.state === 'awaiting');
      if (oldTask) this.db.update('review_task', oldTask.id, { state: 'superseded' });
      if (entry.status === 'approved') {
        this.db.update('entry', entryId, { status: 'revision_changed' });
      }
    }
    return rev;
  }

  _spanFields(span) {
    const { id, start, end, status, ...rest } = span;
    return rest;
  }

  // ---------- 项目引用（数据库维护，不靠裸链接） ----------
  createProject(title, { isPrivate = false } = {}) {
    return this.db.insert('project', { id: newId('proj'), title, is_private: isPrivate ? 1 : 0 });
  }

  attachProject(entryId, projectId, relevance) {
    if (!relevance || !relevance.trim()) throw conflict('BAD_RELEVANCE', '引用项目必须填写关联说明，避免读者跳到不相干内容');
    const exists = this.db.findOne('entry_project_ref', (r) => r.entry_id === entryId && r.project_id === projectId);
    if (exists) return exists;
    return this.db.insert('entry_project_ref', { id: newId("ref"), entry_id: entryId, project_id: projectId, relevance });
  }

  // ---------- 附件（内容寻址 + 元数据另行检查） ----------
  addAttachment(entryId, revisionId, { filename, contentType, bytes, metadata }) {
    const { sha256 } = require_sha();
    const digest = sha256(Buffer.from(bytes));
    const { ok, note } = checkAttachmentMeta(filename, contentType, metadata || {});
    return this.db.insert('attachment', {
      id: newId('att'), revision_id: revisionId, sha256: digest, filename, content_type: contentType,
      metadata_ok: ok ? 1 : 0, metadata_note: note,
    });
  }

  revisionAttachments(revId) {
    return this.db.find('attachment', (a) => a.revision_id === revId);
  }

  // ---------- 规则扫描与人工标注 ----------
  runRules(revisionId, { whitelist = [] } = {}) {
    const rev = this.db.mustGet('revision', revisionId);
    const hits = scanContent(this.revisionContent(rev), { whitelist });
    const existing = new Set(
      this.db.find('sensitive_span', (s) => s.revision_id === revisionId).map((s) => `${s.section}:${s.start}:${s.end}:${s.rule_id ?? ''}`),
    );
    for (const h of hits) {
      const key = `${h.section}:${h.start}:${h.end}:${h.rule_id}`;
      if (existing.has(key)) continue;
      const text = this.revisionContent(rev)[h.section];
      this.db.insert('sensitive_span', {
        id: newId('span'), revision_id: revisionId, section: h.section, start: h.start, end: h.end,
        match_text: h.match_text, kind: h.kind, source: 'rule', status: 'suggested',
        rule_id: h.rule_id, rule_note: h.rule_note, anchor_json: JSON.stringify(makeAnchor(text, h.start, h.end)),
      });
    }
    this.db.insert('rule_scan', { id: newId('scan'), revision_id: revisionId, triggered: JSON.stringify(hits), scan_engine: 'builtin-v1', created_at: now() });
    return hits;
  }

  // 人工标注敏感片段（最终以此为准）
  annotate(revisionId, section, start, end, kind, user) {
    const rev = this.db.mustGet('revision', revisionId);
    const text = this.revisionContent(rev)[section];
    if (start < 0 || end > text.length || start >= end) throw conflict('BAD_SPAN', '片段范围越界');
    return this.db.insert('sensitive_span', {
      id: newId('span'), revision_id: revisionId, section, start, end,
      match_text: text.slice(start, end), kind: kind || 'other', source: 'human', status: 'active',
      annotated_by: user, anchor_json: JSON.stringify(makeAnchor(text, start, end)),
    });
  }

  // 规则命中处置：确认敏感 / 误报放行（必须写理由）
  triageRuleSpan(spanId, action, reason, user) {
    const span = this.db.mustGet('sensitive_span', spanId);
    if (span.source !== 'rule') throw conflict('NOT_RULE_SPAN', '只有规则命中需要 triage');
    if (action === 'confirm') return this.db.update('sensitive_span', spanId, { status: 'confirmed', confirmed_by: user });
    if (action === 'dismiss') {
      if (!reason || !reason.trim()) throw conflict('REASON_REQUIRED', '判定误报必须记录理由，供审计');
      return this.db.update('sensitive_span', spanId, { status: 'dismissed', dismiss_reason: reason, triaged_by: user });
    }
    throw conflict('BAD_ACTION', 'confirm 或 dismiss');
  }

  // 漂移片段处置：删除/改写导致找不到锚点 -> 丢弃（确认敏感物已消失）或重新人工标注
  resolveDrift(spanId, action, user) {
    const span = this.db.mustGet('sensitive_span', spanId);
    if (span.status !== 'drifted') throw conflict('NOT_DRIFTED', '该片段未漂移');
    if (action === 'drop') return this.db.update('sensitive_span', spanId, { status: 'dismissed', dismiss_reason: '原稿改写后敏感文本已消失', triaged_by: user });
    throw conflict('BAD_ACTION', '漂移锚点不能自动套用；drop 或在新修订上重新 annotate');
  }

  // ---------- 送审 / 审阅锁 / 批准 ----------
  submitForReview(entryId) {
    const entry = this.db.mustGet('entry', entryId);
    const rev = this.db.mustGet('revision', entry.current_rev_id);
    let task = this.db.findOne('review_task', (t) => t.revision_id === rev.id);
    if (!task) {
      task = this.db.insert('review_task', {
        id: newId('task'), entry_id: entryId, revision_id: rev.id, state: 'awaiting',
        rule_scan_at: null, decided_by: null, decided_at: null, decision_note: null,
        lock_holder: null, lock_version: 0,
      });
    } else if (task.state === 'changes_requested' || task.state === 'superseded') {
      task = this.db.update('review_task', task.id, { state: 'awaiting' });
    }
    this.db.update('entry', entryId, { status: 'awaiting_review' });
    this.runRules(rev.id);
    return task;
  }

  acquireReviewLock(taskId, user) {
    const task = this.db.mustGet('review_task', taskId);
    if (task.lock_holder && task.lock_holder !== user) {
      throw conflict('LOCK_HELD', `审阅锁由 ${task.lock_holder} 持有`);
    }
    return this.db.update('review_task', taskId, { lock_holder: user }, { lock_version: task.lock_version });
  }

  requestChanges(taskId, user, note) {
    const task = this.db.mustGet('review_task', taskId);
    this._checkLock(task, user);
    this.db.update('review_task', taskId, { state: 'changes_requested', decided_by: user, decided_at: now(), decision_note: note, lock_holder: null, lock_version: task.lock_version + 1 });
    this.db.update('entry', task.entry_id, { status: 'editing' });
  }

  _checkLock(task, user) {
    if (!task.lock_holder) throw conflict('NO_LOCK', '需先获取审阅锁');
    if (task.lock_holder !== user) throw conflict('LOCK_HELD', '锁的持有者不是你');
  }

  approve(taskId, user, note) {
    // 发布仍需要“明确审阅结论”：人、结论、备注缺一不可，规则零命中也不能自动发布
    if (!note || !note.trim()) throw conflict('DECISION_NOTE_REQUIRED', '批准必须写明审阅结论');
    const task = this.db.mustGet('review_task', taskId);
    this._checkLock(task, user);
    if (task.state !== 'awaiting') throw conflict('BAD_STATE', `任务状态 ${task.state} 不可批准`);
    const rev = this.db.mustGet('revision', task.revision_id);
    const entry = this.db.mustGet('entry', rev.entry_id);

    const spans = this.db.find('sensitive_span', (s) => s.revision_id === rev.id);
    const suggested = spans.filter((s) => s.source === 'rule' && s.status === 'suggested');
    if (suggested.length) throw conflict('RULES_TRIAGE_PENDING', `还有 ${suggested.length} 条规则命中未确认/排除`);
    const drifted = spans.filter((s) => s.status === 'drifted');
    if (drifted.length) throw conflict('ANCHOR_DRIFT', `有 ${drifted.length} 个脱敏锚点漂移，必须重新定位或回到待审`);
    const needRecheck = spans.filter((s) => s.needs_recheck === 1 && s.status === 'active');
    if (needRecheck.length) throw conflict('RECHECK_PENDING', '自动重定位的片段需要人工复核');

    const atts = this.revisionAttachments(rev.id);
    const badAtt = atts.find((a) => !a.metadata_ok);
    if (badAtt) throw conflict('ATTACHMENT_METADATA', `附件 ${badAtt.filename} 元数据检查未通过（EXIF/GPS/作者等）`);

    const refs = this.db.find('entry_project_ref', (r) => r.entry_id === entry.id);
    for (const r of refs) {
      const p = this.db.mustGet('project', r.project_id);
      if (p.is_private) throw conflict('PROJECT_PRIVATE', `引用的项目已转私密：${p.title}，需移除引用或换公开项目后重审`);
    }

    // 生成公开派生稿（脱敏在服务端完成；公开库里不存在未遮罩原文）
    const content = this.revisionContent(rev);
    const masked = maskContent(content, spans);
    const last = this.db.findOne('public_version', (p) => p.entry_id === entry.id);
    const seq = last ? last.seq + 1 : 1;
    const pv = this.db.insert('public_version', {
      id: newId('pv'), entry_id: entry.id, revision_id: rev.id, seq,
      content_json: JSON.stringify(masked), content_hash: masked.hash,
      approved_by: user, approved_at: now(), withdrawn: 0,
    });
    for (const r of refs) {
      const p = this.db.mustGet('project', r.project_id);
      this.db.insert('public_project_ref', {
        id: newId('pref'), public_version_id: pv.id, project_id: p.id,
        project_title: p.title, project_public: p.is_private ? 0 : 1, relevance: r.relevance,
      });
    }
    for (const a of atts) {
      this.db.insert('public_attachment', { id: newId('patt'), public_version_id: pv.id, attachment_id: a.id, sha256: a.sha256 });
    }

    this.db.update('review_task', taskId, { state: 'approved', decided_by: user, decided_at: now(), decision_note: note, lock_holder: null, lock_version: task.lock_version + 1 });
    this.db.update('entry', entry.id, { status: 'approved' });

    this._enqueue('publish', pv, seq);
    return pv;
  }

  _nextEpoch(entryId, channel) {
    const st = this.db.findOne('channel_state', (c) => c.entry_id === entryId && c.channel === channel);
    return (st ? st.effective_epoch : 0) + 1;
  }

  _enqueue(kind, pv, seq) {
    const jobs = [];
    for (const channel of CHANNELS) {
      jobs.push(this.db.insert('publish_job', {
        id: newId('job'), entry_id: pv.entry_id, channel, kind, pv_id: pv.id,
        intended_pv_seq: seq, epoch: this._nextEpoch(pv.entry_id, channel),
        state: 'queued', result_note: null, created_at: now(), finished_at: null,
      }));
    }
    return jobs;
  }

  // ---------- 发布执行（fencing：迟到任务不得覆盖新意图） ----------
  processJob(jobId) {
    const job = this.db.mustGet('publish_job', jobId);
    if (job.state !== 'queued') return job;
    const st = this.db.findOne('channel_state', (c) => c.entry_id === job.entry_id && c.channel === job.channel);

    // 同渠道若已存在更新的排队意图（如 v2 已入队），早到的旧版任务（v1）也必须丢弃，
    // 不能在“清空队列”式执行时先发布旧版再被覆盖。
    // 仅在同渠道内按 epoch 比较：v2 入队后，晚处理的 v1 同渠道任务作废；
    // 不同渠道互不影响（搜索渠道晚刷新不能被 web 渠道的任务连累）。
    const newerQueued = this.db.findOne('publish_job', (j) =>
      j.entry_id === job.entry_id && j.channel === job.channel && j.id !== job.id
      && j.kind === job.kind && j.epoch > job.epoch && (j.state === 'queued' || j.state === 'done'));
    if (newerQueued) {
      return this.db.update('publish_job', jobId, { state: 'stale_dropped', result_note: '同渠道已有更新的版本意图', finished_at: now() });
    }

    if (st && job.epoch < st.effective_epoch) {
      return this.db.update('publish_job', jobId, { state: 'stale_dropped', result_note: '迟到任务：渠道已有更新的意图纪元', finished_at: now() });
    }
    if (job.kind === 'withdraw') {
      // 渠道已在展示更新的版本 -> 这条撤回针对旧版本，丢弃，绝不能把新版本撤掉
      if (st && st.effective_seq != null && st.effective_seq > job.intended_pv_seq) {
        return this.db.update('publish_job', jobId, { state: 'stale_dropped', result_note: '迟到撤回：渠道版本已更新', finished_at: now() });
      }
      const next = this.db.update('channel_state', stateKey(this.db, job.entry_id, job.channel),
        { status: 'withdrawing', effective_epoch: job.epoch, updated_at: now() },
        st ? { effective_epoch: st.effective_epoch } : {});
      finishChannel(this.db, next, job, 'withdrawn');
      invalidateSearchCache(this.db, job.entry_id, st ? st.effective_seq : null);
      return this.db.get('publish_job', jobId);
    }

    // publish
    const pv = this.db.mustGet('public_version', job.pv_id);
    if (st && st.effective_seq != null && pv.seq < st.effective_seq) {
      return this.db.update('publish_job', jobId, { state: 'stale_dropped', result_note: '迟到发布：渠道已在更新版本', finished_at: now() });
    }
    if (pv.withdrawn) {
      return this.db.update('publish_job', jobId, { state: 'failed', result_note: '公开稿已撤回，拒绝上线', finished_at: now() });
    }
    ensureChannelRow(this.db, job.entry_id, job.channel);
    const row = this.db.mustGet('channel_state', stateKey(this.db, job.entry_id, job.channel));
    const updated = this.db.update('channel_state', row.id, {
      status: 'live', effective_epoch: job.epoch, effective_pv_id: pv.id, effective_seq: pv.seq, updated_at: now(),
    }, { effective_epoch: row.effective_epoch });
    // 各渠道文本（搜索/RSS/摘要卡/下载）全部从批准公开稿渲染
    const rendered = renderForChannel(job.channel, pv, this.db);
    this.db.insert('channel_payload', {
      id: newId('payload'), entry_id: job.entry_id, channel: job.channel,
      pv_id: pv.id, pv_seq: pv.seq, content_hash: pv.content_hash,
      body: rendered.body, rendered_at: now(),
    });
    if (job.channel === 'search') {
      this.db.insert('search_snippet_cache', {
        id: newId('scache'), entry_id: job.entry_id, cache_key: `${job.entry_id}:${pv.seq}`,
        pv_id: pv.id, content_hash: pv.content_hash,
        snippet: rendered.snippet, refreshed_at: now(),
      });
    }
    this.db.update('publish_job', jobId, { state: 'done', result_note: `已发布 v${pv.seq}`, finished_at: now() });
    return updated;
  }

  pendingJobs() {
    return this.db.find('publish_job', (j) => j.state === 'queued');
  }

  // 处理当前全部排队任务：必须先快照再遍历，
  // 否则处理过程中任务状态变化会让迭代跳过相邻任务（如只刷了部分渠道）。
  drainJobs(predicate = () => true) {
    const jobs = this.pendingJobs().filter(predicate);
    return jobs.map((j) => this.processJob(j.id));
  }

  // ---------- 撤回 ----------
  withdrawEntry(entryId, reason) {
    const entry = this.db.mustGet('entry', entryId);
    const pv = newestPv(this.db, entryId);
    if (!pv) throw conflict('NO_PUBLIC_VERSION', '尚无公开稿');
    this.db.update('public_version', pv.id, { withdrawn: 1, withdraw_reason: reason || '' });
    this.db.update('entry', entryId, { status: 'withdrawn' });
    const jobs = [];
    for (const channel of CHANNELS) {
      jobs.push(this.db.insert('publish_job', {
        id: newId('job'), entry_id: entryId, channel, kind: 'withdraw', pv_id: pv.id,
        intended_pv_seq: pv.seq, epoch: this._nextEpoch(entryId, channel),
        state: 'queued', result_note: null, created_at: now(), finished_at: null,
      }));
    }
    return jobs;
  }

  // ---------- 项目转私密：级联撤回引用它的公开内容 ----------
  setProjectPrivate(projectId) {
    const p = this.db.mustGet('project', projectId);
    this.db.update('project', projectId, { is_private: 1 });
    const affected = [];
    for (const ref of this.db.find('entry_project_ref', (r) => r.project_id === projectId)) {
      const entry = this.db.mustGet('entry', ref.entry_id);
      const pv = newestPv(this.db, entry.id);
      const pvRef = pv && this.db.findOne('public_project_ref', (x) => x.public_version_id === pv.id && x.project_id === projectId);
      if (pv && pvRef && !pv.withdrawn) {
        this.db.update('public_version', pv.id, { withdrawn: 1, withdraw_reason: `引用项目《${p.title}》转私密` });
        this.db.update('entry', entry.id, { status: 'withdrawn' });
        this._enqueue('withdraw', pv, pv.seq);
        invalidateSearchCache(this.db, entry.id, pv.seq);
        affected.push({ entry_id: entry.id, pv_seq: pv.seq });
      }
    }
    return affected;
  }

  // ---------- 搜索读取：缓存必须与公开稿哈希一致 ----------
  searchLookup(entryId) {
    const st = this.db.findOne('channel_state', (c) => c.entry_id === entryId && c.channel === 'search');
    if (!st || st.status !== 'live' || st.effective_seq == null) {
      return { hit: false, reason: '搜索渠道未发布或已撤回' };
    }
    const pv = this.db.findOne('public_version', (p) => p.entry_id === entryId && p.seq === st.effective_seq);
    if (!pv || pv.withdrawn) return { hit: false, reason: '公开稿缺失或已撤回' };
    const latest = newestPv(this.db, entryId);
    // 渠道尚未刷新到最新批准稿（其它渠道已是新版本）时，宁可 miss，不返回跨版本不一致的摘要
    if (latest && !latest.withdrawn && latest.seq !== st.effective_seq) {
      return { hit: false, reason: '搜索渠道尚未刷新到最新公开版', stale: true };
    }
    const cache = this.db.findOne('search_snippet_cache', (x) => x.cache_key === `${entryId}:${pv.seq}`);
    // 缓存尚未刷新 / 属于旧版本 / 哈希不符：宁可 miss，不展示陈旧摘要
    if (!cache || cache.pv_id !== pv.id || cache.content_hash !== pv.content_hash) {
      return { hit: false, reason: '缓存尚未刷新或版本不符', stale: true };
    }
    return { hit: true, snippet: cache.snippet, pv_seq: pv.seq };
  }

  // ---------- 读者侧：按版本解析，返回来源版本，不跳转 ----------
  resolveReader(entryId, requestedSeq) {
    const pvs = this.db.find('public_version', (p) => p.entry_id === entryId).sort((a, b) => a.seq - b.seq);
    if (!pvs.length) return { status: 'never_published' };
    let pv;
    if (requestedSeq != null) {
      pv = pvs.find((p) => p.seq === Number(requestedSeq));
      if (!pv) return { status: 'version_not_found', requested_seq: requestedSeq, latest_seq: pvs.at(-1).seq };
    } else {
      pv = pvs.at(-1);
    }
    const refs = this.db.find('public_project_ref', (r) => r.public_version_id === pv.id).map((r) => {
      const live = this.db.get('project', r.project_id);
      return { ...r, project_now_private: live ? !!live.is_private : true };
    });
    const atts = this.db.find('public_attachment', (a) => a.public_version_id === pv.id);
    if (pv.withdrawn) {
      return { status: 'withdrawn', pv_seq: pv.seq, reason: pv.withdraw_reason || '', refs, latest_seq: pvs.at(-1).seq, auto_redirect: false };
    }
    return { status: 'ok', pv_seq: pv.seq, content: JSON.parse(pv.content_json), refs, attachments: atts, auto_redirect: false };
  }

  // ---------- 状态页数据：各渠道实际版本与撤回进度 ----------
  statusSnapshot() {
    return this.db.find('entry', () => true).map((e) => {
      const channels = CHANNELS.map((ch) => {
        const st = this.db.findOne('channel_state', (c) => c.entry_id === e.id && c.channel === ch);
        const pending = this.db.find('publish_job', (j) => j.entry_id === e.id && j.channel === ch && j.state === 'queued').length;
        return {
          channel: ch,
          status: st ? st.status : 'not_published',
          effective_seq: st ? st.effective_seq : null,
          effective_epoch: st ? st.effective_epoch : 0,
          pending_jobs: pending,
        };
      });
      const pvs = this.db.find('public_version', (p) => p.entry_id === e.id).sort((a, b) => a.seq - b.seq)
        .map((p) => ({ seq: p.seq, withdrawn: !!p.withdrawn, reason: p.withdraw_reason || '' }));
      return { entry_id: e.id, title: e.title, entry_status: e.status, channels, public_versions: pvs };
    });
  }
}

// ---------- 脱敏与公开稿派生 ----------
export function maskContent(content, spans) {
  const active = spans.filter((s) => s.status === 'active' || s.status === 'confirmed')
    .sort((a, b) => b.start - a.start);
  const out = {};
  for (const section of SECTIONS) {
    let text = content[section] ?? '';
    for (const s of active) {
      if (s.section !== section) continue;
      text = `${text.slice(0, s.start)}【已隐去】${text.slice(s.end)}`;
    }
    out[section] = text;
  }
  const { sha256 } = require_sha();
  out.hash = sha256(SECTIONS.map((k) => out[k]).join('<<pv-boundary>>'));
  return out;
}

function newestPv(db, entryId) {
  const all = db.find('public_version', (p) => p.entry_id === entryId).sort((a, b) => b.seq - a.seq);
  return all[0] || null;
}

function stateKey(db, entryId, channel) {
  const row = ensureChannelRow(db, entryId, channel);
  return row.id;
}

function ensureChannelRow(db, entryId, channel) {
  let row = db.findOne('channel_state', (c) => c.entry_id === entryId && c.channel === channel);
  if (!row) {
    row = db.insert('channel_state', {
      id: newId('cs'), entry_id: entryId, channel, effective_epoch: 0,
      effective_pv_id: null, effective_seq: null, status: 'not_published', updated_at: now(),
    });
  }
  return row;
}

function finishChannel(db, row, job, status) {
  db.update('channel_state', row.id, { status });
  db.update('publish_job', job.id, { state: 'done', result_note: status === 'withdrawn' ? '渠道已撤回' : '完成', finished_at: now() });
}

function invalidateSearchCache(db, entryId, seq) {
  for (const c of db.find('search_snippet_cache', (x) => x.entry_id === entryId)) {
    if (seq != null && c.cache_key !== `${entryId}:${seq}`) continue;
    db.update('search_snippet_cache', c.id, { snippet: '', invalidated: 1 });
  }
}

// 附件元数据检查：正文规则看不到的部分（EXIF/GPS、作者、文件名、缩略图）
export function checkAttachmentMeta(filename, contentType, metadata) {
  const problems = [];
  if (metadata.gps && (metadata.gps.lat || metadata.gps.lon)) problems.push('EXIF 含 GPS 定位');
  if (metadata.author && !metadata.authorPublic) problems.push(`文档/图片作者字段未公开授权：${metadata.author}`);
  if (metadata.cameraSerial) problems.push('相机序列号未清除');
  if (metadata.comments && /客户|密码|地址/.test(metadata.comments)) problems.push('批注/图层备注含敏感词');
  if (/截图|screenshot|微信|钉钉/i.test(filename) && !metadata.filenameReviewed) problems.push('文件名疑似含内部来源，需人工确认');
  return { ok: problems.length === 0, note: problems.join('；') || '通过' };
}

function require_sha() {
  return { sha256: (buf) => createHash('sha256').update(buf).digest('hex') };
}
