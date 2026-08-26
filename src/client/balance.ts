/**
 * 余额数据层（client 半侧）：拉取 /dsh-pet-7340/balance → 解析 → 档位计算。
 *
 * 职责：
 * - 契约校验：按 RawBalanceResult 结构校验 host 侧 /dsh-pet-7340/balance 响应，
 *   非法数据显式抛错（绝不静默当 0），产出类型安全的 BalanceState 供上层消费；
 * - 档位计算：balancePercent（已用百分比）+ balanceEventIndex（6 档事件索引），
 *   供 pet.ts 按 animations.events.balance 池（pool[idx]）触发余额事件动画；
 * - 展示辅助：urgentWindow / resetInText / deepseekPricingTier，
 *   供 bubble.ts 渲染余额气泡（联想框）文案与峰谷配色。
 *
 * 数据流：pet.ts 按 eventsRefreshSec.balance 周期调用 fetchBalanceState()
 *   → host 侧查询官方接口（opencode /zen/go/v1/usage、deepseek /user/balance）
 *   → HTTP 返回 → 本模块解析校验 → BalanceState → pet.ts（档位动画）/ bubble.ts（气泡）消费。
 *
 * 模块关系：纯逻辑模块（不依赖 React/DOM），可独立单测；与 host/balance.ts 的
 * BalanceResult 结构同构（HTTP 契约两端各自声明，避免 client 打包跨层 import host）。
 * 新增/变更字段时两端需同步修改，否则客户端校验会抛「响应非法」。
 */

/** /dsh-pet-7340/balance 响应（与 host/balance.ts 同构；client 按此结构校验）。
 * 注意：所有字段声明为 unknown（部分字段允许缺省），由 fetchBalanceState 逐字段校验定型——
 * 网络输入一律不信任，避免把脏数据带进展示/档位计算。 */
export interface RawBalanceResult {
  /** 查询是否成功：true 时 data 必为对象（按 kind 校验）；false 时看 reason/message */
  ok: boolean;
  /** 服务商 id（agentDefaultModel.currentSelection().provider），未知时回退 'unknown' */
  provider?: string;
  /** 余额类型：opencode=用量百分比（三窗口）/ deepseek=金额余额；决定 data 字段集合 */
  kind?: 'opencode' | 'deepseek';
  /** 失败原因（ok=false 时）：unsupported=无公开查询接口 / credential-missing=缺凭证 / fetch-error=抓取失败 */
  reason?: string;
  /** 失败时的可读错误信息（气泡展示用，可缺省） */
  message?: string;
  /** opencode 数据：三窗口用量（0-100 百分比）+ 各自重置时间；deepseek 数据：金额字段 */
  data?: {
    /** 5 小时滚动窗口已用百分比 */
    rolling?: unknown;
    /** 周窗口已用百分比 */
    weekly?: unknown;
    /** 月窗口已用百分比 */
    monthly?: unknown;
    /** 各窗口额度重置的 ISO 时间（仅 opencode 提供） */
    rollingResetsAt?: unknown;
    weeklyResetsAt?: unknown;
    monthlyResetsAt?: unknown;
    /** 币种（如 'CNY'，仅 deepseek 提供） */
    currency?: unknown;
    /** 总余额（字符串金额，与官方接口一致） */
    total?: unknown;
    /** 赠送余额（字符串金额） */
    granted?: unknown;
    /** 充值余额（字符串金额） */
    toppedUp?: unknown;
  };
  /** 移植自插件 A 的用量语义：mode=ledger（余额差值记账）/ token（平台接口峰谷定价） */
  usage?: {
    /** 记账模式：ledger=余额差值 / token=峰谷定价；非法值回落 ledger */
    mode?: unknown;
    /** 今日已用金额（元）；非法/缺失回落 null（气泡不显示该行） */
    todayUsage?: unknown;
  };
}

/** 已解析的余额视图（client 展示 + 档位计算用）：
 * fetchBalanceState 校验后的成功态（ok 恒为 true）；opencode 与 deepseek 字段互斥，
 * 消费方按 kind 收窄后再读取对应字段。 */
export interface BalanceView {
  /** 服务商 id（原样透传 host 返回值，气泡展示用） */
  provider: string;
  /** 余额类型（已收窄为合法枚举，见 RawBalanceResult.kind） */
  kind: 'opencode' | 'deepseek';
  /** 成功标记（恒 true；与 BalanceUnavailable.ok=false 构成可辨识联合，便于调用方收窄） */
  ok: true;
  /** opencode：三窗口用量（0-100 数字）+ 各自的重置时间 */
  rolling?: number;
  weekly?: number;
  monthly?: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
  /** deepseek：余额金额（字符串，与接口一致） */
  currency?: string;
  total?: string;
  granted?: string;
  toppedUp?: string;
  /** 今日已用（移植自插件 A）：ledger/token 模式金额（元）；opencode 或不可得为 null */
  usage?: { mode: 'ledger' | 'token'; todayUsage: number | null };
}

/** 无效（不支持/缺凭证/抓取失败）：显式标记，不静默。
 * 消费方（pet.ts/bubble.ts）收到后跳过档位动画，气泡只显示失败原因。 */
export interface BalanceUnavailable {
  /** 服务商 id（透传，失败也要报出来源） */
  provider: string;
  /** 失败标记（恒 false，联合收窄用） */
  ok: false;
  /** 失败原因枚举（白名单外的 reason 已在 fetchBalanceState 兜底映射为 fetch-error） */
  reason: 'unsupported' | 'credential-missing' | 'fetch-error';
  /** 可读错误信息（可能缺失；气泡按 reason 给默认文案） */
  message?: string;
}

/** 余额查询结果联合：BalanceView=成功（可展示/算档位）；BalanceUnavailable=失败（只报原因，不播余额动画） */
export type BalanceState = BalanceView | BalanceUnavailable;

/** 单次请求超时（ms）：超时经 AbortSignal 中断并计为一次失败 */
const TIMEOUT_MS = 20000;
/** 失败重试次数（不含首次，即最多 RETRIES+1 次尝试；重试间隔 600ms） */
const RETRIES = 2;

/**
 * 带超时 + 重试的 GET（host 已内置重试，这里再兜底网络抖动）。
 * @param url 同源相对路径（/dsh-pet-7340/balance）
 * @returns ok 的 Response；非 ok（HTTP 4xx/5xx）不抛，记录后进入重试
 * @throws 全部尝试失败后抛最后一次错误（Error 原样抛出，其余值包装为 Error）
 */
async function getWithRetry(url: string): Promise<Response> {
  let last: unknown;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res;
      last = new Error('HTTP ' + res.status);
    } catch (e) {
      last = e;
    }
    if (i < RETRIES) await new Promise((r) => setTimeout(r, 600));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * 拉取当前状态的余额；网络/解析失败显式抛错（上层决定报错方式，绝不静默 0）。
 *
 * 校验策略（按 kind 分支，逐字段手工校验）：
 * - ok=false → 按 reason 白名单映射为 BalanceUnavailable（其余兜底 fetch-error）；
 * - opencode → 三窗口百分比必须为有限数字，否则 throw；
 * - deepseek → 金额必须为 string（非法/缺失回落 undefined），usage 单独软校验；
 * - kind 缺失/非法 → throw。
 *
 * @returns BalanceState：成功 → BalanceView；不支持/缺凭证/抓取失败 → BalanceUnavailable
 * @throws 网络失败（重试耗尽）/ 响应非 JSON / 结构非法 / kind 非法
 */
export async function fetchBalanceState(): Promise<BalanceState> {
  const res = await getWithRetry('/dsh-pet-7340/balance');
  const raw: RawBalanceResult = await res.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: /dsh-pet-7340/balance 响应非法');

  const provider = String(raw.provider ?? 'unknown');
  if (raw.ok !== true) {
    // 失败态：reason 走白名单，未知值兜底 fetch-error（对外只承诺三种失败原因）
    const reason =
      raw.reason === 'unsupported' || raw.reason === 'credential-missing' || raw.reason === 'fetch-error'
        ? raw.reason
        : 'fetch-error';
    return { provider, ok: false, reason, message: typeof raw.message === 'string' ? raw.message : undefined };
  }

  if (raw.kind === 'opencode') {
    const d = raw.data;
    if (!d || typeof d !== 'object') throw new Error('dsh-pet: /dsh-pet-7340/balance opencode 数据非法');
    // 三窗口百分比必须为有限数字（Number 兜底强转，转不出有限数即视为脏数据）
    const rolling = Number(d.rolling);
    const weekly = Number(d.weekly);
    const monthly = Number(d.monthly);
    if (![rolling, weekly, monthly].every(Number.isFinite))
      throw new Error('dsh-pet: /dsh-pet-7340/balance opencode 百分比非数字');
    return {
      provider,
      kind: 'opencode',
      ok: true,
      rolling,
      weekly,
      monthly,
      rollingResetsAt: typeof d.rollingResetsAt === 'string' ? d.rollingResetsAt : undefined,
      weeklyResetsAt: typeof d.weeklyResetsAt === 'string' ? d.weeklyResetsAt : undefined,
      monthlyResetsAt: typeof d.monthlyResetsAt === 'string' ? d.monthlyResetsAt : undefined,
    };
  }
  if (raw.kind === 'deepseek') {
    const d = raw.data;
    if (!d || typeof d !== 'object') throw new Error('dsh-pet: /dsh-pet-7340/balance deepseek 数据非法');
    // 今日已用（移植自插件 A）：ledger/token 金额；非法/缺失回落 null（气泡不显示该行）
    let usage: { mode: 'ledger' | 'token'; todayUsage: number | null } | undefined;
    if (raw.usage && typeof raw.usage === 'object') {
      // mode 白名单（token 之外一律按 ledger）；todayUsage 强转数字，转不出回落 null
      const mode = raw.usage.mode === 'token' ? 'token' : 'ledger';
      const n = Number(raw.usage.todayUsage);
      usage = { mode, todayUsage: Number.isFinite(n) ? n : null };
    }
    return {
      provider,
      kind: 'deepseek',
      ok: true,
      currency: typeof d.currency === 'string' ? d.currency : undefined,
      total: typeof d.total === 'string' ? d.total : undefined,
      granted: typeof d.granted === 'string' ? d.granted : undefined,
      toppedUp: typeof d.toppedUp === 'string' ? d.toppedUp : undefined,
      usage,
    };
  }
  throw new Error('dsh-pet: /dsh-pet-7340/balance kind 非法');
}

/** DeepSeek 满额基准（¥）：余额 ≥ 该值视为 100%（未消耗），余额按比例折算为已用百分比。
 * 业务约定值（非官方口径）：¥20 为「满额」参照线，余额 20 元 → 已用 0%，0 元 → 已用 100%。 */
const DEEPSEEK_FULL_BALANCE_CNY = 20;

/**
 * 事件档位百分比（已用百分比语义：0 = 未消耗，100 = 耗尽）：
 * - opencode：取三窗口最大（风险最高者为准）
 * - deepseek：余额按 DEEPSEEK_FULL_BALANCE_CNY（¥20 = 100%）折算为已用百分比
 *   （余额 20 元 → 0%，10 元 → 50%，0 元 → 100%）
 *
 * deepseek 换算公式：
 *   remaining% = max(0, total) / DEEPSEEK_FULL_BALANCE_CNY × 100   // 剩余百分比 0~100+
 *   used%      = clamp(100 − remaining%, 0, 100)                   // 折算为已用百分比
 *   ——total 为负（透支）按 0 余额计（已用 100%）；余额超 ¥20 时 remaining% > 100，used% 封顶 0。
 *
 * @param v 已解析的余额视图（调用前已确保 ok=true）
 * @returns 0~100 的已用百分比（喂给 balanceEventIndex 求档位）；
 *          数据缺失/非法（如 deepseek 金额非数字）时 undefined——调用方跳过档位动画
 */
export function balancePercent(v: BalanceView): number | undefined {
  if (v.kind === 'opencode') return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
  if (v.kind === 'deepseek') {
    const total = Number(v.total);
    if (!Number.isFinite(total)) return undefined; // 金额非法（非数字）：不触发（上层校验已兜底，此处双保险）
    // 负数 = 透支，与 0 等价按「已用完」折算：-0.02 → 剩余 0 → 已用 100%（播「分文不剩」档）
    const remaining = (Math.max(0, total) / DEEPSEEK_FULL_BALANCE_CNY) * 100; // 剩余百分比 0~100+
    return Math.max(0, Math.min(100, 100 - remaining)); // 折算为已用百分比
  }
  return undefined;
}

/**
 * 余额事件档位索引（与 assets/config.jsonc 注释一致）：
 * index = p === 100 ? 5 : Math.floor(p / 20)
 *
 * 档位映射表（已用百分比 p → animations.events.balance 数组下标，数组顺序 = 档位顺序）：
 *   0 ≤ p ≤ 19   → 0 档
 *   20 ≤ p ≤ 39  → 1 档
 *   40 ≤ p ≤ 59  → 2 档
 *   60 ≤ p ≤ 79  → 3 档
 *   80 ≤ p ≤ 99  → 4 档
 *   p = 100      → 5 档（耗尽，「分文不剩」）
 * @param p 已用百分比（0~100，来自 balancePercent）
 * @returns 档位索引 0~5（即 balance 事件动画池的下标）
 */
export function balanceEventIndex(p: number): number {
  if (p === 100) return 5;
  const i = Math.floor(p / 20);
  return i < 5 ? i : 4;
}

/** OpenCode 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月。
 * 用途：urgentWindow 由已用百分比反推剩余美元金额，供气泡联想框展示「剩余 $x」。 */
export const OPENCODE_QUOTA_USD = {
  rolling: 12,
  weekly: 30,
  monthly: 60,
} as const;

/** 窗口展示名（联想框文案用）：5h = 5 小时额度窗口、周、月。
 * 键必须与 OPENCODE_QUOTA_USD / OpenCodeWindow 一致；新增窗口时四处需同步：
 * RawBalanceResult.data、BalanceView、OPENCODE_QUOTA_USD、本表。 */
export const WINDOW_LABELS = {
  rolling: '5h',
  weekly: '周',
  monthly: '月',
} as const;

/** 额度窗口键（'rolling' | 'weekly' | 'monthly'），由 OPENCODE_QUOTA_USD 的键派生——单一事实来源 */
export type OpenCodeWindow = keyof typeof OPENCODE_QUOTA_USD;

/** 一个窗口的额度概况（用于联想框一句话判定）。
 * urgentWindow 产出：三窗口中「剩余额度最少」的一个（最先用完者）。 */
export interface WindowUsage {
  /** 展示名（'5h' / '周' / '月'，取自 WINDOW_LABELS） */
  label: string;
  /** 已用百分比（0-100，直接取自 BalanceView 对应窗口字段） */
  percent: number;
  /** 满额度（USD，取自 OPENCODE_QUOTA_USD） */
  quotaUsd: number;
  /** 剩余额度（USD）= 满额度 × (100 − percent) / 100 */
  remainingUsd: number;
  /** 额度重置的 ISO 时间（可能缺失；喂给 resetInText 转相对文案） */
  resetsAt?: string;
}

/**
 * 取三窗口剩余额度最少的那个（最先到达满额度/最先用完）。
 * 遍历 rolling/weekly/monthly，由已用百分比计算剩余 USD，取最小者；
 * 平局时保留先遍历到的（rolling 优先）。
 * @param v 余额视图；非 opencode 直接返回 undefined（deepseek 无窗口概念）
 * @returns 剩余额度最小的 WindowUsage；仅 opencode 状态可用
 */
export function urgentWindow(v: BalanceView): WindowUsage | undefined {
  if (v.kind !== 'opencode') return undefined;
  const windows: OpenCodeWindow[] = ['rolling', 'weekly', 'monthly'];
  const resets: Record<OpenCodeWindow, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  let best: WindowUsage | undefined;
  for (const w of windows) {
    const percent = v[w] ?? 0;
    const quota = OPENCODE_QUOTA_USD[w];
    const remaining = (quota * (100 - percent)) / 100;
    const cand: WindowUsage = {
      label: WINDOW_LABELS[w],
      percent,
      quotaUsd: quota,
      remainingUsd: remaining,
      resetsAt: resets[w],
    };
    if (best === undefined || remaining < best.remainingUsd) best = cand;
  }
  return best;
}

/**
 * 重置时间 → 相对文案（保留 1 位小数）：
 * - 距重置 ≥ 4 天 → 「N.x 天」
 * - 距重置 < 4 天 → 「N.x 小时」
 * - 已过重置点 → 「已重置」；未知时间 → 空串
 *
 * 边界条件：
 * - iso 缺失/非法（new Date 得 NaN）→ 返回 ''（气泡跳过该行）；
 * - delta ≤ 0（已过重置点）→ '已重置'；
 * - 不足 0.1 小时（6 分钟）时向上取 0.1 显示「0.1 小时」，避免「0.0 小时」。
 * @param iso 重置时间（ISO 字符串，来自 BalanceView.*ResetsAt）
 * @returns 中文相对文案；无时间信息返回空串
 */
export function resetInText(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = t - Date.now();
  if (delta <= 0) return '已重置';
  const hoursF = delta / 3_600_000;
  if (hoursF >= 96) return (Math.round((hoursF / 24) * 10) / 10).toFixed(1) + ' 天';
  return Math.max(0.1, Math.round(hoursF * 10) / 10).toFixed(1) + ' 小时';
}

/**
 * DeepSeek 峰谷计价档位（北京时间）：
 * - 高峰：工作日 9:00–12:00、14:00–18:00；其余为空闲（低谷）
 * - 周六/周日全天按低谷价计费（自 2026-08-23 起，周末不再区分峰谷）
 * 用途：bubble.ts 按档位给余额行配色（peak=红字/谷=绿字）与峰谷标签。
 */
export type PricingTier = 'peak' | 'idle';

/**
 * 当前时刻的 DeepSeek 计价档位（按北京时间 Asia/Shanghai，UTC+8 无夏令时）。
 * 实现：Intl.DateTimeFormat 取北京时间的星期与小时（而非本地时区），保证用户在
 * 任意时区下档位判定一致；hourCycle: 'h23' 避免午夜被格式化为 "24:00" 造成 Number 误判。
 * @param now 待判定的时刻（默认当前时间；参数注入以便单测固定时刻）
 * @returns 'peak'（高峰价）| 'idle'（低谷价）
 */
export function deepseekPricingTier(now: Date = new Date()): PricingTier {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23', // h23 避免午夜被格式化为 "24:00"
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return 'idle'; // 周末全天低谷
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'idle';
}
