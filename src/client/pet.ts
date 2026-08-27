// ============================================================================
// 宠物页面（client 半侧核心 UI）：单个宠物实例（PetCard）+ 多开容器（PetMulti）。
// ============================================================================
// 职责：
//   - PetMulti：多开容器。加载 config.jsonc（合并用户覆盖层）→ 渲染 N 个 PetCard；
//     统一管理余额轮询（周期 / 手动触发）并把余额状态共享给所有宠物。
//   - PetCard：单只宠物。负责动画链（idle/turn/move/clicks/drag/事件）、双缓冲视频
//     切换、点击 vs 拖拽、漫游移动（rAF 驱动）、贴边边界、余额气泡、汉堡菜单按钮。
// 关键流程：
//   1) 容器拉取 /dsh-pet-7340/config.jsonc + 用户覆盖层 → assertClientConfig 校验 → petBridge.sync
//   2) PetCard 动画链：handleEnded（前台视频播完）→ 按权重 roll 选下一类 → setAnim →
//      switchTo 双缓冲切前台；intervalSec > 0 时经 chainAdvance 定时器插入停顿（交互触发跳过停顿）
//   3) 余额事件：容器成功拉取递增 balanceTick → PetCard 按档位（balanceEventIndex）播事件动画 + 弹气泡
//   4) 拖拽/点击：pointer 事件 + DRAG_THRESHOLD 阈值区分；拖拽落点写回 customPos（比例坐标）
// 工厂形态与 settings.ts 一致：client 半侧不能顶层 import react，
// react 能力由 DSH 运行时注入（rt），组件在工厂内制造。
// 动作配置在本模块持有：PetMulti 加载后赋值，PetCard 只读（单一事实来源 = config.jsonc）。
// 已知坑：
//   - DSH 宿主注入的 jsx 工厂（rt.h）不接受 null props：h('div', null) 会运行时报错，
//     无自定义 style 时必须传 {}（见 rootStyle 回落分支）；children 数组里的 null 是允许的
//   - Safari 不支持 VP9-alpha webm（透明通道渲染为黑底），需走 .mov（HEVC-alpha），
//     由 playbackExt() 在运行时按 UA 判定
//   - 双缓冲切换时，被降级为背景的旧视频若继续播完，其残留 onended 会经 handleEnded
//     掐断当前前台动画（历史上表现为随机急速跳转/雪崩）：必须在切换时清 handler + 停播（拆雷，见 switchTo）
//   - customPos 一旦存在（用户拖拽过），角落 CSS 定位即被内联 left/top 覆盖；容器改配置
//     只影响未拖拽过的宠物；resize 时通过浅拷贝 state 触发重渲染并重新贴边钳制
// ============================================================================
import { pick, rollKind, pickCategoryAction } from './pickers';
import { planMove } from './motion';
import { assertClientConfig, EMPTY_CONF, applyUserOverrides, stripJsonc, type UserOverrides } from './config';
import { balanceEventIndex, balancePercent, fetchBalanceState, type BalanceState } from './balance';
import { makeBalanceBubble } from './bubble';
import {
  ensureMenu,
  getWidgetSettings,
  loadWidgetSettings,
  onScaleChanged,
  onSettingsLoaded,
  onUsageModeChanged,
  petPressDown,
  petPressUp,
  toggleMenu,
} from './menu';
import { openApiPopup, setFolderOpenedListener } from './menu';
import {
  CANVAS_H,
  EDGE_M_B,
  EDGE_M_L,
  EDGE_M_R,
  EDGE_M_T,
  EDGE_PAD,
  FEET_Y,
  HIT_BOX,
  DRAG_THRESHOLD,
  PET_REF_WIDTH,
} from './constants';
import { petBridge } from './settings';
import type { ClientConfig, Corner, Pet } from './types';
import type * as ReactNS from 'react';
import type { Dispatch, ReactNode, SetStateAction, useEffect, useRef } from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 运行时配置（PetMulti 加载后赋值；PetCard 只读） */
let config: ClientConfig = EMPTY_CONF;

/** 播放动画扩展名：发布期注入，不做运行时判断。
 *  源码里是占位符 __PET_EXT__；publish 的 prepack 链用 scripts/inject-ext.js
 *  在 bundle 之后把构建产物替换为 .webm / .mov，本地开发同样用它切换。 */
const THUMB_EXT: string = '__PET_EXT__';

/** Safari 不支持 VP9-alpha webm（透明通道渲染为黑底），只支持 HEVC-with-Alpha mov。
 *  本地双格式素材（assets/webm + assets/mov）并存时，Safari 运行时改用 .mov；
 *  其余浏览器沿用发布期注入的扩展名。
 *  兜底：独立版（Electron，esbuild 直接打包源码、无注入步骤）里占位符原样保留，
 *  此时自动回落 .webm——Chromium 在 macOS/Windows 均支持 VP9-alpha。 */
function playbackExt(): string {
  if (typeof navigator !== 'undefined') {
    const ua = String(navigator.userAgent || '');
    const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Edg|OPR|FxiOS/i.test(ua);
    if (isSafari) return '.mov';
  }
  return THUMB_EXT === '__PET_EXT__' ? '.webm' : THUMB_EXT;
}

/** 余额气泡展示时长（ms）：定时自动消失，与动画生命周期解耦 */
const BUBBLE_DURATION_MS = 10_000;
/** 单击响应延迟（ms）：等待可能的双击第二击（系统双击间隔通常 ≤500ms），超时则按单击播 clicks 动画 */
const SINGLE_CLICK_DELAY_MS = 550;

/** 内联 CSS —— 注入一次（官方插件标准做法）。
 *  层级模型（由外到内）：
 *   - .dsh-pet-root：固定定位锚点；角落由 data-corner + CSS 变量 --dsh-pet-mx/my 控制，
 *     被拖拽后改为内联 left/top（rootStyle），不再受角落规则约束
 *   - .dsh-pet-stage：舞台（16:9 区域，宽 = --dsh-pet-size），整体 pointer-events:none
 *   - .dsh-pet-video：双缓冲视频（A/B 轮换），前台加 .is-front 淡入（transition .18s）
 *   - .dsh-pet-hit：命中层（唯一的 pointer-events:auto 区域），承载拖拽/点击 + 抓取光标 */
/** GIF 总时长（ms）：扫描 Graphic Control Extension 的帧延迟并累加（单位 1/100 秒，0 视为 100ms） */
function gifDuration(bytes: Uint8Array): number {
  let total = 0;
  let i = 13; // 跳过 6 字节头 + 7 字节逻辑屏幕描述符
  const read = (o: number) => bytes[o] ?? 0;
  while (i < bytes.length) {
    const b = read(i);
    if (b === 0x21) {
      // 扩展块：21 <label> <子块序列…> 00
      if (read(i + 1) === 0xf9) {
        // Graphic Control Extension：21 F9 04 <packed> <delay_lo> <delay_hi> <trans> 00
        const delay = read(i + 4) | (read(i + 5) << 8);
        total += (delay === 0 ? 10 : delay) * 10;
      }
      let j = i + 2;
      while (j < bytes.length) {
        const size = read(j);
        j += 1;
        if (size === 0) break;
        j += size;
      }
      i = j + 1;
    } else if (b === 0x3b) break; // 文件结束符
    else if (b === 0x2c) {
      // 图像描述符：2c + 9 字节 + 局部色表(可选) + LZW 最小码长(1) + 数据子块…
      const packed = read(i + 9);
      let j = i + 10;
      if ((packed & 0x80) !== 0) j += 3 * (1 << ((packed & 7) + 1));
      j += 1;
      while (j < bytes.length) {
        const size = read(j);
        j += 1;
        if (size === 0) break;
        j += size;
      }
      i = j + 1;
    } else i += 1;
  }
  return total;
}

/** APNG/PNG 总时长（ms）：累加 fcTL 帧延迟；无 acTL（静态 PNG）返回 3000 兜底 */
function apngDuration(bytes: Uint8Array): number {
  if (bytes.length < 8 || bytes[0] !== 0x89) return 3000;
  let total = 0;
  let animated = false;
  let i = 8;
  const u32 = (o: number) =>
    ((bytes[o] ?? 0) << 24) | ((bytes[o + 1] ?? 0) << 16) | ((bytes[o + 2] ?? 0) << 8) | (bytes[o + 3] ?? 0);
  while (i + 8 <= bytes.length) {
    const len = u32(i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (type === 'acTL') animated = true;
    else if (type === 'fcTL') {
      // fcTL 数据：seq(4)+w(4)+h(4)+x(4)+y(4)=20 字节 → delay_num(2) delay_den(2)
      const num = (bytes[i + 8 + 20] ?? 0) | ((bytes[i + 8 + 21] ?? 0) << 8);
      const den = (bytes[i + 8 + 22] ?? 0) | ((bytes[i + 8 + 23] ?? 0) << 8);
      total += den === 0 ? 100 : (num / den) * 1000;
    }
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return animated ? total : 3000;
}

const css = [
  '.dsh-pet-root{position:fixed;z-index:40;pointer-events:none;user-select:none}',
  '.dsh-pet-root[data-corner="bottom-right"]{right:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="bottom-left"]{left:var(--dsh-pet-mx,24px);bottom:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-right"]{right:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-root[data-corner="top-left"]{left:var(--dsh-pet-mx,24px);top:var(--dsh-pet-my,0)}',
  '.dsh-pet-stage{position:relative;width:var(--dsh-pet-size,462px);height:calc(var(--dsh-pet-size,462px)*9/16);pointer-events:none}',
  '.dsh-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}',
  '.dsh-pet-video.is-front{opacity:1}',
  '.dsh-pet-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .18s ease;transform-origin:center}',
  '.dsh-pet-img.is-front{opacity:1}',
  '.dsh-pet-hit{position:absolute;pointer-events:auto;cursor:url("/dsh-pet-7340/pic/cursor-grab.png") 16 16, grab;z-index:1}',
  '.dsh-pet-hit.dragging{cursor:url("/dsh-pet-7340/pic/cursor-grabbing.png") 16 16, grabbing}',
  '@media (prefers-reduced-motion: reduce){.dsh-pet-video{transition:none}}',
].join('\n');
const cssTag = 'dsh-pet/style.css';
/**
 * 注入内联样式表（幂等）：按 style[data-plugin-css] 判重，已注入则跳过；
 * 只在有 document 的环境执行（构建/SSR 期无 DOM 不注入），全局共享注入一次。
 */
function injectCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssTag + '"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = cssTag;
    tag.textContent = css;
    document.head.appendChild(tag);
  }
}

/**
 * 制造宠物页面组件（工厂，与 makePetConfigSection 同理：react 由运行时注入）。
 * 工厂内定义 PetCard / PetMulti，并在返回组件前 injectCss() 注入一次全局样式。
 * @param rt 运行时注入的 react 能力（h=jsx / useState / useEffect / useRef）
 * @returns PetMulti 多开容器组件（内部渲染多个 PetCard）
 * 已知坑：rt.h 是 DSH 宿主提供的 jsx 工厂，props 参数不接受 null ——
 *         所有 h(...) 调用的第二参数必须传对象（无属性时传 {}），否则运行时报错。
 */
export function makePetUI(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  useEffect: typeof useEffect;
  useRef: typeof useRef;
}): () => ReactNode {
  const { h, useState, useEffect, useRef } = rt;
  injectCss();

  /** 余额气泡（哑组件：数据与显隐由 PetCard 传入） */
  const BalanceBubble = makeBalanceBubble({ h });

  /**
   * 单个宠物实例（配置由容器 PetMulti 传入）。
   * @param cfg 该宠物的配置（pets[i] 合并结果）；容器/设置页更新后通过 effect 即时跟随
   * @param balance 容器共享的余额状态（未启用余额的宠物不使用；数据为 null 时气泡显示「加载中…」）
   * @param balanceTick 容器余额拉取成功次数：递增即触发一次余额事件动画 + 气泡（见余额 effect）
   * @param onManualRefresh 点击宠物时手动刷新余额的回调（由容器注入，与周期轮询同一路径）
   */
  function PetCard({
    cfg,
    balance,
    balanceTick,
    onManualRefresh,
  }: {
    cfg: Pet;
    balance: BalanceState | null;
    balanceTick: number;
    onManualRefresh?: () => void;
  }) {
    // ---- 尺寸（由配置传入；容器/设置页更新后即时跟随）----
    const [size, setSize] = useState(cfg.size);
    // 视觉缩放（移植自插件 A 的菜单大小滑块：0.6–2.5，不影响配置 px 尺寸）
    const [scale, setScaleState] = useState(1);
    const eff = size * scale;
    const halfW = eff / 2;
    const halfH = (eff * 9) / 16 / 2;

    // ---- React 状态 ----
    // 当前动画名（状态驱动：anim/once/seq 任一变化 → effect 调用 switchTo 切视频）
    const [anim, setAnim] = useState(config.animations.idle[0] ?? '');

    // DIY 随机池：外部动画文件夹（anime / motion）中 idle/turn/drag 的实际文件清单。
    // 选中该大类后按清单文件数纯随机（1 个文件=100%，4 个=各 25%）；未加载时回落配置名单。
    const [animeDir, setAnimeDir] = useState<{ idle: string[]; turn: string[]; drag: string[] }>({
      idle: [],
      turn: [],
      drag: [],
    });
    const animeDirRef = useRef(animeDir);
    useEffect(() => {
      animeDirRef.current = animeDir;
    }, [animeDir]);
    // 挂载时立即扫描一次，之后事件驱动刷新：
    // - 服务器 fs.watch 监听动画文件夹，文件增删 → SSE 推送 → 立即重扫（无时限、无盲区，
    //   用户从任意方式管理文件夹都生效；500ms 防抖合并连发事件）
    // - 每小时兜底扫描 1 次（防网络盘等 fs.watch 不可靠的场景）
    // - 点击「自定动作 / ···」后立即扫一次（打开文件夹后的即时反馈）
    useEffect(() => {
      let alive = true;
      let timer: number | null = null;
      let debounce: number | null = null;
      let es: EventSource | null = null;
      let lastCounts: Record<string, number> | null = null; // 上次各文件夹文件数（null=尚未扫描）

      /** 拉取一次动画文件夹清单；仅在数量有变化时应用（首次视为变化） */
      const refresh = async (): Promise<void> => {
        try {
          const r = await fetch('/dsh-pet-7340/anime-files');
          if (!r.ok) return;
          const data = (await r.json()) as Record<string, string[]>;
          if (!alive) return;
          const counts: Record<string, number> = {};
          for (const k of Object.keys(data)) counts[k] = Array.isArray(data[k]) ? data[k].length : 0;
          const changed = lastCounts === null || JSON.stringify(counts) !== JSON.stringify(lastCounts);
          lastCounts = counts;
          if (changed) {
            setAnimeDir((prev) => ({
              idle: Array.isArray(data['待机']) && data['待机'].length ? data['待机'] : prev.idle,
              turn: Array.isArray(data['转身']) && data['转身'].length ? data['转身'] : prev.turn,
              drag: Array.isArray(data['拖曳']) && data['拖曳'].length ? data['拖曳'] : prev.drag,
            }));
          }
        } catch {
          /* 服务未就绪等瞬时故障：保持现有清单（下一次事件/兜底扫描重试） */
        }
      };

      /** SSE 变化推送 → 300ms 防抖后重扫（与服务器 500ms 防抖叠加，多事件合并为一次） */
      const onAnimeEvent = () => {
        if (debounce !== null) window.clearTimeout(debounce);
        debounce = window.setTimeout(() => {
          debounce = null;
          void refresh();
        }, 300);
      };

      void refresh(); // 启动时强制扫描 1 次
      try {
        es = new EventSource('/dsh-pet-7340/anime-events');
        es.onmessage = onAnimeEvent;
      } catch {
        /* 不支持 SSE 的环境：每小时兜底扫描仍可用 */
      }
      timer = window.setTimeout(function hourly() {
        void refresh(); // 每小时兜底（fs.watch 失效场景如网络盘）
        if (alive) timer = window.setTimeout(hourly, 3_600_000);
      }, 3_600_000);
      setFolderOpenedListener(() => void refresh()); // 打开文件夹 → 立即扫一次

      return () => {
        alive = false;
        setFolderOpenedListener(null);
        if (timer !== null) window.clearTimeout(timer);
        if (debounce !== null) window.clearTimeout(debounce);
        if (es) es.close();
      };
    }, []);
    // 是否「单次播放」：true = 播完触发 handleEnded 接续下一段；false = 循环播放（如 idle 呼吸）
    const [once, setOnce] = useState(true);
    // 朝向：left/right。影响镜像（scaleX(-1)）与 turn/move 的方向选择
    const [facing, setFacing] = useState('left' as 'left' | 'right');
    // 拖拽中标记：true 时舞台禁用脚底对齐位移（transform:none），跟手移动
    const [dragging, setDragging] = useState(false);
    // 用户拖拽后的自定义位置（视口比例坐标）；一旦存在即覆盖角落 CSS 定位
    const [customPos, setCustomPos] = useState<null | { rx: number; ry: number }>(null);
    // 初始角落与边距（来自配置；可被容器更新覆盖）
    const [corner, setCorner] = useState<Corner>(cfg.position.corner);
    const [margin, setMargin] = useState({ x: cfg.position.marginX, y: cfg.position.marginY });
    // 余额气泡显隐（事件触发时显示，10s 后定时自动消失）
    const [bubbleOn, setBubbleOn] = useState(false);
    const bubbleTimerRef = useRef<number | null>(null);

    // 配置变化即时跟随（容器重新合并 / 设置页保存后通过 petBridge.sync 触发）
    useEffect(() => {
      setSize(cfg.size);
      setCorner(cfg.position.corner);
      setMargin({ x: cfg.position.marginX, y: cfg.position.marginY });
    }, [cfg.size, cfg.position.corner, cfg.position.marginX, cfg.position.marginY]);
    // 菜单 + 缩放：挂载时初始化（幂等），注册缩放回调（菜单滑块 / 持久化设置加载）
    useEffect(() => {
      ensureMenu();
      const offScale = onScaleChanged((s) => setScaleState(s));
      const offLoaded = onSettingsLoaded((s) => setScaleState(s.scale));
      return () => {
        offScale();
        offLoaded();
      };
    }, []);
    // 动画序号：同名动画连续播放两次时，靠 seq 自增强制 effect 重跑（switchTo 对同名同 once 会去重）
    const [seq, setSeq] = useState(0);

    // ---- DOM / 状态 refs（跨渲染帧共享；不触发重渲染）----
    // 根节点：定位层（角落 CSS / 内联 left-top 均落在它上面）
    const rootRef = useRef<HTMLDivElement | null>(null);
    // 舞台节点：脚底对齐（translateY）与拖拽复位（transform:none）作用于此
    const stageRef = useRef<HTMLDivElement | null>(null);
    // 双缓冲视频 A/B：前台播放、后台预载，切换时交替
    const videoARef = useRef<HTMLVideoElement | null>(null);
    const videoBRef = useRef<HTMLVideoElement | null>(null);
    // GIF/APNG 双缓冲 img 槽：与 video 双槽同构，仅以 onload 代替 loadeddata、以时长定时器代替 ended
    const imgARef = useRef<HTMLImageElement | null>(null);
    const imgBRef = useRef<HTMLImageElement | null>(null);
    const imgFrontRef = useRef(0); // 0=A 前台，1=B 前台
    const imgPendingRef = useRef<{ anim: string; once: boolean; gen: number } | null>(null);
    const imgGenRef = useRef(0);
    const imgEndTimerRef = useRef<number | null>(null); // 单次播放的「结束」定时器（img 无 ended 事件，用解析出的总时长模拟）
    const durationCacheRef = useRef<Map<string, number>>(new Map()); // 动画时长缓存（按文件名）
    // 当前前台视频索引（0=A / 1=B）；切换成功后翻转
    const frontRef = useRef(0);
    // 挂起的切换请求：loadeddata 就绪前记录目标动画与代际，用于去重与陈旧判定
    const pendingRef = useRef<null | { anim: string; once: boolean; gen: number }>(null);
    // 切换代际计数器：每次 switchTo 自增；就绪回调发现代际不符即放弃（防陈旧请求抢占前台）
    const genRef = useRef(0);
    // 拖拽全程状态（active=按压中 / dragging=已越过阈值 / sx,sy=起点 / offX,offY=指针相对中心偏移）
    const dragRef = useRef({ active: false, dragging: false, sx: 0, sy: 0, offX: 0, offY: 0 });
    // 「刚结束一次拖拽」标记（松手后 100ms 内为 true）：吞掉同一次手势尾部的 click，避免拖拽误触发点击
    const justDraggedRef = useRef(false);
    // 动画名镜像（供 handleEnded / pickNext 同步读取最新值，避免闭包旧值）
    const animRef = useRef(anim);
    animRef.current = anim;

    /**
     * 双缓冲切换动画：把 next 预载到后台视频，loadeddata 就绪后交换前台。
     * 状态流转：pendingRef 挂起 → 后台视频设 src/load → loadeddata →（代际校验）
     *   → 旧前台摘 .is-front 并停播清 onended（拆雷）→ 新视频加 .is-front 播放 → 翻转 frontRef。
     * @param next 动画名（thumb 目录文件名，不含扩展名）
     * @param nextOnce 是否单次播放（决定 loop 与是否挂 handleEnded）
     * 返回：无（异步完成）；重复请求同名同 once 直接去重；目标 DOM 未挂载时静默放弃。
     * 已知坑：旧前台视频必须 onended=null + pause()，否则它播完后触发 handleEnded
     *         （此时它已不是前台，历史上仍会掐断当前动画造成随机急速跳转）。
     */
    /**
     * 动画切换入口：按文件扩展名分派渲染路径。
     * - .webm/.mov（或无扩展名的配置名）→ 双缓冲 <video>（Safari 自动回落 .mov）
     * - .gif/.png/.apng → 双缓冲 <img>（动图格式，透明度：GIF 1-bit、APNG 8-bit）
     */
    const switchTo = (next: string, nextOnce: boolean) => {
      if (!next) return;
      if (/\.(gif|png|apng)$/i.test(next)) switchToImg(next, nextOnce);
      else switchToVideo(next, nextOnce);
    };

    /**
     * 视频路径（原 switchTo）：双缓冲 <video> 交叉淡入淡出。
     * @param next 动画名（不含扩展名；带扩展名的视频文件名也可，此时忽略 playbackExt 追加）
     * @param nextOnce 是否单次播放（决定 loop 与是否挂 handleEnded）
     * 返回：无（异步完成）；重复请求同名同 once 直接去重；目标 DOM 未挂载时静默放弃。
     * 已知坑：旧前台视频必须 onended=null + pause()，否则它播完后触发 handleEnded
     *         （此时它已不是前台，历史上仍会掐断当前动画造成随机急速跳转）。
     */
    const switchToVideo = (next: string, nextOnce: boolean) => {
      if (!next) return;
      const pending = pendingRef.current;
      if (pending && pending.anim === next && pending.once === nextOnce) return;
      // 跨格式防护：清掉 img 单次播放的结束定时器（视频接管前台，旧动图定时器不得再推进链）
      if (imgEndTimerRef.current !== null) {
        window.clearTimeout(imgEndTimerRef.current);
        imgEndTimerRef.current = null;
      }
      const gen = ++genRef.current;
      pendingRef.current = { anim: next, once: nextOnce, gen };
      const target = frontRef.current === 0 ? videoBRef : videoARef;
      const el = target.current;
      if (!el) return;
      const base = '/dsh-pet-7340/thumb/' + encodeURIComponent(next);
      // 带扩展名的完整文件名直接用自身扩展；无扩展名的配置名追加平台扩展（Safari .mov / 其余 .webm）
      el.src = /\.[a-z0-9]+$/i.test(next) ? base : base + playbackExt();
      el.loop = !nextOnce;
      el.muted = true;
      el.autoplay = true;
      el.playsInline = true;
      el.onended = nextOnce ? handleEnded : null;
      el.load();
      const onReady = () => {
        el.removeEventListener('loadeddata', onReady);
        if (pendingRef.current?.gen !== gen) return;
        const old = frontRef.current === 0 ? videoARef : videoBRef;
        el.classList.add('is-front');
        if (old.current && old.current !== el) {
          old.current.classList.remove('is-front');
          // 拆雷：降级为背景的视频继续播完会触发它身上残留的 onended → handleEnded，
          // 掐断当前前台动画（历史上表现为随机急速跳转/雪崩）。清 handler + 停播彻底消除。
          old.current.onended = null;
          old.current.pause();
        }
        frontRef.current = frontRef.current === 0 ? 1 : 0;
        pendingRef.current = null;
        el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
        el.play().catch(() => {});
        if (pendingMoveRef.current) startMoveDrive(el);
      };
      el.addEventListener('loadeddata', onReady);
      if (el.readyState >= 2) onReady();
      // 跨格式切换：清掉 img 槽的前台态（视频接管前台时旧动图必须退场）
      if (imgARef.current) imgARef.current.classList.remove('is-front');
      if (imgBRef.current) imgBRef.current.classList.remove('is-front');
    };

    /**
     * 动图路径（GIF/APNG/静态 PNG）：双缓冲 <img> 交叉淡入淡出。
     * 与视频路径的差异：无 ended 事件——单次播放时解析文件总时长，用定时器触发 handleEnded；
     * 循环播放（nextOnce=false）则依赖 GIF/APNG 自身循环。
     */
    const switchToImg = (next: string, nextOnce: boolean) => {
      const pending = imgPendingRef.current;
      if (pending && pending.anim === next && pending.once === nextOnce) return;
      const gen = ++imgGenRef.current;
      imgPendingRef.current = { anim: next, once: nextOnce, gen };
      const target = imgFrontRef.current === 0 ? imgBRef : imgARef;
      const el = target.current;
      if (!el) return;
      el.src = '/dsh-pet-7340/thumb/' + encodeURIComponent(next);
      const onLoad = () => {
        el.removeEventListener('load', onLoad);
        if (imgPendingRef.current?.gen !== gen) return;
        const old = imgFrontRef.current === 0 ? imgARef : imgBRef;
        el.classList.add('is-front');
        if (old.current && old.current !== el) old.current.classList.remove('is-front');
        imgFrontRef.current = imgFrontRef.current === 0 ? 1 : 0;
        imgPendingRef.current = null;
        el.style.transform = facingRef.current === 'right' ? 'scaleX(-1)' : '';
        // 单次播放：解析总时长后定时推进动画链（链上其它切换会先清掉本定时器，见 handleEnded 路径）
        if (imgEndTimerRef.current !== null) {
          window.clearTimeout(imgEndTimerRef.current);
          imgEndTimerRef.current = null;
        }
        if (nextOnce) {
          void fetchAnimeDuration(next).then((ms) => {
            const isFrontNow = imgFrontRef.current === (el === imgARef.current ? 0 : 1);
            if (!isFrontNow) return; // 已被切换走：不推进
            imgEndTimerRef.current = window.setTimeout(handleEnded, Math.max(ms, 300));
          });
        }
      };
      el.addEventListener('load', onLoad);
      if (el.complete) onLoad();
      // 跨格式切换：清掉 video 槽的前台态；并停掉旧前台视频 + 摘除其 onended
      //（否则旧视频播完仍会触发 handleEnded，掐断动图动画链——与视频路径的拆雷同理）
      if (videoARef.current) {
        videoARef.current.classList.remove('is-front');
        videoARef.current.onended = null;
        videoARef.current.pause();
      }
      if (videoBRef.current) {
        videoBRef.current.classList.remove('is-front');
        videoBRef.current.onended = null;
        videoBRef.current.pause();
      }
    };

    /**
     * 获取动图（GIF/APNG）总时长（ms）：拉取文件并解析；解析失败回落 3000ms 兜底。
     * 结果按文件名缓存（durationCacheRef），同一会话内不重复拉取解析。
     */
    const fetchAnimeDuration = async (name: string): Promise<number> => {
      const cached = durationCacheRef.current.get(name);
      if (cached !== undefined) return cached;
      let ms = 3000;
      try {
        const r = await fetch('/dsh-pet-7340/thumb/' + encodeURIComponent(name));
        if (r.ok) {
          const bytes = new Uint8Array(await r.arrayBuffer());
          if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
            ms = gifDuration(bytes);
          } else {
            ms = apngDuration(bytes);
          }
        }
      } catch {
        /* 兜底 3000ms */
      }
      if (ms <= 0) ms = 3000;
      durationCacheRef.current.set(name, ms);
      return ms;
    };

    // ---- 状态驱动播放 ----
    useEffect(() => {
      switchTo(anim, once);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anim, once, seq]);
    // 卸载时停掉进行中的 rAF 移动与挂起计划（token 失效，旧帧不再写 DOM）
    useEffect(() => () => stopMove(), []);
    useEffect(
      () => () => {
        if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      },
      [],
    );
    // 余额事件：容器拉取成功后递增 balanceTick → 按档位播放事件动画 + 弹气泡
    // （仅启用余额功能的宠物触发：未启用则该宠物完全不播余额动画、不显示气泡；
    //   无效/不支持按设计不触发动画，错误由容器侧显式上报）
    const prevTickRef = useRef(0);
    useEffect(() => {
      if (!cfg.balanceEnabled) return; // 未启用余额功能 -> 该宠物对余额事件完全免疫
      if (balanceTick === 0 || balanceTick === prevTickRef.current) return;
      prevTickRef.current = balanceTick;
      if (!balance || !balance.ok) {
        // 双击刷新却缺 API Key：自动弹出设置框引导填写（仅用户主动触发的刷新；周期轮询不打扰）
        if (manualRefreshRef.current && balance && balance.reason === 'credential-missing') {
          manualRefreshRef.current = false;
          openApiPopup(); // 自动弹设置框引导填写
          setBubbleOn(true); // 同时亮气泡提示（气泡文本组件会显示缺 key 的友好文案）
        }
        return;
      }
      manualRefreshRef.current = false;
      const p = balancePercent(balance);
      if (p === undefined) return; // 当前数据源没有百分比语义（如 DeepSeek 余额），不触发档位动画
      const pool = config.animations.events?.balance;
      if (!pool || pool.length === 0) {
        console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
        return;
      }
      const idx = balanceEventIndex(p);
      const name = pool[idx];
      if (!name) {
        console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
        return;
      }
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' balance pet=' +
          cfg.id +
          ' p=' +
          p.toFixed(1) +
          '% -> [档' +
          idx +
          '] ' +
          name,
      );
      stopMove();
      cancelChainTimer(); // 余额事件：立即播放，不受动画链间隔影响
      setBubbleOn(true);
      // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => setBubbleOn(false), BUBBLE_DURATION_MS);
      setOnce(true);
      setAnim(name);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [balanceTick]);
    // 视口 resize：对 customPos 浅拷贝触发重渲染 → rootStyle 重新贴边钳制（比例坐标不变，
    // 但 px 位置随视口缩放，越出贴边边界时会被 edgeBounds 钳回安全区）
    useEffect(() => {
      const onResize = () => setCustomPos((prev) => (prev ? { ...prev } : prev));
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    // ---- 动画链：播完按权重选下一个（无链式定时器：完全由「前台视频 ended」驱动推进）----
    /**
     * 按 animationWeights 加权 roll 选动画类别，再在类内随机挑具体动作：
     *  - idle/turn：直接 pick（不与当前重复）；turn 不改朝向，翻转在 handleEnded 分支做
     *  - move：tryMove 尝试发起漫游 —— 成功播移动动画；占用中（true）不重播；失败（false）回落分类动作
     *  - 其它：走 categories 分类动作（pickCategoryAction 按权重选类，facing=right 时跳过 noMirror）
     * 结束时 setOnce(true) + seq+1 强制推进；每次选择打一行调试日志（时间/宠物/朝向/roll/类别/动作）。
     */
    const pickNext = () => {
      const { animations, animationWeights } = config;
      const roll = Math.random();
      const k = rollKind(roll, animationWeights);
      let kind: string;
      let next: string;
      if (k === 'idle') {
        kind = 'IDLE';
        const pool = animeDirRef.current.idle.length ? animeDirRef.current.idle : animations.idle;
        next = pick(pool, animRef.current);
        setAnim(next);
      } else if (k === 'turn') {
        kind = 'TURN';
        const pool = animeDirRef.current.turn.length ? animeDirRef.current.turn : animations.turn;
        next = pick(pool, animRef.current);
        setAnim(next);
      } else if (k === 'move') {
        const moved = tryMove();
        if (moved === false) {
          const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
          kind = act.id;
          next = act.name;
          setAnim(next);
        } else {
          kind = 'MOVES';
          // 成功返回具体动作名；占用中返回 true（已有一场移动在进行，不重播、不另设动画）
          next = typeof moved === 'string' ? moved : '移动进行中(不重播)';
        }
      } else {
        const act = pickCategoryAction(animations.categories, animations.idle, facingRef.current, animRef.current);
        kind = act.id;
        next = act.name;
        setAnim(next);
      }
      console.log(
        '[dsh-pet] ' +
          new Date().toTimeString().slice(0, 8) +
          ' pet=' +
          cfg.id +
          ' facing=' +
          facingRef.current +
          ' roll=' +
          roll.toFixed(4) +
          ' -> [' +
          kind +
          '] ' +
          next,
      );
      setOnce(true);
      setSeq((s) => s + 1);
    };

    // ---- 动画链间隔（汉堡菜单「间隔」滑块，移植自用户需求）：动画播完后、下一个开始前的停顿时长 ----
    // intervalSec = 0（默认，当前行为）→ 立即接续；>0 → 暂停该秒数后再推进（交互触发不受间隔影响）
    const intervalTimerRef = useRef<number | null>(null);
    useEffect(
      () => () => {
        if (intervalTimerRef.current !== null) window.clearTimeout(intervalTimerRef.current);
      },
      [],
    );
    const cancelChainTimer = () => {
      if (intervalTimerRef.current !== null) {
        window.clearTimeout(intervalTimerRef.current);
        intervalTimerRef.current = null;
      }
    };
    /**
     * 动画链推进入口：intervalSec = 0 时立即执行 fn；
     * intervalSec > 0 时先清旧定时器再延迟该秒数执行（播完 → 停顿 → 下一段）。
     * 交互触发（点击/拖拽/余额事件）一律先 cancelChainTimer() 再直接 setAnim，不受间隔影响。
     * @param fn 推进回调（播下一段 / 翻转后 pickNext 等）
     */
    const chainAdvance = (fn: () => void) => {
      cancelChainTimer();
      const sec = getWidgetSettings().intervalSec;
      if (!(sec > 0)) {
        fn();
        return;
      }
      intervalTimerRef.current = window.setTimeout(() => {
        intervalTimerRef.current = null;
        fn();
      }, sec * 1000);
    };

    /**
     * 前台视频播完的统一点（仅挂在 once 动画上；循环动画不触发）。
     * 分流逻辑：
     *   1) 非前台视频的残留 ended → 直接丢弃（防双缓冲竞态掐断当前动画）
     *   2) 拖拽按压中 → 忽略（拖拽会重设动画）
     *   3) 事件动画（events.*）→ 回 idle（不进随机链；气泡由独立定时器收起，与动画解耦）
     *   4) turn 动画 → 翻转 facing + pickNext（翻转后用新朝向过滤 noMirror）
     *   5) drag/clicks 动画 → 回 idle（与事件分支同构，不进随机链）
     *   6) 其余（idle/move/分类）→ pickNext 按权重推进
     * 除第 1/2 条外，全部经 chainAdvance 包裹（受间隔滑块约束）。
     */
    const handleEnded = (e?: Event) => {
      // 只认前台视频触发的 ended：后台（被降级停播）视频即便有残留事件也一律丢弃，防止掐断当前动画
      const evEl = e && (e.currentTarget as HTMLVideoElement | null);
      if (evEl && !evEl.classList.contains('is-front')) return;
      const { animations } = config;
      if (dragRef.current.active) return;
      // 事件动画播完：回 idle（与 drag/clicks 同分支，不进入随机链）；气泡由定时器自动消失，与动画解耦
      const isEvent = Object.values(animations.events ?? {}).some((pool) => pool.includes(animRef.current));
      const idlePool = animeDirRef.current.idle.length ? animeDirRef.current.idle : animations.idle;
      if (isEvent) {
        chainAdvance(() => {
          if (idlePool.length) setAnim(pick(idlePool, animRef.current));
          setOnce(true);
          setSeq((s) => s + 1);
        });
        return;
      }
      const isTurn = animations.turn.includes(animRef.current) || animeDirRef.current.turn.includes(animRef.current);
      if (isTurn) {
        chainAdvance(() => {
          const next = facing === 'left' ? 'right' : 'left';
          setFacing(next);
          facingRef.current = next; // 翻转后的 pickNext 用新朝向过滤 noMirror（右侧不选文字类）
          pickNext();
        });
        return;
      }
      const isDrag = animations.drag.includes(animRef.current) || animeDirRef.current.drag.includes(animRef.current);
      if (isDrag || animations.clicks.includes(animRef.current)) {
        chainAdvance(() => {
          if (idlePool.length) setAnim(pick(idlePool, animRef.current));
          setOnce(true);
          setSeq((s) => s + 1);
        });
        return;
      }
      chainAdvance(() => pickNext());
    };

    // ---- 移动系统（漫游）：planMove 规划 → 挂起计划 → 视频就绪后 rAF 驱动逐帧位移 ----
    // 当前 rAF 帧 id（null=未在移动）；驱动循环用它续帧，stopMove 用它取消
    const moveRef = useRef<number | null>(null);
    // 移动代际 token：stopMove 自增使所有在途帧失效（帧回调比对 token，不符即退出）
    const moveTokenRef = useRef(0);
    // 挂起的移动计划（planMove 结果 + dir/leadSec/tailSec）：等视频 loadeddata 后由 startMoveDrive 消费
    const pendingMoveRef = useRef<null | {
      startRatio: number;
      startYRatio: number;
      targetRatio: number;
      dir: number;
      totalRatio: number;
      leadSec: number;
      tailSec: number;
    }>(null);
    const customPosRef = useRef(customPos);
    customPosRef.current = customPos;

    /**
     * 当前中心点 x（px）：优先 customPos（拖拽过）；否则实测 DOM 位置；
     * 无 DOM 时保守回落为统一贴边边界（右下角贴边处），保证规划不越界。
     */
    const currentCenterX = () => {
      const cp = customPosRef.current;
      if (cp) return cp.rx * window.innerWidth;
      const rootEl = rootRef.current;
      if (rootEl) return rootEl.getBoundingClientRect().left + halfW;
      // 无 DOM 时的保守回落：统一贴边边界
      return window.innerWidth - EDGE_PAD - halfW + EDGE_M_R * eff;
    };
    /** 当前中心点 y（px）：移动只走水平线，y 仅作起点/全程记录 */
    const currentCenterY = () => {
      const cp = customPosRef.current;
      if (cp) return cp.ry * window.innerHeight;
      const rootEl = rootRef.current;
      if (rootEl) return rootEl.getBoundingClientRect().top + halfH;
      return window.innerHeight - 20 - halfH;
    };

    /**
     * 启动 rAF 位移驱动：把视频播放进度映射为水平位移（start→target）。
     * 只在视频 loadeddata（时长可知）后调用；leadSec/tailSec 为「起势/收势」静止段，
     * 中间 travelWindow 内线性插值。驱动期间逐帧写 rootEl 内联 left/top（right/bottom 置 auto），
     * 结束后把终点写回 customPos（比例坐标），使后续逻辑以新位置为准。
     * @param el 已就绪的移动动画视频元素
     */
    const startMoveDrive = (el: HTMLVideoElement) => {
      const pm = pendingMoveRef.current;
      if (!pm || moveRef.current !== null) return;
      pendingMoveRef.current = null;
      const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
      const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
      const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
      const token = ++moveTokenRef.current;
      const step = () => {
        if (moveTokenRef.current !== token) return;
        const t = el.currentTime || 0;
        const rootEl = rootRef.current;
        if (rootEl) {
          const W = window.innerWidth;
          const H = window.innerHeight;
          let ratioX;
          if (t <= leadSec) ratioX = startRatio;
          else if (t >= duration - tailSec) ratioX = targetRatio;
          else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
          const px = ratioX * W;
          const py = startYRatio * H;
          rootEl.style.left = px - halfW + 'px';
          rootEl.style.top = py - halfH + 'px';
          rootEl.style.right = 'auto';
          rootEl.style.bottom = 'auto';
        }
        if (t < duration - tailSec) moveRef.current = requestAnimationFrame(step);
        else {
          moveRef.current = null;
          setCustomPos({ rx: targetRatio, ry: startYRatio });
        }
      };
      moveRef.current = requestAnimationFrame(step);
    };

    /** 尝试发起一次移动：占用中返回 true（不重播），无法移动返回 false，成功返回动作名（供日志显示具体动作） */
    const tryMove = (): boolean | string => {
      if (moveRef.current !== null || pendingMoveRef.current) return true;
      const moves = config.animations.moves;
      const actions = moves.actions;
      if (!actions.length) return false;
      const chosen = actions[Math.floor(Math.random() * actions.length)];
      const mp = Object.assign({}, moves.default, chosen.params || {});
      const dir =
        (facingRef.current === 'right') !==
        (config.animations.turn.includes(animRef.current) || animeDirRef.current.turn.includes(animRef.current))
          ? 1
          : -1;
      const W = window.innerWidth;
      // 移动距离随宠物缩放：config 的 minDist/maxDist 是基准尺寸（462px 宽）下的 px，
      // 按 实际size/基准 等比缩放 —— 小宠物挪小步、大宠物挪大步，与人物自身大小匹配
      const distScale = eff / PET_REF_WIDTH;
      const plan = planMove({
        cx: currentCenterX(),
        cy: currentCenterY(),
        W,
        H: window.innerHeight,
        dir,
        minDist: mp.minDist * distScale,
        maxDist: mp.maxDist * distScale,
        // 贴边边界：统一边距+安全垫（所有动画一致，位置不因动画切换而跳动）
        leftBound: halfW - EDGE_M_L * eff + EDGE_PAD,
        rightBound: W - halfW + EDGE_M_R * eff - EDGE_PAD,
      });
      if (!plan) return false;
      pendingMoveRef.current = {
        ...plan,
        dir,
        leadSec: mp.leadSec,
        tailSec: mp.tailSec,
      };
      setOnce(true);
      setAnim(chosen.name);
      return chosen.name;
    };
    /** 停止移动：清空挂起计划 + token 自增（在途帧全部失效）+ 取消 rAF。幂等，可安全重复调用 */
    const stopMove = () => {
      pendingMoveRef.current = null;
      moveTokenRef.current++;
      if (moveRef.current !== null) {
        cancelAnimationFrame(moveRef.current);
        moveRef.current = null;
      }
    };

    const facingRef = useRef<'left' | 'right'>(facing);
    facingRef.current = facing;

    // ---- 点击 vs 拖拽：按压不立即判定，移动越过 DRAG_THRESHOLD 才算拖拽 ----
    /**
     * 按压：记录起点与指针相对中心偏移、抓取 pointer capture、停掉在途移动与链间隔、
     * 播按压音效并进入 active 状态（尚未判定为拖拽）。
     */
    const handlePointerDown = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.classList.add('dragging');
      stopMove();
      cancelChainTimer(); // 拖拽开始：取消动画链间隔
      petPressDown(); // 按压音效（移植自插件 A）
      e.currentTarget.setPointerCapture(e.pointerId);
      const rootEl = rootRef.current;
      let offX = 0;
      let offY = 0;
      if (rootEl) {
        const rr = rootEl.getBoundingClientRect();
        offX = e.clientX - (rr.left + rr.width / 2);
        offY = e.clientY - (rr.top + rr.height / 2);
      }
      dragRef.current = { active: true, dragging: false, sx: e.clientX, sy: e.clientY, offX, offY };
    };
    /**
     * 移动：位移越过 DRAG_THRESHOLD 才升级为拖拽 —— 升级时切 drag 动画（单次）、
     * 进入跟手模式（舞台 transform:none，root 内联 left/top 随指针实时更新）。
     */
    const handlePointerMove = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d.active) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        d.dragging = true;
        setDragging(true);
        setOnce(true);
        if (config.animations.drag.length) {
          const pool = animeDirRef.current.drag.length ? animeDirRef.current.drag : config.animations.drag;
          const name = pick(pool);
          console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [DRAG] ' + name);
          setAnim(name);
        }
      }
      const rootEl = rootRef.current;
      if (rootEl) {
        rootEl.style.left = e.clientX - d.offX - halfW + 'px';
        rootEl.style.top = e.clientY - d.offY - halfH + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
      }
      const stageEl = stageRef.current;
      if (stageEl) stageEl.style.transform = 'none';
    };
    /**
     * 松手（pointerup / pointercancel 共用）：结束按压状态；若是拖拽则把落点写回
     * customPos（比例坐标）、舞台恢复脚底对齐、回 idle 循环，并置 justDraggedRef
     * 100ms 屏蔽随后误发的 click；若位移未越过阈值，后续 click 事件正常处理。
     */
    const handlePointerUp = (e: ReactNS.PointerEvent<HTMLDivElement>) => {
      petPressUp(); // 松手音效（移植自插件 A；长按/短按时序同 A）
      const d = dragRef.current;
      const wasDragging = d.dragging;
      d.active = false;
      d.dragging = false;
      e.currentTarget.classList.remove('dragging');
      if (wasDragging) {
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 100);
        setDragging(false);
        setCustomPos({ rx: (e.clientX - d.offX) / window.innerWidth, ry: (e.clientY - d.offY) / window.innerHeight });
        const stageEl = stageRef.current;
        if (stageEl) stageEl.style.transform = 'translateY(' + bottomPad + 'px)';
        if (config.animations.idle.length) setAnim(pick(config.animations.idle, animRef.current));
        setOnce(false);
      }
    };
    /**
     * 点击分发（单击/双击分离）：
     * - 单击：延迟 SINGLE_CLICK_DELAY_MS 播随机 clicks 响应动画（等待期间若第二击到达则取消，不播）
     * - 双击：走 onDoubleClick —— 取消单击定时器，仅触发余额刷新；余额动画由 balanceTick
     *   effect 按档位播放。避免历史问题：单击立即播 clicks 动画 + 立即刷新余额，余额动画
     *   返回时掐断 clicks 动画造成「闪烁」。
     * 双击判定使用浏览器/操作系统原生 dblclick（click 事件 e.detail 计数区分第几击）。
     */
    const clickTimerRef = useRef<number | null>(null);
    const handleClick = (e: ReactNS.MouseEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (d.active || d.dragging || justDraggedRef.current) return;
      if (e.detail !== 1) return; // 双击的第二击（detail=2）交由 onDoubleClick 处理
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        handleSingleClick();
      }, SINGLE_CLICK_DELAY_MS);
    };
    /** 单击：停移动/取消链间隔 → 播随机 clicks 响应动画（单次） */
    const handleSingleClick = () => {
      stopMove();
      cancelChainTimer(); // 交互触发：取消动画链间隔（点击立即响应，不等待停顿）
      setOnce(true);
      if (!config.animations.clicks.length) return;
      const name = pick(config.animations.clicks);
      console.log('[dsh-pet] ' + new Date().toTimeString().slice(0, 8) + ' pet=' + cfg.id + ' -> [CLICK] ' + name);
      setAnim(name);
    };
    /** 双击：仅触发余额刷新（余额动画 + 气泡由 balanceTick effect 按档位播放） */
    const manualRefreshRef = useRef(false); // 标记本次刷新是否为用户双击触发（缺 key 时据此弹 API 设置框）
    const handleDoubleClick = () => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      stopMove();
      cancelChainTimer();
      if (cfg.balanceEnabled && onManualRefresh) {
        manualRefreshRef.current = true;
        onManualRefresh();
      }
    };
    // 卸载清理：单击判定定时器（防组件销毁后误触发）
    useEffect(() => () => {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    }, []);

    // ---- 统一贴边边界（所有动画共用固定边距+安全垫：位置永不因动画切换而跳动）----
    // 与 tryMove 的左右边界（centerX 口径）不同，这里是 root 层 left/top 口径的钳制区间：
    // root 的 left/top 是舞台左上角，而舞台按 EDGE_M_* 允许部分伸出屏幕（宽动画不跳变），
    // 再额外保留 EDGE_PAD 安全垫保证角色可见像素不贴死屏幕边缘。customPos 渲染时用它钳制。
    const edgeBounds = () => {
      const stageH = (eff * 9) / 16;
      return {
        minLeft: -(EDGE_M_L * eff) + EDGE_PAD,
        maxLeft: window.innerWidth - eff + EDGE_M_R * eff - EDGE_PAD,
        minTop: -(bottomPad + EDGE_M_T * stageH) + EDGE_PAD,
        maxTop: window.innerHeight - bottomPad - (1 - EDGE_M_B) * stageH + EDGE_PAD,
      };
    };

    // ---- 渲染 ----
    // 脚底对齐 padding：把 640×360 画布上的脚底线（FEET_Y=330）映射到舞台底部，
    // 让不同身高的动画都「站在同一地平线」上；按缩放等比例换算（eff 为当前舞台宽）
    const bottomPad = (eff * (9 / 16) * (CANVAS_H - FEET_Y)) / CANVAS_H;
    // 舞台样式：常态下移 bottomPad 做脚底对齐；拖拽中 transform:none 跟手移动
    const stageStyle = dragging ? { transform: 'none' } : { transform: 'translateY(' + bottomPad + 'px)' };
    // root 定位样式：有 customPos（拖拽过）→ 按比例坐标算 left/top 并经 edgeBounds 钳制贴边；
    // 无 customPos → 交由 CSS 角落规则定位
    const rootStyle = customPos
      ? (() => {
          const rx = customPos.rx;
          const ry = customPos.ry;
          const b = edgeBounds();
          const left = Math.min(Math.max(rx * window.innerWidth - halfW, b.minLeft), b.maxLeft);
          const top = Math.min(Math.max(ry * window.innerHeight - halfH, b.minTop), b.maxTop);
          return { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' };
        })()
      : // 已知坑：DSH 的 jsx 工厂 h 不接受 null props —— 无内联样式时必须传 {}（而非 null）
        {};
    // 双缓冲视频公共属性：静音 + 内联播放 + 自动播放（浏览器自动播放策略要求 muted）
    const commonVideoProps = { muted: true, playsInline: true, autoPlay: true, title: 'DeepSeek娘' };
    // 命中层 props：HIT_BOX 是 thumb 640×360 像素坐标，换算为舞台百分比定位；点击/拖拽事件直接绑在命中层上
    const hitProps = {
      className: 'dsh-pet-hit',
      style: {
        left: (HIT_BOX.x0 / 640) * 100 + '%',
        top: (HIT_BOX.y0 / 360) * 100 + '%',
        width: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100 + '%',
        height: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100 + '%',
      },
      onClick: handleClick,
      onDoubleClick: handleDoubleClick,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
      title: 'DeepSeek娘',
    };
    // DOM 结构：root(定位层) > [余额气泡(条件渲染)、汉堡菜单按钮、stage(舞台) > [videoA、videoB、hit]]
    // 注意：h 的第二个参数（props）恒为对象；children 内条件不满足处传 null（children 允许 null，props 不允许）
    return h('div', {
      ref: rootRef,
      className: 'dsh-pet-root',
      'data-corner': corner,
      'data-facing': facing,
      style: Object.assign(
        { '--dsh-pet-size': eff + 'px', '--dsh-pet-mx': margin.x + 'px', '--dsh-pet-my': margin.y + 'px' },
        rootStyle,
      ),
      children: [
        // 余额气泡（启用余额功能的宠物：bubbleOn 时渲染；数据为 null 显示「加载中…」，失败显示原因）
        cfg.balanceEnabled && bubbleOn ? h(BalanceBubble, { state: balance, on: bubbleOn }) : null,
        // 汉堡菜单按钮（移植自插件 A：悬停显示、点击弹出菜单面板）
        h('button', {
          type: 'button',
          className: 'dsh-pet-menu-btn',
          title: '菜单',
          onClick: (e: ReactNS.MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            toggleMenu({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
          },
          children: [h('span', {}), h('span', {}), h('span', {})],
        }),
        h('div', {
          ref: stageRef,
          className: 'dsh-pet-stage',
          style: stageStyle,
          children: [
            h('video', Object.assign({}, commonVideoProps, { ref: videoARef, className: 'dsh-pet-video is-front' })),
            h('video', Object.assign({}, commonVideoProps, { ref: videoBRef, className: 'dsh-pet-video' })),
            h('img', { ref: imgARef, className: 'dsh-pet-img', alt: '', draggable: false }),
            h('img', { ref: imgBRef, className: 'dsh-pet-img', alt: '', draggable: false }),
            h('div', hitProps),
          ],
        }),
      ],
    });
  }

  /**
   * 多开容器：拉取配置 → 合并默认+用户层 pets → 渲染多个 PetCard。
   * 职责：配置加载与校验（assertClientConfig × 2：默认层一次、合并后一次）、
   *       余额状态统一拉取与共享（balance / balanceTick）、周期轮询 +
   *       手动 /balance/trigger 轻量轮询、渲染 N 个 PetCard（key=p.id）。
   * 关键设计：余额只在「至少一只宠物启用余额」时轮询（全禁用则不发请求）；
   *       所有失败/不支持均不伪造数据、不触发动画（错误显式 console.error，
   *       静默仅限按设计的 unsupported）。
   */
  function PetMulti() {
    const [pets, setPets] = useState<Pet[]>([]);
    const [ready, setReady] = useState(false);
    // 余额状态（容器统一拉取，PetCard 共享；balanceTick 每次成功拉取递增，驱动事件动画）
    const [balance, setBalance] = useState<BalanceState | null>(null);
    const [balanceTick, setBalanceTick] = useState(0);

    // 手动刷新余额（点击宠物 / 用量模式切换时触发；与周期轮询同一路径）
    const refreshOnce = async (): Promise<void> => {
      try {
        const state = await fetchBalanceState();
        setBalance(state);
        if (state.ok) setBalanceTick((t) => t + 1);
        else if (state.reason !== 'unsupported') {
          console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
        }
      } catch (e) {
        console.error('[dsh-pet] 余额拉取异常', e);
      }
    };
    const refreshRef = useRef(refreshOnce);
    refreshRef.current = refreshOnce;

    useEffect(() => {
      let alive = true;
      (async () => {
        try {
          const r1 = await fetch('/dsh-pet-7340/config.jsonc');
          if (!r1.ok) throw new Error('config.jsonc HTTP ' + r1.status);
          config = assertClientConfig(JSON.parse(stripJsonc(await r1.text())));
          const defaults = config.pets;
          // 用户覆盖层（覆盖片段：pets / animations / animationWeights，缺省回落默认）
          let user: UserOverrides = {};
          try {
            const r2 = await fetch('/dsh-pet-7340/config');
            if (r2.ok && r2.status !== 204) user = await r2.json().catch(() => ({}));
          } catch {
            /* 无用户层时忽略 */
          }
          // 合并后统一校验：用户层覆盖可能缺字段（如 moves/events），直接整体替换会静默丢失，
          // 这里对最终配置再跑一遍 assertClientConfig —— 缺失即显式报错，不静默运行残缺配置
          config = assertClientConfig(applyUserOverrides(config, user));
          const merged = config.pets;
          if (!alive) return;
          petBridge.current = merged;
          petBridge.template = defaults.length ? defaults[0] : undefined;
          petBridge.sync = (list: Pet[]) => {
            setPets(list);
            petBridge.current = list;
          };
          setPets(merged);
          setReady(true);
        } catch (e) {
          console.error('[dsh-pet] 配置加载失败', e); // 配置缺失/损坏：显式报错，不静默隐藏
        }
      })();
      return () => {
        alive = false;
        petBridge.sync = () => {};
      };
    }, []);

    // 是否存在启用余额功能的宠物：全禁用时跳过余额轮询（不拉取 /dsh-pet-7340/balance，避免无意义的周期请求）
    const anyBalanceEnabled = pets.some((p) => p.balanceEnabled);

    // 挂件设置加载 + 用量模式联动（移植自插件 A）：就绪后拉取持久化设置；菜单切换用量模式 → 立即刷新余额
    useEffect(() => {
      if (!ready) return;
      void loadWidgetSettings();
      const off = onUsageModeChanged(() => {
        void refreshRef.current();
      });
      return off;
    }, [ready]);

    // 余额轮询：配置就绪（ready）且至少一只宠物启用余额后启动拉取一次，之后按 eventsRefreshSec.balance（秒）周期刷新；
    // 成功递增 balanceTick 触发事件动画；失败/不支持均不触发动画（错误显式 console.error，绝不显示伪造余额）
    useEffect(() => {
      if (!ready || !anyBalanceEnabled) return; // 未就绪 / 全宠物未启用余额：不启动轮询
      let alive = true;
      const refresh = async () => {
        try {
          const state = await fetchBalanceState();
          if (!alive) return;
          setBalance(state);
          if (state.ok) setBalanceTick((t) => t + 1);
          else if (state.reason === 'unsupported') {
            /* 无匹配服务商：按设计不显示、不播动画 */
          } else {
            console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
          }
        } catch (e) {
          if (alive) console.error('[dsh-pet] 余额拉取异常', e);
        }
      };
      void refresh();
      const intervalMs = Math.max(1000, (config.eventsRefreshSec?.balance ?? 1800) * 1000);
      const timer = window.setInterval(() => void refresh(), intervalMs);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }, [ready, anyBalanceEnabled]);

    // 手动 /balance 触发：1s 轻量轮询触发计数（host 端点响应头已禁止缓存），
    // 计数变化且余额启用时立即刷新余额并递增 balanceTick（与周期轮询同一触发路径）
    useEffect(() => {
      if (!ready || !anyBalanceEnabled) return;
      let alive = true;
      let prev = -1;
      const poll = async () => {
        try {
          const r = await fetch('/dsh-pet-7340/balance/trigger');
          if (!alive || !r.ok) return;
          const data = await r.json().catch(() => null);
          const count = data && typeof data.count === 'number' ? data.count : -1;
          if (count < 0) return;
          if (prev === -1) {
            prev = count; // 首次仅记基线：避免页面加载时重放历史触发
            return;
          }
          if (count === prev) return;
          prev = count;
          const state = await fetchBalanceState();
          if (!alive) return;
          setBalance(state);
          if (state.ok) setBalanceTick((t) => t + 1);
          else {
            console.error(
              '[dsh-pet] 手动触发余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''),
            );
          }
        } catch {
          /* 轻量轮询失败静默：下一周期再试 */
        }
      };
      void poll();
      const timer = window.setInterval(() => void poll(), 1000);
      return () => {
        alive = false;
        window.clearInterval(timer);
      };
    }, [ready, anyBalanceEnabled]);

    return ready
      ? pets.map((p) =>
          h(PetCard, { key: p.id, cfg: p, balance, balanceTick, onManualRefresh: () => void refreshRef.current() }),
        )
      : null;
  }

  return PetMulti;
}
