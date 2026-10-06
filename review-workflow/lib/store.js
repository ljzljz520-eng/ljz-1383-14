// 内存表存储：字段与 schema.sql 一一对应，提供行级 CAS（乐观锁）。
// 生产环境替换为支持事务的关系库即可，领域模块不依赖此处实现。
import { deepClone } from './util.js';

export class Store {
  constructor() {
    this.tables = {};
  }

  table(name) {
    if (!this.tables[name]) this.tables[name] = new Map();
    return this.tables[name];
  }

  insert(name, row) {
    const t = this.table(name);
    if (t.has(row.id)) throw new Error(`duplicate key in ${name}: ${row.id}`);
    t.set(row.id, deepClone(row));
    return deepClone(row);
  }

  get(name, id) {
    const row = this.table(name).get(id);
    return row ? deepClone(row) : null;
  }

  mustGet(name, id) {
    const row = this.get(name, id);
    if (!row) throw new Error(`missing ${name}: ${id}`);
    return row;
  }

  update(name, id, patch, expected) {
    // compare-and-set：expected 给出必须相等的字段（如 lock_version / epoch），
    // 用于“两人同时改写、迟到发布任务”等并发验收。
    const t = this.table(name);
    const cur = t.get(id);
    if (!cur) throw new Error(`missing ${name}: ${id}`);
    for (const [k, v] of Object.entries(expected || {})) {
      if (cur[k] !== v) {
        const err = new Error(`CAS_CONFLICT ${name}.${k} expected=${v} actual=${cur[k]}`);
        err.code = 'CAS_CONFLICT';
        throw err;
      }
    }
    const next = { ...cur, ...patch };
    t.set(id, next);
    return deepClone(next);
  }

  all(name) {
    return [...this.table(name).values()].map(deepClone);
  }

  find(name, pred) {
    return this.all(name).filter(pred);
  }

  findOne(name, pred) {
    return this.all(name).find(pred) || null;
  }
}

export function uniqueIndex(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), r);
  return m;
}
