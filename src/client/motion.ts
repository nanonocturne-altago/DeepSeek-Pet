// ============================================================================
// 移动几何规划：纯计算模块（无 DOM / ref / 副作用），可独立单测。
// ----------------------------------------------------------------------------
// 职责：给定宠物中心点、视口尺寸、方向与距离范围，规划一次水平漫游的
//       起点/终点，返回归一化比例坐标。不做任何像素位移 —— 位移由调用方
//       （pet.ts startMoveDrive 的 rAF 驱动）在播放期逐帧插值完成。
// 关键流程：随机取距离（randomBetween）→ 按方向求目标中心点 →
//           目标越出贴边边界即判失败（返回 null，由调用方回落其它动作）→
//           成功则换算为视口比例坐标返回。
// 与其他模块的关系：
//   - pet.ts tryMove：唯一调用方，传入视口/贴边边界并把计划写入 pendingMoveRef
//   - pet.ts startMoveDrive：消费 MovePlan，把播放进度映射到 start→target 位移
//   - pickers.randomBetween：距离随机数来源
// 已知坑：
//   - 坐标口径分两种：入参 cx/cy/minDist/maxDist/leftBound/rightBound 是 px，
//     返回的 startRatio/targetRatio/totalRatio 是视口比例（0~1）—— 混用必错位
//   - minDist/maxDist 必须已是「按宠物缩放后」的 px（pet.ts tryMove 已按 PET_REF_WIDTH 换算）
// ============================================================================
import { randomBetween } from './pickers';

/** 一次移动的几何参数（比例坐标） */
export interface MovePlan {
  /** 起点 x 比例（= cx / W，规划时锁定） */
  startRatio: number;
  /** 起点 y 比例（= cy / H；移动只走水平线，y 全程不变） */
  startYRatio: number;
  /** 终点 x 比例（= target / W） */
  targetRatio: number;
  /** 水平移动总量（比例，|target - cx| / W；rAF 线性插值的总跨度） */
  totalRatio: number;
}

/**
 * 计算一次移动的起点/终点比例坐标；目标越出视口边缘（含边距）时返回 null。
 * 纯函数：无副作用、不抛错 —— 失败语义（null）由调用方按「无法移动」回落处理。
 * @param o.cx / o.cy 宠物中心点当前 px 坐标（customPos 或 DOM 实测，见 pet.ts currentCenterX/Y）
 * @param o.W / o.H 视口宽高（px）
 * @param o.dir 移动方向：1=右 / -1=左（由朝向与 turn 动画状态共同决定）
 * @param o.minDist / o.maxDist 随机移动距离范围（px；调用方已按宠物缩放换算）
 * @param o.leftBound 中心点允许的左边界（px，按当前动画可见包围盒计算，允许舞台部分伸出屏幕）
 * @param o.rightBound 中心点允许的右边界（px）
 * @returns 目标可行 → MovePlan（比例坐标）；目标越界 → null
 */
export const planMove = (o: {
  cx: number;
  cy: number;
  W: number;
  H: number;
  dir: 1 | -1;
  minDist: number;
  maxDist: number;
  /** 中心点允许的左边界（px，按当前动画可见包围盒计算，允许舞台部分伸出屏幕） */
  leftBound: number;
  /** 中心点允许的右边界（px） */
  rightBound: number;
}): MovePlan | null => {
  // 随机抽取本次移动距离（区间内均匀随机；距离与动画本身无关，仅决定落点远近）
  const distance = randomBetween(o.minDist, o.maxDist);
  // 按方向求目标中心点 x（水平线移动，y 不变）
  const target = o.cx + o.dir * distance;
  // 贴边校验：目标点必须落入允许区间，否则放弃本次移动（调用方回落为其它动作）
  if (target < o.leftBound || target > o.rightBound) return null;
  // px → 视口比例：rAF 驱动期用比例插值，窗口缩放时比例不变、px 位置由渲染期重新换算
  return {
    startRatio: o.cx / o.W,
    startYRatio: o.cy / o.H,
    targetRatio: target / o.W,
    totalRatio: Math.abs(target - o.cx) / o.W,
  };
};
