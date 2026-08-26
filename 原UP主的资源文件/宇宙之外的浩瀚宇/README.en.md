# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=monthly&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=total&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-dynamic%20animations-ff69b4">
</p>

A desktop pet living inside the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI: idle breathing, random actions (including dozing off), occasional turns, screen wandering, click reactions, and draggable — it can also display your LLM provider's balance/quota in real time (balance animations + a thinking bubble above the head).

This is not just a plugin — it's a **complete three-piece project**:

```
① Prompts (recipe)      →  ② Asset pipeline (engine)  →  ③ Plugin (product)
AI animation prompts        source video → transparent       the pet running in DSH
```

Anyone who clones this repository can **generate their own desktop pet from scratch** — swap characters, actions, and styles; the whole pipeline is reproducible.

---

## Quick Start (Install the Plugin)

> All commands below run in your **terminal** (PowerShell, CMD, etc.). First make sure the DSH environment is ready:

```sh
# ① Prerequisites: confirm Node.js is installed
node -v

# ② Install the DSH launcher and pnpm (skip if already installed; reopen your terminal afterwards)
npm install -g @deepseek-ai/dsh pnpm
dsh --version   # verify the dsh command works

# ③ Install this plugin
dsh plugin --profile web add dsh-pet
```

Restart `dsh web` and the pet appears in the bottom-right corner.

> **Compatibility**: this plugin is developed and tested with dsh **`0.1.1-rc.2`** (check yours with `dsh --version`). Using the same version is recommended; please report any issues on other versions.

### Install from source (after cloning this repo)

The `lib/` build output is not committed, so clone first, then build, then install:

```sh
# ① Clone this repo and enter the plugin directory
git clone https://github.com/PC2005-cloud/dsh-pet.git
cd dsh-pet/dsh-pet

# ② Install dependencies
npm install

# ③ Build + inject the playback format (webm build; use npm run prepare:mov for Safari)
npm run prepare:webm

# ④ Install into DSH (file: points at this directory, uses the built lib)
dsh plugin --profile web add file:D:/path/to/dsh-pet
```

> Note: only `prepare:webm` / `prepare:mov` produce an installable lib (they inject the playback extension); a bare `tsdown` build leaves the placeholder in place and animations won't play.

## Generate Your Own Pet from Scratch (Full Pipeline)

### ① Prompts → Source Videos

Use an AI video generation tool (e.g., Kling, Runway, Doubao — this project's assets were generated with Doubao) with the recipes in `prompts/桌面宠物 10 秒动作提示词.md` to generate one ten-second green-screen video per action:

- Video ratio 16:9 with a pure green background (#00FF00)
- Fixed character position/size (head top at ~20% height, feet bottom at ~85% height)
- The action stays fully inside the frame; the first and last frames are standard front-facing standing
- Each animation is broken down by second (per-stage actions for 0–10s)

Put the results into `video/` (one mp4 per action).

> **Getting the source videos**: to keep the repo small, `video/` sources are not committed. Releases provide **zipped bundles** you can download directly in the browser:
>
> - `assets-videos.zip` — all source videos (Chinese-named mp4s; extract and put them into `video/`)
>
> Extract with `Expand-Archive assets-videos.zip` (Windows) or `unzip assets-videos.zip`, then put the mp4s back into `video/` — the pipeline is ready to run.

### ② Source Videos → Transparent Animations (Asset Pipeline)

step02 (transparent video) has **two tracks, pick one per action** (automatic by default and reproducible by anyone; PR hand-keying as a quality override):

```sh
cd scripts
# Track A (default): automatic green-screen keying (HSV hue, no manual work)
python watermark_step01.py   # fill watermark masks → step01/
python chroma_step02.py      # chroma-key the green screen to transparency → step02/

# Track B (optional): PR hand-keying override (for actions with 3rd-party props
#                     or where auto keying looks bad)
#   1. Hand-key in Premiere Pro, export a transparent .mov with alpha
#      (e.g. ProRes 4444 with Alpha)
#   2. Put it in pr/ with the action's name (e.g. 吃白饭.mov)
python pr_import_step02.py   # pr/*.mov → step02/ (transparent webm, overrides the auto result)

# The rest of the pipeline is shared by both tracks:
python normalize_step03.py   # normalize to 2160×1215 unified standing, centered → step03/
python encode_thumbs.py      # transcode 640×360 playback variants → step04/
```

**Dependencies**: Python 3 + ffmpeg + numpy + scipy (the pipeline scripts automatically use the ffmpeg under the workspace `.tools/`).

> **This project uses Track B for all 97 actions** (every action is PR hand-keyed): for actions with 3rd-party props or complex transparent edges, automatic HSV keying tends to leave fringes or mis-key pixels, while manual masks in PR are far cleaner. Both tracks produce the same `step02/` level, so everything downstream is identical; `chroma_step02.py` is kept as the automatic fallback so any action can still be generated with one command.

### ②.5 🍎 Safari build (webm → mov, GitHub Actions macOS pipeline)

The `step04/` output above is **VP9-alpha webm** (natively supported by Chrome/Edge/Firefox), but **Safari does not support webm alpha** (renders a black background) — it only supports **HEVC-with-Alpha mov**, and that encoder (`hevcWithAlpha`, AVFoundation) **only exists on macOS — Windows/Linux cannot produce it**. This project is developed on Windows, which cannot run this encoding locally, so the mov assets are batch-transcoded in the cloud on a **GitHub Actions macOS runner** (`macos-latest`, free allowance, no Mac needed):

```sh
# Manually trigger the repo's hevc-alpha workflow (Settings → Actions → Workflows → Run workflow)
# The workflow uses actions/checkout to grab this repo and encodes in place — assets and pipeline share the repo, no cross-repo clone
```

> If you have a Mac (or a macOS VM), **you don't need GitHub Actions** — run the same encoder script locally:
> ```sh
> chmod +x scripts/encode_hevc_alpha.sh
> ./scripts/encode_hevc_alpha.sh dsh-pet/assets/webm dsh-pet/assets/mov
> ```

- workflow: `.github/workflows/hevc-alpha.yml` (manual trigger via `workflow_dispatch`)
- encoder script: `scripts/encode_hevc_alpha.sh` (ffmpeg only decodes the webm → raw BGRA frame pipeline → Swift `hevc_alpha_encoder.swift` via AVAssetWriter `hevcWithAlpha` native API)
- input: `dsh-pet/assets/webm/*.webm`; **output written directly back to `dsh-pet/assets/mov/`**
- verification: automatically checks the products carry a real `hvc1` tag + alpha channel, then uploads them as an artifact (`dsh-pet-hevc-alpha`)

### ③ Animations → Plugin

```sh
# Sync the step04 playback variants into the plugin package (webm is a plain cp)
cp step04/*.webm dsh-pet/assets/webm/   # Chrome / Edge / Firefox playback format (VP9-alpha)
# Safari uses HEVC-with-Alpha mov — produced automatically into dsh-pet/assets/mov/
# by the GitHub Actions macOS pipeline (see ②.5 above)

# Install the plugin locally (webm build)
dsh plugin --profile web add file:D:/path/to/dsh-pet
```

> Intermediate products (step01-04) are generated by scripts and not committed to the repo; `video/` source videos and scripts are deliverables and maintained in the repo.

### 🎯 Dual-format publishing (one package name, dist-tags)

Same npm package `dsh-pet`, published as two builds by browser target (the `assets/webm` /
`assets/mov` directories are each packed only into the matching build, halving the payload):

```sh
cd dsh-pet
npm run prepare:webm   # Chrome/Edge/Firefox build → dsh-pet@0.2.0, tag latest
npm run prepare:mov    # Safari build (HEVC-alpha) → dsh-pet@0.2.0-hevc, tag hevc
```

Users pick by browser:

```sh
dsh plugin --profile web add dsh-pet        # Chrome/Edge/Firefox (default latest → webm)
dsh plugin --profile web add dsh-pet@hevc   # Safari (HEVC-alpha mov)
```

- The client does no runtime browser sniffing — the extension is injected at publish time
  (`prepare:webm` → `.webm` / `prepare:mov` → `.mov`); sources are shared, artifacts are per-format
- MOV assets are produced by the in-repo workflow `.github/workflows/hevc-alpha.yml`
  (GitHub Actions cloud macOS `macos-latest` encoding)

## Project Structure

```
├── prompts/                 # ① Generation prompts for the actions (green-screen spec + per-second breakdown)
├── step01/                  # ② Pipeline intermediates: green-screen raw frames (not committed)
├── step02/                  # ② Pipeline intermediates: keyed output (not committed)
├── step03/                  # ② Pipeline intermediates: watermark-composited (not committed)
├── step04/                  # ② Pipeline intermediates: 640×360 playback variants (not committed)
├── scripts/                 # ② Asset pipeline (Python: watermark/keying/normalize/transcode)
├── video/                   # ② Source videos (green-screen mp4s, one per action + watermark mask; not committed, zipped on Releases)
├── pr/                      # ② Track B input: PR-exported transparent .mov (local working data, not committed)
├── prproj/                  # ② PR project directory (.prproj + mask cache + auto-saves, local, not committed)
├── tools/                   # Dev tools: preview.html (pipeline stage previews)
├── .github/workflows/       # CI: hevc-alpha.yml (macOS runner batch transcode webm → mov, manual trigger)
├── dsh-pet/                 # ③ The plugin (can be published to npm independently)
│   ├── src/                 #   TS sources (host half: /dsh-pet-7340 routes; client half: animation chain)
│   ├── lib/                 #   tsdown build output (built by prepare; lib/*.js not committed)
│   ├── assets/webm/         #   640×360 VP9-alpha playback animations (Chrome/Edge/Firefox build assets)
│   ├── assets/mov/          #   640×360 HEVC-with-Alpha playback animations (Safari build assets)
│   ├── assets/preview/      #   GIF previews (for README display, pinyin filenames)
│   ├── assets/fonts/        #   bubble/notification fonts
│   ├── assets/pic/          #   notification icons + glove cursors
│   ├── assets/config.jsonc  #   default config (animation pools / weights / pet list, single source of truth)
│   ├── scripts/prepack-check.js  # pre-publish health check
│   └── scripts/prepare.js   # pre-publish micro-adjust (build + inject playback extension .webm/.mov)
├── DESIGN.md                # Design & implementation docs
└── LICENSE                  # MIT
```

## Plugin Features

- **A pure pet, nothing else**: it just keeps you company — no weather lookups, no system monitoring, no agent-state sensing; the only "business feature" is the **optional balance display** (see below). Zero core changes (never touches the DSH kernel)
- **Balance display**: shows the current LLM provider's balance/quota in real time — DeepSeek official shows the account balance (¥); OpenCode Zen Go shows whichever of the 5h/weekly/monthly quota windows is tightest; on every refresh it plays a tiered balance animation and pops a thinking bubble above the head (scales with the pet size, auto-dismisses after 10 s); each pet can enable it independently (`balanceEnabled`)
- **Animation chain**: each animation (idle included) is immediately followed by a weight-based pick (weights live in `config.jsonc`; default idle 10 / turn 5 / move 5 + per-category weights), endless and seamless
- **Multi-pet**: configure multiple pets at once, each with its own size and position (add/remove in the "Pet Config" settings page)
- **Screen wandering**: walks toward its facing direction, checks the space ahead, never walks off screen
- **Click/drag**: click for a reaction animation; drag anywhere
- **Left/right facing**: all animations can be mirrored; the character can face left or right
- **Ground alignment**: animations share a unified foot line, the pet always stands on the ground
- **Smooth switching**: double-buffered cross-fade, no blank frames between transitions

## ⚙️ Balance Display

Balance is a kind of "event animation": at runtime the plugin polls the current provider's (following `agent-default-model`) balance/quota endpoint every `eventsRefreshSec.balance` seconds; on each refresh it plays a tiered balance animation and pops a **thinking bubble** above the pet's head (a white "thought" bubble that scales with the pet size and auto-dismisses after 10 seconds):

- **DeepSeek official (`deepseek-official`)**: the bubble shows the account balance (e.g. `余额 ¥8.79`); the balance is converted to a used-percentage against ¥20 as full, then mapped to 6 animation tiers (钱袋满溢 → 金袋叮当 → 钱袋如常 → 数金皱眉 → 袋空如洗 → 分文不剩)
- **OpenCode Zen Go (`opencode-go`)**: the bubble shows whichever of the 5h/weekly/monthly quota windows runs out first (e.g. `周额度已用 88%` / `2.5 天重置`), mapped to the same percentage tiers
- **Per-pet switch**: `pets[i].balanceEnabled` (required boolean) controls whether that pet triggers balance animations/shows the bubble; when every pet has it disabled, polling is skipped entirely
- **Required credentials**: the provider's API key (`deepseek-official` → `DEEPSEEK_API_KEY`; `opencode-go` → `OPENCODE_GO_API_KEY`), configured in DSH credentials; unmapped providers deliberately never trigger the animation or bubble

## ⚙️ Configuration (Size / Position / Multi-pet)

The pet's size, position and multi-pet setup can be configured in two ways:

> 💡 **Both paths are just different editors for the same user config** — the configurable surface is far larger than the settings page: the settings page only edits size/position/multi-pet, but **editing the config file by hand unlocks arbitrary free configuration** (animation pools, play weights, event animations, refresh periods…). Just keep the **same shape as the default `config.jsonc`**; user config **overrides** the corresponding fields wholesale.

### Via the settings page (recommended)
DSH Settings → **Pet Config**:

- **Size**: width in px (height is automatic = width × 9/16)
- **Position**: one of four corners (corner) plus horizontal/vertical margins (marginX / marginY)
- **Balance**: tick it to let this pet trigger balance animations and show the balance bubble
- **Multi-pet**: add/remove pets; each pet has its own id, size and position
- **Save** applies **instantly** (no page refresh needed); **Reset to default** restores the `config.jsonc` defaults

### Via config.jsonc (single source of truth)
The `pets` array in `dsh-pet/assets/config.jsonc` defines the **default pets**:

```jsonc
"pets": [
  { "id": "main", "size": 462, "balanceEnabled": true, "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } }
]
```

- Each pet: `id` (identifier) / `size` (width px) / `balanceEnabled` (whether balance is enabled, required boolean) / `position` (corner + marginX/marginY)
- Balance refresh period: `eventsRefreshSec.balance` (seconds) — the interval between balance data refreshes and balance-animation triggers; fires once on startup, then loops at this interval (default 180)
- Changes made in the settings page are saved to the user layer `$DSH_HOME/dsh-pet/main-config.json` (a **full pet list** that overrides the package defaults); "Reset to default" removes it and falls back to `config.jsonc`

### Via editing the config file directly (advanced, fully free config)

The user-layer config lives at `$DSH_HOME/dsh-pet/main-config.json`. **It uses the exact same shape as the package default** — copy any part of `assets/config.jsonc` you want to change; missing/invalid fields fall back to the defaults (you don't need, and can't, write the whole file):

| Field | Purpose | Shape |
|---|---|---|
| `pets` | pet list (size/position/multi-pet/balance toggle) | array, same as `pets[]` |
| `animations` | **animation pools**: idle / turn / drag / clicks / moves / categories / events (balance, …) | same as `animations` |
| `animationWeights` | animation-chain weights (idle / turn / move) | same as `animationWeights` |
| `eventsRefreshSec` | event refresh period (seconds) | same as `eventsRefreshSec` |
| `notificationsEnabled` | system-notification master switch (boolean) | same as `notificationsEnabled` |

> Override semantics: a field present in the user layer **replaces the whole default field** (e.g. writing `animations` swaps in your entire animation pool); omitted fields fall back to the package defaults. Validation runs at plugin load — malformed configs fail loudly in the DSH console instead of silently running a broken config.

## Running Screenshots

What the pet looks like running inside the DSH Web UI:

<p>
  <img src="assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet running in DSH Web UI 1" title="dsh-pet running in DSH Web UI 1">
  <img src="assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet running in DSH Web UI 2" title="dsh-pet running in DSH Web UI 2">
  <img src="assets/screenshots/dsh-pet-running-3.png" width="380" alt="dsh-pet running in DSH Web UI 3" title="dsh-pet running in DSH Web UI 3">
  <img src="assets/screenshots/dsh-pet-running-4.png" width="380" alt="dsh-pet running in DSH Web UI 4" title="dsh-pet running in DSH Web UI 4">
  <img src="assets/screenshots/dsh-pet-running-5.png" width="380" alt="dsh-pet running in DSH Web UI 5" title="dsh-pet running in DSH Web UI 5">
  <img src="assets/screenshots/dsh-pet-running-6.png" width="380" alt="dsh-pet running in DSH Web UI 6" title="dsh-pet running in DSH Web UI 6">
</p>

## Animation Previews

All animations (640×360, the actual assets the plugin plays) — GIF previews live in the repo at `dsh-pet/assets/preview/` (rendered via raw links, pinyin filenames for cross-platform safety); the full transparent videos live in the plugin package under `dsh-pet/assets/webm/` (VP9-alpha, Chrome/Edge/Firefox) and `dsh-pet/assets/mov/` (HEVC-alpha, Safari):

**Idle / Turning**

<p>
  <img src="dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="Idle breathing & chill" title="Idle breathing & chill">
  <img src="dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="Looking around" title="Looking around">
</p>

**Movement**

<p>
  <img src="dsh-pet/assets/preview/pangxie-zoulu.gif" width="160" alt="Crab walk" title="Crab walk">
  <img src="dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="Floating in place" title="Floating in place">
  <img src="dsh-pet/assets/preview/yuandi-zuozhuan-benpao.gif" width="160" alt="Sprinting in place" title="Sprinting in place">
</p>

**Actions**

<p>
  <img src="dsh-pet/assets/preview/youxian-hengga.gif" width="160" alt="Humming a tune" title="Humming a tune">
  <img src="dsh-pet/assets/preview/chaoda-shenlanyao.gif" width="160" alt="Big stretch" title="Big stretch">
  <img src="dsh-pet/assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="160" alt="Playing with a Rubik's cube" title="Playing with a Rubik's cube">
  <img src="dsh-pet/assets/preview/yuandi-qiaoji-zhuomian-hudong.gif" width="160" alt="Tapping the desk" title="Tapping the desk">
  <img src="dsh-pet/assets/preview/yuandi-zhongli-xiadun-yasuo.gif" width="160" alt="Gravity squat" title="Gravity squat">
  <img src="dsh-pet/assets/preview/haqian-liantian.gif" width="160" alt="Yawning" title="Yawning">
  <img src="dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="Napping" title="Napping">
  <img src="dsh-pet/assets/preview/yuandi-dunxia-wan-wanju-qiche.gif" width="160" alt="Playing with a toy car" title="Playing with a toy car">
  <img src="dsh-pet/assets/preview/jingyu-tu-paopao-texiao.gif" width="160" alt="Whale blowing bubbles" title="Whale blowing bubbles">
  <img src="dsh-pet/assets/preview/nvpu-quxi-liyi.gif" width="160" alt="Maid curtsy" title="Maid curtsy">
  <img src="dsh-pet/assets/preview/beixiayitiao-zhamao.gif" width="160" alt="Startled (fur standing up)" title="Startled (fur standing up)">
  <img src="dsh-pet/assets/preview/yuandi-tiaoyue-zhuasui-touding-wupin.gif" width="160" alt="Jumping to smash something overhead" title="Jumping to smash something overhead">
  <img src="dsh-pet/assets/preview/xiaofudu-yuandi-360du-xuanzhuan-zhanshi.gif" width="160" alt="Slow 360° spin" title="Slow 360° spin">
  <img src="dsh-pet/assets/preview/touchi-lingshi-bei-zhuazhu.gif" width="160" alt="Caught sneaking snacks" title="Caught sneaking snacks">
  <img src="dsh-pet/assets/preview/wan-youxi-qijibaituai.gif" width="160" alt="Frustrated at a game" title="Frustrated at a game">
  <img src="dsh-pet/assets/preview/yong-jingyu-weiba-paidadi.gif" width="160" alt="Slapping the floor with the whale tail" title="Slapping the floor with the whale tail">
  <img src="dsh-pet/assets/preview/da-keshui-bei-jingxing.gif" width="160" alt="Woken from a doze" title="Woken from a doze">
  <img src="dsh-pet/assets/preview/wan-shuiqiang.gif" width="160" alt="Playing with a water gun" title="Playing with a water gun">
  <img src="dsh-pet/assets/preview/xiaotiqin-yanzou.gif" width="160" alt="Playing the violin" title="Playing the violin">
  <img src="dsh-pet/assets/preview/lanjing-xianshi.gif" width="160" alt="Whale emerging" title="Whale emerging">
  <img src="dsh-pet/assets/preview/chi-baifan.gif" width="160" alt="Eating rice" title="Eating rice">
  <img src="dsh-pet/assets/preview/zhao-jingzi.gif" width="160" alt="Looking in the mirror" title="Looking in the mirror">
  <img src="dsh-pet/assets/preview/youya-nvpuwu.gif" width="160" alt="Elegant maid dance" title="Elegant maid dance">
  <img src="dsh-pet/assets/preview/qingkuai-yaobaiwu.gif" width="160" alt="Lighthearted sway dance" title="Lighthearted sway dance">
  <img src="dsh-pet/assets/preview/keai-zhaiwu.gif" width="160" alt="Cute anime dance" title="Cute anime dance">
  <img src="dsh-pet/assets/preview/zhengti-huanzhuang-shise.gif" width="160" alt="Trying on outfits" title="Trying on outfits">
  <img src="dsh-pet/assets/preview/dakou-chi-lingshi.gif" width="160" alt="Munching snacks" title="Munching snacks">
  <img src="dsh-pet/assets/preview/chui-qiqiu.gif" width="160" alt="Blowing a balloon" title="Blowing a balloon">
  <img src="dsh-pet/assets/preview/dongwu-huanrao.gif" width="160" alt="Animals circling around" title="Animals circling around">
  <img src="dsh-pet/assets/preview/shendu-sikao-suisuinian.gif" width="160" alt="Deep thinking & muttering" title="Deep thinking & muttering">
  <img src="dsh-pet/assets/preview/qingkuai-jilu.gif" width="160" alt="Taking light notes" title="Taking light notes">
  <img src="dsh-pet/assets/preview/xie-daima.gif" width="160" alt="Writing code" title="Writing code">
</p>

**Click Responses**

<p>
  <img src="dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="Click response - happy bounce" title="Click response - happy bounce">
  <img src="dsh-pet/assets/preview/dianji-huiying-haixiu-jingya.gif" width="160" alt="Click response - shy surprise" title="Click response - shy surprise">
  <img src="dsh-pet/assets/preview/dianji-huiying-aojiao-shengqi-ceshen-zhanshi.gif" width="160" alt="Click response - tsundere pout" title="Click response - tsundere pout">
</p>

**Dragging**

<p>
  <img src="dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="Dragged by the mouse" title="Dragged by the mouse">
</p>

**Balance Events** (tiered by used balance percentage — full → warning → empty)

<p>
  <img src="dsh-pet/assets/preview/qian-dai-man-yi.gif" width="160" alt="Balance - overflowing money bag" title="Balance - overflowing money bag">
  <img src="dsh-pet/assets/preview/jin-dai-ding-dang.gif" width="160" alt="Balance - jingling coins" title="Balance - jingling coins">
  <img src="dsh-pet/assets/preview/qian-dai-ru-chang.gif" width="160" alt="Balance - bag as usual" title="Balance - bag as usual">
  <img src="dsh-pet/assets/preview/shu-jin-zhou-mei.gif" width="160" alt="Balance - counting coins, frowning" title="Balance - counting coins, frowning">
  <img src="dsh-pet/assets/preview/dai-kong-ru-xi.gif" width="160" alt="Balance - empty bag" title="Balance - empty bag">
  <img src="dsh-pet/assets/preview/fen-wen-bu-sheng.gif" width="160" alt="Balance - no penny left" title="Balance - no penny left">
</p>

> Note: the animations have transparent backgrounds; in these GIF previews the transparent areas show the page background color, while the actual webm playback is transparent.

## Documentation

- [Design & Implementation](DESIGN.md) — architecture, animation-chain model, asset pipeline

## License

- Code: MIT
- Assets (animations/prompts/source videos): open-source use permitted, **no commercial use**
