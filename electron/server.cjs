/**
 * 独立版本地 HTTP 服务（Electron 主进程内运行，仅监听 127.0.0.1 随机端口）。
 *
 * 职责：为渲染页提供与 DSH 插件宿主完全同构的 /dsh-pet-7340 路由，
 *       宠物客户端代码（pet/menu/balance/config 等）零改动直接复用：
 *   - 静态资源：/index.html、/renderer.js、/thumb（webm 动画）、/font、/pic
 *   - 宠物配置：/config.jsonc（包内默认层）、/config（用户覆盖层 main-config.json）
 *   - 余额与用量：/balance（deepseek 官方 /user/balance + 记账/峰谷计价双模式）、
 *                 /balance/trigger（轻量刷新触发，直接回 ok）
 *   - 挂件设置：/widget-settings（GET/PUT，与插件版同构校验）
 *   - 音效：/sound-sets（目录实时扫描，命名规则 <名称>1/2.mp3）、
 *           /sound/press|release.mp3?set=<名称>
 *   - API key：/api-key（GET 只回 hasKey / PUT 保存 / DELETE 清除，文件 0600）
 *   - 打开音效目录：/open-sound-dir（macOS 用 open、Windows 用 explorer）
 *
 * 数据目录（app.getPath('userData')，即 ~/Library/Application Support/DeepSeekPet）：
 *   widget-settings.json / main-config.json / api-key.json / .dshw-usage.json / sound/
 *   首次启动时把包内两套自带音效（小黄鸭/音效）播种进 sound/ 目录。
 *
 * 凭据解析优先级（只读值，绝不打印）：
 *   插件本地 api-key.json → ~/.dsh/.credentials.yaml（DSH 官方凭据存储，与插件版共用）
 *   → 环境变量 DEEPSEEK_API_KEY。平台令牌（DEEPSEEK_PLATFORM_TOKEN）同理（无则回落记账）。
 *
 * 已知坑：
 *   - 打包后资源位于 app.asar 内，fs 读取由 Electron 自动透传，路径一律用 join(APP_ROOT,...)；
 *   - 音效目录必须用 userData 下的真实目录（asar 内目录无法被 open/explorer 打开）。
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
/**
 * Electron 应用对象（仅主进程内可用；纯 node 测试环境下 require('electron') 返回路径字符串，
 * 此时优雅降级为「非打包/用户目录」行为，保证测试装置可独立运行 server.cjs）
 */
let electronApp = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.app) electronApp = electron.app;
} catch {
  electronApp = null;
}
const isPackagedApp = electronApp ? electronApp.isPackaged : false;
/** 应用数据目录（打包后）：~/Library/Application Support/DeepSeekPet 等 */
const appUserDataDir = () =>
  electronApp ? electronApp.getPath('userData') : path.join(os.homedir(), '.dsh', 'dsh-pet');
/** 用户数据目录（默认与插件版共享 ~/.dsh/dsh-pet）：设置/账本/key 的落盘处；
 *  注意：音效与动画目录不走这里（见 resolveSoundDir 与 ANIME_DIR） */
const USER_DATA = process.env.DSH_PET_USER_DATA || path.join(os.homedir(), '.dsh', 'dsh-pet');

// ==================== 路径常量 ====================
/** 应用根目录：源码运行时 = 项目根；打包后 = app.asar 内（fs 读取透明） */
const APP_ROOT = path.join(__dirname, '..');
/** 包内资源：动画/字体/图标/默认配置/自带音效 */
const ASSET_DIR = path.join(APP_ROOT, 'assets');
/**
 * 解析 JSONC（支持 // 与 /* 注释；字符串感知，注释标记在字符串内不误伤）
 */
function parseJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  while (i < text.length) {
    const ch = text[i];
    const nx = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && nx === '/') {
        inBlock = false;
        i += 2;
      } else i++;
      continue;
    }
    if (inStr) {
      out += ch;
      if (ch === '\\') {
        out += nx;
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && nx === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === '/' && nx === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out);
}

/**
 * 用户动画目录（DIY 可维护性）：
 * - macOS 应用：~/Library/Application Support/DSH.Pet.Anime
 * - Windows 便携版：exe 同级 motion/
 * - 开发/测试模式：USER_DATA/anime（避免污染真实目录）
 * 首次启动把包内动画按「触发类别」分文件夹播种（idle/turn/moves/clicks/drag/balance + 各分类动作 id），
 * 之后 /thumb 优先从该目录取文件（缺文件回落包内 webm），用户替换/新增文件即可 DIY。
 */
const ANIME_DIR = (() => {
  if (isPackagedApp && process.platform === 'darwin') return path.join(appUserDataDir(), 'DSH.Pet.Anime');
  if (isPackagedApp && process.platform === 'win32') return path.join(path.dirname(process.execPath), 'motion');
  return path.join(USER_DATA, 'anime');
})();

/** 动画名 → 子文件夹 映射（由包内 config.jsonc 的动画分类构建） */
const ANIME_FOLDER_MAP = buildAnimeFolderMap();
function buildAnimeFolderMap() {
  const map = new Map();
  try {
    const raw = fs.readFileSync(path.join(ASSET_DIR, 'config.jsonc'), 'utf8');
    const cfg = parseJsonc(raw);
    const an = (cfg && cfg.animations) || {};
    const put = (list, folder) => {
      for (const n of list || []) map.set(String(n), folder);
    };
    put(an.idle, 'idle');
    put(an.turn, 'turn');
    put(an.drag, 'drag');
    put(an.clicks, 'clicks');
    put(an.events && an.events.balance, 'balance');
    put((an.moves && an.moves.actions || []).map((a) => a.name), 'moves');
    for (const cat of an.categories || []) put(cat.actions, String(cat.id));
  } catch (e) {
    console.error('[server] 动画分类映射构建失败（回退全部指向 webm 根）', e);
  }
  return map;
}

/** 首次启动：把包内动画按分类播种进用户动画目录（缺文件才复制，不覆盖用户改动） */
function seedAnimeDirs() {
  try {
    for (const [name, folder] of ANIME_FOLDER_MAP) {
      const dest = path.join(ANIME_DIR, folder, name + '.webm');
      if (fs.existsSync(dest)) continue;
      const src = path.join(ASSET_DIR, 'webm', name + '.webm');
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  } catch (e) {
    console.error('[server] 动画播种失败', e);
  }
}
/** 用户覆盖配置（对应插件版的 $DSH_HOME/dsh-pet/main-config.json） */
const USER_CONFIG_PATH = path.join(USER_DATA, 'main-config.json');
/** 挂件设置（大小/音效/音量/间隔/用量模式） */
const WIDGET_SETTINGS_PATH = path.join(USER_DATA, 'widget-settings.json');
/** 插件本地 API key（API 弹窗保存，0600 权限） */
const API_KEY_PATH = path.join(USER_DATA, 'api-key.json');
/** 记账账本（余额差值累计今日已用） */
const LEDGER_PATH = path.join(USER_DATA, '.dshw-usage.json');
/**
 * 用户音效目录（可写、可被系统文件管理器打开）：
 * - Windows 便携版：exe 同级的 sound/ 文件夹——相对 exe 定位，用户一眼可见（不可写时回落用户数据目录）；
 * - macOS 应用：标准应用数据目录 app.getPath('userData')/sound（~/Library/Application Support/DeepSeekPet/sound），
 *   不再使用与插件版共享的 ~/.dsh/dsh-pet；经菜单「···」按钮一键打开；
 * - 开发模式：与插件版共享的 USER_DATA/sound（不污染真实应用数据）。
 */
function resolveSoundDir() {
  if (!isPackagedApp) return path.join(USER_DATA, 'sound'); // 开发模式
  if (process.platform === 'win32') {
    const exeDir = path.dirname(process.execPath);
    const candidate = path.join(exeDir, 'sound');
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate; // exe 同目录可写 → 就用它
    } catch {
      /* exe 目录只读（如被放在受保护位置）→ 回落到用户数据目录 */
    }
    return path.join(appUserDataDir(), 'sound');
  }
  if (process.platform === 'darwin') return path.join(appUserDataDir(), 'sound');
  return path.join(USER_DATA, 'sound');
}
const SOUND_DIR = resolveSoundDir();
/** 旧音效目录（历史版本曾使用与插件版共享的 ~/.dsh/dsh-pet/sound），首次迁移来源 */
const LEGACY_SOUND_DIR = path.join(USER_DATA, 'sound');
/** DSH 官方凭据存储（与插件版共用，仅读取） */
const DSH_CREDENTIALS_PATH = path.join(os.homedir(), '.dsh', '.credentials.yaml');

/** 挂件设置默认值（与插件版 host 一致） */
const DEFAULT_WIDGET_SETTINGS = { sound: true, vol: 0.9, soundSet: 'duck', usageMode: 'ledger', scale: 1, intervalSec: 0 };
/** 旧音效组名 → 新命名规则（<名称>1/2.mp3）的迁移映射（与插件版一致） */
const LEGACY_SOUND_MAP = { duck: '小黄鸭', fx1: '音效' };

// ==================== 工具函数 ====================

/** 音效名称合法性：拒绝路径分隔符 / Windows 保留符 / 控制字符，防路径穿越 */
function isValidSoundName(name) {
  // eslint-disable-next-line no-control-regex
  return name.length > 0 && name.length <= 32 && !/[\\/:*?"<>|\u0000-\u001f]/.test(name);
}

/** 旧组名迁移：duck→小黄鸭、fx1→音效；其余原样（若合法） */
function normalizeSoundSet(name) {
  if (typeof name !== 'string') return DEFAULT_WIDGET_SETTINGS.soundSet;
  if (LEGACY_SOUND_MAP[name]) return LEGACY_SOUND_MAP[name];
  return isValidSoundName(name) ? name : DEFAULT_WIDGET_SETTINGS.soundSet;
}

/** 读取挂件设置文件；缺失/损坏 → 默认值（逐字段软校验，与插件版同构） */
function readWidgetSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(WIDGET_SETTINGS_PATH, 'utf8'));
  } catch {
    /* 不存在/损坏 → 默认 */
  }
  const out = { ...DEFAULT_WIDGET_SETTINGS };
  if (typeof raw.sound === 'boolean') out.sound = raw.sound;
  if (typeof raw.vol === 'number' && isFinite(raw.vol)) out.vol = Math.min(1, Math.max(0, raw.vol));
  if (typeof raw.soundSet === 'string') out.soundSet = normalizeSoundSet(raw.soundSet);
  if (raw.usageMode === 'token' || raw.usageMode === 'ledger') out.usageMode = raw.usageMode;
  const scale = Number(raw.scale);
  if (isFinite(scale)) out.scale = Math.min(2.5, Math.max(0.6, scale));
  const interval = Number(raw.intervalSec);
  if (isFinite(interval)) out.intervalSec = Math.min(90, Math.max(0, interval));
  return out;
}

/** 合并写回挂件设置（只接受白名单字段，未知字段丢弃） */
function writeWidgetSettings(patch) {
  const cur = readWidgetSettings();
  const merged = { ...cur };
  if (typeof patch.sound === 'boolean') merged.sound = patch.sound;
  if (typeof patch.vol === 'number' && isFinite(patch.vol)) merged.vol = Math.min(1, Math.max(0, patch.vol));
  if (typeof patch.soundSet === 'string') merged.soundSet = normalizeSoundSet(patch.soundSet);
  if (patch.usageMode === 'token' || patch.usageMode === 'ledger') merged.usageMode = patch.usageMode;
  const scale = Number(patch.scale);
  if (isFinite(scale)) merged.scale = Math.min(2.5, Math.max(0.6, scale));
  const interval = Number(patch.intervalSec);
  if (isFinite(interval)) merged.intervalSec = Math.min(90, Math.max(0, interval));
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(WIDGET_SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/** 读取插件本地 API key（API 弹窗保存）；不存在/损坏 → null */
function readApiKey() {
  try {
    const parsed = JSON.parse(fs.readFileSync(API_KEY_PATH, 'utf8'));
    return typeof parsed.key === 'string' && parsed.key.length > 0 ? parsed.key : null;
  } catch {
    return null;
  }
}

/** 从 DSH 官方凭据存储读一个凭据（极简 YAML 正则解析；只读不写、不打印值） */
function readCredential(name) {
  try {
    const text = fs.readFileSync(DSH_CREDENTIALS_PATH, 'utf8');
    const m = text.match(new RegExp('^\\s*' + name + '\\s*:\\s*["\']?([^"\'\\n]+)', 'm'));
    if (m) {
      const v = m[1].trim();
      if (v.length > 0) return v;
    }
  } catch {
    /* 无凭据文件 → 环境变量兜底 */
  }
  return process.env[name] || undefined;
}

/** 解析 DEEPSEEK_API_KEY：插件本地 key 优先，其次 DSH 凭据存储，最后环境变量 */
function resolveApiKey() {
  const local = readApiKey();
  if (local) return local;
  return readCredential('DEEPSEEK_API_KEY');
}

// ==================== 记账 / 峰谷计价（忠实移植自插件版 src/host/usage.ts） ====================

/** 今日日期键（YYYY-MM-DD，宿主本地时区） */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 读取账本；缺失/损坏 → 新建空账本 */
function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed;
  } catch {
    /* 重建 */
  }
  return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} };
}

/** 落盘账本；失败静默（记账尽力而为，绝不阻断余额链路） */
function writeLedger(led) {
  try {
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(led), 'utf8');
  } catch {
    /* 跳过 */
  }
}

/**
 * 记账模式：余额下降差值累计当天用量（充值不扣减；跨天归档最近 30 天）。
 * @returns 当天累计用量（元）
 */
function recordLedgerUsage(currentBalance) {
  const t = todayKey();
  const led = readLedger();
  if (led.date !== t) {
    if (led.date && typeof led.todayUsage === 'number') {
      led.history = led.history || {};
      led.history[led.date] = led.todayUsage;
    }
    led.date = t;
    led.lastBalance = currentBalance;
    led.todayUsage = 0;
  } else {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance;
    if (currentBalance < prev) led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance);
    led.lastBalance = currentBalance;
  }
  const keys = Object.keys(led.history || {}).sort();
  while (keys.length > 30) {
    const k = keys.shift();
    if (k !== undefined) delete led.history[k];
  }
  writeLedger(led);
  return typeof led.todayUsage === 'number' ? led.todayUsage : 0;
}

/** 高峰时段（北京时间小时区间，半开 [start, end)） */
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
];
/** 每百万 token 单价：[[空闲价, 高峰价]...]；hit=缓存命中输入 / miss=缓存未命中输入 / out=输出 */
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] };

/** bucket 时间戳（epoch 秒）→ 是否高峰（北京时间） */
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false;
  const hour = new Date(Number(timeSec) * 1000 + 8 * 3600 * 1000).getUTCHours();
  return PEAK_HOURS.some(([s, e]) => hour >= s && hour < e);
}

/**
 * 实时·令牌模式：平台用量接口返回 token 分桶，按峰谷定价换算今日金额。
 * @returns { amount, tokens }；失败/无数据返回 null（上层回落记账模式）
 */
async function fetchTokenUsage(token) {
  try {
    const now = new Date();
    const tz = -now.getTimezoneOffset() * 60;
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const end = start + 86400;
    const url = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=' + start + '&end=' + end + '&tz=' + tz;
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const d = body && body.data;
    let series;
    if (d && d.biz_data && Array.isArray(d.biz_data.series)) series = d.biz_data.series;
    else if (d && Array.isArray(d.series)) series = d.series;
    if (!series || series.length === 0) return null;
    let cost = 0;
    let tokens = 0;
    let found = false;
    for (const s of series) {
      if (!s || typeof s !== 'object') continue;
      const buckets = Array.isArray(s.buckets) ? s.buckets : [];
      for (const b of buckets) {
        const u = b && typeof b === 'object' ? b.usage : undefined;
        if (!u || typeof u !== 'object') continue;
        const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0;
        const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0;
        const out = Number(u.RESPONSE_TOKEN) || 0;
        if (hit + miss + out === 0) continue;
        found = true;
        tokens += hit + miss + out;
        const pi = isPeakTime(b.time) ? 1 : 0;
        cost += (hit / 1e6) * BASE_PRICE.hit[pi] + (miss / 1e6) * BASE_PRICE.miss[pi] + (out / 1e6) * BASE_PRICE.out[pi];
      }
    }
    return found ? { amount: cost, tokens } : null;
  } catch {
    return null;
  }
}

// ==================== 余额查询（deepseek 官方 /user/balance） ====================

/** 抓取一次（20s 超时 + 3 次重试、0.8s 线性退避；与插件版一致） */
async function fetchDeepseekBalance(key) {
  let last;
  for (let i = 0; i <= 3; i++) {
    try {
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: 'Bearer ' + key, 'User-Agent': 'dsh-pet-balance' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('deepseek balance HTTP ' + res.status);
      const body = await res.json();
      const infos = body && body.balance_infos;
      if (!Array.isArray(infos) || infos.length === 0) throw new Error('dsh-pet: deepseek balance 响应缺少 balance_infos');
      const first = infos[0];
      return {
        currency: String(first.currency),
        total: String(first.total_balance),
        granted: String(first.granted_balance),
        toppedUp: String(first.topped_up_balance),
      };
    } catch (e) {
      last = e;
      if (i < 3) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * /balance 主逻辑：查询余额 + 计算今日已用。
 * 响应形状与插件版 wire 格式完全一致（client/balance.ts 零改动解析）。
 */
async function balanceWithUsage() {
  const key = resolveApiKey();
  if (!key) return { ok: false, provider: 'deepseek-official', kind: 'deepseek', reason: 'credential-missing', message: '缺少凭证 DEEPSEEK_API_KEY' };
  try {
    const data = await fetchDeepseekBalance(key);
    const settings = readWidgetSettings();
    const total = Number(data.total);
    const ledgerUsage = isFinite(total) ? recordLedgerUsage(total) : 0;
    let mode = settings.usageMode;
    let todayUsage = ledgerUsage;
    if (settings.usageMode === 'token') {
      const token = readCredential('DEEPSEEK_PLATFORM_TOKEN');
      if (token) {
        const u = await fetchTokenUsage(token.replace(/^Bearer\s+/i, ''));
        if (u && u.amount !== undefined) todayUsage = u.amount;
        else mode = 'ledger'; // 令牌失效/无数据：回落记账模式
      } else {
        mode = 'ledger';
      }
    }
    return { ok: true, provider: 'deepseek-official', kind: 'deepseek', data, usage: { mode, todayUsage } };
  } catch (e) {
    return { ok: false, provider: 'deepseek-official', kind: 'deepseek', reason: 'fetch-error', message: e instanceof Error ? e.message : String(e) };
  }
}

// ==================== 音效目录 ====================

/** 扫描用户音效目录：返回「1/2 成对齐全」的音效组列表（名称即显示名） */
function scanSoundSets() {
  let files = [];
  try {
    files = fs.readdirSync(SOUND_DIR);
  } catch {
    return [];
  }
  const found = new Set();
  for (const f of files) {
    const m = /^(.+?)([12])\.mp3$/.exec(f);
    if (m) found.add(m[1]);
  }
  const sets = [];
  for (const name of found) {
    if (!isValidSoundName(name)) continue;
    if (files.includes(name + '1.mp3') && files.includes(name + '2.mp3')) sets.push({ id: name, label: name });
  }
  sets.sort((a, b) => a.id.localeCompare(b.id, 'zh'));
  return sets;
}

/** 按组名+角色定位音效文件（严格校验，防路径穿越）；不存在返回 null */
function soundFile(name, role) {
  if (!isValidSoundName(name)) return null;
  const p = path.join(SOUND_DIR, name + role + '.mp3');
  return fs.existsSync(p) ? p : null;
}

/** 首次启动：把包内两套自带音效播种进用户音效目录；并迁移旧版音效目录中的用户文件 */
function seedBuiltinSounds() {
  try {
    fs.mkdirSync(SOUND_DIR, { recursive: true });
    // 旧目录迁移（历史版本 mac 曾用 ~/.dsh/dsh-pet/sound）：把用户自定义音效搬进新目录（不覆盖同名）
    if (LEGACY_SOUND_DIR !== SOUND_DIR) {
      try {
        for (const f of fs.readdirSync(LEGACY_SOUND_DIR)) {
          const src = path.join(LEGACY_SOUND_DIR, f);
          const dst = path.join(SOUND_DIR, f);
          if (fs.statSync(src).isFile() && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
        }
      } catch {
        /* 旧目录不存在或不可读则跳过 */
      }
    }
    const builtin = path.join(ASSET_DIR, 'sound');
    const pairs = [
      ['小黄鸭', ['小黄鸭1.mp3', '小黄鸭2.mp3']],
      ['音效', ['音效1.mp3', '音效2.mp3']],
    ];
    for (const [, files] of pairs) {
      for (const f of files) {
        const dst = path.join(SOUND_DIR, f);
        const src = path.join(builtin, f);
        if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
      }
    }
  } catch {
    /* 播种失败不阻断服务 */
  }
}

// ==================== 打开音效目录（系统文件管理器） ====================

function openSoundDir() {
  return new Promise((resolve) => {
    fs.mkdirSync(SOUND_DIR, { recursive: true });
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : null;
    if (!cmd) return resolve({ ok: false, error: 'unsupported platform' });
    execFile(cmd, [SOUND_DIR], () => resolve({ ok: true }));
  });
}

// ==================== HTTP 服务 ====================

/** JSON 响应 */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 静态文件响应（带缓存头；mp4/webm 视频需 Range 支持，这里客户端不拉 Range，直接整体返回） */
function sendFile(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

/** 读取请求体（上限 256KB） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 从 query 中取 set 参数（音效组名，未编码的中文由 URLSearchParams 处理） */
function soundSetFromUrl(url) {
  try {
    return new URL(url, 'http://localhost').searchParams.get('set') || '';
  } catch {
    return '';
  }
}

/** 启动服务器：返回 { port }（随机可用端口，由 main.cjs 注入页面地址） */
function startServer() {
  return new Promise((resolve) => {
    seedBuiltinSounds();
    seedAnimeDirs();
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        let rest = decodeURIComponent(url.pathname.slice(1)); // 去掉开头 /
        const prefix = 'dsh-pet-7340/';
        const isPetRoute = rest.startsWith(prefix);
        if (isPetRoute) rest = rest.slice(prefix.length);

        // ---- 独立版应用页面（非宠物路由） ----
        if (!isPetRoute) {
          if (rest === '' || rest === 'index.html') return sendFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
          if (rest === 'renderer.js') return sendFile(res, path.join(__dirname, '..', 'dist', 'renderer.js'), 'text/javascript; charset=utf-8');
          return sendJson(res, 404, { error: 'not found' });
        }

        // ---- 宠物路由（与插件版 host 同构） ----
        // 宠物默认配置层（包内 config.jsonc）
        if (rest === 'config.jsonc') return sendFile(res, path.join(ASSET_DIR, 'config.jsonc'), 'application/json; charset=utf-8');
        // 用户覆盖配置层（main-config.json；缺失 → 空对象回落默认）
        if (rest === 'config') {
          if (req.method === 'GET') {
            try {
              const raw = fs.readFileSync(USER_CONFIG_PATH, 'utf8');
              return sendJson(res, 200, JSON.parse(raw));
            } catch {
              return sendJson(res, 200, {});
            }
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }
        // 余额 + 今日已用
        if (rest === 'balance') {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
          return sendJson(res, 200, await balanceWithUsage());
        }
        // 余额刷新触发（客户端轻量轮询用，直接回 ok）
        if (rest === 'balance/trigger') return sendJson(res, 200, { ok: true });
        // 挂件设置
        if (rest === 'widget-settings') {
          if (req.method === 'GET') return sendJson(res, 200, readWidgetSettings());
          if (req.method === 'PUT') {
            try {
              const body = await readBody(req);
              const merged = writeWidgetSettings(JSON.parse(body));
              return sendJson(res, 200, { ok: true, settings: merged });
            } catch {
              return sendJson(res, 400, { error: 'invalid JSON body' });
            }
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }
        // 音效列表（每次打开菜单实时扫描）
        if (rest === 'sound-sets') return sendJson(res, 200, { sets: scanSoundSets() });
        // 音效文件：press.mp3 / release.mp3 ?set=<名称>（<名称>1/2.mp3）
        if (rest === 'sound/press.mp3' || rest === 'sound/release.mp3') {
          const name = soundSetFromUrl(req.url);
          const file = soundFile(name, rest === 'sound/press.mp3' ? '1' : '2');
          if (!file) return sendJson(res, 404, { error: 'sound set not found: ' + name });
          return sendFile(res, file, 'audio/mpeg');
        }
        // 插件本地 API key（GET 只回 hasKey，绝不回传 key 本体）
        if (rest === 'api-key') {
          if (req.method === 'GET') return sendJson(res, 200, { hasKey: !!readApiKey() });
          if (req.method === 'PUT') {
            try {
              const body = JSON.parse(await readBody(req));
              const key = typeof body.key === 'string' ? body.key.trim() : '';
              if (!key || key.length > 512) return sendJson(res, 400, { error: 'key 非法（非空、≤512 字符）' });
              fs.mkdirSync(USER_DATA, { recursive: true });
              fs.writeFileSync(API_KEY_PATH, JSON.stringify({ key }), { mode: 0o600 });
              return sendJson(res, 200, { ok: true, hasKey: true });
            } catch {
              return sendJson(res, 400, { error: 'invalid JSON body' });
            }
          }
          if (req.method === 'DELETE') {
            try {
              fs.rmSync(API_KEY_PATH, { force: true });
            } catch {
              /* 不存在也视为成功 */
            }
            return sendJson(res, 200, { ok: true, hasKey: false });
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }
        // 打开动画文件夹（DIY 入口）：macOS 用 open、Windows 用 explorer
        if (rest === 'open-anime-dir') {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          try {
            fs.mkdirSync(ANIME_DIR, { recursive: true });
            if (process.platform === 'win32') execFile('explorer', [ANIME_DIR]);
            else execFile('open', [ANIME_DIR]);
            return sendJson(res, 200, { ok: true });
          } catch (e) {
            return sendJson(res, 500, { error: String(e) });
          }
        }
        // 打开音效目录（系统文件管理器）
        if (rest === 'open-sound-dir') {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          return sendJson(res, 200, await openSoundDir());
        }
        // 动画文件夹文件清单（DIY 随机池：客户端按文件夹内实际文件纯随机选取）
        if (rest === 'anime-files') {
          const out = {};
          for (const folder of new Set(ANIME_FOLDER_MAP.values())) {
            const names = new Set();
            try {
              for (const f of fs.readdirSync(path.join(ANIME_DIR, folder))) {
                if (f.endsWith('.webm')) names.add(f.slice(0, -'.webm'.length));
              }
            } catch {
              /* 文件夹不存在则回落配置名单 */
            }
            // 文件夹被清空时回落配置名单，保证有动画可播（素材由包内兜底提供）
            if (names.size === 0) {
              for (const [n, fd] of ANIME_FOLDER_MAP) {
                if (fd === folder) names.add(n);
              }
            }
            out[folder] = [...names].sort();
          }
          return sendJson(res, 200, out);
        }
        // 动画素材（webm；名称防路径穿越；优先用户动画目录（DIY），缺失回落包内）
        if (rest.startsWith('thumb/')) {
          const name = rest.slice('thumb/'.length);
          if (!name || name.includes('/') || name.includes('..')) return sendJson(res, 400, { error: 'bad path' });
          const base = name.replace(/\.(webm|mov)$/i, ''); // 映射键为不带扩展名的动画名
          const folder = ANIME_FOLDER_MAP.get(base);
          if (folder) {
            const extPath = path.join(ANIME_DIR, folder, name);
            if (fs.existsSync(extPath)) return sendFile(res, extPath, 'video/webm');
          }
          return sendFile(res, path.join(ASSET_DIR, 'webm', name), 'video/webm');
        }
        // 字体（气泡用上首软糖体）
        if (rest.startsWith('font/')) {
          const name = rest.slice('font/'.length);
          if (!name || name.includes('/') || name.includes('..')) return sendJson(res, 400, { error: 'bad path' });
          return sendFile(res, path.join(ASSET_DIR, 'fonts', name), 'font/ttf');
        }
        // 通知图标（系统通知功能占位；独立版 v1 未接通知，路由保留供后续使用）
        if (rest.startsWith('pic/')) {
          const name = rest.slice('pic/'.length);
          if (!name || name.includes('/') || name.includes('..')) return sendJson(res, 400, { error: 'bad path' });
          return sendFile(res, path.join(ASSET_DIR, 'pic', name), 'image/png');
        }
        return sendJson(res, 404, { error: 'not found: ' + rest });
      } catch (e) {
        return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, server });
    });
  });
}

module.exports = { startServer };
