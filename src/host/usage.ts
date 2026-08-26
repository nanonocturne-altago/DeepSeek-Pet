/**
 * 用量计算（host 半侧）：把「今日已用」从两种来源算出——
 * 移植自插件 A（dsh-whale-widget）的记账/令牌双模式：
 *
 * 1. 小鲸鱼记账（ledger，默认）：每次观测到余额后，用余额下降差值自动累计当天用量，
 *    持久化到 `$DSH_HOME/dsh-pet/.dshw-usage.json`（跨天自动归档最近 30 天、当日归零）。
 *    余额上升（充值）不扣减，只更新基准。
 * 2. 实时·令牌（token）：用平台会话令牌调 DeepSeek 平台用量接口（只返回 token 分桶），
 *    按北京时间峰谷定价表换算金额。
 *
 * 与其他文件的关系：仅被 src/host/index.ts 的 balanceWithUsage() 调用；
 * 账本文件（$DSH_HOME/dsh-pet/.dshw-usage.json）由本模块独占读写，
 * index.ts 只负责传路径、不解析内容。
 *
 * 已知坑：
 * - 账本日界线取宿主本地时区（todayKey），而峰谷定价按北京时间判定——宿主时区
 *   非 UTC+8 时两者的「今天」可能错位一天；
 * - 平台用量接口需要会话令牌（DEEPSEEK_PLATFORM_TOKEN，非 API key），拿不到或
 *   令牌失效时上层自动回落 ledger 模式，属预期降级而非错误；
 * - 记账写盘为尽力而为（失败静默跳过），绝不阻断余额链路。
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** 抓取超时（ms） */
const USAGE_FETCH_TIMEOUT_MS = 15000;

/** 高峰时段（北京时间小时区间，半开 [start, end)，与 isPeakTime 判定一致） */
const PEAK_HOURS: [number, number][] = [
  [9, 12],
  [14, 18],
];

/** 每百万 token 单价：[[空闲价, 高峰价]...]；hit=缓存命中输入 / miss=缓存未命中输入 / out=输出 */
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] };
// 定价注册表：模型名子串 → 单价。目前所有 deepseek 型号同价（共用 BASE_PRICE），
// 未来价格差异化时在此登记新键；未命中任何键回落 _default
const PRICING: Record<string, typeof BASE_PRICE> = {
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': BASE_PRICE,
  _default: BASE_PRICE,
};

/**
 * 模型名 → 单价表：按子串匹配定价键（大小写不敏感）。
 * @param model bucket 上报的模型名（可能为空/缺失，接口字段不稳定）
 * @returns 命中的单价表；未命中任何键时返回 PRICING._default
 */
function priceFor(model: unknown): typeof BASE_PRICE {
  const m = String(model ?? '').toLowerCase();
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue;
    if (m.indexOf(key) !== -1) return PRICING[key];
  }
  return PRICING._default;
}

/** bucket time（epoch 秒）→ 是否高峰（北京时间） */
function isPeakTime(timeSec: unknown): boolean {
  if (!isFinite(Number(timeSec))) return false;
  const hour = new Date(Number(timeSec) * 1000 + 8 * 3600 * 1000).getUTCHours();
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true;
  }
  return false;
}

/** 记账模式账本结构（与插件 A 同构：{date, lastBalance, todayUsage, history}） */
interface Ledger {
  /** 账本所属日期（YYYY-MM-DD，宿主本地时区）；跨天时旧账先归档进 history */
  date: string;
  /** 上次观测到的余额（元）；null = 尚未观测过（新账本） */
  lastBalance: number | null;
  /** 当天累计用量（元）：余额下降差值的累加 */
  todayUsage: number;
  /** 历史归档：date → 当天用量；最多保留最近 30 天（recordLedgerUsage 内裁剪） */
  history: Record<string, number>;
}

/** 今日日期键（YYYY-MM-DD，宿主本地时区）——账本按此切分与归档 */
function todayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 读取账本；文件不存在/损坏/结构非法 → 返回当天新建的空账本（不抛错） */
function readLedger(ledgerPath: string): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed;
  } catch {
    /* 不存在/损坏 → 新建 */
  }
  return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} };
}

/** 同步落盘账本；失败静默跳过（记账尽力而为，绝不阻断余额链路） */
function writeLedger(ledgerPath: string, led: Ledger): void {
  try {
    writeFileSync(ledgerPath, JSON.stringify(led), 'utf8');
  } catch {
    /* 目录不存在等：跳过（记账为尽力而为，失败不阻断余额） */
  }
}

/**
 * 记账模式：每次观测到余额后累计当天用量（余额下降差值；充值不扣减；跨天归档）。
 * @param currentBalance 本次观测到的余额（元）
 * @param ledgerPath 账本文件路径（$DSH_HOME/dsh-pet/.dshw-usage.json）
 * @returns 当天累计用量（元）
 */
export function recordLedgerUsage(currentBalance: number, ledgerPath: string): number {
  const t = todayKey();
  const led = readLedger(ledgerPath);
  if (led.date !== t) {
    // 跨天：把旧账当天用量归档进 history，再重置当日基准与用量
    if (led.date && typeof led.todayUsage === 'number') {
      led.history = led.history || {};
      led.history[led.date] = led.todayUsage;
    }
    led.date = t;
    led.lastBalance = currentBalance;
    led.todayUsage = 0;
  } else {
    // 同日：余额下降 → 差值计入今日用量；余额上升（充值）不扣减，只更新基准
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance;
    if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
      led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance);
    }
    led.lastBalance = currentBalance;
  }
  // 归档只保留最近 30 天（按日期键升序删除最旧）
  const keys = Object.keys(led.history || {}).sort();
  while (keys.length > 30) {
    const k = keys.shift();
    if (k !== undefined) delete led.history[k];
  }
  writeLedger(ledgerPath, led);
  return typeof led.todayUsage === 'number' ? led.todayUsage : 0;
}

/**
 * 实时·令牌模式：平台用量接口只返回 token 分桶，按峰谷定价换算今日金额。
 * @returns { amount, tokens }；失败返回 null（上层回落记账模式）
 */
export async function fetchTokenUsage(token: string): Promise<{ amount: number; tokens: number } | null> {
  try {
    // 查询窗口 = 今天 00:00:00 → 次日 00:00:00（宿主本地时区，epoch 秒）；
    // tz 为分钟级时区偏移，平台接口用它把 bucket 归到对应日历日
    const now = new Date();
    const tz = -now.getTimezoneOffset() * 60;
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const end = start + 86400;
    const url =
      'https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=' + start + '&end=' + end + '&tz=' + tz;
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    // 兼容两种响应形状（平台接口迭代史）：data.biz_data.series 或 data.series；
    // series 为空（今日无调用记录）→ null，上层回落 ledger 模式
    const d = body as { data?: { biz_data?: { series?: unknown[] }; series?: unknown[] } };
    let series: unknown[] | undefined;
    if (d?.data?.biz_data && Array.isArray(d.data.biz_data.series)) series = d.data.biz_data.series;
    else if (d?.data && Array.isArray(d.data.series)) series = d.data.series;
    if (!series || series.length === 0) return null;
    let cost = 0;
    let tokens = 0;
    let found = false;
    for (const s of series) {
      // series 逐模型：每个 series 是某模型的用量序列，其 buckets 是每次请求的分桶统计
      if (!s || typeof s !== 'object') continue;
      const p = priceFor((s as { model?: unknown }).model);
      const buckets = Array.isArray((s as { buckets?: unknown }).buckets)
        ? ((s as { buckets?: unknown[] }).buckets as unknown[])
        : [];
      for (const b of buckets) {
        // 每个 bucket：缓存命中 / 缓存未命中 / 输出 token 三类分桶（接口固定键名）
        const u =
          b && typeof b === 'object'
            ? ((b as { usage?: unknown }).usage as Record<string, unknown> | undefined)
            : undefined;
        if (!u || typeof u !== 'object') continue;
        const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0;
        const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0;
        const out = Number(u.RESPONSE_TOKEN) || 0;
        // 全零分桶 = 空调用记录，跳过（整天都跳过时 found=false，整体返回 null）
        if (hit + miss + out === 0) continue;
        found = true;
        tokens += hit + miss + out;
        // pi=0 空闲价 / 1 高峰价：按 bucket 时间戳判定北京时间是否高峰
        const pi = isPeakTime((b as { time?: unknown }).time) ? 1 : 0;
        cost += (hit / 1e6) * p.hit[pi] + (miss / 1e6) * p.miss[pi] + (out / 1e6) * p.out[pi];
      }
    }
    // found=false = 整天无任何有效调用数据：返回 null 让上层回落 ledger 模式
    return found ? { amount: cost, tokens } : null;
  } catch {
    return null;
  }
}
