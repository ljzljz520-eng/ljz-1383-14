'use strict';
/**
 * redact.js —— 敏感片段规则检测、文本锚点定位、公开稿派生、人/机标注对比。
 *
 * 核心原则：
 * 1. 脱敏锚点不保存"裸偏移量"作为唯一依据，而是保存 原文片段(exact) + 前后文(prefix/suffix)。
 *    原稿被修改后必须重新定位；定位失败/歧义 => 锚点失效(stale)，绝不把旧偏移误套到新文字上。
 * 2. 公开稿只能由"已批准(approved)"的片段派生，未审片段不得进入任何公开渠道。
 */

// ---- 规则库（辅助检测，存在已知的遗漏与误报，详见 docs/review-workflow.md）----
const RULES = [
  { id: 'phone',    label: '手机号',   re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { id: 'email',    label: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { id: 'idcard',   label: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { id: 'bankcard', label: '银行卡号', re: /(?<!\d)\d{16,19}(?!\d)/g },
  { id: 'qq',       label: 'QQ号',    re: /(?<![\dA-Za-z])[1-9]\d{4,9}(?![\dA-Za-z])/g },
];

const SECTIONS = ['problem', 'action', 'result', 'reflection'];
const SECTION_LABELS = { problem: '问题', action: '行动', result: '结果', reflection: '反思' };

/** 对四个段落运行规则检测，返回候选片段（按段落内偏移排序，重叠时先命中的规则优先）。 */
function detect(sections) {
  const found = [];
  for (const section of SECTIONS) {
    const text = sections[section] || '';
    const taken = []; // 已占用区间，避免 qq 规则重复命中 phone 等
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text)) !== null) {
        const start = m.index, end = m.index + m[0].length;
        if (taken.some(([s, e]) => start < e && s < end)) continue;
        taken.push([start, end]);
        found.push({ section, start, end, exact: m[0], rule: rule.id, ruleLabel: rule.label });
      }
    }
  }
  return found;
}

const CTX = 24; // 锚点前后文长度

/** 由文本与偏移生成锚点。 */
function makeAnchor(text, start, end) {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CTX), start),
    suffix: text.slice(end, end + CTX),
  };
}

/**
 * 在新文本中重新定位锚点。
 * 返回 { start, end } | null（找不到或存在歧义时返回 null —— 调用方必须将其置为 stale，
 * 不允许回退使用旧偏移）。
 */
function relocate(text, anchor) {
  const hits = [];
  let idx = text.indexOf(anchor.exact);
  while (idx !== -1) {
    hits.push(idx);
    idx = text.indexOf(anchor.exact, idx + 1);
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return { start: hits[0], end: hits[0] + anchor.exact.length };
  // 多处出现：用前后文打分，唯一最佳才接受，否则视为歧义
  let best = null, bestScore = -1, tie = false;
  for (const h of hits) {
    const pre = text.slice(Math.max(0, h - CTX), h);
    const suf = text.slice(h + anchor.exact.length, h + anchor.exact.length + CTX);
    let score = 0;
    for (let i = 1; i <= anchor.prefix.length; i++) if (pre.endsWith(anchor.prefix.slice(-i))) score++; else break;
    for (let i = 1; i <= anchor.suffix.length; i++) if (suf.startsWith(anchor.suffix.slice(0, i))) score++; else break;
    if (score > bestScore) { bestScore = score; best = h; tie = false; }
    else if (score === bestScore) tie = true;
  }
  if (tie || bestScore === 0) return null;
  return { start: best, end: best + anchor.exact.length };
}

/** 用已批准片段派生公开稿（替换为占位符）。 */
function derivePublic(sections, approvedSpans) {
  const out = {};
  for (const section of SECTIONS) {
    let text = sections[section] || '';
    const spans = approvedSpans
      .filter(s => s.section === section)
      .sort((a, b) => b.start - a.start); // 从后往前替换，偏移不受前面替换影响
    for (const s of spans) {
      text = text.slice(0, s.start) + '［已隐去］' + text.slice(s.end);
    }
    out[section] = text;
  }
  return out;
}

/** 区间是否重叠。 */
function overlap(a, b) {
  return a.section === b.section && a.start < b.end && b.start < a.end;
}

/**
 * 人工标注 vs 规则检测对比。
 * human / rule 均为片段数组（含 section/start/end/exact）。
 * 返回 { both, misses, falsePositives }：遗漏=人工标了规则没标；误报=规则标了人工没标。
 */
function compare(human, rule) {
  const both = [], misses = [], falsePositives = [];
  const ruleUsed = new Set();
  for (const h of human) {
    const ri = rule.findIndex((r, i) => !ruleUsed.has(i) && overlap(h, r));
    if (ri === -1) misses.push(h);
    else { ruleUsed.add(ri); both.push({ human: h, rule: rule[ri] }); }
  }
  rule.forEach((r, i) => { if (!ruleUsed.has(i)) falsePositives.push(r); });
  return { both, misses, falsePositives };
}

module.exports = { RULES, SECTIONS, SECTION_LABELS, detect, makeAnchor, relocate, derivePublic, compare };
