/**
 * 桌宠配置管理设置页（settings.section 插槽，id: pet-config）
 *
 * - 多开：管理多个桌宠，每个宠物独立 id/size/位置（corner + marginX/Y）
 * - 数据流：设置页持有「合并后的完整宠物列表」→ 保存时全量 PUT /dsh-pet-7340/config
 *   （用户覆盖层 = 完整列表，加载时全量替换默认，天然支持增删）
 * - 即时生效：保存/恢复默认后调用 petBridge.sync 通知容器重新渲染，无需刷新页面
 *
 * 与后端（host）的 HTTP 契约（同源相对路径）：
 * - GET    /dsh-pet-7340/config         读取用户级 main-config.json（含 notificationsEnabled）
 * - PUT    /dsh-pet-7340/config         整包写用户覆盖层（pets + notificationsEnabled）
 * - DELETE /dsh-pet-7340/config         恢复默认 = 删除整个用户覆盖层
 * - GET    /dsh-pet-7340/config/meta    配置文件磁盘路径（「高级配置」区块展示用）
 * - GET    /dsh-pet-7340/config.jsonc   默认配置全文（重置后作为新的「完整列表」）
 *
 * 与其他 client 模块关系：
 * - petBridge（本文件导出）：与 pet.ts 容器共享的单例桥——容器加载配置后写入
 *   current/template 并注册 sync 回调；本页保存/重置后经 sync 通知容器重渲染；
 * - config.ts：assertClientConfig / stripJsonc 用于解析重置后的默认配置；
 * - notify.ts：requestNotificationPermission / reloadNotifications / NOTIFY_ICONS
 *   支撑「系统通知」总开关与权限申请流程；
 * - types.ts：Pet / Corner 与 config.jsonc 同构的类型模型。
 *
 * 样式对齐官方设置页：max-width 720px、全走 --dsw-alias-* 语义 token（主题跟随）。
 */
import { assertClientConfig, stripJsonc } from './config';
import { NOTIFY_ICONS, reloadNotifications, requestNotificationPermission } from './notify';
import type { Corner, Pet } from './types';
import type { ChangeEvent, CSSProperties, Dispatch, FunctionComponent, SetStateAction, useEffect } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 容器与设置页共享的桥（同一 bundle 单例）：
 * current=最新完整宠物列表（默认空）；sync=容器注册的重渲染回调（未注册时为无操作函数）；
 * template=config.jsonc 默认宠物模板（pets[0]），「添加宠物」用它作为默认配置
 *
 * 生命周期：pet.ts 容器挂载时写入 current/template 并注册 sync（卸载时重置为 noop
 * 防悬挂调用）；本页保存/重置/切换通知开关时更新 current 并调用 sync，容器无需重新拉取配置。
 * 因此设置页初始化状态可直接取自 petBridge.current，与屏幕上的宠物严格一致。 */
export const petBridge: {
  current: Pet[];
  sync: (pets: Pet[]) => void;
  template: Pet | undefined;
} = {
  current: [],
  sync: () => {},
  template: undefined,
};

/** 字典命名空间（ctx.locale.bind(NS) 的绑定键；zh/en 表按键一一对应，新增文案需两表同步） */
export const NS = 'pet.config';

/** 中文文案表：键即 t('key') 的 key；与下方 en 一一对应（zh 为基准，新增键必须两表同步，
 * 否则英文环境 t() 返回 undefined 直接渲染到界面上） */
export const zh = {
  nav: '桌宠配置',
  intro: '管理多个桌宠：每个宠物可独立设置大小与位置（保存后即时生效）。',
  petsLabel: '宠物列表',
  add: '添加宠物',
  remove: '删除',
  confirmRemove: '确定删除宠物「{id}」吗？',
  confirmTitle: '确认操作',
  cancel: '取消',
  atLeastOne: '至少保留一个宠物。',
  emptyPets: '暂无宠物，点击「添加宠物」创建。',
  sizeLabel: '大小（宽度 px）',
  sizeHint: '高度自动 = 宽度 × 9/16。',
  balanceEnabled: '余额功能',
  balanceEnabledHint: '启用后该宠物触发余额动画并显示余额气泡。',
  cornerLabel: '位置',
  'corner.top-left': '左上角',
  'corner.top-right': '右上角',
  'corner.bottom-left': '左下角',
  'corner.bottom-right': '右下角',
  marginX: '水平偏移',
  marginY: '垂直偏移',
  save: '保存',
  reset: '恢复默认',
  confirmReset: '确定恢复默认吗？将删除整个用户配置（含自定义的动画池与播放权重）。',
  resetHint: '「重置」会删除整个用户配置（含自定义的动画池与播放权重），不只是宠物列表。',
  configMeta: '高级配置（文件）',
  configMetaHint: '用户配置可覆盖宠物列表 / 动画池 / 播放权重，修改后刷新或重启生效；默认配置为完整参考。',
  defaultConfig: '默认配置（只读，完整参考）',
  userConfig: '用户配置（自定义覆盖）',
  animationDir: '动画素材目录（可自定义/扩充动画）',
  saved: '已保存，桌宠即时生效。',
  loadError: '加载配置失败',
  invalid: '请检查输入：大小需为正数，边距可为任意数字。',
  busy: '保存中…',
  notifyToggle: '系统通知',
  notifyToggleHint: '对话完成 / 生成失败 / 权限申请 / 用户选择，在窗口失焦时弹出系统级通知（桌面右下角）。',
  notifyGetPermission: '获取权限',
  notifyPermissionOk: '已获得通知权限，右下角出现测试通知。',
  notifyDenyUnsupported: '当前环境不支持系统通知（浏览器无 Notification API）。',
  notifyDenyBlocked: '通知权限已被浏览器标记为「阻止」。',
  notifyDenyRejected: '你在权限询问弹窗中选择了「阻止」。',
  notifyDenyError: '申请权限时出错',
  notifyGuide: '引导：点击地址栏左侧 🔒/ⓘ →「网站设置」→「通知」→ 改为「允许」，刷新页面后重试。',
};

/** 英文文案表：与 zh 键一一对应（改文案时两表同步维护） */
export const en = {
  nav: 'Pet Config',
  intro: 'Manage multiple pets: each pet has its own size and position (applies instantly after saving).',
  petsLabel: 'Pets',
  add: 'Add pet',
  remove: 'Remove',
  confirmRemove: 'Delete pet "{id}"?',
  confirmTitle: 'Confirm action',
  cancel: 'Cancel',
  atLeastOne: 'Keep at least one pet.',
  emptyPets: 'No pets yet — click "Add pet" to create one.',
  sizeLabel: 'Size (width px)',
  sizeHint: 'Height is automatic = width × 9/16.',
  balanceEnabled: 'Balance',
  balanceEnabledHint: 'When enabled, this pet plays balance animations and shows the balance bubble.',
  cornerLabel: 'Position',
  'corner.top-left': 'Top-left',
  'corner.top-right': 'Top-right',
  'corner.bottom-left': 'Bottom-left',
  'corner.bottom-right': 'Bottom-right',
  marginX: 'Horizontal offset',
  marginY: 'Vertical offset',
  save: 'Save',
  reset: 'Reset to default',
  confirmReset: 'Reset to default? This deletes the whole user config (including custom animation pools & weights).',
  resetHint:
    '"Reset" deletes the whole user config (including custom animation pools & weights), not just the pet list.',
  configMeta: 'Advanced (files)',
  configMetaHint:
    'User config may override pets / animation pools / weights — refresh or restart to apply. The default config is the complete reference.',
  defaultConfig: 'Default config (read-only, complete reference)',
  userConfig: 'User config (custom overrides)',
  animationDir: 'Animation assets dir (add/customize animations here)',
  saved: 'Saved — the pets updated instantly.',
  loadError: 'Failed to load config',
  invalid: 'Check your input: size must be positive; margins can be any number.',
  busy: 'Saving…',
  notifyToggle: 'System notifications',
  notifyToggleHint:
    'OS-level toasts (bottom-right of the desktop) for conversation completion, failures, permission requests, and questions — only while this window is unfocused.',
  notifyGetPermission: 'Get permission',
  notifyPermissionOk: 'Notification permission granted — a test notification was sent.',
  notifyDenyUnsupported: 'System notifications are not supported in this environment (no Notification API).',
  notifyDenyBlocked: 'Notification permission is blocked by the browser.',
  notifyDenyRejected: 'You chose "Block" in the permission prompt.',
  notifyDenyError: 'Failed to request permission',
  notifyGuide:
    'Guide: click the 🔒/ⓘ icon next to the address bar → Site settings → Notifications → set to "Allow", then refresh and retry.',
};

/**
 * 制造「桌宠配置」设置页组件（工厂函数）。
 *
 * 为什么是工厂而非直接定义组件：client 半侧是 __ModuleLoader__ 单文件形态，
 * react 能力不能顶层 import，只能由 DSH 的 require('react') 在运行时注入，
 * 因此把组件依赖作为参数传入，在工厂内制造出可用的组件后再注册进设置页插槽。
 *
 * @param rt        运行时注入的依赖集合
 * @param rt.h      react/jsx-runtime 的 jsx 函数（即 factory 里的 `h`）——
 *                  用于手写 React 元素，如 `h('button', { onClick, children: '保存' })`
 * @param rt.useState react 的 useState hook——管理页面内可变状态
 *                  （宠物列表 / 选中项 / 忙碌 / 保存消息），值变化时自动重渲染
 * @param rt.useEffect react 的 useEffect hook——挂载时拉取配置元信息与通知开关
 * @param rt.t      locale 绑定到本插件的翻译函数（ctx.locale.bind(NS)）——
 *                  取中英文文案，如 `t('nav')` → '桌宠配置' / 'Pet Config'
 * @returns PetConfigSection 组件：即整个「桌宠配置」设置页
 *          （props 仅有 close，由设置页外壳提供，本页当前未使用）
 *
 * 注：组件初始化状态取自 petBridge.current（容器加载时已合并默认 + 用户覆盖），
 * 因此组件挂载即持有与屏幕一致的宠物列表，无需再自行拉取配置。
 */
export function makePetConfigSection(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  useEffect: typeof useEffect;
  t: (key: string) => string;
}): FunctionComponent<{ close?: () => void }> {
  const { h, useState, useEffect, t } = rt;

  /** 四角枚举（数组顺序 = 下拉框展示顺序；值与 types.ts 的 Corner 类型一致） */
  const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  /** corner 枚举 → 本地化文案：字典键为 'corner.' + 枚举值（如 t('corner.top-left')） */
  const cornerLabel = (c: Corner): string => t('corner.' + c);

  /** 数字输入框/下拉框通用样式（对齐官方设置页输入控件；颜色全走主题 token，跟随深浅色） */
  const inputStyle = {
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '5px 10px',
    fontSize: '13px',
    minHeight: '28px',
    outline: 'none',
  } as CSSProperties;

  /**
   * 生成一个未占用的宠物 id（pet-2、pet-3…）：
   * 从 2 开始递增（默认模板首宠通常为 pet-1），跳过列表中已占用的 id。
   * @param list 当前宠物列表（id 占用来源）
   * @returns 第一个未被占用的 'pet-N' 字符串（恒成功，不会死循环）
   */
  const nextId = (list: Pet[]): string => {
    let n = 2;
    for (; ; n++) {
      const id = 'pet-' + n;
      if (!list.some((p) => p.id === id)) return id;
    }
  };

  /**
   * 「桌宠配置」设置页组件本体（props 仅 close，由设置页外壳提供，本页未使用）。
   * 状态清单：
   * - pets：编辑中的宠物列表（深拷贝自 petBridge.current，保存/重置/切开关时才写回后端与桥）；
   * - selId：当前选中宠物（表单数据源）；busy：请求中锁表单；msg：保存/重置反馈；
   * - confirm：确认弹窗（'remove'=删宠物 / 'reset'=恢复默认，均为破坏性操作需二次确认）；
   * - paths：配置文件路径（「高级配置」区块）；notifyEnabled/permMsg：通知总开关与权限反馈。
   */
  return function PetConfigSection() {
    // 初始化数据源：容器（pet.ts）加载配置后已写入 petBridge.current；
    // 这里深拷贝（position 嵌套对象也拷贝）后交给 useState，避免与容器共享可变引用。
    const initPets = petBridge.current;
    // 编辑中的宠物列表；初始为容器的「合并后完整列表」深拷贝
    const [pets, setPets] = useState<Pet[]>(initPets.map((p) => ({ ...p, position: { ...p.position } })));
    // 当前选中宠物的 id；列表为空时 ''，此时表单区渲染「暂无宠物」空态
    const [selId, setSelId] = useState<string>(initPets[0]?.id ?? '');
    // 请求中标记：禁用表单控件（输入/删除/添加/保存），防止并发写配置
    const [busy, setBusy] = useState(false);
    // 全局保存/重置反馈（操作区按钮旁；kind='err' 红字 / 'ok' 绿字；与权限反馈 permMsg 分离）
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 确认弹窗（仿官方弹窗：遮罩 + 居中卡片 + 双按钮）
    // 'remove'=确认删除当前宠物，'reset'=确认恢复默认（两者均为破坏性操作，需二次确认）
    const [confirm, setConfirm] = useState<null | 'remove' | 'reset'>(null);
    // 配置文件地址（「高级配置」区块；读取失败仅缺省不显示，不影响表单）
    // { user=用户配置路径, default=默认配置路径, animations=动画素材目录 }
    const [paths, setPaths] = useState<null | { user: string; default: string; animations: string }>(null);
    // 挂载时拉取配置文件路径元信息（GET /dsh-pet-7340/config/meta，只读展示用）；
    // 响应非 ok 或失败时 paths 保持 null、高级配置区块不渲染（非核心功能，静默降级）
    useEffect(() => {
      fetch('/dsh-pet-7340/config/meta')
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => setPaths(p))
        .catch(() => console.warn('[dsh-pet] 读取配置文件路径失败'));
    }, []);

    // 系统通知总开关（全局：读写用户级配置 main-config.json 的 notificationsEnabled；即时生效）。
    // 初值 true；挂载后 GET /dsh-pet-7340/config 回填真实值（无用户层时保持默认 true）
    const [notifyEnabled, setNotifyEnabled] = useState(true);
    // 权限申请按钮的反馈（就地显示在按钮旁，与全局保存反馈分离）
    const [permMsg, setPermMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 挂载时读回用户级配置中的 notificationsEnabled（仅当字段存在且为布尔时才覆盖默认 true）；
    // alive 标志防止组件卸载后异步回写已销毁的 state
    useEffect(() => {
      let alive = true;
      fetch('/dsh-pet-7340/config')
        .then((r) => (r.ok && r.status !== 204 ? r.json() : null))
        .then((d) => {
          if (alive && d && typeof d.notificationsEnabled === 'boolean') setNotifyEnabled(d.notificationsEnabled);
        })
        .catch(() => {
          /* 无用户层时保持默认（true） */
        });
      return () => {
        alive = false;
      };
    }, []);

    /**
     * 系统通知总开关的切换处理（勾选即触发，全局生效）：
     * 1. 开启时先借用户手势申请系统通知权限（无手势的自动申请可能被浏览器静默压制）；
     * 2. 与保存同构：整包 PUT 用户级配置（pets + 开关），避免只写开关被 sanitize 拒绝；
     * 3. 成功后同步 petBridge 并 reloadNotifications 让引擎重读开关（即时生效，无需刷新页面）。
     * @param v 目标开关值（true=开启，false=关闭）
     */
    const toggleNotify = async (v: boolean) => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 开启时先借用户手势申请系统通知权限（无手势的自动申请可能被浏览器静默压制）
        if (v) await requestNotificationPermission();
        // 与保存同构：整包写用户级配置（pets + 开关），避免开关写入被 sanitize 拒绝
        const res = await fetch('/dsh-pet-7340/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pets: pets, notificationsEnabled: v }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        setNotifyEnabled(v);
        petBridge.current = pets;
        petBridge.sync(pets);
        void reloadNotifications(); // 引擎重读开关：即时生效，无需刷新页面
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    /**
     * 「获取权限」按钮处理：申请浏览器通知权限并在按钮旁给出就地反馈（permMsg）。
     * 成功：发一条测试通知验证整条链路（个别环境构造失败时静默，仍按已授权提示）；
     * 失败：按 reason 映射红字文案（unsupported 无引导——改环境才有意义，其余附引导）。
     */
    const grantNotifyPermission = async () => {
      setPermMsg({ kind: '', text: '' });
      const r = await requestNotificationPermission();
      if (!r.ok) {
        // 红字：失败理由 + 引导（unsupported 无引导，改环境才有意义）
        const reason =
          r.reason === 'unsupported'
            ? t('notifyDenyUnsupported')
            : r.reason === 'denied'
              ? t('notifyDenyBlocked')
              : r.reason === 'rejected'
                ? t('notifyDenyRejected')
                : t('notifyDenyError') + (r.message ? '：' + r.message : '');
        setPermMsg({ kind: 'err', text: reason + (r.reason === 'unsupported' ? '' : ' ' + t('notifyGuide')) });
        return;
      }
      try {
        // 成功即发一条测试通知验证链路（绕过聚焦门，直接确认）
        new Notification('测试通知', { body: '【dsh-pet】系统通知已就绪。', icon: NOTIFY_ICONS.test });
      } catch {
        /* 个别环境构造失败：仍按已授权提示 */
      }
      setPermMsg({ kind: 'ok', text: t('notifyPermissionOk') });
    };

    // 当前选中的宠物对象（表单数据源）；selId 由 add/remove/reset 同步维护，列表非空时恒有效。
    // 列表为空时 selId=''，find 失败回落 null → 表单区渲染「暂无宠物」空态
    const cur = pets.find((p) => p.id === selId) ?? null;

    /**
     * 更新选中的宠物：size 走顶层；position 子字段整体替换。
     * 不可变更新：只重建 selId 对应的宠物（{ ...p, ...rest }），其余原引用返回
     * （React 靠引用不等判断重渲染）；position 带补丁时浅合并 { ...p.position, ...posPatch }，
     * 不带时原样保留。
     * @param patch 顶层字段补丁（size/balanceEnabled）+ 可选的 position 子字段补丁（corner/marginX/marginY）
     */
    const updateSel = (patch: Partial<Omit<Pet, 'position'>> & { position?: Partial<Pet['position']> }) =>
      setPets((list) =>
        list.map((p) => {
          if (p.id !== selId) return p;
          const { position: posPatch, ...rest } = patch;
          return { ...p, ...rest, position: posPatch ? { ...p.position, ...posPatch } : p.position };
        }),
      );

    /**
     * 表单校验（保存前调用）：逐宠物检查 size 为正有限数、marginX/marginY 为有限数。
     * 任一非法：写入红字错误消息（t('invalid')）并返回 false，保存流程中止。
     * 注意：输入框 Number('') = 0，空输入会被 size<=0 拦截；边距允许任意数字（含负值）。
     * @returns 全部合法返回 true；否则 false（副作用：设置错误消息）
     */
    const validated = (): boolean => {
      for (const p of pets) {
        if (
          !Number.isFinite(p.size) ||
          p.size <= 0 ||
          !Number.isFinite(p.position.marginX) ||
          !Number.isFinite(p.position.marginY)
        ) {
          setMsg({ kind: 'err', text: t('invalid') });
          return false;
        }
      }
      return true;
    };

    /**
     * 「保存」按钮处理：校验通过后整包 PUT /dsh-pet-7340/config。
     * 关键细节：先 GET 读回用户级配置里的 notificationsEnabled（可能为手写值），
     * 存在则随包回写——避免全量覆盖时把手写的通知开关冲掉；读取失败（无用户层）时忽略。
     * 成功后同步 petBridge（current + sync），容器即时重渲染。
     */
    const save = async () => {
      const isOk = validated();
      if (!isOk) return;
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 保留用户级配置（main-config.json）里手写的 notificationsEnabled，避免保存时被整体覆盖丢失
        let notificationsEnabled: boolean | undefined;
        try {
          const prev = await fetch('/dsh-pet-7340/config');
          if (prev.ok && prev.status !== 204) {
            const pj = await prev.json().catch(() => null);
            if (pj && typeof pj.notificationsEnabled === 'boolean') notificationsEnabled = pj.notificationsEnabled;
          }
        } catch {
          /* 无用户层时忽略 */
        }
        const body: Record<string, unknown> = { pets: pets };
        if (notificationsEnabled !== undefined) body.notificationsEnabled = notificationsEnabled;
        const res = await fetch('/dsh-pet-7340/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        petBridge.current = pets;
        petBridge.sync(pets);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    /** 「恢复默认」按钮：只弹确认框，真正的删除在 doReset（防止误触清掉整个用户配置） */
    const reset = () => setConfirm('reset');

    /**
     * 确认恢复默认：DELETE /dsh-pet-7340/config（删除整个用户覆盖层，含动画池/权重等高级自定义）
     * → 拉取默认配置 config.jsonc → assertClientConfig 校验 → 以其 pets 作为新的完整列表
     * → 同步本地 state 与 petBridge（即时生效）。
     * 任一环节失败：红字 loadError，配置保持原样。
     */
    const doReset = async () => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        await fetch('/dsh-pet-7340/config', { method: 'DELETE' });
        const defRes = await fetch('/dsh-pet-7340/config.jsonc');
        const defs = assertClientConfig(JSON.parse(stripJsonc(await defRes.text()))).pets;
        setPets(defs.map((p) => ({ ...p, position: { ...p.position } })));
        setSelId(defs[0]?.id ?? '');
        petBridge.current = defs;
        petBridge.sync(defs);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    /**
     * 添加宠物：以 petBridge.template（config.jsonc 的 pets[0]）为模板，
     * 分配新 id（nextId，跳过已占用 id），追加到列表末尾并选中新宠物。
     * 模板缺失（容器尚未加载完成）时静默忽略。
     * 注意：此时仅改本地 state，需点「保存」才落盘。
     */
    const addPet = () => {
      const tpl = petBridge.template;
      if (!tpl) return;
      const id = nextId(pets);
      setPets((list) => [
        ...list,
        { id, size: tpl.size, balanceEnabled: tpl.balanceEnabled, position: { ...tpl.position } },
      ]);
      setSelId(id);
    };

    /**
     * 「删除」按钮：只剩一只宠物时拒绝（至少保留一只，红字提示）；
     * 否则弹确认框（doRemove 才真正删除，需用户二次确认）。
     */
    const removeSel = () => {
      if (pets.length <= 1) {
        setMsg({ kind: 'err', text: t('atLeastOne') });
        return;
      }
      setConfirm('remove');
    };

    /** 确认删除选中宠物：过滤掉 selId 后重选列表第一只（此时列表至少 2 只，恒有第一项）；
     * 同样仅改本地 state，需点「保存」才落盘 */
    const doRemove = () => {
      const list = pets.filter((p) => p.id !== selId);
      setPets(list);
      setSelId(list[0].id);
    };

    /**
     * 数字输入框工厂（size / marginX / marginY 三个字段共用）：
     * size 步进 10、min 120；边距步进 1 且无 min（允许负值——偏移可为任意方向）。
     * onChange 立即 Number(...) 写回 state（空输入 Number('') = 0，由 validated 兜底拦截）。
     * @param key 字段类型（决定 step / min 规则）
     * @param value 当前值（受控组件）
     * @param setter 写回回调（闭包内调用 updateSel 打补丁）
     * @param width 输入框宽度（px）
     */
    const field = (key: 'size' | 'marginX' | 'marginY', value: number, setter: (v: number) => void, width: string) =>
      h('input', {
        type: 'number',
        step: key === 'size' ? '10' : '1',
        min: key === 'size' ? '120' : '',
        value: String(value),
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
        style: { width, ...inputStyle },
      });

    // 渲染顺序：标题/简介 → 宠物列表（选择+添加）→ 选中宠物表单 → 系统通知总开关 →
    // 权限申请 → 操作区（保存/重置）→ 重置副作用提示 → 高级配置 → 确认弹窗
    return h('section', {
      style: {
        maxWidth: '720px',
        color: 'var(--dsw-alias-label-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      children: [
        h('h2', {
          style: { margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: '24px' },
          children: t('nav'),
        }),
        h('p', {
          style: {
            margin: 0,
            fontSize: '14px',
            color: 'var(--dsw-alias-label-tertiary)',
            lineHeight: '22px',
          },
          children: t('intro'),
        }),

        // 宠物列表 + 添加
        h('div', {
          style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '4px' },
          children: [
            h('span', {
              style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
              children: t('petsLabel'),
            }),
            ...pets.map((p) =>
              h('button', {
                key: p.id,
                type: 'button',
                onClick: () => setSelId(p.id),
                style: {
                  border:
                    '1px solid ' +
                    (p.id === selId ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'),
                  background: p.id === selId ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  borderRadius: '8px',
                  padding: '4px 12px',
                  fontSize: '13px',
                  cursor: 'pointer',
                },
                children: p.id + ' (' + p.size + 'px)',
              }),
            ),
            h('button', {
              type: 'button',
              onClick: addPet,
              disabled: busy,
              style: {
                border: '1px dashed var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                borderRadius: '8px',
                padding: '4px 12px',
                fontSize: '13px',
                cursor: 'pointer',
              },
              children: '+ ' + t('add'),
            }),
          ],
        }),

        // 选中宠物表单（cur 为 null 时显示空态提示）
        cur
          ? h('div', {
              style: {
                display: 'flex',
                gap: '16px',
                flexWrap: 'wrap',
                marginTop: '8px',
                padding: '12px 14px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '12px',
              },
              children: [
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('sizeLabel'),
                    field('size', cur.size, (v) => updateSel({ size: v }), '150px'),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('sizeHint'),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('cornerLabel'),
                    h('select', {
                      value: cur.position.corner,
                      disabled: busy,
                      onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                        updateSel({ position: { corner: e.target.value as Corner } }),
                      style: { width: '160px', ...inputStyle },
                      children: CORNERS.map((c) =>
                        h('option', {
                          key: c,
                          value: c,
                          children: cornerLabel(c),
                        }),
                      ),
                    }),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('marginX'),
                    field('marginX', cur.position.marginX, (v) => updateSel({ position: { marginX: v } }), '120px'),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('marginY'),
                    field('marginY', cur.position.marginY, (v) => updateSel({ position: { marginY: v } }), '120px'),
                  ],
                }),
                h('label', {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                  children: [
                    t('balanceEnabled'),
                    h('input', {
                      type: 'checkbox',
                      checked: !!cur.balanceEnabled,
                      disabled: busy,
                      onChange: (e: ChangeEvent<HTMLInputElement>) => updateSel({ balanceEnabled: e.target.checked }),
                      style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)' },
                    }),
                    h('span', {
                      style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: t('balanceEnabledHint'),
                    }),
                  ],
                }),
                h('button', {
                  type: 'button',
                  onClick: removeSel,
                  disabled: busy,
                  title: t('remove'),
                  style: {
                    alignSelf: 'flex-end',
                    border: '1px solid var(--dsw-alias-state-error-secondary)',
                    background: 'transparent',
                    color: 'var(--dsw-alias-state-error-primary)',
                    borderRadius: '8px',
                    padding: '4px 12px',
                    fontSize: '12px',
                    cursor: 'pointer',
                  },
                  children: t('remove'),
                }),
              ],
            })
          : h('p', {
              style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' },
              children: t('emptyPets'),
            }),

        // 系统通知总开关（全局，写入用户级配置；即时生效，不归属单个宠物）
        h('label', {
          style: {
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            marginTop: '8px',
            fontSize: '13px',
            color: 'var(--dsw-alias-label-primary)',
          },
          children: [
            h('input', {
              type: 'checkbox',
              checked: notifyEnabled,
              disabled: busy,
              onChange: (e: ChangeEvent<HTMLInputElement>) => void toggleNotify(e.target.checked),
              style: { width: '16px', height: '16px', accentColor: 'var(--dsw-alias-state-business-primary)' },
            }),
            h('span', { children: t('notifyToggle') }),
            h('span', {
              style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
              children: t('notifyToggleHint'),
            }),
          ],
        }),

        // 权限获取按钮 + 反馈（独立一行，样式对齐设置页现有按钮）
        h('div', {
          style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' },
          children: [
            h('button', {
              type: 'button',
              onClick: () => void grantNotifyPermission(),
              style: {
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: '8px',
                padding: '4px 14px',
                fontSize: '12px',
                cursor: 'pointer',
              },
              children: t('notifyGetPermission'),
            }),
            permMsg.text
              ? h('span', {
                  style: {
                    fontSize: '12px',
                    color:
                      permMsg.kind === 'err'
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-state-ok-primary)',
                    lineHeight: '18px',
                  },
                  children: permMsg.text,
                })
              : null,
          ],
        }),

        // 操作区
        h('div', {
          style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' },
          children: [
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: save,
              style: {
                border: '1px solid var(--dsw-alias-button-info-fill)',
                background: 'var(--dsw-alias-button-info-fill)',
                color: '#fff',
                borderRadius: '8px',
                padding: '4px 14px',
                fontSize: '12px',
                cursor: 'pointer',
                opacity: busy ? 0.5 : 1,
              },
              children: t('save'),
            }),
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: reset,
              style: {
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: '8px',
                padding: '4px 14px',
                fontSize: '12px',
                cursor: 'pointer',
                opacity: busy ? 0.5 : 1,
              },
              children: t('reset'),
            }),
            msg.text
              ? h('span', {
                  style: {
                    fontSize: '12px',
                    color:
                      msg.kind === 'err' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-ok-primary)',
                    marginLeft: '4px',
                  },
                  children: msg.text,
                })
              : null,
          ],
        }),

        // 重置的副作用提示（DELETE 会清掉整个用户配置，含高级自定义）
        h('p', {
          style: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: '16px' },
          children: t('resetHint'),
        }),

        // 高级配置（文件地址）：供高级用户直接编辑配置文件自定义
        paths
          ? h('div', {
              style: {
                marginTop: '12px',
                padding: '10px 14px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-secondary)',
              },
              children: [
                h('div', {
                  style: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
                  children: t('configMeta'),
                }),
                h('div', { style: { fontSize: '12px', lineHeight: '20px' }, children: t('configMetaHint') }),
                h('div', {
                  style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all' },
                  children: t('defaultConfig') + '：' + paths.default,
                }),
                h('div', {
                  style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all' },
                  children: t('userConfig') + '：' + paths.user,
                }),
                h('div', {
                  style: { fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all' },
                  children: t('animationDir') + '：' + paths.animations,
                }),
              ],
            })
          : null,

        // 确认弹窗（仿官方弹窗视觉：遮罩 + 居中卡片 + 双按钮）
        confirm
          ? h('div', {
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 2147483647,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.45)',
              },
              // 点遮罩关闭；内部卡片 stopPropagation 阻止冒泡，避免点卡片内误关
              onClick: () => setConfirm(null),
              children: h('div', {
                style: {
                  width: '340px',
                  maxWidth: 'calc(100vw - 40px)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '12px',
                  padding: '16px 18px',
                  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                },
                onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
                children: [
                  h('div', {
                    style: { fontSize: '14px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
                    children: t('confirmTitle'),
                  }),
                  h('div', {
                    style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                    children: confirm === 'remove' ? t('confirmRemove').replace('{id}', selId) : t('confirmReset'),
                  }),
                  h('div', {
                    style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
                    children: [
                      h('button', {
                        type: 'button',
                        onClick: () => setConfirm(null),
                        style: {
                          border: '1px solid var(--dsw-alias-border-l2)',
                          background: 'transparent',
                          color: 'var(--dsw-alias-label-primary)',
                          borderRadius: '8px',
                          padding: '4px 14px',
                          fontSize: '12px',
                          cursor: 'pointer',
                        },
                        children: t('cancel'),
                      }),
                      h('button', {
                        type: 'button',
                        onClick: () => {
                          // 确认按钮：先存弹窗类型再关闭（setConfirm 后本渲染周期的 confirm 不变，
                          // 显式存 k 更稳健），按类型分流——remove=删除选中宠物，reset=恢复默认（异步 void）
                          const k = confirm;
                          setConfirm(null);
                          if (k === 'remove') doRemove();
                          else void doReset();
                        },
                        style:
                          confirm === 'remove'
                            ? {
                                border: '1px solid var(--dsw-alias-state-error-secondary)',
                                background: 'transparent',
                                color: 'var(--dsw-alias-state-error-primary)',
                                borderRadius: '8px',
                                padding: '4px 14px',
                                fontSize: '12px',
                                cursor: 'pointer',
                              }
                            : {
                                border: '1px solid var(--dsw-alias-button-info-fill)',
                                background: 'var(--dsw-alias-button-info-fill)',
                                color: '#fff',
                                borderRadius: '8px',
                                padding: '4px 14px',
                                fontSize: '12px',
                                cursor: 'pointer',
                              },
                        children: confirm === 'remove' ? t('remove') : t('reset'),
                      }),
                    ],
                  }),
                ],
              }),
            })
          : null,
      ],
    });
  };
}
