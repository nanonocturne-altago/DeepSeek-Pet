// 配置层：剥注释、校验 config.jsonc。运行时（ANIM）直接使用与 jsonc 同构的 ClientConfig，
// 不做字段转换；缺失/非法一律视为配置错误（throw，由加载层显式报错）。
//
// 职责：client 半侧的配置读取与合并工具集——
//   1. stripJsonc：剥除 JSONC 注释，得到可被 JSON.parse 直接解析的纯 JSON 文本；
//   2. assertClientConfig：把 jsonc 解析产物逐字段校验为 ClientConfig，
//      任一字段缺失/非法即 throw（宁可显式报错，也不静默运行残缺配置）；
//   3. resolvePets / applyUserOverrides：把用户覆盖层合并到默认配置。
//
// 配置的三层来源（合并路径见 pet.ts 加载处与本文件的 applyUserOverrides）：
//   ① EMPTY_CONF：代码内的空占位（模块级 config 变量初始值，仅首帧兜底，不参与合并）；
//   ② 默认层：包内 assets/config.jsonc，经宿主路由 /dsh-pet-7340/config.jsonc 提供（只读）；
//   ③ 用户层：$DSH_HOME/dsh-pet/main-config.json，经宿主路由 /dsh-pet-7340/config 提供
//      （GET 读取 / PUT 保存 / DELETE 恢复默认）。
//   合并语义：顶层字段整体替换、缺省回落默认（不深合并）。
//
// 与其它模块的关系：
//   - types.ts：ClientConfig / Pet / Animations 等类型定义（与 jsonc 同构，
//     唯一事实来源是 config.jsonc 的结构）；
//   - pet.ts：加载并合并配置后二次 assertClientConfig（config = assertClientConfig(
//     applyUserOverrides(config, user))），模块级 config 的初始值即 EMPTY_CONF；
//   - notify.ts：readNotificationsEnabled 复用同一条合并路径读「系统通知总开关」；
//   - settings.ts：读取默认 pets 列表（新增宠物表单用）时使用 stripJsonc/assertClientConfig。
//
// 调用时机：页面加载后、宠物首次渲染前（pet.ts 的加载 effect）；校验失败会 throw，
//   由加载层显式报错（控制台可见），保证不静默运行残缺配置。
import type { Animations, ClientConfig, Corner, Pet, Weights } from './types';

/** 剥除 JSONC 注释（行注释 // 与块注释），得到纯 JSON 字符串 */
// 实现细节：
//   - 先用非贪婪正则剥掉所有块注释，再按行剥行注释——两步顺序保证块注释内部的
//     // 不会被误判为行注释；
//   - 行注释的正则带「前一个字符不是反斜杠或冒号」的排除，避免误伤字符串内容里的
//     URL（如 "https://..."）与被转义的斜杠。
// 边界：只做文本级剥除，不做任何语法校验——非法 JSON 由后续的 JSON.parse /
//   assertClientConfig 报错。
export const stripJsonc = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

/** 支持的角落白名单 */
export const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
/** corner 合法性检查用的 string 集合（Corner[] 的 includes 要求 Corner 参数，无法接收未知 string） */
const CORNER_SET: ReadonlySet<string> = new Set(CORNERS);

/** ClientConfig 类型占位（data-less；PetMulti 加载后由 assertClientConfig 赋真实值） */
// 用途：pet.ts 的模块级 config 变量初始值——配置拉取是异步的，首帧渲染需要
// 一个形状完整的空配置兜底（空 pets 列表 + 空动画池 + 全零权重 + 空事件表），
// 让所有消费方无需判空；真实配置加载完成后整体替换，占位值不参与合并。
export const EMPTY_CONF: ClientConfig = {
  notificationsEnabled: true,
  pets: [],
  animations: {
    idle: [],
    turn: [],
    drag: [],
    clicks: [],
    moves: { default: {}, actions: [] },
    categories: [],
    events: {},
  },
  animationWeights: { idle: 0, turn: 0, move: 0 },
  eventsRefreshSec: {},
};

/** 校验 config.jsonc 解析结果并返回 ClientConfig；任一字段缺失/非法即视为配置错误抛出 */
// @param raw JSON.parse 的产物（unknown）。既可能是默认层 config.jsonc，也可能是
//            applyUserOverrides 合并后的整体——两处都走本函数（见 pet.ts 加载处）
// @returns 通过全部校验的 ClientConfig；animations/animationWeights 等段原样透传
//          （与 jsonc 同构），pets/eventsRefreshSec 为重建后的净化对象
// @throws Error（消息带 'dsh-pet: ' 前缀），校验清单：
//   pets[]              非空数组；id 非空且不重复；size>0；balanceEnabled 必须为布尔；
//                       position.corner 必须在 CORNERS 白名单内；marginX/Y 必须为有限数
//   animations          idle/turn/drag/clicks/categories 必须为数组；
//                       moves 结构完整（default 对象 + actions 数组）；
//                       events 为对象、每个值是非空动画名字符串数组（数组顺序即档位顺序）、
//                       events.balance 必备
//   animationWeights    idle/turn/move 必须为 ≥0 的有限数
//   eventsRefreshSec    每个值为正数秒（输出净化副本）；eventsRefreshSec.balance 必备
//   notificationsEnabled 必须为布尔（系统通知总开关）
export function assertClientConfig(raw: unknown): ClientConfig {
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: config 非对象');
  // raw 是 unknown 输入（jsonc 解析产物），按 Record 读取后逐字段手工校验，字段读写无法静态定型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = raw as Record<string, any>;

  // ---- pets ----
  const petsArr = cfg.pets;
  if (!Array.isArray(petsArr) || !petsArr.length) throw new Error('dsh-pet: 缺少 pets');
  // seen 在循环中累积：多只宠物靠 id 区分，重复 id 即配置错误
  const seen = new Set<string>();
  const pets: Pet[] = [];
  for (const p of petsArr) {
    const id = String(p?.id ?? '');
    if (!id || seen.has(id)) throw new Error('dsh-pet: pet id 非法或重复「' + id + '」');
    const size = Number(p?.size);
    // size 是渲染宽高的基准值，必须为有限正数
    if (!Number.isFinite(size) || size <= 0) throw new Error('dsh-pet: pet「' + id + '」大小非法');
    const balanceEnabled = p?.balanceEnabled;
    // 必须显式给布尔：true=启用余额功能（余额动画+余额气泡），false=该宠物完全禁用余额
    if (typeof balanceEnabled !== 'boolean')
      throw new Error('dsh-pet: pet「' + id + '」缺少 balanceEnabled（需为布尔值 true/false）');
    const corner = p?.position?.corner;
    if (typeof corner !== 'string' || !CORNER_SET.has(corner)) throw new Error('dsh-pet: pet「' + id + '」corner 非法');
    const marginX = Number(p?.position?.marginX);
    const marginY = Number(p?.position?.marginY);
    // 边距：距所在屏幕角落的像素偏移；缺字段/非数字会被 Number() 转成 NaN，故统一用有限数校验
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) throw new Error('dsh-pet: pet「' + id + '」边距非法');
    seen.add(id);
    // 逐字段重建对象：只透传已校验字段，jsonc 里多余/脏字段不会进入运行时
    pets.push({ id, size, balanceEnabled, position: { corner: corner as Corner, marginX, marginY } });
  }

  // ---- animations ----
  const a = cfg.animations;
  if (!a || typeof a !== 'object') throw new Error('dsh-pet: 缺少 animations');
  // 四类基础动画池只保证是数组（元素内容的合法性由运行时消费方负责），原引用透传
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    if (!Array.isArray(a[key])) throw new Error('dsh-pet: animations.' + key + ' 缺失');
  }
  // moves：default 提供未写字段的默认参数，actions 是带可选覆盖的移动动作列表
  if (
    !a.moves ||
    typeof a.moves !== 'object' ||
    typeof a.moves.default !== 'object' ||
    a.moves.default === null ||
    !Array.isArray(a.moves.actions)
  ) {
    throw new Error('dsh-pet: animations.moves 结构非法');
  }
  if (!Array.isArray(a.categories)) throw new Error('dsh-pet: animations.categories 缺失');

  // ---- animations.events（事件动画：事件名 → 非空 string 数组，数组顺序即档位顺序）----
  // 事件功能已内置：events 段与 balance 事件均为必需，缺失即配置不完整，显式报错
  const ev = a.events;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new Error('dsh-pet: 缺少 animations.events');
  for (const [eventName, pool] of Object.entries(ev)) {
    if (!Array.isArray(pool) || pool.length === 0) {
      throw new Error('dsh-pet: animations.events.' + eventName + ' 必须是非空动画名数组');
    }
    for (const name of pool) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('dsh-pet: animations.events.' + eventName + ' 含非法动画名');
      }
    }
  }
  // 余额事件动画池是内置功能的硬依赖：缺失或为空直接报错
  const balance = ev.balance;
  if (!Array.isArray(balance) || balance.length === 0) {
    throw new Error('dsh-pet: animations.events.balance 缺失或为空（余额事件必备）');
  }

  // ---- animationWeights ----
  const w = cfg.animationWeights;
  if (!w || typeof w !== 'object') throw new Error('dsh-pet: 缺少 animationWeights');
  for (const key of ['idle', 'turn', 'move']) {
    const v = Number(w[key]);
    if (!Number.isFinite(v) || v < 0) throw new Error('dsh-pet: animationWeights.' + key + ' 非法');
    // 原地回写数值：把字符串数字（jsonc 手写常见）归一化成 number，供 rollKind 直接运算
    w[key] = v;
  }

  // ---- eventsRefreshSec（事件刷新周期：事件名 → 正数秒数）----
  // 事件功能已内置：周期段与 balance 周期均为必需，缺失/非法即配置不完整，显式报错
  const ers = cfg.eventsRefreshSec;
  if (!ers || typeof ers !== 'object' || Array.isArray(ers)) throw new Error('dsh-pet: 缺少 eventsRefreshSec');
  // 产出净化后的新对象而不是直接改输入：默认配置对象可被重复使用/复用
  const cleaned: Record<string, number> = {};
  for (const [eventName, sec] of Object.entries(ers)) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error('dsh-pet: eventsRefreshSec.' + eventName + ' 非法（需为正数秒）');
    cleaned[eventName] = n;
  }
  // 余额事件刷新周期：驱动余额数据轮询与余额动画触发间隔，内置功能硬依赖
  const balanceSec = cleaned.balance;
  if (balanceSec === undefined) throw new Error('dsh-pet: eventsRefreshSec.balance 缺失（余额事件周期必备）');

  // ---- notificationsEnabled（系统通知总开关：必填布尔值）----
  const notificationsEnabled = cfg.notificationsEnabled;
  if (typeof notificationsEnabled !== 'boolean')
    throw new Error('dsh-pet: 缺少 notificationsEnabled（需为布尔值 true/false）');

  // animations 与 animationWeights 原引用透传（同构、无需深拷贝）；pets/eventsRefreshSec 为重建对象
  return { notificationsEnabled, pets, animations: a, animationWeights: w, eventsRefreshSec: cleaned };
}

/** 合并宠物：用户层（{ pets }，与 jsonc 同构）全量替换默认；无用户层回落默认 */
// @param defaults 默认宠物列表（来自包内 config.jsonc）
// @param user     用户覆盖层（来自 /dsh-pet-7340/config，即 main-config.json 的解析产物）
// @returns 用户层给出非空 pets 列表时原样采用（全量替换，不做逐只合并）；
//          否则回落 defaults。注意：用户层 pets 为空数组 [] 也回落默认——
//          空数组视为「未配置」而非「一只宠物都不要」，避免宠物意外消失。
export function resolvePets(defaults: Pet[], user: { pets?: Pet[] }): Pet[] {
  if (user && Array.isArray(user.pets)) return user.pets.length ? user.pets : defaults;
  return defaults;
}

/** 用户覆盖片段（与 jsonc 同构；高级用户直接编辑 main-config.json，缺省字段回落默认） */
// 五个顶层字段全部可选：给出哪个替换哪个（整体替换，不做深合并），
// 缺省的全部回落默认配置——与 applyUserOverrides 的合并语义一一对应。
export interface UserOverrides {
  pets?: Pet[];
  animations?: Animations;
  animationWeights?: Weights;
  eventsRefreshSec?: Record<string, number>;
  /** 系统通知总开关（可选）：用户层给出时优先于默认配置 */
  notificationsEnabled?: boolean;
}

/** 合并用户覆盖片段到完全体配置：pets / animations / animationWeights / eventsRefreshSec 有则整体替换，缺省回落默认 */
// @param base 默认完全体配置（assertClientConfig(config.jsonc) 的产物）
// @param user 用户覆盖片段（main-config.json 经 /dsh-pet-7340/config 读取，可能只含部分字段）
// @returns 新的 ClientConfig（不修改 base）：五个顶层段各自「有则整体替换，无则沿用默认」；
//          pets 额外经 resolvePets（空列表回落默认），notificationsEnabled 显式给出才覆盖。
// 注意：合并是顶层整体替换而非深合并——用户层给出 animations 时，其中的 moves/events
// 等子段必须完整；缺了会在 pet.ts 的二次 assertClientConfig 处显式报错（不静默运行残缺配置）。
// 调用方：pet.ts（运行时主配置）、notify.ts（只关心 notificationsEnabled 总开关）。
export function applyUserOverrides(base: ClientConfig, user: UserOverrides): ClientConfig {
  // 浅拷贝 base 起步：未覆盖的段保持默认引用；pets 先走 resolvePets（空列表回落默认）
  const next: ClientConfig = { ...base, pets: resolvePets(base.pets, user) };
  if (user.animations) next.animations = user.animations;
  if (user.animationWeights) next.animationWeights = user.animationWeights;
  if (user.eventsRefreshSec) next.eventsRefreshSec = user.eventsRefreshSec;
  // 系统通知总开关：用户层显式给出时优先，缺省回落默认配置
  if (user.notificationsEnabled !== undefined) next.notificationsEnabled = user.notificationsEnabled;
  return next;
}
