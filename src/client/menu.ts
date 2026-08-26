// ============================================================================
// 挂件菜单 + 点击音效系统（移植自插件 A dsh-whale-widget 的汉堡菜单）。
// ============================================================================
//
// 职责：
// 1. 悬停宠物 → 右上角三点按钮（React 渲染，样式由本模块注入）→ 点击弹出菜单面板
//    （plain DOM 挂 document.body，React 不接管，避免被重渲染销毁）。
//    菜单行：大小（scale 0.6–2.5 滑块 + 1–20 数字）、音效（小黄鸭/音效1）、
//    音量（0–1 滑块 + 百分比）、用量（小鲸鱼记账 / 实时·令牌）。
// 2. 设置持久化：GET/PUT /dsh-pet-7340/widget-settings（sound/vol/soundSet/usageMode/scale）。
// 3. 按压/松手音效：duck=Ya1/Ya2、fx1=D1/D2，含长按/短按时序控制（同插件 A）。
//
// DOM 结构（三块均只建一次、挂 document.body，React 不接管）：
//   <style data-plugin-css="dsh-pet/menu"> —— 本模块注入的唯一样式表（menuCss 拼接）
//   <div class="dsh-pet-menu">            —— 菜单面板：鸣谢按钮 + 大小/音效/音量/间隔/用量 5 行
//   <div class="dsh-pet-credits">         —— 鸣谢弹窗（超链接列表 + 页脚 + X 关闭）
//   <div class="dsh-pet-apibox">          —— API key 更新弹窗（密码输入框 + 清空/更新 + X）
//
// 与其它模块的关系：
//   - pet.ts（PetCard/PetMulti）：调用 ensureMenu/toggleMenu/petPressDown/loadWidgetSettings；
//     注册 onScaleChanged（即时缩放）、onSettingsLoaded（初始化 scale）、onUsageModeChanged
//     （切换用量模式时立即刷新余额）；汉堡按钮由 pet.ts 渲染，点击时以按钮的视口矩形
//     （getBoundingClientRect）调用 toggleMenu。
//   - host 侧（DSH 运行时插件后端）：GET/PUT /dsh-pet-7340/widget-settings（widget-settings.json
//     持久化）、GET /dsh-pet-7340/sound-sets（扫描 assets/sound 目录）、
//     POST /dsh-pet-7340/open-sound-dir、PUT/DELETE /dsh-pet-7340/api-key。
//   - bubble.ts/balance.ts：经 usageModeHandlers 间接联动（用量模式切换 → 余额气泡刷新）。
//
// 已知坑：
//   - 菜单/弹窗 z-index 必须 2147483647（int32 上限）：宠物舞台往往叠得很高，不够大时
//     点击会被宠物层/宿主页面拦截；且面板挂 body、汉堡按钮在宠物 DOM 树内，
//     两层之间必须靠 z-index + contains() 判定协作。
//   - 面板只挂一次（menuBox 单例、ensureMenu 幂等），重复挂载不会重复创建。
//   - 打开位置默认在按钮上方；宠物贴近屏幕顶部、上方空间不足时自动翻转到按钮下方
//     （positionMenu，用面板 offsetHeight 估算翻转空间）。
//   - 菜单「点击外部关闭」监听 document pointerdown：鸣谢/API 弹窗视为菜单流程内部
//     （点弹窗不关菜单）；两个弹窗各自另有独立的「外部点击关闭」监听。
//   - 音效 URL 带 ?set=<组名> 查询串区分缓存；组名来自 assets/sound 目录扫描，
//     命名规则 <组名>-1.mp3/<组名>-2.mp3（本插件映射为 press/release）。
//   - saveSettings 是 fire-and-forget（void fetch），失败静默，下次启动回落内存值/默认值。
// ============================================================================

/** 挂件设置（与 host 侧 widget-settings.json 同构） */
export interface WidgetSettings {
  /** 是否开启按压/松手音效（音量调为 0 时联动置 false，>0 联动置 true） */
  sound: boolean;
  /** 音量 0–1（保留 2 位小数），与 sound 开关联动 */
  vol: number;
  /** 音效组名（动态：assets/sound 目录扫描发现，命名 <组名>-1/-2.mp3） */
  soundSet: string;
  /** 用量模式：ledger=本地小鲸鱼记账（默认）/ token=API 实时（官方接口查询） */
  usageMode: 'ledger' | 'token';
  /** 宠物视觉缩放倍数（0.6–2.5；不影响配置里的 px 尺寸，只是显示缩放，同插件 A 语义） */
  scale: number;
  /** 动画链间隔（秒）：每个动画播完后、下一个动画开始前的停顿时长，0=无间隔（默认，当前行为） */
  intervalSec: number;
}

// 设置持久化接口（host 侧 widget-settings.json）；插件专属相对路径
const SETTINGS_URL = '/dsh-pet-7340/widget-settings';
// 按压/松手音效静态前缀；实际资源 press.mp3/release.mp3，用 ?set=<组名> 区分音效组缓存
const SOUND_BASE = '/dsh-pet-7340/sound';
// 宠物缩放下限/上限（同插件 A 语义）
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.5;
/** 动画链间隔上限（秒）：滑块最左 = 90s，最右 = 0s（当前行为） */
const MAX_INTERVAL_SEC = 90;

// 模块级内存设置（本模块单一数据源）：启动时取默认值，loadWidgetSettings 用持久化值覆盖；
// 之后每次 setXxx 都同步「内存 + PUT 持久化」，外部模块只读（getWidgetSettings）。
let settings: WidgetSettings = {
  sound: true,
  vol: 0.9,
  soundSet: 'duck',
  usageMode: 'ledger',
  scale: 1,
  intervalSec: 0,
};
/** 用量模式变化回调（PetMulti 注册：立即刷新余额） */
const usageModeHandlers = new Set<() => void>();
/** 大小缩放变化回调（PetCard 注册：即时生效） */
const scaleHandlers = new Set<(scale: number) => void>();
/** 设置初始化完成回调（PetCard 注册：拿持久化 scale 初始化） */
const settingsLoadedHandlers = new Set<(s: WidgetSettings) => void>();

// ---- 订阅/取值 API（pet.ts 等外部模块调用；均返回取消订阅函数，组件卸载时调用防泄漏） ----

/**
 * 订阅用量模式变化。
 * @param fn 切换 ledger/token 后立即回调（PetMulti 用它刷新余额气泡）
 * @returns 取消订阅函数（调用即从集合移除）
 */
export function onUsageModeChanged(fn: () => void): () => void {
  usageModeHandlers.add(fn);
  return () => usageModeHandlers.delete(fn);
}
/**
 * 订阅宠物缩放变化。
 * @param fn 缩放值（0.6–2.5）变化时回调（PetCard 即时应用视觉缩放）
 * @returns 取消订阅函数
 */
export function onScaleChanged(fn: (scale: number) => void): () => void {
  scaleHandlers.add(fn);
  return () => scaleHandlers.delete(fn);
}
/**
 * 订阅设置首次加载完成。
 * @param fn 持久化设置载入后回调一次（PetCard 拿持久化 scale 初始化，而非默认 1）
 * @returns 取消订阅函数
 */
export function onSettingsLoaded(fn: (s: WidgetSettings) => void): () => void {
  settingsLoadedHandlers.add(fn);
  return () => settingsLoadedHandlers.delete(fn);
}

/**
 * 读取当前内存设置（同步、非阻塞）。
 * @returns 当前 WidgetSettings 引用（只读约定：外部不要直接改这个对象，请走 setXxx 入口）
 */
export function getWidgetSettings(): WidgetSettings {
  return settings;
}

/**
 * 设置持久化入口：先合并更新内存设置，再整体 PUT 到 host 的 widget-settings.json。
 * 持久化流程：settings = {...settings, ...patch} → fire-and-forget PUT（不 await，避免卡 UI）
 *   → 失败静默（下次启动回落内存值/默认值，见 loadWidgetSettings）。
 * @param patch 只包含变化字段的部分设置（内部与完整 settings 合并后全量提交）
 * @副作用 修改模块级 settings；发起一次 PUT 请求
 */
function saveSettings(patch: Partial<WidgetSettings>): void {
  settings = { ...settings, ...patch };
  try {
    void fetch(SETTINGS_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  } catch {
    /* 持久化失败静默：下次加载回落内存值/默认值 */
  }
}

// ============================ 音效系统（移植自插件 A） ============================
// 模型：两个常驻 Audio（按压 pressAudio / 松手 releaseAudio）。
// 时序状态机（按压周期内 4 个旗标）：按下 → playPress（复位旗标 + 播按压音）；
// 松开 → 长按（按压音已播完 pressEnded）立即播松手音；短按 → 剩余时长已知时
// 在按压音结束前 100ms 排定时器重叠起播；时长未知 → pressAudio.onended 兜底。
// 音量跟随 settings.vol；音效组切换（setSoundSet）由 applySoundSet 整体重建 Audio。

// —— 按压/松手音效状态（按当前音效组构造，组切换时整体重建）——
let pressAudio: HTMLAudioElement | null = null; // 按压音（对应 <组名>-1.mp3）
let releaseAudio: HTMLAudioElement | null = null; // 松手音（对应 <组名>-2.mp3）
let pressing = false; // 宠物是否处于按压中（petPressDown/petPressUp 维护）
let pressEnded = false; // 按压音是否已自然播完（onended 置位）
let releasePlayed = false; // 本按压周期内松手音是否已播（防重入）
let releaseTimer: number | null = null; // 短按场景的松手音定时器

/**
 * 按当前音效组重建按压/松手 Audio 并预加载（preload=auto）。
 * ?set=<组名> 查询串让不同音效组命中不同缓存条目，切换后无需手动清缓存。
 * @副作用 替换 pressAudio/releaseAudio；音量设为当前 settings.vol；
 *          构造失败静默降级（无声音，不影响其它功能）
 */
function applySoundSet(): void {
  try {
    pressAudio = new Audio(SOUND_BASE + '/press.mp3?set=' + settings.soundSet);
    pressAudio.preload = 'auto';
    pressAudio.volume = settings.vol;
    releaseAudio = new Audio(SOUND_BASE + '/release.mp3?set=' + settings.soundSet);
    releaseAudio.preload = 'auto';
    releaseAudio.volume = settings.vol;
  } catch {
    /* 音效不可用：静默降级（无声音） */
  }
}

/**
 * 播放按压音效（宠物按下时）。
 * @副作用 取消未决的松手定时器、停掉并复位上一个松手音、清 pressEnded/releasePlayed 旗标、
 *          从头播放按压音；onended 兜底——按压音播完时若用户已松手且松手音未播，立即接播
 */
function playPress(): void {
  if (!pressAudio || !settings.sound) return;
  try {
    if (releaseTimer) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
    if (releaseAudio) {
      releaseAudio.pause();
      releaseAudio.currentTime = 0;
    }
    pressEnded = false;
    releasePlayed = false;
    pressAudio.onended = () => {
      pressEnded = true;
      // 时长未知时的兜底：松手后 Ya1 播完紧接着 Ya2
      if (!pressing && !releasePlayed) playRelease();
    };
    pressAudio.currentTime = 0;
    const p = pressAudio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* 自动播放被拦截等：静默 */
  }
}

/**
 * 播放松手音效（一次性）。
 * 前置条件：releaseAudio 已建、音效开关开启、本按压周期内尚未播过（releasePlayed 防重）。
 * @副作用 releasePlayed = true；从头播放松手音
 */
function playRelease(): void {
  if (releasePlayed || !releaseAudio || !settings.sound) return;
  releasePlayed = true;
  try {
    releaseAudio.currentTime = 0;
    const p = releaseAudio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* 静默 */
  }
}

/**
 * 宠物按压（pointerdown）：播放按压音效。
 * 入口说明：pet.ts 在 pointerdown 时调用。
 * @副作用 pressing = true；触发 playPress 时序状态机
 */
export function petPressDown(): void {
  pressing = true;
  playPress();
}

/**
 * 宠物松手（pointerup/cancel）：播放松手音效（短按重叠 100ms / 长按立即播，同插件 A）。
 * 入口说明：pet.ts 在 pointerup/pointercancel 时调用。
 * 时序：长按（按压音已播完）→ 立即播松手音；短按 → 剩余时长已知时在按压音结束前
 * 100ms 排定时器重叠起播；时长未知（元数据未加载）→ 依赖 playPress 里 onended 兜底。
 * @副作用 pressing = false；可能排 releaseTimer 或直接触发 playRelease
 */
export function petPressUp(): void {
  pressing = false;
  if (pressEnded) {
    // 长按（或 Ya1 已播完）：立即播 Ya2
    playRelease();
    return;
  }
  // 短按：Ya2 在 Ya1 末尾前 100ms 起播
  let durKnown = false;
  let remainMs = 0;
  try {
    const dur = pressAudio ? pressAudio.duration : 0;
    if (isFinite(dur) && dur > 0) {
      durKnown = true;
      remainMs = (dur - (pressAudio ? pressAudio.currentTime : 0)) * 1000;
    }
  } catch {
    /* 静默 */
  }
  if (durKnown) {
    releaseTimer = window.setTimeout(
      () => {
        releaseTimer = null;
        playRelease();
      },
      Math.max(0, remainMs - 100),
    );
  }
  // 时长未知 → pressAudio.onended 兜底
}

// ============================ 菜单 DOM（移植自插件 A 的汉堡菜单） ============================
// 结构总览（三块，均只建一次、挂在 document.body 上，React 不接管）：
//   1) <style data-plugin-css="dsh-pet/menu"> —— 本模块全部 CSS（menuCss 数组拼接）；
//   2) .dsh-pet-menu      菜单面板：鸣谢按钮 + 大小/音效/音量/间隔/用量 5 行；
//   3) .dsh-pet-credits   鸣谢弹窗；.dsh-pet-apibox API key 更新弹窗（居中模态层）。
// 显隐由「open 态类」驱动（opacity/transform 过渡），开关状态机见 menuOpen/creditsOpen/
// apiOpen 三个旗标与 toggleMenu/closeMenu/openXxx/closeXxx 函数。
// z-index 2147483647：必须压过宠物舞台与宿主页面，否则点击会被下层元素拦截（已知坑）。

const menuCss = [
  // 按钮悬于角色头部右上方：53%+2 按钮宽(52px≈11.3%) → 64.3%；26%−0.6 按钮高(15.6px≈6%) → 20%（默认 462×260 舞台）
  '.dsh-pet-menu-btn{position:absolute;left:64.3%;top:20%;transform:translate(-50%,-50%);width:26px;height:26px;border:none;border-radius:6px;background:rgba(32,49,112,.85);cursor:pointer;pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:0;z-index:5;opacity:0;transition:opacity .15s ease}',
  '.dsh-pet-root:hover .dsh-pet-menu-btn{opacity:1}',
  '.dsh-pet-menu-btn span{display:block;width:14px;height:2px;background:#fff;border-radius:1px}',
  '.dsh-pet-menu-btn:hover{background:#203170}',
  '.dsh-pet-menu{position:fixed;min-width:172px;background:rgba(255,255,255,.92);border:1px solid rgba(32,49,112,.35);border-radius:10px;padding:10px 12px;opacity:0;transform:scale(.92) translateY(-4px);transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:2147483647;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:light;font-family:inherit}',
  '.dsh-pet-menu.dsh-pet-menu-open{opacity:1;transform:scale(1) translateY(0);pointer-events:auto}',
  '.dsh-pet-menu-row{display:flex;align-items:center;gap:8px;margin:5px 0;color:#203170;font-size:12px;white-space:nowrap}',
  '.dsh-pet-menu-range{flex:1;min-width:0;accent-color:#203170}',
  '.dsh-pet-menu-number{width:46px;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:2px 4px;font-size:12px;color:#203170;background:#fff}',
  '.dsh-pet-menu-select{flex:1;min-width:0;border:1px solid rgba(32,49,112,.4);border-radius:6px;background:rgba(32,49,112,.08);color:#203170;font-size:12px;padding:3px 0;cursor:pointer}',
  // 打开音效目录按钮（窄、蓝底白字；按压变暗、松开恢复）
  '.dsh-pet-sounddir-btn{width:20px;height:22px;flex:none;margin-left:4px;border:none;border-radius:6px;background:rgba(32,49,112,.85);color:#fff;font-size:11px;line-height:22px;text-align:center;cursor:pointer;padding:0;transition:background .12s ease}',
  '.dsh-pet-sounddir-btn:hover{background:#203170}',
  '.dsh-pet-sounddir-btn:active{background:#141f47}',
  '.dsh-pet-menu-select:hover{background:rgba(32,49,112,.16)}',
  // 用量模式按钮（两个并排互斥）：未激活=略透明白底蓝字；激活=蓝底白字（同鸣谢按钮）
  '.dsh-pet-mode-btn{flex:1;min-width:0;border:1px solid rgba(32,49,112,.4);border-radius:6px;background:rgba(255,255,255,.55);color:#203170;font-size:12px;padding:3px 0;cursor:pointer;text-align:center;transition:background .15s ease,color .15s ease;font-family:inherit}',
  '.dsh-pet-mode-btn:hover{background:rgba(32,49,112,.12)}',
  '.dsh-pet-mode-btn.dsh-pet-mode-active{background:rgba(32,49,112,.85);color:#fff;border-color:rgba(32,49,112,.85)}',
  '.dsh-pet-menu-volpct{width:36px;text-align:right;color:#203170;font-size:12px}',
  // 鸣谢按钮：菜单首行整宽按钮，蓝底白字、文字居中，左缘与「大小」等行左对齐（同内边距）
  '.dsh-pet-credit-btn{display:block;width:100%;margin:2px 0 8px;padding:5px 0;border:none;border-radius:6px;background:rgba(32,49,112,.85);color:#fff;font-size:12px;cursor:pointer;text-align:center;font-family:inherit}',
  '.dsh-pet-credit-btn:hover{background:#203170}',
  // 鸣谢弹窗：样式与菜单面板一致（白底圆角描边阴影），居中弹出
  '.dsh-pet-credits{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(.95);min-width:280px;max-width:min(560px,86vw);background:rgba(255,255,255,.95);border:1px solid rgba(32,49,112,.35);border-radius:10px;padding:18px 22px 18px 18px;opacity:0;pointer-events:none;z-index:2147483647;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:light;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);color:#203170;font-size:12px;line-height:2;font-family:inherit}',
  '.dsh-pet-credits.dsh-pet-credits-open{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}',
  '.dsh-pet-credits-title{text-align:center;font-size:14px;font-weight:700;margin-bottom:4px}',
  '.dsh-pet-credits-row{text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-pet-credits-row a{color:#203170;text-decoration:underline;cursor:pointer}',
  '.dsh-pet-credits-row a:hover{color:#0e1c4a;text-decoration:none}',
  '.dsh-pet-credits-gap{height:2em}',
  '.dsh-pet-credits-footer{text-align:left;color:rgba(32,49,112,.72);font-size:11px}',
  '.dsh-pet-credits-close{position:absolute;top:6px;right:6px;width:24px;height:24px;border:none;border-radius:6px;background:rgba(32,49,112,.85);color:#fff;font-size:13px;line-height:24px;text-align:center;cursor:pointer;padding:0}',
  '.dsh-pet-credits-close:hover{background:#203170}',
  // API 更新弹窗（风格同鸣谢弹窗）
  '.dsh-pet-apibox{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(.95);min-width:300px;max-width:min(520px,86vw);background:rgba(255,255,255,.95);border:1px solid rgba(32,49,112,.35);border-radius:10px;padding:16px 18px;opacity:0;pointer-events:none;z-index:2147483647;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:light;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);color:#203170;font-size:12px;line-height:2;font-family:inherit}',
  '.dsh-pet-apibox.dsh-pet-apibox-open{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}',
  '.dsh-pet-api-label{text-align:left;font-size:12px;font-weight:700;margin-bottom:2px}',
  '.dsh-pet-api-input{display:block;width:100%;box-sizing:border-box;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:4px 8px;font-size:12px;color:#203170;background:#fff;outline:none;font-family:inherit}',
  '.dsh-pet-api-input:focus{border-color:#203170}',
  '.dsh-pet-api-gap{height:1em}',
  '.dsh-pet-api-btns{display:flex;gap:8px}',
  '.dsh-pet-api-btn{flex:1;min-width:0;border:1px solid rgba(32,49,112,.4);border-radius:6px;background:rgba(255,255,255,.55);color:#203170;font-size:12px;padding:4px 0;cursor:pointer;text-align:center;transition:background .15s ease,color .15s ease;font-family:inherit}',
  '.dsh-pet-api-btn:hover{background:rgba(32,49,112,.12)}',
  '.dsh-pet-api-btn.dsh-pet-api-active{background:rgba(32,49,112,.85);color:#fff;border-color:rgba(32,49,112,.85)}',
].join('\n');

// —— DOM 单例引用与开关状态旗标（ensureMenu 只构建一次；旗标是各层状态机的唯一真相源）——
let menuCssInjected = false; // 样式是否已注入 <head>（幂等开关）
let menuBox: HTMLDivElement | null = null; // 菜单面板本体
let menuOpen = false; // 菜单开/关（toggleMenu 翻转，closeMenu 复位）
let scaleInput: HTMLInputElement | null = null; // 行1 大小：range 滑块（0.6–2.5）
let scaleNumber: HTMLInputElement | null = null; // 行1 大小：number 输入（1–20，线性映射）
let soundSelect: HTMLSelectElement | null = null; // 行2 音效：下拉（refreshSoundSets 动态重建选项）
let volInput: HTMLInputElement | null = null; // 行3 音量：range 滑块（0–1）
let volPct: HTMLSpanElement | null = null; // 行3 音量：右侧百分比文本
let intervalInput: HTMLInputElement | null = null; // 行3.5 间隔：range 滑块（0–90，实际间隔=90−值）
let intervalLabel: HTMLSpanElement | null = null; // 行3.5 间隔：右侧「N秒」文本
let creditsBox: HTMLDivElement | null = null; // 鸣谢弹窗
let creditsOpen = false; // 鸣谢弹窗开/关
let modeLedgerBtn: HTMLButtonElement | null = null; // 行4 用量：「本地记账(推荐)」按钮
let modeTokenBtn: HTMLButtonElement | null = null; // 行4 用量：「API 实时」按钮
let apiBox: HTMLDivElement | null = null; // API key 更新弹窗
let apiOpen = false; // API 弹窗开/关
let apiInput: HTMLInputElement | null = null; // API 弹窗：密码输入框（已存 key 不回显，留空=不变）
let apiClearBtn: HTMLButtonElement | null = null; // API 弹窗：「清空API」按钮
let apiUpdateBtn: HTMLButtonElement | null = null; // API 弹窗：「更新」按钮（成功变「已更新」）

/**
 * 真实缩放值 → 菜单数字框显示值（1–20 整数，线性映射；与 setScale 中数字框回读方向相反）。
 * @param s 真实缩放（0.6–2.5）
 * @returns 1..20 的显示值（0.6→1，2.5→20）
 */
function scaleToDisplay(s: number): number {
  return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / 19)) + 1;
}

/**
 * 构建菜单面板（仅由 ensureMenu 调用一次）。
 * DOM 结构（自上而下）：
 *   [鸣谢按钮]（整宽蓝底白字）
 *   行1 大小：  label + range(0.6–2.5, step .1) + number(1–20)
 *   行2 音效：  label + select（选项动态，初始以当前设置组兜底）+ 「···」打开音效目录
 *   行3 音量：  label + range(0–1, step .05) + 百分比文本
 *   行3.5 间隔：label + range(0–90) + 「N秒」文本（滑块值 = 90 − 实际间隔）
 *   行4 用量：  label + [本地记账] [API 实时] 两个互斥按钮（构建完立即同步高亮）
 * @returns 未插入文档的菜单面板元素（ensureMenu 负责挂 body）
 * @副作用 填充本模块全部控件单例引用并绑定各控件事件（scaleInput/volInput/…）
 */
function buildMenu(): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'dsh-pet-menu';
  const label = (text: string): HTMLSpanElement => {
    const s = document.createElement('span');
    s.textContent = text;
    return s;
  };
  const row = (): HTMLDivElement => {
    const r = document.createElement('div');
    r.className = 'dsh-pet-menu-row';
    return r;
  };
  const opt = (value: string, text: string): HTMLOptionElement => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  };

  // 首行：鸣谢按钮（整宽、蓝底白字、文字居中；左缘与各行对齐）
  const creditBtn = document.createElement('button');
  creditBtn.type = 'button';
  creditBtn.className = 'dsh-pet-credit-btn';
  creditBtn.textContent = '鸣谢';
  creditBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCredits();
  });

  // 行1 大小：range 0.6–2.5 + number 1–20（线性映射，同插件 A）
  scaleInput = document.createElement('input');
  scaleInput.type = 'range';
  scaleInput.min = String(MIN_SCALE);
  scaleInput.max = String(MAX_SCALE);
  scaleInput.step = '0.1';
  scaleInput.className = 'dsh-pet-menu-range';
  scaleInput.value = String(settings.scale);
  scaleInput.addEventListener('input', () => setScale(Number(scaleInput?.value)));
  scaleNumber = document.createElement('input');
  scaleNumber.type = 'number';
  scaleNumber.min = '1';
  scaleNumber.max = '20';
  scaleNumber.step = '1';
  scaleNumber.className = 'dsh-pet-menu-number';
  scaleNumber.value = String(scaleToDisplay(settings.scale));
  scaleNumber.addEventListener('change', () => {
    const v = Math.round(Number(scaleNumber?.value));
    const s = MIN_SCALE + Math.max(0, Math.min(20, v) - 1) * ((MAX_SCALE - MIN_SCALE) / 19);
    setScale(s);
  });
  const row1 = row();
  row1.appendChild(label('大小'));
  row1.appendChild(scaleInput);
  row1.appendChild(scaleNumber);

  // 行2 音效（选项动态：每次打开菜单时向 host 拉取目录扫描结果并重建；初始以当前设置兜底）
  soundSelect = document.createElement('select');
  soundSelect.className = 'dsh-pet-menu-select';
  soundSelect.appendChild(opt(settings.soundSet, settings.soundSet));
  soundSelect.value = settings.soundSet;
  soundSelect.addEventListener('change', () => {
    const v = soundSelect?.value || settings.soundSet;
    setSoundSet(v);
  });
  // 「···」按钮：打开音效目录（host 在系统文件管理器打开插件自身的 assets/sound）
  const soundDirBtn = document.createElement('button');
  soundDirBtn.type = 'button';
  soundDirBtn.className = 'dsh-pet-sounddir-btn';
  soundDirBtn.textContent = '···';
  soundDirBtn.title = '打开音效文件夹';
  soundDirBtn.addEventListener('click', () => {
    void fetch('/dsh-pet-7340/open-sound-dir', { method: 'POST' }).catch(() => {});
  });
  const row2 = row();
  row2.appendChild(label('音效'));
  row2.appendChild(soundSelect);
  row2.appendChild(soundDirBtn);

  // 行3 音量
  volInput = document.createElement('input');
  volInput.type = 'range';
  volInput.min = '0';
  volInput.max = '1';
  volInput.step = '0.05';
  volInput.className = 'dsh-pet-menu-range';
  volInput.value = String(settings.vol);
  volPct = document.createElement('span');
  volPct.className = 'dsh-pet-menu-volpct';
  volPct.textContent = Math.round(settings.vol * 100) + '%';
  volInput.addEventListener('input', () => setVol(Number(volInput?.value)));
  const row3 = row();
  row3.appendChild(label('音量'));
  row3.appendChild(volInput);
  row3.appendChild(volPct);

  // 行3.5 间隔：动画链停顿（滑块最左=90s，最右=0s 当前行为；线性、单位秒）
  intervalInput = document.createElement('input');
  intervalInput.type = 'range';
  intervalInput.min = '0';
  intervalInput.max = String(MAX_INTERVAL_SEC);
  intervalInput.step = '1';
  intervalInput.className = 'dsh-pet-menu-range';
  // 滑块值 = 90 − 实际间隔（左端 90s ↔ 右端 0s）
  intervalInput.value = String(MAX_INTERVAL_SEC - settings.intervalSec);
  intervalLabel = document.createElement('span');
  intervalLabel.className = 'dsh-pet-menu-volpct';
  intervalLabel.textContent = settings.intervalSec + '秒';
  intervalInput.addEventListener('input', () => setIntervalSec(Number(intervalInput?.value)));
  const rowInterval = row();
  rowInterval.appendChild(label('间隔'));
  rowInterval.appendChild(intervalInput);
  rowInterval.appendChild(intervalLabel);

  // 行4 用量：两个并排互斥按钮（本地记账 / API 实时）
  modeLedgerBtn = document.createElement('button');
  modeLedgerBtn.type = 'button';
  modeLedgerBtn.className = 'dsh-pet-mode-btn';
  modeLedgerBtn.textContent = '本地记账(推荐)';
  modeLedgerBtn.title = '小鲸鱼记账：余额差值自动累计今日用量';
  modeLedgerBtn.addEventListener('click', () => {
    setUsageMode('ledger');
    closeApiPopup(); // 切走 API 模式：收起 API 更新弹窗
  });

  modeTokenBtn = document.createElement('button');
  modeTokenBtn.type = 'button';
  modeTokenBtn.className = 'dsh-pet-mode-btn';
  modeTokenBtn.textContent = 'API 实时';
  modeTokenBtn.title = '余额用官方接口查询（已保存API 优先）；优先取平台实时用量并换算，无平台令牌时自动回落本地模式';
  modeTokenBtn.addEventListener('click', () => {
    setUsageMode('token');
    openApiPopup(); // 点击 API 实时：弹出 API 更新窗口
  });

  const row4 = row();
  row4.appendChild(label('用量'));
  row4.appendChild(modeLedgerBtn);
  row4.appendChild(modeTokenBtn);
  updateModeButtons();

  box.appendChild(creditBtn);
  box.appendChild(row1);
  box.appendChild(row2);
  box.appendChild(row3);
  box.appendChild(rowInterval);
  box.appendChild(row4);
  return box;
}

/**
 * 鸣谢弹窗（样式与菜单面板一致）：标题居中，四行内容左对齐，右上角 X 关闭；
 * 点击弹窗外任意位置（左右键均可）关闭。
 * DOM 结构：[标题] + 若干 .dsh-pet-credits-row（prefix 文本 + <a target=_blank> 超链接）
 *          + 空行 gap + 页脚「Created w. DeepSeek & DeepSeek harness」+ 右上角 X 按钮。
 * @returns 未插入文档的弹窗元素（ensureMenu 负责挂 body）
 * @副作用 赋值 creditsBox 单例引用；X 按钮绑定 closeCredits
 */
function buildCredits(): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'dsh-pet-credits';

  const title = document.createElement('div');
  title.className = 'dsh-pet-credits-title';
  title.textContent = '特别鸣谢';

  const lines: Array<{ prefix: string; text: string; href?: string }> = [
    { prefix: '形象设计：', text: '@ZipZipPipe （bilibili）', href: 'https://space.bilibili.com/4168597' },
    {
      prefix: '改造基底：',
      text: '@宇宙之外的浩瀚宇（bilibili）',
      href: 'https://space.bilibili.com/1364176066',
    },
    { prefix: '菜单、记账模式、音效设定、定价换算：', text: '@月匠（bilibili）', href: 'https://space.bilibili.com/345797244' },
    { prefix: 'Safari支持，整合功能，添加支持，完善逻辑，细节调整等：', text: 'nanonocturne-altago（github）' },
  ];

  box.appendChild(title);
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'dsh-pet-credits-row';
    row.appendChild(document.createTextNode(line.prefix));
    if (line.href) {
      const a = document.createElement('a');
      a.href = line.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = line.text;
      row.appendChild(a);
    } else {
      row.appendChild(document.createTextNode(line.text));
    }
    box.appendChild(row);
  }

  // 末尾：空行 + 「Created w. DeepSeek & DeepSeek harness」
  const gap = document.createElement('div');
  gap.className = 'dsh-pet-credits-gap';
  box.appendChild(gap);
  const footer = document.createElement('div');
  footer.className = 'dsh-pet-credits-footer';
  footer.textContent = 'Created w. DeepSeek & DeepSeek harness';
  box.appendChild(footer);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dsh-pet-credits-close';
  close.textContent = 'X';
  close.title = '关闭';
  close.addEventListener('click', closeCredits);
  box.appendChild(close);

  return box;
}

/**
 * 打开鸣谢弹窗：加 .dsh-pet-credits-open 触发 CSS 过渡，置 creditsOpen 旗标。
 * 注意：此时菜单保持打开——鸣谢属于菜单流程，见 ensureMenu 的外部点击判定。
 */
function openCredits(): void {
  if (!creditsBox) return;
  creditsBox.classList.add('dsh-pet-credits-open');
  creditsOpen = true;
}

/**
 * 关闭鸣谢弹窗（X 按钮 / 点击弹窗外触发）：去 open 类、清 creditsOpen 旗标。
 * 仅复位本弹窗状态，不影响菜单面板。
 */
function closeCredits(): void {
  creditsOpen = false;
  creditsBox?.classList.remove('dsh-pet-credits-open');
}

/**
 * API 更新弹窗（风格同鸣谢弹窗）：输入/清空/更新插件本地保存的 DeepSeek API key。
 * 布局：1=标题行「DeepSeek API：」2=输入框 3/4=空行 5=清空API + 更新按钮。
 * 交互细节：
 *   - 输入框 type=password（已保存的 key 永不回显；留空提交 = 保持原 API 不变）；
 *   - 清空按钮：pointerdown 即发 DELETE（按住期间蓝底白字，松开/离开/取消恢复）；
 *   - 更新按钮：输入非空才 PUT {key}，成功后变「已更新」蓝底；输入变化复位按钮状态。
 * @returns 未插入文档的弹窗元素（ensureMenu 负责挂 body）
 * @副作用 赋值 apiBox/apiInput/apiClearBtn/apiUpdateBtn 单例引用并绑定事件
 */
function buildApiPopup(): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'dsh-pet-apibox';

  const label = document.createElement('div');
  label.className = 'dsh-pet-api-label';
  label.textContent = 'DeepSeek API：';
  box.appendChild(label);

  apiInput = document.createElement('input');
  apiInput.type = 'password';
  apiInput.className = 'dsh-pet-api-input';
  apiInput.placeholder = '输入你的API到这里更新余额计算，留空保持原API';
  apiInput.addEventListener('input', resetApiUpdateBtn);
  box.appendChild(apiInput);

  // 行3/4：两个空行（按钮落在第五行）
  const gap1 = document.createElement('div');
  gap1.className = 'dsh-pet-api-gap';
  box.appendChild(gap1);
  const gap2 = document.createElement('div');
  gap2.className = 'dsh-pet-api-gap';
  box.appendChild(gap2);

  // 行5：清空API + 更新
  const btns = document.createElement('div');
  btns.className = 'dsh-pet-api-btns';

  apiClearBtn = document.createElement('button');
  apiClearBtn.type = 'button';
  apiClearBtn.className = 'dsh-pet-api-btn';
  apiClearBtn.textContent = '清空API';
  apiClearBtn.title = '清除你保存的API';
  apiClearBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    apiClearBtn?.classList.add('dsh-pet-api-active'); // 按下：蓝底白字
    void fetch('/dsh-pet-7340/api-key', { method: 'DELETE' }).catch(() => undefined); // 同时清除本地保存的 API
  });
  apiClearBtn.addEventListener('pointerup', () => apiClearBtn?.classList.remove('dsh-pet-api-active')); // 松开：恢复
  apiClearBtn.addEventListener('pointerleave', () => apiClearBtn?.classList.remove('dsh-pet-api-active'));
  apiClearBtn.addEventListener('pointercancel', () => apiClearBtn?.classList.remove('dsh-pet-api-active'));
  btns.appendChild(apiClearBtn);

  apiUpdateBtn = document.createElement('button');
  apiUpdateBtn.type = 'button';
  apiUpdateBtn.className = 'dsh-pet-api-btn';
  apiUpdateBtn.textContent = '更新';
  apiUpdateBtn.addEventListener('click', () => {
    const v = apiInput ? apiInput.value.trim() : '';
    if (!v) return; // 无输入：不做任何操作
    void fetch('/dsh-pet-7340/api-key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: v }),
    })
      .then((r) => {
        if (!r.ok) throw new Error('api-key PUT failed');
        if (apiUpdateBtn) {
          apiUpdateBtn.classList.add('dsh-pet-api-active'); // 更新完成：蓝底白字
          apiUpdateBtn.textContent = '已更新';
        }
      })
      .catch(() => undefined);
  });
  btns.appendChild(apiUpdateBtn);

  box.appendChild(btns);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dsh-pet-credits-close';
  close.textContent = 'X';
  close.title = '关闭';
  close.addEventListener('click', closeApiPopup);
  box.appendChild(close);

  return box;
}

/**
 * 「更新」按钮复位（输入变化/关闭弹窗时调用）：去高亮类、文案回「更新」。
 * 防止用户修改输入后仍显示上一次的「已更新」误导状态。
 */
function resetApiUpdateBtn(): void {
  if (apiUpdateBtn) {
    apiUpdateBtn.classList.remove('dsh-pet-api-active');
    apiUpdateBtn.textContent = '更新';
  }
}

/** 打开 API 弹窗：加 .dsh-pet-apibox-open 触发 CSS 过渡，置 apiOpen 旗标 */
function openApiPopup(): void {
  if (!apiBox) return;
  apiBox.classList.add('dsh-pet-apibox-open');
  apiOpen = true;
}

/**
 * 关闭 API 弹窗（X / 点击弹窗外 / 切回本地记账模式时调用）：
 * 去 open 类、清 apiOpen 旗标，并复位输入框与「更新」按钮状态，
 * 保证下次打开是全新状态（不回显上次输入）。
 */
function closeApiPopup(): void {
  apiOpen = false;
  apiBox?.classList.remove('dsh-pet-apibox-open');
  // 复位：清空输入与「已更新」状态，下次打开是全新状态
  if (apiInput) apiInput.value = '';
  resetApiUpdateBtn();
}

/**
 * 设置宠物缩放（行1 滑块与数字框共用入口，双向同步）。
 * @param v 目标缩放值（任意数字，内部夹紧到 0.6–2.5 并保留 1 位小数）
 * @副作用 更新内存设置、回填滑块+数字框、PUT 持久化、广播 scaleHandlers（即时生效）
 */
function setScale(v: number): void {
  const next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v))) * 10) / 10;
  settings = { ...settings, scale: next };
  if (scaleInput) scaleInput.value = String(next);
  if (scaleNumber) scaleNumber.value = String(scaleToDisplay(next));
  saveSettings({ scale: next });
  for (const fn of scaleHandlers) fn(next);
}

/**
 * 设置音量（0–1，保留 2 位小数；音量 >0 时联动开启音效开关）。
 * @param v 目标音量（任意数字，内部夹紧到 0–1）
 * @副作用 更新内存设置（含 sound 联动）、回填滑块+百分比文本、
 *          实时更新两个 Audio 的 volume、PUT 持久化
 */
function setVol(v: number): void {
  const next = Math.round(Math.min(1, Math.max(0, Number(v))) * 100) / 100;
  settings = { ...settings, vol: next, sound: next > 0 };
  if (volInput) volInput.value = String(next);
  if (volPct) volPct.textContent = Math.round(next * 100) + '%';
  try {
    if (pressAudio) pressAudio.volume = next;
    if (releaseAudio) releaseAudio.volume = next;
  } catch {
    /* 静默 */
  }
  saveSettings({ vol: next, sound: next > 0 });
}

/**
 * 切换音效组（行2 下拉选择时触发）。
 * @param v 音效组 id（host 目录扫描结果之一）
 * @副作用 更新内存设置、回填下拉、重建按压/松手 Audio（applySoundSet）、PUT 持久化
 */
function setSoundSet(v: string): void {
  settings = { ...settings, soundSet: v };
  if (soundSelect) soundSelect.value = v;
  applySoundSet();
  saveSettings({ soundSet: v });
}

/**
 * 间隔滑块：滑块值 0..90（左端 90s ↔ 右端 0s），实际间隔 = 90 − 滑块值（线性、秒）。
 * @param sliderValue 滑块原始值（0–90，内部夹紧取整）
 * @副作用 更新内存设置、回填滑块+「N秒」文本、PUT 持久化（pet.ts 动画链读取该值）
 */
function setIntervalSec(sliderValue: number): void {
  const clamped = Math.round(Math.min(MAX_INTERVAL_SEC, Math.max(0, Number(sliderValue))));
  const delay = MAX_INTERVAL_SEC - clamped;
  settings = { ...settings, intervalSec: delay };
  if (intervalInput) intervalInput.value = String(clamped);
  if (intervalLabel) intervalLabel.textContent = delay + '秒';
  saveSettings({ intervalSec: delay });
}

/**
 * 用量模式按钮高亮同步（互斥：激活=蓝底白字，未激活=透明白底蓝字）。
 * 纯展示函数：按 settings.usageMode 切换两个按钮的 .dsh-pet-mode-active 类，
 * 不触发持久化/回调（切换动作在 setUsageMode）。
 */
function updateModeButtons(): void {
  if (modeLedgerBtn) modeLedgerBtn.classList.toggle('dsh-pet-mode-active', settings.usageMode === 'ledger');
  if (modeTokenBtn) modeTokenBtn.classList.toggle('dsh-pet-mode-active', settings.usageMode === 'token');
}

/**
 * 切换用量模式（行4 双按钮共用入口）。
 * @param v ledger=本地记账（调用方在切走 API 模式时负责收起 API 弹窗）/ token=API 实时
 * @副作用 更新内存设置、刷新按钮高亮、PUT 持久化、广播 usageModeHandlers（余额刷新）
 */
function setUsageMode(v: 'ledger' | 'token'): void {
  settings = { ...settings, usageMode: v };
  updateModeButtons();
  saveSettings({ usageMode: v });
  for (const fn of usageModeHandlers) fn();
}

/**
 * 面板定位（同插件 A）：打开于按钮上方，右侧锚右下 / 左侧锚左下；上方空间不足时翻转到按钮下方。
 * 细分规则：宠物在屏幕左半边 → 面板左缘对齐按钮左缘（锚左下）；右半边 → 右缘对齐按钮右缘
 * （锚右下）；上方空间不足（宠物贴近屏幕顶部）→ 翻转到按钮下方（锚左上/右上）。
 * @param anchor 汉堡按钮的视口矩形（pet.ts 由 getBoundingClientRect() 提供）
 * @副作用 直接写 menuBox 的 left/right/top/bottom 与 transformOrigin；
 *          面板高度用 offsetHeight（未渲染时兜底 200px）估算翻转空间
 */
function positionMenu(anchor: { left: number; top: number; right: number; bottom: number }): void {
  if (!menuBox) return;
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const onLeft = (anchor.left + anchor.right) / 2 < vpW / 2;
  if (onLeft) {
    menuBox.style.left = anchor.left + 'px';
    menuBox.style.right = 'auto';
  } else {
    menuBox.style.right = vpW - anchor.right + 'px';
    menuBox.style.left = 'auto';
  }
  const menuHeight = menuBox.offsetHeight || 200;
  const spaceAbove = anchor.top;
  if (spaceAbove >= menuHeight + 8) {
    // 上方空间足够：面板底部对齐按钮顶部
    menuBox.style.bottom = vpH - anchor.top + 'px';
    menuBox.style.top = 'auto';
    menuBox.style.transformOrigin = onLeft ? 'bottom left' : 'bottom right';
  } else {
    // 上方空间不足（宠物靠近屏幕顶部）：翻转到按钮下方
    menuBox.style.top = anchor.bottom + 'px';
    menuBox.style.bottom = 'auto';
    menuBox.style.transformOrigin = onLeft ? 'top left' : 'top right';
  }
}

/**
 * 初始化菜单（幂等）：注入样式、构建面板、加载持久化设置。
 * 每个 PetCard 挂载时调用一次即可。
 * 实现说明：内部用单例判空保证只建一次，重复调用零副作用；
 * 设置数据加载在 loadWidgetSettings（boot 时由 pet.ts 调用），本函数只负责 DOM/样式/监听。
 * 同时注册三个 document 级 pointerdown 监听：
 *   - 菜单外部点击 → closeMenu（点击鸣谢/API 弹窗内部或汉堡按钮不关菜单：弹窗属于
 *     菜单流程，由各自的外部点击监听管理关闭）；
 *   - 鸣谢弹窗外部点击 → closeCredits（pointerdown 覆盖左/右键）；
 *   - API 弹窗外部点击 → closeApiPopup（pointerdown 覆盖左/右键）。
 */
export function ensureMenu(): void {
  if (!menuCssInjected && typeof document !== 'undefined') {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/menu';
    tag.textContent = menuCss;
    document.head.appendChild(tag);
    menuCssInjected = true;
  }
  if (menuBox === null && typeof document !== 'undefined') {
    menuBox = buildMenu();
    document.body.appendChild(menuBox);
    // 点击面板外部关闭（鸣谢/API 弹窗属于菜单流程：点击弹窗内部不关菜单）
    document.addEventListener('pointerdown', (e) => {
      if (!menuOpen) return;
      const t = e.target as Node | null;
      if (
        t &&
        (menuBox?.contains(t) ||
          (t instanceof Element && t.closest('.dsh-pet-menu-btn')) ||
          (creditsBox && creditsBox.contains(t)) ||
          (apiBox && apiBox.contains(t)))
      ) {
        return;
      }
      closeMenu();
    });
  }
  if (creditsBox === null && typeof document !== 'undefined') {
    creditsBox = buildCredits();
    document.body.appendChild(creditsBox);
    // 点击鸣谢弹窗外任意位置（pointerdown 覆盖左/右键）→ 关闭弹窗
    document.addEventListener('pointerdown', (e) => {
      if (!creditsOpen) return;
      const t = e.target as Node | null;
      if (t && creditsBox && creditsBox.contains(t)) return; // 弹窗内部：保持打开（X 按钮自己处理关闭）
      closeCredits();
    });
  }
  if (apiBox === null && typeof document !== 'undefined') {
    apiBox = buildApiPopup();
    document.body.appendChild(apiBox);
    // 点击 API 弹窗外任意位置（pointerdown 覆盖左/右键）→ 关闭弹窗
    document.addEventListener('pointerdown', (e) => {
      if (!apiOpen) return;
      const t = e.target as Node | null;
      if (t && apiBox && apiBox.contains(t)) return; // 弹窗内部：保持打开（X 按钮自己处理关闭）
      closeApiPopup();
    });
  }
}

/**
 * 刷新音效下拉选项：向 host 拉取声音目录的实时扫描结果并重建选项（保留当前选中项）。
 * 触发时机：每次打开菜单（toggleMenu）。GET /dsh-pet-7340/sound-sets（no-store 防缓存）。
 * @副作用 重建 soundSelect 的 <option> 列表；当前选中组仍在列表中则保持选中，
 *          否则回落第一项并同步内存设置 + 重建 Audio（applySoundSet）。
 *          拉取失败/结果为空时静默保留现有选项（初始选项 = 当前设置组兜底）。
 */
export async function refreshSoundSets(): Promise<void> {
  if (!soundSelect) return;
  let sets: Array<{ id: string; label: string }> = [];
  try {
    const r = await fetch('/dsh-pet-7340/sound-sets', { cache: 'no-store' });
    if (r.ok) {
      const raw: unknown = await r.json().catch(() => null);
      const arr =
        raw && typeof raw === 'object' && Array.isArray((raw as { sets?: unknown }).sets)
          ? (raw as { sets: Array<{ id: string; label: string }> }).sets
          : [];
      sets = arr.filter((s) => s && typeof s.id === 'string' && typeof s.label === 'string');
    }
  } catch {
    /* 拉取失败：保留现有选项 */
  }
  if (!sets.length) return;
  const prev = settings.soundSet;
  soundSelect.replaceChildren();
  for (const s of sets) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.label;
    soundSelect.appendChild(o);
  }
  // 保持当前选中（若当前设置仍在列表中），否则回落第一项并同步设置
  if (sets.some((s) => s.id === prev)) {
    soundSelect.value = prev;
  } else {
    soundSelect.value = sets[0].id;
    settings = { ...settings, soundSet: sets[0].id };
    applySoundSet();
  }
}

/**
 * 开/关菜单（锚点 = 触发按钮的视口矩形）。
 * 状态机：menuOpen 翻转——打开：先 positionMenu 定位，再加 open 类触发过渡，
 * 并异步刷新音效下拉；关闭：closeMenu（去 open 类 + 清旗标）。
 */
export function toggleMenu(anchor: { left: number; top: number; right: number; bottom: number }): void {
  if (!menuBox) return;
  menuOpen = !menuOpen;
  if (menuOpen) {
    positionMenu(anchor);
    menuBox.classList.add('dsh-pet-menu-open');
    void refreshSoundSets(); // 每次打开菜单：实时扫描音效目录重建列表
  } else {
    closeMenu();
  }
}

/**
 * 关闭菜单（外部点击 / 再次点击汉堡按钮 / 切模式时调用）：去 open 类、清 menuOpen 旗标。
 * 纯 UI 复位：不动子状态（鸣谢/API 弹窗是否打开由各自路径管理）。
 */
export function closeMenu(): void {
  menuOpen = false;
  menuBox?.classList.remove('dsh-pet-menu-open');
}

/**
 * 加载持久化设置（boot 时由 PetMulti 调用；完成后通知已注册的回调）。
 * 流程：GET /dsh-pet-7340/widget-settings（no-store 防缓存）→ 逐字段校验并合并
 *   （类型/范围不合法的字段保留默认值）→ 回填菜单控件 → 更新用量按钮高亮 →
 *   重建音效 Audio（applySoundSet）→ 广播 settingsLoadedHandlers。
 * @returns 加载后的完整设置（同时缓存在模块级 settings）
 * @副作用 覆盖内存设置、刷新菜单控件、触发 settingsLoadedHandlers
 */
export async function loadWidgetSettings(): Promise<WidgetSettings> {
  try {
    const r = await fetch(SETTINGS_URL, { cache: 'no-store' });
    if (r.ok) {
      const raw: Record<string, unknown> = await r.json().catch(() => ({}));
      const next: WidgetSettings = { ...settings };
      if (typeof raw.sound === 'boolean') next.sound = raw.sound;
      const vol = Number(raw.vol);
      if (Number.isFinite(vol) && vol >= 0 && vol <= 1) next.vol = Math.round(vol * 100) / 100;
      if (typeof raw.soundSet === 'string') next.soundSet = raw.soundSet;
      if (raw.usageMode === 'token' || raw.usageMode === 'ledger') next.usageMode = raw.usageMode;
      const scale = Number(raw.scale);
      if (Number.isFinite(scale) && scale >= MIN_SCALE && scale <= MAX_SCALE) next.scale = Math.round(scale * 10) / 10;
      const intervalSec = Number(raw.intervalSec);
      if (Number.isFinite(intervalSec) && intervalSec >= 0 && intervalSec <= MAX_INTERVAL_SEC)
        next.intervalSec = Math.round(intervalSec);
      settings = next;
    }
  } catch {
    /* 设置拉取失败：回落默认值 */
  }
  // 菜单控件与加载后的设置对齐（面板可能已先按默认值构建）
  if (scaleInput) {
    scaleInput.value = String(settings.scale);
    if (scaleNumber) scaleNumber.value = String(scaleToDisplay(settings.scale));
  }
  if (soundSelect) soundSelect.value = settings.soundSet;
  if (volInput) {
    volInput.value = String(settings.vol);
    if (volPct) volPct.textContent = Math.round(settings.vol * 100) + '%';
  }
  if (intervalInput) {
    intervalInput.value = String(MAX_INTERVAL_SEC - settings.intervalSec);
    if (intervalLabel) intervalLabel.textContent = settings.intervalSec + '秒';
  }
  updateModeButtons();
  applySoundSet();
  for (const fn of settingsLoadedHandlers) fn(settings);
  return settings;
}
