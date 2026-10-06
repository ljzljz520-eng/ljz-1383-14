// 规则辅助检测：只做“提示命中”，不做最终判定。
// 与人工标注的关系见 docs：规则会遗漏(语义/元数据/变形)，也会误报(公开客服号、示例文本)。
// 命中结果作为 source='rule' 的待确认片段写入，审校可以 dismiss 并记录理由。

const luhnOk = (digits) => {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

export const RULES = [
  {
    id: 'cn_mobile',
    kind: 'phone',
    // 仅匹配常见直写手机号；故意不覆盖 1xx 全号段变形写法，以暴露“遗漏”
    re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    note: '中国大陆手机号（直写）',
  },
  {
    id: 'email',
    kind: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    note: '邮箱地址（可能是公开客服邮箱，存在误报）',
  },
  {
    id: 'cn_idcard',
    kind: 'idcard',
    re: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    validate: (s) => luhnOk(s.slice(0, 17)),
    note: '18 位身份证（带校验位启发式，仍会误报长数字串）',
  },
  {
    id: 'bank_card',
    kind: 'bankcard',
    re: /(?<!\d)\d{16,19}(?!\d)/g,
    validate: (s) => luhnOk(s),
    note: '16-19 位银行卡（Luhn 启发式；会误报订单号/演示号）',
  },
  {
    id: 'internal_ip',
    kind: 'internal_ip',
    re: /(?<!\d)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\d)/g,
    note: '内网 IP',
  },
  {
    id: 'keyword_secret',
    kind: 'keyword',
    re: /(?:密码|口令|token|secret|AKIA[0-9A-Z]{12,}|客户全名|身份证号|家庭住址)/gi,
    note: '密钥/凭据/隐私词（词表法，覆盖不了同义改写）',
  },
];

function dedupeOverlapping(findings) {
  // 同一段内重叠命中：保留更长的；等长保留靠前的
  const bySection = new Map();
  for (const f of findings) {
    if (!bySection.has(f.section)) bySection.set(f.section, []);
    bySection.get(f.section).push(f);
  }
  const out = [];
  for (const arr of bySection.values()) {
    arr.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
    let lastEnd = -1;
    for (const f of arr) {
      if (f.start >= lastEnd) {
        out.push(f);
        lastEnd = f.end;
      }
    }
  }
  return out;
}

// whitelist: 明确登记为“可公开”的字符串（如官网客服邮箱、400 电话）。
// 规则自身不判断公开与否——允许列表由审校流程维护，体现“误报由人处置”。
export function scanContent(content, { whitelist = [] } = {}) {
  const allow = new Set(whitelist);
  const hits = [];
  for (const section of ['problem', 'action', 'result', 'reflection']) {
    const text = content[section] || '';
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text)) !== null) {
        const value = m[0];
        if (allow.has(value)) continue;
        if (rule.validate && !rule.validate(value)) continue;
        hits.push({
          section,
          start: m.index,
          end: m.index + value.length,
          match_text: value,
          kind: rule.kind,
          rule_id: rule.id,
          rule_note: rule.note,
        });
        if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1;
      }
    }
  }
  return dedupeOverlapping(hits);
}

// 给出规则能力边界说明，供审校界面直接展示（“规则的遗漏和误报”必须可见）
export const RULE_LIMITS = {
  misses: [
    '语义敏感：未点名的人物指代、客户内部项目代号、可被推断的身份组合（岗位+部门+时间）',
    '文本变形：全角数字、插空格/符号（1 3 8 xxxx）、拼音谐音、截图或图片里的文字（OCR 未覆盖）',
    '附件与元数据：照片 EXIF 中的 GPS/相机序列号、文档作者、PDF 图层与批注，正文规则完全看不到',
    '上下文关联：单句无敏感词，但与历史日记/公开信息组合后可定位个人',
  ],
  falsePositives: [
    '已公开的客服邮箱、官网 400 电话、文档示例号（如 13800000000 演示值）',
    '长订单号/工单号满足 Luhn 或长度特征，被当成身份证/银行卡',
    '技术文章中的内网网段示例、示例 token 字符串',
  ],
  policy: '规则命中只生成“待确认”片段；是否敏感以人工标注为准。放行误报必须填写理由(dismiss_reason)。',
};
