// 脱敏锚点与漂移重定位。
// 核心约束：不得把旧脱敏锚点按字符偏移“套”到新文字上。
// 锚点 = {section, match_text, 序号(同文本第几次出现), 前后各 12 字上下文}
// 改写后：
//   1) 先在同段用 “原文+序号+上下文” 重定位，且要求上下文相似；
//   2) 唯一精确命中 -> relocated（记录新偏移，仍需复核）；
//   3) 找不到/多义 -> drifted：发布门禁拒绝，必须回到待审重新定位。

import { sha256 } from './util.js';

const CTX = 12;
const ANCHOR_SEP = '||';

export function makeAnchor(sectionText, start, end) {
  const matchText = sectionText.slice(start, end);
  // ordinal：同样的文本在本段是第几次出现（消除“同字符串多处”歧义）
  let ordinal = 0;
  let from = 0;
  while (from <= start) {
    const idx = sectionText.indexOf(matchText, from);
    if (idx === -1 || idx >= start) break;
    ordinal += 1;
    from = idx + matchText.length;
  }
  return {
    sectionKey: sectionText.slice(0, start),
    match_text: matchText,
    ordinal,
    prefix: sectionText.slice(Math.max(0, start - CTX), start),
    suffix: sectionText.slice(end, end + CTX),
    anchor_hash: sha256([sectionText.slice(0, start), matchText, String(ordinal)].join(ANCHOR_SEP)),
  };
}

const overlap = (a, b) => !(a.end <= b.start || b.end <= a.start);

function occurrences(haystack, needle) {
  const out = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

function ctxSimilar(text, idx, len, prefix, suffix) {
  const p = text.slice(Math.max(0, idx - prefix.length), idx);
  const s = text.slice(idx + len, idx + len + suffix.length);
  // 上下文被原样保留才算定位可信；只要一侧完全一致即可。
  // 前后同时改写时不做猜测——交给漂移处理，回到人工。
  return (prefix && p === prefix) || (suffix && s === suffix);
}

// oldRevContent/newRevContent: {problem,action,result,reflection}
// spans: 旧修订上仍 active 的片段（含锚点字段 anchor_json）
export function relocateSpans(oldRevContent, newRevContent, spans) {
  const results = [];
  for (const span of spans) {
    const oldText = oldRevContent[span.section] || '';
    const newText = newRevContent[span.section] || '';
    const anchor = span.anchor_json ? JSON.parse(span.anchor_json) : null;
    const matchText = anchor?.match_text ?? span.match_text;

    if (newText === oldText && newText.slice(span.start, span.end) === matchText) {
      // 该段未变：偏移仍然有效
      results.push({ span, status: 'unchanged', start: span.start, end: span.end });
      continue;
    }

    const positions = occurrences(newText, matchText);
    const candidates = positions
      .map((p) => ({ start: p, end: p + matchText.length }))
      .filter((c) => ctxSimilar(newText, c.start, matchText.length, anchor?.prefix || '', anchor?.suffix || ''));

    const uniq = [];
    for (const c of candidates) {
      if (!uniq.some((u) => overlap(u, c))) uniq.push(c);
    }

    if (uniq.length === 1) {
      // 唯一且上下文吻合：可重定位，但必须重新走复核（不自动视为已确认）
      results.push({ span, status: 'relocated', start: uniq[0].start, end: uniq[0].end });
    } else if (uniq.length === 0 && positions.length === 1) {
      // 原文唯一出现但上下文变了：不自动套用，判漂移
      results.push({ span, status: 'drifted', reason: '上下文已变化，需人工确认新位置' });
    } else if (positions.length >= 2) {
      results.push({ span, status: 'drifted', reason: '原文在新稿中多处出现，无法唯一定位' });
    } else {
      results.push({ span, status: 'drifted', reason: '原文已被删除或改写' });
    }
  }
  return results;
}
