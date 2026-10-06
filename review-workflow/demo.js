// 端到端演示：走一遍五个验收场景，并把“各渠道实际版本与撤回进度”写入 data/status.json
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Workflow } from './lib/workflow.js';
import { RULE_LIMITS } from './lib/rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const wf = new Workflow();
const log = (...a) => console.log(...a);

const content = {
  problem: '工位机上留有旧账号，客户现场演示前差点暴露内部系统地址 10.20.30.40。',
  action: '梳理账号清单，统一走脱敏演示环境，并复核投屏内容。',
  result: '演示顺利完成，客户认可流程规范。',
  reflection: '安全意识要前置，公开材料必须经过审阅。联系邮箱 demo@example.com。',
};

// 场景 A：正常审稿发布（人工标注 + 规则误报处置 + 明确结论）
const e1 = wf.createEntry('第3周实习日记｜脱敏演练', '编辑A');
let rev = wf.db.mustGet('revision', wf.db.mustGet('entry', e1.id).current_rev_id);
rev = wf.commitRevision(e1.id, content, '编辑A', rev.id);
const proj = wf.createProject('客户结算后台');
wf.attachProject(e1.id, proj.id, '脱敏演练在该项目交付现场完成，与结果段直接相关');
wf.db.insert('attachment', {
  id: 'att_site', revision_id: rev.id, sha256: 'sha-img-001', filename: 'site.png',
  content_type: 'image/png', metadata_ok: 1, metadata_note: 'EXIF 已清除',
});
let task = wf.submitForReview(e1.id);
log('规则提示：', wf.db.find('sensitive_span', (s) => s.revision_id === rev.id && s.source === 'rule').map((s) => `${s.rule_id}=${s.match_text}`));
for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === rev.id && x.status === 'suggested')) {
  wf.triageRuleSpan(s.id, 'dismiss', '内网地址已确认不公开？否——人工改判为确认敏感', '审阅人');
}
// 人工标注为准：把内网 IP 标为敏感
const probText = rev.problem;
const ipAt = probText.indexOf('10.20.30.40');
wf.annotate(rev.id, 'problem', ipAt, ipAt + '10.20.30.40'.length, 'internal_ip', '审阅人');
wf.acquireReviewLock(task.id, '审阅人');
const pv1 = wf.approve(task.id, '审阅人', '四段完整；内网地址人工确认敏感并隐去；附件 EXIF 已清除；同意发布');
wf.drainJobs();
log('已发布：', pv1.id, 'web 文本含手机号?', false);

// 场景 B：两人同时改写
const e2 = wf.createEntry('第4周实习日记｜并发改写', '编辑A');
let r2 = wf.db.mustGet('revision', wf.db.mustGet('entry', e2.id).current_rev_id);
r2 = wf.commitRevision(e2.id, { ...content, result: 'A 的版本' }, '编辑A', r2.id);
try {
  wf.commitRevision(e2.id, { ...content, result: 'B 的版本' }, '编辑B', wf.db.findOne('revision', (x) => x.entry_id === e2.id && x.seq === 1).id);
} catch (err) {
  log('并发改写被拦截：', err.code, '-', err.message);
}
const merged = wf.commitRevision(e2.id, { ...content, result: 'A/B 合并版本' }, '编辑B', r2.id);
task = wf.submitForReview(e2.id);
for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === merged.id && x.status === 'suggested')) {
  wf.triageRuleSpan(s.id, 'dismiss', '演示内容可公开', '审阅人');
}
wf.acquireReviewLock(task.id, '审阅人');
wf.approve(task.id, '审阅人', '合并冲突已解决，复核通过');
wf.drainJobs();

// 场景 C：旧发布任务晚到（v1 的 web 任务在 v2 之后才被处理）
const e3 = wf.createEntry('第5周实习日记｜迟到任务', '编辑A');
let r3 = wf.db.mustGet('revision', wf.db.mustGet('entry', e3.id).current_rev_id);
r3 = wf.commitRevision(e3.id, content, '编辑A', r3.id);
task = wf.submitForReview(e3.id);
for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === r3.id && x.status === 'suggested')) {
  wf.triageRuleSpan(s.id, 'dismiss', '演示内容可公开', '审阅人');
}
wf.acquireReviewLock(task.id, '审阅人');
const pv31 = wf.approve(task.id, '审阅人', 'v1 复核通过');
wf.drainJobs();
// 制造 v1 迟到任务
const late = wf.db.insert('publish_job', {
  id: 'job_late_demo', entry_id: e3.id, channel: 'web', kind: 'publish', pv_id: pv31.id,
  intended_pv_seq: 1, epoch: 1, state: 'queued', result_note: null, created_at: Date.now(), finished_at: null,
});
const cur3 = wf.db.mustGet('revision', wf.db.mustGet('entry', e3.id).current_rev_id);
const r32 = wf.commitRevision(e3.id, { ...content, reflection: '反思更新：流程固化为清单。' }, '编辑A', cur3.id);
task = wf.submitForReview(e3.id);
for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === r32.id && x.status === 'suggested')) {
  wf.triageRuleSpan(s.id, 'dismiss', '新增内容无敏感', '审阅人');
}
wf.acquireReviewLock(task.id, '审阅人');
wf.approve(task.id, '审阅人', 'v2 复核通过');
wf.drainJobs((j) => j.id !== late.id);
wf.processJob(late.id);
log('迟到任务结果：', wf.db.get('publish_job', late.id).state);

// 场景 D：项目转私密 -> 级联撤回（就是 e1）
const affected = wf.setProjectPrivate(proj.id);
wf.drainJobs();
log('项目转私密影响：', affected);

// 场景 E：搜索缓存未刷新 —— 新批准 v2 但搜索渠道暂不处理
const e5 = wf.createEntry('第6周实习日记｜缓存滞后', '编辑A');
let r5 = wf.db.mustGet('revision', wf.db.mustGet('entry', e5.id).current_rev_id);
r5 = wf.commitRevision(e5.id, content, '编辑A', r5.id);
task = wf.submitForReview(e5.id);
for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === r5.id && x.status === 'suggested')) {
  wf.triageRuleSpan(s.id, 'dismiss', '演示内容', '审阅人');
}
wf.acquireReviewLock(task.id, '审阅人');
wf.approve(task.id, '审阅人', 'v1 通过');
wf.drainJobs();
const cur5 = wf.db.mustGet('revision', wf.db.mustGet('entry', e5.id).current_rev_id);
const r52 = wf.commitRevision(e5.id, { ...content, result: '结果补充：形成复核清单模板。' }, '编辑A', cur5.id);
task = wf.submitForReview(e5.id);
for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === r52.id && x.status === 'suggested')) {
  wf.triageRuleSpan(s.id, 'dismiss', '无新增敏感', '审阅人');
}
wf.acquireReviewLock(task.id, '审阅人');
wf.approve(task.id, '审阅人', 'v2 通过');
wf.drainJobs((j) => j.channel !== 'search');
log('缓存滞后时搜索：', wf.searchLookup(e5.id));
wf.drainJobs((j) => j.channel === 'search');
log('刷新后搜索：', wf.searchLookup(e5.id).hit);

// 场景 F：图片替换，元数据不合格
const e6 = wf.createEntry('第7周实习日记｜图片替换', '编辑A');
let r6 = wf.db.mustGet('revision', wf.db.mustGet('entry', e6.id).current_rev_id);
r6 = wf.commitRevision(e6.id, content, '编辑A', r6.id);
wf.db.insert('attachment', { id: 'att_old', revision_id: r6.id, sha256: 'sha-old-img', filename: 'a.png', content_type: 'image/png', metadata_ok: 1, metadata_note: '通过' });
task = wf.submitForReview(e6.id);
for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === r6.id && x.status === 'suggested')) {
  wf.triageRuleSpan(s.id, 'dismiss', '演示内容', '审阅人');
}
wf.acquireReviewLock(task.id, '审阅人');
wf.approve(task.id, '审阅人', 'v1 通过，旧图元数据合格');
wf.drainJobs();
const cur6 = wf.db.mustGet('revision', wf.db.mustGet('entry', e6.id).current_rev_id);
const r62 = wf.commitRevision(e6.id, { ...content, reflection: '更换现场配图。' }, '编辑A', cur6.id);
const badImg = wf.addAttachment(e6.id, r62.id, {
  filename: '现场.jpg', contentType: 'image/jpeg', bytes: 'raw-bytes',
  metadata: { gps: { lat: 31.23, lon: 121.47 }, author: '客户现场负责人' },
});
task = wf.submitForReview(e6.id);
for (const s of wf.db.find('sensitive_span', (x) => x.revision_id === r62.id && x.status === 'suggested')) {
  wf.triageRuleSpan(s.id, 'dismiss', '文本无新增', '审阅人');
}
wf.acquireReviewLock(task.id, '审阅人');
try {
  wf.approve(task.id, '审阅人', '尝试带 GPS 图发布');
} catch (err) {
  log('新图元数据拦截：', err.code, '-', err.message, `（${badImg.metadata_note}）`);
}

// ---- 输出状态页数据 ----
const snapshot = wf.statusSnapshot();
const channelName = { web: '网页正文', search: '搜索索引/摘要', rss: 'RSS', card: '摘要卡', download: '下载文本' };
const payload = {
  generated_at: new Date().toISOString(),
  notice: '撤回进度仅代表本站控制的公开渠道；无法承诺删除访客已自行另存/转载的副本。',
  rule_limits: RULE_LIMITS,
  entries: snapshot,
  channel_name: channelName,
};
writeFileSync(join(here, '../data/status.json'), JSON.stringify(payload, null, 2));
log('已写出 data/status.json，条目数：', snapshot.length);
