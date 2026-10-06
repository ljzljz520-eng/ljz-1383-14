// 验收测试：node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workflow, maskContent, checkAttachmentMeta } from '../lib/workflow.js';
import { scanContent, RULE_LIMITS } from '../lib/rules.js';

function readyEntry(wf, user, content, opts = {}) {
  const e = wf.createEntry('第3周实习日记', user);
  let rev = wf.db.mustGet('revision', wf.db.mustGet('entry', e.id).current_rev_id);
  rev = wf.commitRevision(e.id, content, user, rev.id);
  if (opts.attachOk) {
    wf.db.insert('attachment', {
      id: `att_${e.id}`, revision_id: rev.id, sha256: 'imgold', filename: 'site.png',
      content_type: 'image/png', metadata_ok: 1, metadata_note: '通过',
    });
  }
  const task = wf.submitForReview(e.id);
  // triage 全部规则建议
  for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === rev.id && x.status === 'suggested')) {
    wf.triageRuleSpan(s.id, 'dismiss', '演示文本，经人工核对可公开', user);
  }
  return { e, rev, task };
}

function approveAll(wf, entryId, user) {
  const rev = wf.db.mustGet('revision', wf.db.mustGet('entry', entryId).current_rev_id);
  const task = wf.db.findOne('review_task', (t) => t.revision_id === rev.id);
  if (!task) return null; // 尚未送审
  if (task.state !== 'awaiting') return null;
  wf.acquireReviewLock(task.id, user);
  const pv = wf.approve(task.id, user, '四段完整，敏感信息已人工核对，同意公开发布');
  wf.drainJobs();
  return pv;
}

function submitAndTriage(wf, entryId, user) {
  const rev = wf.db.mustGet('revision', wf.db.mustGet('entry', entryId).current_rev_id);
  const task = wf.submitForReview(entryId);
  for (const x of wf.db.find('sensitive_span', (s) => s.revision_id === rev.id && s.status === 'suggested')) {
    wf.triageRuleSpan(x.id, 'dismiss', '演示文本，经人工核对可公开', user);
  }
  return { rev, task };
}

const baseContent = {
  problem: '工位机上留有旧账号，客户现场演示前差点暴露内部系统地址 10.20.30.40。',
  action: '梳理账号清单，统一走脱敏演示环境，并复核投屏内容。',
  result: '演示顺利完成，客户认可流程规范。',
  reflection: '安全意识要前置，公开材料必须经过审阅。联系邮箱 demo@example.com。',
};

test('1) 两人同时改写：后提交者基于旧基准必须冲突，合并后才能继续', () => {
  const wf = new Workflow();
  const e = wf.createEntry('日记', '编辑A');
  const rev1 = wf.db.mustGet('revision', wf.db.mustGet('entry', e.id).current_rev_id);
  // A、B 都基于 rev1 改写
  const aSave = wf.commitRevision(e.id, { ...baseContent, result: 'A 改写的结果' }, '编辑A', rev1.id);
  assert.throws(() => wf.commitRevision(e.id, { ...baseContent, result: 'B 改写的结果' }, '编辑B', rev1.id), (err) => err.code === 'REVISION_CONFLICT');
  // B 基于 A 的最新修订合并后可以提交
  const merged = wf.commitRevision(e.id, { ...baseContent, result: 'A+B 合并结果' }, '编辑B', aSave.id);
  assert.equal(merged.seq, 3);
});

test('2) 旧发布任务晚到：fencing 丢弃，不覆盖新版本', () => {
  const wf = new Workflow();
  const { e } = readyEntry(wf, '编辑A', baseContent);
  const pv1 = approveAll(wf, e.id, '审阅人');

  // 制造一条 v1 的迟到发布任务（epoch 已落后于渠道）
  const stale = wf.db.insert('publish_job', {
    id: 'job_late', entry_id: e.id, channel: 'web', kind: 'publish', pv_id: pv1.id,
    intended_pv_seq: 1, epoch: 1, state: 'queued', result_note: null, created_at: Date.now(), finished_at: null,
  });
  // 先批准 v2（改写后需要重新送审）
  const cur = wf.db.mustGet('revision', wf.db.mustGet('entry', e.id).current_rev_id);
  wf.commitRevision(e.id, { ...baseContent, reflection: '反思更新：流程已固化。' }, '编辑A', cur.id);
  submitAndTriage(wf, e.id, '审阅人');
  approveAll(wf, e.id, '审阅人');
  // 迟到任务最后才执行
  wf.processJob(stale.id);
  assert.equal(wf.db.get('publish_job', stale.id).state, 'stale_dropped');
  const web = wf.db.findOne('channel_state', (c) => c.entry_id === e.id && c.channel === 'web');
  assert.equal(web.effective_seq, 2, '渠道仍展示 v2');
});

test('3) 项目改为私密：引用它的公开稿级联撤回，搜索摘要失效，且不跳转新项目', () => {
  const wf = new Workflow();
  const { e } = readyEntry(wf, '编辑A', baseContent);
  const proj = wf.createProject('客户结算后台');
  wf.attachProject(e.id, proj.id, '该日记记录的脱敏演练正是在此项目交付中完成');
  approveAll(wf, e.id, '审阅人');

  assert.equal(wf.searchLookup(e.id).hit, true);
  const affected = wf.setProjectPrivate(proj.id);
  assert.deepEqual(affected.map((a) => a.entry_id), [e.id]);
  for (const j of wf.pendingJobs()) wf.processJob(j.id);

  const search = wf.db.findOne('channel_state', (c) => c.entry_id === e.id && c.channel === 'search');
  assert.equal(search.status, 'withdrawn');
  assert.equal(wf.searchLookup(e.id).hit, false);

  // 读者带着旧版本链接回来：保持来源版本，明确已撤回，不自动跳到新项目
  const reader = wf.resolveReader(e.id, 1);
  assert.equal(reader.status, 'withdrawn');
  assert.equal(reader.auto_redirect, false);
  assert.equal(reader.refs[0].project_now_private, true);
});

test('4) 搜索缓存尚未刷新：宁可 miss，不返回旧摘要', () => {
  const wf = new Workflow();
  const { e } = readyEntry(wf, '编辑A', baseContent);
  approveAll(wf, e.id, '审阅人');
  // 批准 v3 但故意不执行 search 渠道任务（缓存没刷新）
  const cur = wf.db.mustGet('revision', wf.db.mustGet('entry', e.id).current_rev_id);
  wf.commitRevision(e.id, { ...baseContent, result: '结果补充：增加复核清单。' }, '编辑A', cur.id);
  const rev3 = wf.db.mustGet('revision', wf.db.mustGet('entry', e.id).current_rev_id);
  const task3 = wf.submitForReview(e.id);
  for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === rev3.id && x.status === 'suggested')) {
    wf.triageRuleSpan(s.id, 'dismiss', '无新增敏感', '审阅人');
  }
  wf.acquireReviewLock(task3.id, '审阅人');
  wf.approve(task3.id, '审阅人', '补充内容复核通过');
  wf.drainJobs((j) => j.channel !== 'search');

  const r = wf.searchLookup(e.id);
  assert.equal(r.hit, false);
  assert.equal(r.stale, true);
  // 刷新后恢复
  wf.drainJobs((j) => j.channel === 'search');
  assert.equal(wf.searchLookup(e.id).hit, true);
});

test('5) 图片替换：内容寻址，旧版本链接仍指向旧图；新图未过元数据检查不得发布', () => {
  const wf = new Workflow();
  const { e, rev } = readyEntry(wf, '编辑A', baseContent, { attachOk: true });
  approveAll(wf, e.id, '审阅人');

  // 新版本替换图片：新对象新哈希
  let cur = wf.db.mustGet('revision', wf.db.mustGet('entry', e.id).current_rev_id);
  cur = wf.commitRevision(e.id, { ...baseContent, reflection: '反思配图更新。' }, '编辑A', cur.id);
  const newAtt = wf.addAttachment(e.id, cur.id, {
    filename: '现场照片.jpg', contentType: 'image/jpeg', bytes: 'new-image-bytes',
    metadata: { gps: { lat: 31.2, lon: 121.5 }, author: '客户员工' },
  });
  assert.equal(newAtt.metadata_ok, 0);
  const task = wf.submitForReview(e.id);
  for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === cur.id && x.status === 'suggested')) {
    wf.triageRuleSpan(s.id, 'dismiss', '无文本敏感', '审阅人');
  }
  wf.acquireReviewLock(task.id, '审阅人');
  assert.throws(() => wf.approve(task.id, '审阅人', '尝试发布'), (err) => err.code === 'ATTACHMENT_METADATA');

  // 读者访问 v1 仍拿到旧图哈希
  const reader = wf.resolveReader(e.id, 1);
  assert.equal(reader.attachments[0].sha256, 'imgold');
});

test('锚点漂移：改写后旧偏移不得套用；唯一上下文可重定位但需复核，多义/删除判漂移', () => {
  const wf = new Workflow();
  const e = wf.createEntry('日记', '编辑A');
  const rev0 = wf.db.mustGet('revision', wf.db.mustGet('entry', e.id).current_rev_id);
  const v1 = {
    problem: '联系电话是 13800138000，记得会后跟进。',
    action: '行动段', result: '结果段', reflection: '反思段',
  };
  const r1 = wf.commitRevision(e.id, v1, '编辑A', rev0.id);
  const span = wf.annotate(r1.id, 'problem', '联系电话是 '.length, '联系电话是 13800138000'.length, 'phone', '审阅人');

  // 在句首加字：上下文保留，唯一出现 -> relocated，需复核
  const r2 = wf.commitRevision(e.id, { ...v1, problem: '请注意：联系电话是 13800138000，记得会后跟进。' }, '编辑A', r1.id);
  let moved = wf.db.findOne('sensitive_span', (s) => s.revision_id === r2.id && s.source === 'human');
  assert.equal(moved.status, 'active');
  assert.equal(moved.needs_recheck, 1);
  assert.equal(v1.problem.slice('联系电话是 '.length, '联系电话是 13800138000'.length), '13800138000');

  // 新稿中号码出现两次：多义 -> drifted
  const r3 = wf.commitRevision(e.id, {
    ...v1, problem: '旧号 13800138000 与新号 13800138000 待确认。',
  }, '编辑A', r2.id);
  moved = wf.db.findOne('sensitive_span', (s) => s.revision_id === r3.id && s.source === 'human');
  assert.equal(moved.status, 'drifted');

  // 批准必须被门禁拦住
  const task = wf.submitForReview(e.id);
  for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === r3.id && x.status === 'suggested')) {
    wf.triageRuleSpan(s.id, 'dismiss', '号码已知会处理', '审阅人');
  }
  wf.acquireReviewLock(task.id, '审阅人');
  assert.throws(() => wf.approve(task.id, '审阅人', '强行发布'), (err) => err.code === 'ANCHOR_DRIFT');
});

test('脱敏发生在服务端派生：公开稿内容已是【已隐去】，渠道文本不含原稿手机号', () => {
  const wf = new Workflow();
  const e = wf.createEntry('日记', '编辑A');
  const rev0 = wf.db.mustGet('revision', wf.db.mustGet('entry', e.id).current_rev_id);
  const r1 = wf.commitRevision(e.id, { problem: '手机 13912345678', action: 'a', result: 'r', reflection: 'x' }, '编辑A', rev0.id);
  wf.annotate(r1.id, 'problem', 3, 14, 'phone', '审阅人');
  const task = wf.submitForReview(e.id);
  for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === r1.id && x.status === 'suggested')) {
    wf.triageRuleSpan(s.id, 'confirm', '同手机号，人工已标注', '审阅人');
  }
  wf.acquireReviewLock(task.id, '审阅人');
  const pv = wf.approve(task.id, '审阅人', '已人工核对手机号并隐去');
  for (const j of wf.pendingJobs()) wf.processJob(j.id);
  for (const ch of ['web', 'rss', 'card', 'download']) {
    const payload = wf.db.findOne('channel_payload', (p) => p.entry_id === e.id && p.channel === ch);
    assert.ok(!payload.body.includes('13912345678'), `${ch} 不应包含原稿手机号`);
  }
  assert.ok(JSON.parse(pv.content_json).problem.includes('【已隐去】'));
});

test('规则检测：能报直写手机号/邮箱，但对变形与语义遗漏；公开客服邮箱属于误报', () => {
  const hits = scanContent({
    problem: '直写 13912345678，变形 1３９ 12３4 56７8 识别不到，客户是“王总账务”也识别不到。',
    action: '', result: '', reflection: '客服 support@company.com',
  });
  const kinds = hits.map((h) => h.kind);
  assert.ok(kinds.includes('phone'));
  assert.ok(kinds.includes('email'));
  // 全角变形与语义指代漏报——文档必须承认
  assert.ok(RULE_LIMITS.misses.some((m) => m.includes('变形')));

  // 白名单体现误报处置：官网客服邮箱由审校登记后不再提示
  const hits2 = scanContent({ problem: '', action: '', result: '', reflection: 'support@company.com' }, { whitelist: ['support@company.com'] });
  assert.equal(hits2.length, 0);
});

test('附件元数据检查覆盖 GPS/作者/批注', () => {
  assert.equal(checkAttachmentMeta('a.png', 'image/png', { gps: { lat: 1, lon: 1 } }).ok, false);
  assert.equal(checkAttachmentMeta('a.png', 'image/png', { author: '客户', authorPublic: false }).ok, false);
  assert.equal(checkAttachmentMeta('a.png', 'image/png', {}).ok, true);
});
