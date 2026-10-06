// 公共工具：ID、哈希、不可变更新辅助
import { createHash } from 'node:crypto';

export const SECTIONS = ['problem', 'action', 'result', 'reflection'];
export const SECTION_LABEL = {
  problem: '问题',
  action: '行动',
  result: '结果',
  reflection: '反思',
};

// 段落分隔标记：仅用于哈希拼接，不进入正文
const HASH_SEP = '<<section-boundary>>';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

let counter = 0;
export function newId(prefix = 'id') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function now() {
  return Date.now();
}

export function fullBodyHash(content) {
  // 四段拼接哈希：任何一段改写都会改变，作为版本漂移的最终依据
  return sha256(SECTIONS.map((k) => content[k] ?? '').join(HASH_SEP));
}

export function deepClone(v) {
  return structuredClone(v);
}
