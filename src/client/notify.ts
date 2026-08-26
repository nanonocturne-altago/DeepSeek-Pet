// 系统通知引擎（client 半侧）：订阅 DSH 事件流（mux + host），按「聚焦不弹」规则
// 发出系统级 toast（Web Notification API，Windows 为右下角原生通知）。
// 单一总开关：读 config.jsonc 的 notificationsEnabled；纯副作用模块，无 react 依赖，
// 由 app.ts 装配层启动。
//
// 触发清单（与 DSH 事件契约一一对应）：
//   - 对话完成：mux session/event → turn/end，reason.kind === 'completed'
//   - 生成失败：同上，reason.kind === 'error'（含无回合位置的 host/agent-error）
//   - 输出截断：同上，reason.kind === 'max-tokens'
//   - 权限申请：mux approval/requested
//   - 用户选择：mux question/requested
// 过滤：aborted / interrupted 不弹；重连重放的 approval/question 帧按 rpcId 去重。
//
// 与其它模块的关系：
//   - app.ts：装配层在 ctx.effect 里调用 startNotify 启动本引擎（页面加载即常驻，
//     插件卸载/重载时通过 AbortSignal 终止两条事件流）；
//   - config.ts：readNotificationsEnabled 复用 stripJsonc/assertClientConfig/
//     applyUserOverrides 同一条配置合并路径读取总开关；
//   - settings.ts：保存开关后调 reloadNotifications（新值即时生效，无需刷新），
//     「获取权限」按钮调 requestNotificationPermission，成功确认后用
//     NOTIFY_ICONS.test 发测试通知；
//   - host 半侧不参与通知：事件帧全部来自 DSH 连接层（connection.api 的 mux/host 事件流）。
// 调用时机：仅由 app.ts 装配启动一次；开关/权限/聚焦状态在每次触发时实时判断，无需重启。

import { applyUserOverrides, assertClientConfig, stripJsonc } from './config';
import type { UserOverrides } from './config';

// ---------- 聚焦门：仅在页面不可见/失焦时弹 ----------

// 模块级初始值在加载时读取一次；typeof document 是防御写法（本 bundle 只在浏览器运行，
// 但保持与无 document 环境兼容——此时恒视为不可见/失焦，即永不弹窗）
let pageVisible = typeof document !== 'undefined' && !document.hidden;
let pageFocused = typeof document !== 'undefined' && document.hasFocus();

/** visibilitychange 回调：同步页面可见性（切换标签页/最小化窗口都会触发） */
function refreshVisible(): void {
  pageVisible = !document.hidden;
}
/** focus/blur 回调：同步窗口焦点（用户点回页面任意位置即获得焦点） */
function refreshFocused(): void {
  pageFocused = document.hasFocus();
}

/** 注册聚焦/可见性监听，返回解绑函数 */
// 三个原生事件驱动两个模块级布尔：visibilitychange 更新可见性，focus/blur 更新焦点，
// isPageActive() 据此判断「用户是否正在看本页」。
// 解绑在 startNotify 收尾时调用——每次引擎重启（页面刷新/socket 代际）前必须解绑，
// 避免同页重复监听导致状态错乱。
function initFocusTracking(): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', refreshVisible);
  window.addEventListener('focus', refreshFocused);
  window.addEventListener('blur', refreshFocused);
  return () => {
    document.removeEventListener('visibilitychange', refreshVisible);
    window.removeEventListener('focus', refreshFocused);
    window.removeEventListener('blur', refreshFocused);
  };
}

/** 用户是否在看本页（页面可见且持有焦点）——是则跳过通知 */
function isPageActive(): boolean {
  return pageVisible && pageFocused;
}

// ---------- 发送 ----------

/** 通知正文最大长度（超出则截断并补省略号） */
const MAX_BODY = 80;

/** 截断正文到 MAX_BODY：避免超长 body 撑破系统通知 UI（长度按字符计） */
function truncate(text: string): string {
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '…' : text;
}

/** 当前生效的总开关（运行中可被 reloadNotifications 更新——设置页保存后即时生效，无需刷新） */
let notifyEnabled = true;

/** 发一条系统通知；总开关关闭 / 环境不支持 / 未授权 / 聚焦本页 时静默跳过。
 * 日志（【弹窗】类型：内容）在门之后记录——只有真正发出通知时才记，被门拦下的触发不产生日志。 */
// @param title 通知标题
// @param body  正文（可选，先经 truncate 截断）
// @param icon  图标 URL（可选；加载失败仅降级为无图标）
function toast(title: string, body?: string, icon?: string): void {
  if (!notifyEnabled) return;
  if (isPageActive()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  console.log('【弹窗】' + title + (body ? '：' + body : ''));
  try {
    const opts: NotificationOptions = {};
    if (body) opts.body = truncate(body);
    if (icon) opts.icon = icon;
    // 点击通知：聚焦回 DSH 页面并关闭该通知（图标加载失败只降级为无图标，绝不关闭弹窗）
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* 个别环境（e.g. 部分桌面壳）可能在构造时抛错：忽略，不打断业务 */
  }
}

/** 申请浏览器通知权限的结果：ok=true 已授予；ok=false 带失败原因（供设置页红字展示） */
export type PermissionResult =
  { ok: true } | { ok: false; reason: 'unsupported' | 'denied' | 'rejected' | 'error'; message?: string };

/** 申请浏览器通知权限。务必在用户手势（点击）下调用——无手势的自动申请可能被浏览器静默压制；
 * 失败时区分原因：unsupported=环境无 Notification、denied=浏览器已标记阻止、
 * rejected=用户在询问弹窗里选了阻止、error=申请过程异常/弹窗被跳过。 */
export async function requestNotificationPermission(): Promise<PermissionResult> {
  if (typeof Notification === 'undefined') return { ok: false, reason: 'unsupported' };
  if (Notification.permission === 'granted') return { ok: true };
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  try {
    const p = await Notification.requestPermission();
    if (p === 'granted') return { ok: true };
    if (p === 'denied') return { ok: false, reason: 'rejected' };
    // 弹窗被直接关掉/未选择：浏览器仍是 default
    return { ok: false, reason: 'error', message: '权限未授予（' + p + '）' };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- 总开关：用户层配置优先，缺省回落默认配置 ----------

/** 读取系统通知总开关：与宠物配置同一条合并路径（用户层 main-config.json 优先，缺省回落默认）；
 * 拉取/解析失败时不阻塞（默认开启）。 */
// 读取链路（与 pet.ts 的主配置加载完全一致）：
//   1. /dsh-pet-7340/config.jsonc（默认层）→ stripJsonc + JSON.parse + assertClientConfig；
//   2. /dsh-pet-7340/config（用户层）→ 200 且响应体可解析为对象时作为覆盖片段；
//      204 = 宿主明确表示无用户层；解析失败视为无用户层，不中断；
//   3. applyUserOverrides(base, user) 合并后取 .notificationsEnabled。
// 边界：任一步失败（网络/解析/校验）都 catch 住返回 true——通知功能绝不阻塞、
// 绝不让配置问题向上层抛异常。
async function readNotificationsEnabled(): Promise<boolean> {
  try {
    const base = assertClientConfig(JSON.parse(stripJsonc(await (await fetch('/dsh-pet-7340/config.jsonc')).text())));
    let user: UserOverrides = {};
    try {
      const r = await fetch('/dsh-pet-7340/config');
      // 204：宿主返回「无用户层」（用户从未保存过 main-config.json）；非 200 同样跳过用户层
      if (r.ok && r.status !== 204) {
        const parsed = await r.json().catch(() => null);
        if (parsed && typeof parsed === 'object') user = parsed as UserOverrides;
      }
    } catch {
      /* 无用户层时忽略 */
    }
    return applyUserOverrides(base, user).notificationsEnabled;
  } catch {
    return true;
  }
}

/** 重读总开关（设置页保存开关后调用）；之后新触发的通知按新值执行，无需刷新页面 */
export async function reloadNotifications(): Promise<void> {
  notifyEnabled = await readNotificationsEnabled();
}

/** 事件帧的宽松形状：按 type 判别帧类型，其余字段运行时才读取（DSH 事件契约无静态类型） */
type Frame = { type: string; [k: string]: unknown };
/** session/event 帧内 event 子对象的宽松形状 */
type SessionEventLike = { type: string; data?: Record<string, unknown> };

/** 通知图标 URL（pic 路由由宿主提供：assets/pic → /dsh-pet-7340/pic/<file>） */
const ICON = {
  done: '/dsh-pet-7340/pic/notify-done.png',
  error: '/dsh-pet-7340/pic/notify-error.png',
  truncated: '/dsh-pet-7340/pic/notify-truncated.png',
  approval: '/dsh-pet-7340/pic/notify-approval.png',
  question: '/dsh-pet-7340/pic/notify-question.png',
  test: '/dsh-pet-7340/pic/notify-test.png',
} as const;

/** 图标 URL 表（设置页「获取权限」成功确认的测试通知也用） */
export const NOTIFY_ICONS = ICON;

// ---------- mux 流：会话事件 + 权限 + 问题 ----------

/**
 * 消费 mux 事件流，三类帧驱动三类通知：
 *   - session/event(turn/end) → reason.kind：completed=对话完成 / error=生成失败 / max-tokens=输出截断；
 *   - approval/requested → 权限申请（带工具名与申请原因）；
 *   - question/requested → 模型发起提问（取第一个问题的文案）。
 */
// @param api    connection.api（events.mux 返回帧的 AsyncIterable）
// @param signal 取消信号：apply 清理时 abort，for await 即退出、循环结束后函数自然返回
async function runMuxLoop(
  api: { events: { mux: (req: unknown, signal: AbortSignal) => AsyncIterable<{ rpcId: unknown; payload: Frame }> } },
  signal: AbortSignal,
): Promise<void> {
  // 重连时服务器会重放仍 pending 的 approval/question 帧（rpcId 保持不变）——按 rpcId 去重
  const seen = new Set<unknown>();
  for await (const env of api.events.mux({}, signal)) {
    const frame = env?.payload;
    if (!frame) continue;
    switch (frame.type) {
      case 'session/event': {
        const ev = (frame.event ?? {}) as SessionEventLike;
        // 只关心 turn/end（一轮对话结束）：其余 session 事件（如 turn/start）一律跳过
        if (ev.type !== 'turn/end') break;
        const reason = (ev.data?.reason ?? {}) as { kind?: string; error?: { message?: string } };
        const kind = reason.kind;
        // reason.kind 三档（见文件头触发清单）：completed 正常完成、error 生成失败（带错误信息）、
        // max-tokens 输出被截断；aborted、interrupted 不弹
        if (kind === 'completed') toast('对话完成', undefined, ICON.done);
        else if (kind === 'error') toast('生成失败', reason.error?.message ?? '', ICON.error);
        else if (kind === 'max-tokens') toast('输出被截断', '已达到输出 token 上限', ICON.truncated);
        // aborted（用户/父代理取消）、interrupted（崩溃恢复）：不弹
        break;
      }
      case 'approval/requested': {
        // rpcId 去重（重连重放防抖，见 runMuxLoop 头注释）
        if (seen.has(env.rpcId)) break;
        seen.add(env.rpcId);
        const toolName = String(frame.toolName ?? '');
        const reason = typeof frame.reason === 'string' && frame.reason ? (frame.reason as string) : '';
        // body 拼接：工具名（可选）+ 申请原因（可选）；两者皆空时只发标题
        toast(
          '正在申请权限',
          (toolName ? '工具「' + toolName + '」' : '') + (reason ? '：' + reason : ''),
          ICON.approval,
        );
        break;
      }
      case 'question/requested': {
        if (seen.has(env.rpcId)) break;
        seen.add(env.rpcId);
        // 取第一个问题的文案作为正文（模型发起的多选/问答通常为单题）
        const q =
          (Array.isArray(frame.questions) && (frame.questions as Array<{ question?: string }>)[0]?.question) || '';
        toast('模型在等你回答', q, ICON.question);
        break;
      }
      default:
        break;
    }
  }
}

// ---------- host 流：无回合位置的失败 ----------

/**
 * 消费 host 事件流：兜底 host/agent-error（无回合位置的失败，如会话级错误——
 * mux 流里没有对应的 turn/end 帧，因此单独开一条流监听）。
 */
// @param api    connection.api（events.host 返回帧的 AsyncIterable）
// @param signal 取消信号（同 runMuxLoop）
async function runHostLoop(
  api: { events: { host: (req: unknown, signal: AbortSignal) => AsyncIterable<{ rpcId: unknown; payload: Frame }> } },
  signal: AbortSignal,
): Promise<void> {
  for await (const env of api.events.host({}, signal)) {
    const frame = env?.payload;
    if (!frame) continue;
    if (frame.type === 'host/agent-error') {
      toast('生成失败', typeof frame.message === 'string' ? (frame.message as string) : '', ICON.error);
    }
  }
}

/**
 * 启动系统通知。引擎常驻（开关在触发时按实时值判断，不用重启）；
 * 总开关开启且权限未决定时兜底申请一次权限，并行消费 mux + host 两条流。
 * 流关闭/出错即整体静默退出：DSH 连接层自身负责重连，页面刷新或下个 socket 代际会重新启动。
 */
// @param api    connection.api（mux/host 两条事件流都由它提供）
// @param signal 生命周期信号：由 app.ts 的 effect 清理函数 abort；终止后两条流退出、
//               聚焦监听解绑、函数返回
// 启动顺序：读总开关 →（可选）兜底申请权限 → 注册聚焦监听 → 并行消费两条流；
// 两条流全部结束（Promise.allSettled）后才收尾解绑监听。
export async function startNotify(
  api: {
    events: {
      mux: (req: unknown, signal: AbortSignal) => AsyncIterable<{ rpcId: unknown; payload: Frame }>;
      host: (req: unknown, signal: AbortSignal) => AsyncIterable<{ rpcId: unknown; payload: Frame }>;
    };
  },
  signal: AbortSignal,
): Promise<void> {
  notifyEnabled = await readNotificationsEnabled();
  if (typeof Notification !== 'undefined' && notifyEnabled && Notification.permission === 'default') {
    void requestNotificationPermission(); // 兜底申请（无手势时浏览器可能压制；真正的申请在设置页开关/按钮点击处）
  }
  const disposeFocus = initFocusTracking();
  try {
    await Promise.allSettled([runMuxLoop(api, signal), runHostLoop(api, signal)]);
  } finally {
    disposeFocus();
  }
}
