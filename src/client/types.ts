// ============================================================================
// 配置类型模型：与 config.jsonc 结构完全同构（唯一事实来源 = config.jsonc 的
// animations / animationWeights / pets）。运行时（ANIM / 设置页 / PetCard）
// 直接使用这套结构，不额外造转换后的类型。
// ----------------------------------------------------------------------------
// 职责：为配置与运行时共享的结构提供类型；任何配置字段调整都应先改 config.jsonc
//       再同步这里（config.ts 的 assertClientConfig 按本模型校验，缺字段即显式报错）。
// 与其他模块的关系：
//   - config.ts（assertClientConfig / applyUserOverrides）按本模型校验与合并
//   - pet.ts（PetCard/PetMulti）与 menu.ts（设置页）直接消费 Pet / Animations / ClientConfig
//   - balance.ts（balanceEventIndex）依赖 events.balance 数组顺序 = 档位顺序
// 已知坑：
//   - Events 数组顺序即「档位」顺序（下标 = 档位）：增删动画会平移档位，
//     需与 balance.ts 的 balanceEventIndex 档位映射联动，否则播错动画
//   - balanceEnabled / notificationsEnabled 缺失即「配置错误」（不是默认 false）
//   - MoveSpec.params 未写字段取 moves.default（合并发生在 pet.ts tryMove 的 Object.assign）
// ============================================================================

/** 支持的角落（root 层 data-corner 取值，CSS 按它决定贴靠方向与边距） */
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** 移动动作：一个动作名 + 可选覆盖参数（未写字段取 moves.default） */
export interface MoveSpec {
  /** 动画名（thumb 目录文件名，不含扩展名） */
  name: string;
  /** 参数覆盖：与 moves.default 合并（Object.assign），只覆盖写出的键 */
  params?: Record<string, number>;
}

/** 移动池：default 为全局兜底参数，actions 为候选动作列表 */
export interface MovesConfig {
  /** 兜底参数（minDist/maxDist/leadSec/tailSec 等）；具体动作缺省时回落到这里 */
  default: Record<string, number>;
  /** 候选移动动作：tryMove 随机挑一个发起漫游 */
  actions: MoveSpec[];
}

/** 随机动作分类（带文字、镜像会颠倒，facing=right 时跳过） */
export interface Category {
  /** 分类 id（日志 / 调试用） */
  id: string;
  /** 权重：pickCategoryAction 按权重在分类间选择 */
  weight: number;
  /** 镜像禁选：动作含文字，水平镜像会颠倒文字，facing=right 时跳过该分类 */
  noMirror?: boolean;
  /** 分类内的动作名列表 */
  actions: string[];
}

/** 事件动画：事件名 → 动画名数组（数组顺序 = 档位顺序；不进随机链，只由代码显式触发） */
export type Events = Record<string, string[]>;

/** 动画权重（animationWeights 段）：动画链 roll 时按它决定 idle/turn/move 的命中比例 */
export interface Weights {
  idle: number;
  turn: number;
  move: number;
}

/** config.jsonc 的 animations 段 */
export interface Animations {
  /** 待机循环（权重 idle；日常呼吸/待机动作） */
  idle: string[];
  /** 转身动画（权重 turn；播完由 handleEnded 翻转朝向后再推进） */
  turn: string[];
  /** 拖拽中播放的动画 */
  drag: string[];
  /** 点击播放的动画 */
  clicks: string[];
  /** 漫游移动池（权重 move；tryMove 从 actions 随机挑） */
  moves: MovesConfig;
  /** 随机分类动作（权重外的额外类别，如特殊/文字动作） */
  categories: Category[];
  /** 事件动画（balance 等）：数组下标 = 档位，由代码显式触发，不进随机链 */
  events: Events;
}

/** 一只宠物（与 jsonc pets[i] 同形，position 嵌套） */
export interface Pet {
  /** 宠物唯一 id（React key / 日志标识） */
  id: string;
  /** 基准尺寸（px，宽度；舞台高 = 宽 × 9/16） */
  size: number;
  /** 是否启用余额功能：true=触发余额动画+显示余额气泡；false=该宠物完全禁用余额。缺失即配置错误 */
  balanceEnabled: boolean;
  /** 初始位置（角落 + 边距；用户拖拽后由 customPos 接管，此字段仅作初始值） */
  position: { corner: Corner; marginX: number; marginY: number };
}

/** config.jsonc 全集——运行时直接使用（ANIM 即本类型） */
export interface ClientConfig {
  /** 系统通知总开关：true=对话完成/生成失败/输出截断/权限申请/用户选择在窗口失焦时弹出系统通知；缺失即配置错误 */
  notificationsEnabled: boolean;
  /** 宠物列表：config.jsonc 为默认层，用户覆盖层经 applyUserOverrides 合并后同形 */
  pets: Pet[];
  /** 动画素材清单与参数（同构 jsonc animations 段） */
  animations: Animations;
  /** 动画链类别权重（roll 用） */
  animationWeights: Weights;
  /** 事件刷新周期（秒）：事件名 → 间隔；balance = 余额数据刷新 + 动画触发间隔 */
  eventsRefreshSec: Record<string, number>;
}

/** 桌面独立版（Electron）经由 preload 暴露到渲染页的桥接口；
 *  DSH 插件版中不存在该对象，菜单「行为」行应自动隐藏 */
declare global {
  interface Window {
    petDesktop?: {
      /** 光标是否在宠物/弹层上：true=关闭点击穿透（可交互） */
      setInteractive(interactive: boolean): void;
      /** 切换程序坞（Dock）图标的显示/隐藏 */
      setDockVisible(show: boolean): void;
      /** 切换「前台显示」：强制置顶于所有应用（含全屏）之上 */
      setForeground(on: boolean): void;
      /** 读取当前开关状态（菜单打开时同步按钮高亮） */
      getState(): Promise<{ dock: boolean; foreground: boolean }>;
    };
  }
}
