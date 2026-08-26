// 纯选择逻辑：不依赖 React / DOM，可独立单测。
//
// 职责：宠物动画状态机的「随机选择」工具集——等概率抽取（pick）、区间随机整数
//   （randomBetween）、加权掷骰定动画类别（rollKind）、分类池加权选择
//   （pickWeightedCategory）、分类动作选择（pickCategoryAction，含防重复与镜像过滤）。
// 全部为纯函数：唯一非确定性来源是 Math.random()，无副作用、无模块级可变状态。
//
// 与其它模块的关系：
//   - pet.ts 是唯一消费方（动画主循环 pickNext）：rollKind 掷骰定类别、
//     pickCategoryAction 选分类动作、pick 从基础池抽动画名；
//   - types.ts 提供 Category / Weights 类型（与 config.jsonc 同构）；
//   - 不依赖 config.ts / notify.ts / app.ts，也无 DOM/React 依赖。
// 调用时机：每次动画播完接续下一个、随机动作触发时由 pet.ts 调用
//   （动画链高频路径，保持纯函数与小分配，避免卡顿）。
import type { Category, Weights } from './types';

/** 从字符串池里等概率随机抽一个；exclude 排除某个名字（避免连续重复） */
// @param pool    候选池（调用方保证非空——空池时结果为 undefined，由调用方兜底）
// @param exclude 要排除的元素（通常传「当前正在播放的动画名」，实现防连续重复）
// @returns 随机选中的元素（均匀分布）
export const pick = <T>(pool: T[], exclude?: T): T => {
  const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
  // 排除后池空（单元素池 + 排除自己）：退回原池抽——宁可重复，也不要返回 undefined
  const src = entries.length ? entries : pool;
  return src[Math.floor(Math.random() * src.length)];
};

/** 生成 [min, max) 区间内的随机整数 */
// 边界：min === max 时恒返回 min；不做参数校验，调用方保证 min < max。
export const randomBetween = (min: number, max: number): number => Math.floor(min + Math.random() * (max - min));

/**
 * 按权重在分类池中选一个分类；noMirror 分类在镜像(facing=right)时被排除，
 * 剩余权重自动归一化。分类池为空时返回 null。
 */
// @param categories 分类池（来自 config.jsonc 的 animations.categories）
// @param facing     当前朝向（'left' | 'right'）：镜像素材在 facing=right 时跳过 noMirror 分类
// @returns 选中的分类；没有任何「含动作的分类」时返回 null（调用方回退 idle 池）
// 权重语义：weight 越大的分类被抽中概率越高（线性按比例）；归一化通过
// 「总权重 × random − 逐分类权重」的递减法实现，无需预计算概率表。
// 边界：全部候选都被 noMirror 过滤掉时退回全量池（保证有动画可播）；
//       权重全为 0 时 totalW 兜底为 1，轮询后恒落最后一个分类（配置异常但不崩溃）。
export const pickWeightedCategory = (categories: Category[], facing: string): Category | null => {
  const cats = categories.filter((c) => c.actions.length > 0);
  if (!cats.length) return null;
  const filtered = cats.filter((c) => !(c.noMirror && facing === 'right'));
  const eligible = filtered.length ? filtered : cats;
  const totalW = eligible.reduce((s, c) => s + c.weight, 0) || 1;
  let t = Math.random() * totalW;
  for (const c of eligible) {
    t -= c.weight;
    if (t <= 0) return c;
  }
  return eligible[eligible.length - 1];
};

/** 掷骰结果类别 */
// idle 待机 / turn 转身 / move 移动 / action 分类动作
export type RollKind = 'idle' | 'turn' | 'move' | 'action';

/**
 * 按权重掷骰：roll ∈ [0,1) → 下一个动画类别（纯函数，可单测）。
 * topEnd = (idle+turn+move)/100：三档权重占比之和，剩余概率归入 'action'。
 */
// @param roll [0,1) 的随机数（调用方传 Math.random()；区间外取值行为未定义，勿依赖）
// @param w    动画权重（idle/turn/move 各 0-100，来自 config.jsonc 的 animationWeights）
// @returns 命中档位：'idle' | 'turn' | 'move' | 'action'
// 概率语义：权重即百分比——roll 落在 [0, idle/100) 归 idle，依次类推；
// 三档合计不足 100 的剩余概率归 'action'（分类动作）。三档合计 ≥100 时
// roll 恒小于 topEnd，'action' 不可达（配置权重时需留意）。
export const rollKind = (roll: number, w: Weights): RollKind => {
  const topEnd = (w.idle + w.turn + w.move) / 100;
  if (roll < w.idle / 100) return 'idle';
  if (roll < (w.idle + w.turn) / 100) return 'turn';
  if (roll < topEnd) return 'move';
  return 'action';
};

/** 从分类池选一个动作；无可用分类时回退 idle 池（返回 {id, name}，纯函数）。
 * facing 用于 noMirror 镜像过滤；current 用于避免连续重复（pick 的 exclude）。 */
// @param categories 分类池（同 pickWeightedCategory）
// @param idlePool   待机动画池（回退用，来自 animations.idle）
// @param facing     当前朝向（镜像过滤，同 pickWeightedCategory）
// @param current    当前动画名（作为 exclude，防止同一动画连续播放两次）
// @returns { id, name }：正常为「分类 id + 分类内随机动作名」；
//          分类池空时 id 为哨兵 'FALLBACK'，name 从 idle 池抽（同样排除 current）。
//          注意 id 是分类 id 而非动画 id——pet.ts 把它用作动画类别标签（kind）。
export const pickCategoryAction = (
  categories: Category[],
  idlePool: string[],
  facing: string,
  current: string,
): { id: string; name: string } => {
  const cat = pickWeightedCategory(categories, facing);
  if (!cat) return { id: 'FALLBACK', name: pick(idlePool, current) };
  return { id: cat.id, name: pick(cat.actions, current) };
};
