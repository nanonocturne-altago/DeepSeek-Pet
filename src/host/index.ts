/**
 * dsh-pet 宿主半侧（host half）—— 宠物插件的"后端"部分
 *
 * 职责：在 DSH Web 服务器上注册 `/dsh-pet-7340/` 前缀路由，把宠物动画 WebM / 配置 JSONC
 * 流式返回给浏览器。源文件（src/host/index.ts）由 tsdown 构建为 lib/index.js。
 *
 * 路由：
 *   /dsh-pet-7340/thumb/<动画名>.<ext>  → 按扩展名分流：.webm→$DSH_HOME/dsh-pet/main-animation/webm（用户目录，优先）→ 包内 assets/webm；
 *                                       .mov → $DSH_HOME/dsh-pet/main-animation/mov（用户目录，优先）→ 包内 assets/mov
 *   /dsh-pet-7340/config.jsonc        → 插件包内 assets/config.jsonc（默认值，只读）
 *   /dsh-pet-7340/config              → 用户覆盖配置（pets / animations / animationWeights，JSON）
 *                                GET 读取、PUT 保存、DELETE 恢复默认（删除用户层）
 *   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径（设置页展示用）
 *
 * 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内。
 *
 * TODO(类型)：peer 依赖类型包本地暂不可解析，ctx/req/res 暂用 any；
 *             依赖可解析后替换为 DSH 官方类型。
 *
 * 已知坑：
 *   - handler 是前缀路由：每个分支都必须显式 return，否则会继续落入后面的分支，
 *     最终走到 thumb 分支并被 400 拒绝；
 *   - balanceTriggerCount 是进程内存态，宿主重启后归零（/balance 动画触发计数）；
 *   - api-key.json 以 0600 落盘，但内容仍是明文 JSON，仅作本地便利存储。
 */
import { createReadStream, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// DSH 运行时依赖（@deepseek-ai/* 由 DSH 宿主提供，不属于本插件自身依赖树）
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
// 本插件 host 半侧内部模块：余额查询（balance.ts）/ 用量计算（usage.ts）
import { queryBalance, type BalanceResult } from './balance';
import { fetchTokenUsage, recordLedgerUsage } from './usage';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ commands（/balance 斜杠命令） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'commands'];

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 路由前缀 */
const ROUTE_PREFIX = '/dsh-pet-7340';

/** 不同扩展名对应的 Content-Type 映射 */
const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
 * @param root 素材根目录（绝对路径）
 * @param rel 请求提供的相对路径（可能含 ..、分隔符混用等恶意/异常输入）
 * @returns 规范化后的绝对文件路径；非法（穿越）或空路径时返回 undefined
 */
function resolveAsset(root: string, rel: string): string | undefined {
  if (rel.length === 0) return undefined;
  const candidate = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root: string, rel: string): string | undefined {
  const candidate = resolveAsset(root, rel);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/** 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。 */
async function sendFile(res: ServerResponse, file: string, contentType: string): Promise<void> {
  const { size } = await stat(file);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': size,
    'cache-control': 'public, max-age=3600',
  });
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** 支持的角落白名单（与 client 端一致） */
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 收集请求体（文本） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve2(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 从 URL 查询串解析音效集合名（?set=duck|fx1），默认 duck */
function soundSetFromUrl(url: string | undefined): string {
  try {
    const q = String(url || '').split('?')[1] || '';
    const m = /(?:^|&)set=([^&]+)/.exec(q);
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

/** 校验并归一化用户配置：只接受 { pets: [...] }，可选顶层 notificationsEnabled（布尔） */
function sanitizeUserConfig(raw: unknown): { pets: unknown[]; notificationsEnabled?: boolean } | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(o.pets) ? o.pets : null;
  if (!arr || !arr.length) return null;
  const out: unknown[] = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') return null;
    const pp = p as Record<string, unknown>;
    const id = String(pp.id ?? '');
    // 有意过滤文件名非法字符（Windows 保留符 + 控制字符），防止配置值逃逸 main-config.json 路径
    // eslint-disable-next-line no-control-regex
    if (!id || id.length > 64 || /[\\/:\x00-\x1f]/.test(id)) return null;
    const size = Number(pp.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    const balanceEnabled = pp.balanceEnabled;
    if (typeof balanceEnabled !== 'boolean') return null;
    const pos = pp.position && typeof pp.position === 'object' ? (pp.position as Record<string, unknown>) : {};
    const corner = String(pos.corner ?? '');
    if (!CORNERS.includes(corner)) return null;
    const marginX = Number(pos.marginX);
    const marginY = Number(pos.marginY);
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
    out.push({ id, size, balanceEnabled, position: { corner, marginX, marginY } });
  }
  const ne = o.notificationsEnabled;
  if (ne !== undefined && typeof ne !== 'boolean') return null;
  const outConfig: { pets: unknown[]; notificationsEnabled?: boolean } = { pets: out };
  if (ne !== undefined) outConfig.notificationsEnabled = ne;
  return outConfig;
}

/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const userRoot = join(resolveDshHome(), 'dsh-pet');
  // 用户覆盖配置（pets / animations / animationWeights 覆盖片段）
  const userConfigPath = join(userRoot, 'main-config.json');
  // 用户动画目录（thumb 播放时优先于包内素材；按扩展名在 webm/mov 子目录分流）
  const thumbUserRoot = join(userRoot, 'main-animation');
  // 挂件设置（移植自插件 A 的 size.json 语义：sound/vol/soundSet/usageMode/scale）
  const widgetSettingsPath = join(userRoot, 'widget-settings.json');
  // 记账模式账本（移植自插件 A 的 .dshw-usage.json：余额差值累计今日已用）
  const usageLedgerPath = join(userRoot, '.dshw-usage.json');
  // 插件本地保存的 DeepSeek API key（覆盖 DSH 凭据存储；文件 0600，GET 只回 hasKey 不回值）
  const apiKeyPath = join(userRoot, 'api-key.json');

  /**
   * 读取插件本地保存的 DeepSeek API key（api-key.json，由 API 更新弹窗写入）。
   * 使用优先级高于 DSH 凭据存储；文件不存在/损坏/值为空 → null，调用方回落凭据存储。
   * @returns key 字符串；不可用返回 null
   */
  function readApiKey(): string | null {
    try {
      const parsed = JSON.parse(readFileSync(apiKeyPath, 'utf8'));
      if (parsed && typeof parsed.key === 'string' && parsed.key.trim().length > 0) return parsed.key;
    } catch {
      /* 不存在 → null（回落凭据存储） */
    }
    return null;
  }
  // 手动触发计数：/balance 命令 +1，client 轮询变化后立即刷新余额并播动画（进程内内存态，重启归零）
  let balanceTriggerCount = 0;

  /** 包内动画素材根：按扩展名分格式存放（assets/webm 或 assets/mov）。 */
  const assetRootFor = (ext: string): string =>
    ext === '.mov' ? join(PACKAGE_ROOT, 'assets', 'mov') : join(PACKAGE_ROOT, 'assets', 'webm');

  /** 用户动画根：同扩展名分流（main-animation/webm 或 main-animation/mov）。 */
  const userRootFor = (ext: string): string =>
    ext === '.mov' ? join(thumbUserRoot, 'mov') : join(thumbUserRoot, 'webm');

  /** 挂件设置默认值（与插件 A 的 size.json 语义一致；intervalSec 为动画链间隔新增项） */
  const DEFAULT_WIDGET_SETTINGS = {
    sound: true,
    vol: 0.9,
    soundSet: 'duck',
    usageMode: 'ledger',
    scale: 1,
    intervalSec: 0,
  };
  type WidgetSettings = typeof DEFAULT_WIDGET_SETTINGS;

  /**
   * 读取挂件设置（widget-settings.json）并对每个字段做类型/范围校验，
   * 非法值一律回落默认——防止手改文件造成的越界（音量>1、缩放越界等）流入渲染层。
   * @returns 与 DEFAULT_WIDGET_SETTINGS 同构的完整设置（缺失字段已用默认值补齐）
   */
  function readWidgetSettings(): WidgetSettings {
    try {
      const parsed = JSON.parse(readFileSync(widgetSettingsPath, 'utf8'));
      const out: Record<string, unknown> = { ...DEFAULT_WIDGET_SETTINGS };
      if (typeof parsed.sound === 'boolean') out.sound = parsed.sound;
      const vol = Number(parsed.vol);
      if (Number.isFinite(vol) && vol >= 0 && vol <= 1) out.vol = Math.round(vol * 100) / 100;
      if (typeof parsed.soundSet === 'string') out.soundSet = normalizeSoundSet(parsed.soundSet);
      if (parsed.usageMode === 'token' || parsed.usageMode === 'ledger') out.usageMode = parsed.usageMode;
      const scale = Number(parsed.scale);
      if (Number.isFinite(scale) && scale >= 0.6 && scale <= 2.5) out.scale = Math.round(scale * 10) / 10;
      const intervalSec = Number(parsed.intervalSec);
      if (Number.isFinite(intervalSec) && intervalSec >= 0 && intervalSec <= 90)
        out.intervalSec = Math.round(intervalSec);
      return out as WidgetSettings;
    } catch {
      return { ...DEFAULT_WIDGET_SETTINGS };
    }
  }

  /**
   * 合并保存挂件设置：在现有设置上应用 patch（逐字段校验，非法字段忽略、保留原值），
   * 随后同步落盘 widget-settings.json（写盘为尽力而为，失败不阻断返回内存态）。
   * @param patch 客户端 PUT 上来的部分设置对象
   * @returns 合并后的完整设置（无论写盘是否成功）
   */
  function writeWidgetSettings(patch: Record<string, unknown>): WidgetSettings {
    const merged = readWidgetSettings();
    if (typeof patch.sound === 'boolean') merged.sound = patch.sound;
    const vol = Number(patch.vol);
    if (Number.isFinite(vol) && vol >= 0 && vol <= 1) merged.vol = Math.round(vol * 100) / 100;
    if (typeof patch.soundSet === 'string') merged.soundSet = normalizeSoundSet(patch.soundSet);
    if (patch.usageMode === 'token' || patch.usageMode === 'ledger') merged.usageMode = patch.usageMode;
    const scale = Number(patch.scale);
    if (Number.isFinite(scale) && scale >= 0.6 && scale <= 2.5) merged.scale = Math.round(scale * 10) / 10;
    const intervalSec = Number(patch.intervalSec);
    if (Number.isFinite(intervalSec) && intervalSec >= 0 && intervalSec <= 90)
      merged.intervalSec = Math.round(intervalSec);
    void mkdir(userRoot, { recursive: true });
    void writeFile(widgetSettingsPath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  }

  /**
   * 音效集合（动态扫描 assets/sound 目录）。
   * 命名规则：`<名称>1.mp3` = 按压声，`<名称>2.mp3` = 松手声；名称即下拉菜单显示名（如「小熊猫1.mp3/小熊猫2.mp3」→「小熊猫」）。
   * 每次请求实时扫描：用户向目录新增/删除成对文件，菜单列表即时生效，无需改代码。
   * 目录始终取自插件自身位置（PACKAGE_ROOT 相对解析），整个插件文件夹搬走后依然指向正确位置。
   */
  const SOUND_DIR = join(PACKAGE_ROOT, 'assets', 'sound');
  /** 校验音效名称（拒绝路径分隔符/Windows 保留符/控制字符，防路径穿越） */
  const isValidSoundName = (name: string): boolean =>
    // eslint-disable-next-line no-control-regex
    name.length > 0 && name.length <= 32 && !/[\\/:*?"<>|\x00-\x1f]/.test(name);
  /** 旧命名（duck/fx1）→ 新命名（名称即显示名）迁移映射 */
  const LEGACY_SOUND_NAMES: Record<string, string> = { duck: '小黄鸭', fx1: '音效' };
  /** 归一化音效名：旧 id 迁移到新命名；非法名回落默认 */
  function normalizeSoundSet(v: string): string {
    if (LEGACY_SOUND_NAMES[v]) return LEGACY_SOUND_NAMES[v];
    return isValidSoundName(v) ? v : '小黄鸭';
  }
  /** 按名称取音效文件路径（1=按压 / 2=松手）；名称非法或文件不存在返回 null */
  function soundFile(name: string, role: '1' | '2'): string | null {
    if (!isValidSoundName(name)) return null;
    const p = join(SOUND_DIR, name + role + '.mp3');
    return existsSync(p) ? p : null;
  }
  /** 扫描音效目录：返回「1/2 成对齐全」的音效组列表（名称即显示名） */
  function scanSoundSets(): Array<{ id: string; label: string }> {
    let files: string[];
    try {
      files = readdirSync(SOUND_DIR);
    } catch {
      return [];
    }
    const names = new Set<string>();
    for (const f of files) {
      const m = /^(.+)([12])\.mp3$/.exec(f);
      if (m && isValidSoundName(m[1])) names.add(m[1]);
    }
    const sets: Array<{ id: string; label: string }> = [];
    for (const name of names) {
      if (!files.includes(name + '1.mp3') || !files.includes(name + '2.mp3')) continue;
      sets.push({ id: name, label: name });
    }
    sets.sort((a, b) => a.id.localeCompare(b.id, 'zh'));
    return sets;
  }

  /**
   * 余额 + 用量合并（/balance 路由的完整数据源）：
   * 1. queryBalance 按当前服务商抓取余额（key 解析优先插件本地 api-key.json，回落 DSH 凭据存储）；
   * 2. 成功后按 usageMode 计算今日已用：ledger=余额差值记账（顺带自动累积小鲸鱼账本）；
   *    token=平台接口峰谷定价（令牌缺失/失效时回落 ledger）。
   * @returns 余额结果 + usage 附加字段（opencode 无「今日已用」语义，todayUsage 恒为 null）
   */
  async function balanceWithUsage(): Promise<BalanceResult & { usage?: { mode: string; todayUsage: number | null } }> {
    const sel = ctx.agentDefaultModel.currentSelection();
    const result: BalanceResult = await queryBalance(sel.provider, async (ref) => {
      // 插件本地保存的 API key 优先（API 更新弹窗写入），未保存则回落 DSH 凭据存储
      if (ref === 'DEEPSEEK_API_KEY') {
        const local = readApiKey();
        if (local) return local;
      }
      const rc = await ctx.credentials.resolve(credentialRef(ref));
      return rc?.value;
    });
    if (!result.ok) return result;
    const settings = readWidgetSettings();
    if (result.kind !== 'deepseek') {
      // opencode：额度窗口已由数据自带，无「今日已用」语义
      return { ...result, usage: { mode: settings.usageMode, todayUsage: null } };
    }
    const total = Number(result.data.total);
    // 无论哪种模式，都先把余额观测记入账本（自动累积「小鲸鱼记账」数据）
    const ledgerUsage = Number.isFinite(total) ? recordLedgerUsage(total, usageLedgerPath) : 0;
    let mode: string = settings.usageMode;
    let todayUsage: number | null = ledgerUsage;
    if (settings.usageMode === 'token') {
      let cred: { value?: string } | undefined;
      try {
        cred = await ctx.credentials.resolve(credentialRef('DEEPSEEK_PLATFORM_TOKEN'));
      } catch {
        cred = undefined;
      }
      if (cred && typeof cred.value === 'string' && cred.value.length > 0) {
        const token = cred.value.replace(/^Bearer\s+/i, '');
        const u = await fetchTokenUsage(token);
        if (u && u.amount !== undefined) {
          todayUsage = u.amount;
        } else {
          mode = 'ledger'; // 令牌失效/无数据：回落记账模式
        }
      } else {
        mode = 'ledger';
      }
    }
    return { ...result, usage: { mode, todayUsage } };
  }

  // 注册 /dsh-pet-7340 前缀路由：DSH 的 ctx.effect 在插件卸载时自动调用返回的 dispose
  // （即 webServer.register 的返回值），确保路由随插件生命周期正确清理。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          // rest = 去掉路由前缀后的剩余路径（仅 pathname，不含 query；已 URL 解码）。
          // 下方按 rest 逐分支路由；任何分支命中后都必须 return，否则会落入后续分支。
          const url = new URL(req.url ?? '/', 'http://localhost');
          const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));

          // 用户覆盖配置：/dsh-pet-7340/config（GET / PUT / DELETE）
          if (rest === 'config') {
            if (req.method === 'GET') {
              try {
                const raw = await readFile(userConfigPath, 'utf8');
                sendJson(res, 200, JSON.parse(raw));
              } catch {
                sendJson(res, 200, {}); // 无覆盖配置 → 空对象，client 回落默认
              }
              return;
            }
            if (req.method === 'PUT') {
              try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const clean = sanitizeUserConfig(parsed);
                if (!clean) {
                  sendJson(res, 400, {
                    error:
                      'invalid pet config: expected { pets:[{id,size,balanceEnabled,position:{corner,marginX,marginY}}] }（可选顶层 notificationsEnabled 布尔）',
                  });
                  return;
                }
                await mkdir(userRoot, { recursive: true });
                await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
                sendJson(res, 200, { ok: true });
              } catch {
                sendJson(res, 400, { error: 'invalid JSON body' });
              }
              return;
            }
            if (req.method === 'DELETE') {
              try {
                await rm(userConfigPath, { force: true });
              } catch {
                /* 不存在也视为成功 */
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }

          // 配置文件路径（设置页「高级配置」展示用）
          if (rest === 'config/meta') {
            sendJson(res, 200, {
              user: userConfigPath,
              default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
              animations: thumbUserRoot,
            });
            return;
          }

          // 余额查询（client 定时/手动拉取；结果由 host 侧完成全部抓取与校验，client 不接触 key）
          if (rest === 'balance') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            try {
              const result = await balanceWithUsage();
              sendJson(res, 200, result);
            } catch (e) {
              // 意外异常（如注入服务缺失）：显式 500，不静默
              sendJson(res, 500, {
                ok: false,
                provider: 'unknown',
                reason: 'fetch-error',
                message: e instanceof Error ? e.message : String(e),
              });
            }
            return;
          }

          // 挂件设置（移植自插件 A 的 size.json）：GET 读取 / PUT 保存（sound/vol/soundSet/usageMode/scale）
          if (rest === 'widget-settings') {
            if (req.method === 'GET') {
              sendJson(res, 200, readWidgetSettings());
              return;
            }
            if (req.method === 'PUT') {
              try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  sendJson(res, 400, { error: 'invalid widget settings body' });
                  return;
                }
                const merged = writeWidgetSettings(parsed as Record<string, unknown>);
                sendJson(res, 200, merged);
              } catch {
                sendJson(res, 400, { error: 'invalid JSON body' });
              }
              return;
            }
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }

          // 插件本地 API key（API 更新弹窗）：GET 只回 hasKey；PUT 保存（0600）；DELETE 清除
          if (rest === 'api-key') {
            if (req.method === 'GET') {
              sendJson(res, 200, { hasKey: readApiKey() !== null });
              return;
            }
            if (req.method === 'PUT') {
              try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const key = typeof parsed?.key === 'string' ? parsed.key.trim() : '';
                if (!key || key.length > 512) {
                  sendJson(res, 400, { error: 'invalid api key: non-empty string, max 512 chars' });
                  return;
                }
                await mkdir(userRoot, { recursive: true });
                writeFileSync(apiKeyPath, JSON.stringify({ key }), { encoding: 'utf8', mode: 0o600 });
                sendJson(res, 200, { ok: true, hasKey: true });
              } catch {
                sendJson(res, 400, { error: 'invalid JSON body' });
              }
              return;
            }
            if (req.method === 'DELETE') {
              try {
                rmSync(apiKeyPath, { force: true });
              } catch {
                /* 尽力清除 */
              }
              sendJson(res, 200, { ok: true, hasKey: false });
              return;
            }
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }
          // 音效列表（每次打开菜单时客户端拉取：实时扫描目录，新增成对文件即生效）
          if (rest === 'sound-sets') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            sendJson(res, 200, { sets: scanSoundSets() });
            return;
          }

          // 打开音效目录（菜单「···」按钮）：在系统文件管理器打开 assets/sound（路径取自插件自身位置，非硬编码绝对路径）
          if (rest === 'open-sound-dir') {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            try {
              if (process.platform === 'darwin') {
                execFile('open', [SOUND_DIR]);
              } else if (process.platform === 'win32') {
                execFile('explorer', [SOUND_DIR]);
              } else {
                sendJson(res, 200, { ok: false, error: 'unsupported platform: ' + process.platform });
                return;
              }
              sendJson(res, 200, { ok: true });
            } catch {
              sendJson(res, 200, { ok: false, error: 'failed to open sound dir' });
            }
            return;
          }

          // 音效文件：/dsh-pet-7340/sound/press.mp3?set=<名称> 与 release.mp3（<名称>1/2.mp3，名称严格校验）
          if (rest === 'sound/press.mp3' || rest === 'sound/release.mp3') {
            const set = soundSetFromUrl(req.url);
            const file = soundFile(set, rest === 'sound/press.mp3' ? '1' : '2');
            if (!file) {
              sendJson(res, 404, { error: 'sound set not found: ' + set });
              return;
            }
            await sendFile(res, file, 'audio/mpeg');
            return;
          }

          // 手动触发计数：/dsh-pet-7340/balance/trigger（no-cache，client 轻量轮询；/balance 命令写入）
          if (rest === 'balance/trigger') {
            const body = JSON.stringify({ count: balanceTriggerCount });
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache, no-store', // 触发计数必须实时，禁止任何缓存层介入
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
          }

          // 配置文件（JSONC）：/dsh-pet-7340/config.jsonc → 包内 assets/config.jsonc
          if (rest === 'config.jsonc') {
            const cfgFile = join(PACKAGE_ROOT, 'assets', 'config.jsonc');
            if (!existsSync(cfgFile)) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: config.jsonc not found');
              return;
            }
            await sendFile(res, cfgFile, MIME['.jsonc'] ?? 'application/octet-stream');
            return;
          }

          // 字体文件：/dsh-pet-7340/font/<file> → 包内 assets/fonts
          const [scope, ...nameParts] = rest.split('/');
          if (scope === 'font') {
            const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
            const fontFile = resolveExisting(fontRoot, nameParts.join('/'));
            if (fontFile === undefined) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: font not found');
              return;
            }
            const ext = fontFile.slice(fontFile.lastIndexOf('.')).toLowerCase();
            await sendFile(res, fontFile, MIME[ext] ?? 'application/octet-stream');
            return;
          }

          // 通知图标：/dsh-pet-7340/pic/<file> → 包内 assets/pic（方形 png，通知 icon 用）
          if (scope === 'pic') {
            const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
            const picFile = resolveExisting(picRoot, nameParts.join('/'));
            if (picFile === undefined) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: pic not found');
              return;
            }
            const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
            await sendFile(res, picFile, MIME[ext] ?? 'application/octet-stream');
            return;
          }

          // 动画文件：/dsh-pet-7340/thumb/<file>，按扩展名分格式目录
          // （.webm → assets/webm，.mov → assets/mov），查找顺序 = 用户动画目录 → 包内素材
          if (scope !== 'thumb') {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: expected /dsh-pet-7340/thumb/<file>');
            return;
          }
          const fileName = nameParts.join('/');
          const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
          if (ext !== '.webm' && ext !== '.mov') {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: unsupported animation format (expected .webm or .mov)');
            return;
          }
          const file = resolveExisting(userRootFor(ext), fileName) ?? resolveExisting(assetRootFor(ext), fileName);
          if (file === undefined) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: asset not found');
            return;
          }
          await sendFile(res, file, MIME[ext] ?? 'application/octet-stream');
        },
      }),
    'dsh-pet: /dsh-pet-7340 asset route',
  );

  // /balance 斜杠命令：递增触发计数 → client 检测到变化后立即刷新余额并播动画（不进模型历史）
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'balance',
        description: '手动触发桌宠余额动画（立即显示余额气泡）',
        handler: () => {
          balanceTriggerCount += 1;
          return { kind: 'success', text: '已触发桌宠余额动画' };
        },
      }),
    'dsh-pet: /balance command',
  );
}
