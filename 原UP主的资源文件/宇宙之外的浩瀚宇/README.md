# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=%E6%9C%88%E4%B8%8B%E8%BD%BD&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=%E6%80%BB%E4%B8%8B%E8%BD%BD&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="repo size" src="https://img.shields.io/github/repo-size/PC2005-cloud/dsh-pet"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/issues"><img alt="issues" src="https://img.shields.io/github/issues/PC2005-cloud/dsh-pet"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-dynamic%20animations-ff69b4">
</p>

一只住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面里的桌面宠物：待机呼吸、随机动作（含打瞌睡）、偶尔转向、屏幕漫游、点击反应、可拖拽——还能实时展示 LLM 服务商的余额/额度（余额动画 + 头顶联想气泡）。

这不是一个普通插件，而是**完整的三件套项目**：

```
① 提示词（配方）    →  ② 素材生成链（引擎）  →  ③ 插件（成品）
AI 生成动画的配方     源视频 → 透明动画的管线    运行在 DSH 里的宠物
```

任何人 clone 本仓库，都可以**从零生成自己的桌面宠物**——换角色、换动作、换风格，全流程可复现。

---

## 快速开始（安装插件）

> 以下命令都在你的**命令行终端**（PowerShell / CMD 等）中运行。前提是 DSH 环境已就绪：

```sh
# ① 前置要求：确认 Node.js 已安装
node -v

# ② 安装 DSH 启动器与 pnpm（已装可跳过；装完请重新打开终端）
npm install -g @deepseek-ai/dsh pnpm
dsh --version   # 验证 dsh 命令可用

# ③ 安装本插件
dsh plugin --profile web add dsh-pet
```

重启 `dsh web`，宠物出现在右下角。

> **兼容性**：本插件在 dsh **`0.1.1-rc.2`** 下开发并测试（`dsh --version` 可查看你的版本）。建议使用相同版本；其他版本如遇问题欢迎反馈。

### 从源码安装（clone 本仓库后）

`lib/` 构建产物不入库，clone 后需要先构建再安装：

```sh
# ① clone 本仓库，进入插件目录
git clone https://github.com/PC2005-cloud/dsh-pet.git
cd dsh-pet/dsh-pet

# ② 安装依赖
npm install

# ③ 构建 + 注入播放格式（webm 版；Safari 用 npm run prepare:mov）
npm run prepare:webm

# ④ 安装到 DSH（file: 指向本目录，用构建好的 lib）
dsh plugin --profile web add file:D:/path/to/dsh-pet
```

> 注：`prepare:webm` / `prepare:mov` 才产出可安装的 lib（注入播放扩展名）；直接用 `tsdown` 裸构建会留下占位符，动画无法播放。

## 从零生成你自己的宠物（完整流程）

### ① 提示词 → 源视频

用 AI 视频生成工具（如可灵、Runway、豆包等，本项目素材即由豆包生成），按 `prompts/桌面宠物 10 秒动作提示词.md` 的配方，一个动作生成一段 10 秒绿幕视频：

- 视频比例 16:9，背景纯绿幕（#00FF00）
- 人物位置/大小固定（头顶 ~20% 高度、脚底 ~85% 高度）
- 动作全程在画幅内，首尾帧为标准正面站立
- 每段动画按秒分解（0-10s 各阶段动作）

生成结果按动作各存一个 mp4，放入 `video/`。

> **源视频获取**：为控制仓库体积，`video/` 源视频不入 git。Releases 提供**打包压缩包**，浏览器直接下载即可：
>
> - `assets-videos.zip` —— 全部源视频压缩包（中文名 mp4，解压后放入 `video/`）
>
> 解压：`Expand-Archive assets-videos.zip`（Windows）或 `unzip assets-videos.zip`，把 mp4 放回 `video/` 即可运行素材链。

### ② 源视频 → 透明动画（素材链）

step02（透明视频）有**两条路线，按需二选一**（默认自动、人人可复现；效果不佳可用 PR 手工抠像覆盖）：

```sh
cd scripts
# 路线 A（默认）：自动绿幕抠像（HSV 色相，无需人工）
python watermark_step01.py   # 水印遮罩填充 → step01/
python chroma_step02.py      # 绿幕抠像转透明 → step02/

# 路线 B（可选）：PR 手工抠像覆盖（针对含第三方物品/自动抠像效果不佳的动作）
#   1. 在 PR 里手工抠像，导出带 alpha 的透明 .mov（如 ProRes 4444 with Alpha）
#   2. 放入 pr/，文件名与动作名一致（如 吃白饭.mov）
python pr_import_step02.py   # pr/*.mov → step02/（透明 webm，覆盖该动作自动抠像结果）

# 后续步骤两条路线共用：
python normalize_step03.py   # 归一化 2160×1215 统一站立居中 → step03/
python encode_thumbs.py      # 转码 640×360 播放变体 → step04/
```

**依赖**：Python 3 + ffmpeg + numpy + scipy（素材链脚本自动用工作区 `.tools/` 下的 ffmpeg）。

> **本项目全部采用路线 B**（97 个动作均为 PR 手工抠像）：对"含第三方物品/透明边缘复杂"的动作，自动 HSV 抠像易残边或误抠，PR 手动遮罩更精细。两条路线产出同一级 `step02/`，后续步骤完全一致；`chroma_step02.py` 保留为自动化兜底，任何动作仍可一键自动生成。

### ②.5 🍎 Safari 版素材（webm → mov，GitHub Actions macOS 流水线）

上一步产出的 `step04/` 是 **VP9-alpha webm**（Chrome/Edge/Firefox 原生支持），但 **Safari 不认 webm alpha**（渲染黑底），只支持 **HEVC-with-Alpha mov**——而该编码器（`hevcWithAlpha`，AVFoundation）**只有 macOS 有，Windows/Linux 产不出**。本项目开发机是 Windows，无法本地跑这条编码，所以利用 GitHub Actions 的 **macOS runner 云端批量转码**（`macos-latest`，免费额度，无需自备 Mac）：

```sh
# 手动触发仓库的 hevc-alpha workflow（Settings → Actions → Workflows → Run workflow）
# mov 由 workflow 用 actions/checkout 拿到本仓库直接编码，与素材同仓，不跨仓库
```

> 如果你有 Mac（或 macOS 虚拟机），**无需 GitHub Actions**，本地直接跑同样的编码脚本即可：
> ```sh
> chmod +x scripts/encode_hevc_alpha.sh
> ./scripts/encode_hevc_alpha.sh dsh-pet/assets/webm dsh-pet/assets/mov
> ```

- workflow：`.github/workflows/hevc-alpha.yml`（手动触发 `workflow_dispatch`）
- 编码脚本：`scripts/encode_hevc_alpha.sh`（ffmpeg 仅解码 webm → BGRA 帧管线 → Swift `hevc_alpha_encoder.swift` 走 AVAssetWriter `hevcWithAlpha` 原生 API）
- 输入：`dsh-pet/assets/webm/*.webm`；**输出直接写回 `dsh-pet/assets/mov/`**
- 校验：自动检查产物 `hvc1` tag + alpha 通道真实存在，并打包上传为 artifact（`dsh-pet-hevc-alpha`）

### ③ 动画 → 插件

```sh
# 把 step04 的播放变体同步进插件包（webm 直接 cp）
cp step04/*.webm dsh-pet/assets/webm/   # Chrome / Edge / Firefox 播放格式（VP9-alpha）
# Safari 用 HEVC-with-Alpha mov —— 由 GitHub Actions macOS 流水线（见上节 ②.5）自动产出到 dsh-pet/assets/mov/

# 本地安装插件（webm 版）
dsh plugin --profile web add file:D:/path/to/dsh-pet
```

> 中间产物（step01-04）由脚本生成、不入仓库；`video/` 源视频和脚本是成果、入库维护。

### 🎯 双格式发布（一个包名，dist-tag 区分）

同一 npm 包 `dsh-pet`，按浏览器分两个发布版本（素材目录 `assets/webm` / `assets/mov` 各只打进对应版本，包体各瘦一半）：

```sh
cd dsh-pet
npm run prepare:webm   # 发布 Chrome/Edge/Firefox 版 → dsh-pet@0.2.0，tag latest
npm run prepare:mov    # 发布 Safari 版（HEVC-alpha）→ dsh-pet@0.2.0-hevc，tag hevc
```

用户按浏览器选装：

```sh
dsh plugin --profile web add dsh-pet        # Chrome/Edge/Firefox（默认 latest → webm）
dsh plugin --profile web add dsh-pet@hevc   # Safari（HEVC-alpha mov）
```

- client 端不做运行时浏览器判断——扩展名由发布期脚本注入（`prepare:webm` → `.webm` / `prepare:mov` → `.mov`），源码共用、产物分格式
- mov 素材由主仓库内置 workflow `.github/workflows/hevc-alpha.yml` 用 GitHub Actions 云端 macOS（`macos-latest`）编码产出，与素材同仓

### 项目结构

```
├── prompts/                 # ① 各动作的生成提示词（绿幕规范 + 按秒分解）
├── step01/                  # ② 素材链中间产物：绿幕原始帧（不入库）
├── step02/                  # ② 素材链中间产物：抠像（不入库）
├── step03/                  # ② 素材链中间产物：水印合成（不入库）
├── step04/                  # ② 素材链中间产物：640×360 播放变体（不入库）
├── scripts/                 # ② 素材生成链（Python：水印/抠像/归一化/转码）
├── video/                   # ② 源视频（绿幕 mp4 + 水印 mask，一动作一文件；不入库，Releases 有压缩包）
├── pr/                      # ② 路线 B 输入：PR 导出的透明 .mov（本地工作数据，不入库）
├── prproj/                  # ② PR 工程目录（.prproj + 遮罩缓存 + 自动保存，本地不入库）
├── tools/                   # 开发工具：preview.html（素材链各阶段效果预览）
├── .github/workflows/       # CI：hevc-alpha.yml（macOS runner 批量转码 webm → mov，手动触发）
├── dsh-pet/                 # ③ 插件（可独立 npm 发布）
│   ├── src/                 #   TS 源码（host 半侧 /dsh-pet-7340 路由 + client 半侧动画链）
│   ├── lib/                 #   tsdown 构建产物（prepare 自动构建，lib/*.js 不入库）
│   ├── assets/webm/         #   640×360 VP9-alpha 播放动画（Chrome/Edge/Firefox 版素材）
│   ├── assets/mov/          #   640×360 HEVC-with-Alpha 播放动画（Safari 版素材）
│   ├── assets/preview/      #   GIF 预览（README 展示用，拼音命名）
│   ├── assets/fonts/        #   气泡/通知字体
│   ├── assets/pic/          #   通知图标 + 手套光标
│   ├── assets/config.jsonc  #   默认配置（动画池 / 权重 / 宠物列表，单一事实来源）
│   ├── scripts/prepack-check.js  # 发布前健康检查
│   └── scripts/prepare.js   # 发布前微调（构建 + 注入播放格式 .webm/.mov）
├── DESIGN.md                # 设计与实现文档
└── LICENSE                  # MIT
```

## 插件功能

- **纯粹的桌宠**：核心就是陪你——没有天气查询、系统监控、Agent 状态感知等花活；唯一的"业务功能"是**可选的余额展示**（见下节）。零核心改动（不碰 DSH 内核）
- **余额展示**：实时显示当前 LLM 服务商的余额/额度——DeepSeek 官方显示账户余额（¥），OpenCode Zen Go 显示 5h/周/月 三个额度窗口中最紧张的一个；每次刷新按档位播放余额动画，头顶弹出联想气泡（随宠物大小等比缩放，10 秒后自动消失）；每只宠物可独立开关（`balanceEnabled`）
- **动画链**：每个动画（含待机）播完立即按权重选下一个（权重配置于 `config.jsonc`，默认 idle 10 / turn 5 / move 5 + 动作分类权重），首尾相接永不停止
- **多开**：可配置同时显示多个宠物，每只宠物独立的大小与位置（设置页「桌宠配置」添加/删除）
- **屏幕漫游**：朝 facing 方向行走，先检查空间、不走出屏幕
- **点击/拖拽**：点击有回应动画，可拖到任意位置
- **左右朝向**：所有动画可镜像，人物可朝左/朝右
- **落地对齐**：动画统一脚底线，宠物始终站在地面上
- **流畅切换**：双缓冲交叉淡入，切换无空白帧

## ⚙️ 余额展示（Balance）

余额是"事件动画"的一种：运行时按 `eventsRefreshSec.balance`（秒）周期拉取当前服务商（跟随 `agent-default-model` 的 provider）的余额/用量数据，每次刷新按档位触发一次余额动画，并在宠物头顶弹出**联想气泡**（气泡为角色"思考"式白泡，随宠物大小等比缩放，10 秒后自动消失）：

- **DeepSeek 官方（`deepseek-official`）**：气泡显示账户余额（如 `余额 ¥8.79`）；余额按 ¥20 满额折算成已用百分比，分 6 档播放动画（钱袋满溢 → 金袋叮当 → 钱袋如常 → 数金皱眉 → 袋空如洗 → 分文不剩）
- **OpenCode Zen Go（`opencode-go`）**：气泡显示 5h/周/月 三个额度窗口中最先告急的一个（如 `周额度已用 88%` / `2.5 天重置`），同样按已用百分比分档
- **按宠物开关**：`pets[i].balanceEnabled`（必填布尔）控制该宠物是否触发余额动画/显示气泡；全部宠物关闭时自动跳过余额轮询
- **所需凭据**：对应 provider 的 API key（`deepseek-official` → `DEEPSEEK_API_KEY`；`opencode-go` → `OPENCODE_GO_API_KEY`），在 DSH 凭据中配置后启用；未匹配的服务商按设计不触发动画、不显示气泡

## ⚙️ 配置（大小 / 位置 / 多开）

桌宠的大小、位置、多开均可配置，两条途径：

> 💡 **两条途径只是编辑入口不同，最终都是同一份用户配置**——配置能力远不止设置页那几个选项：设置页只能改「大小/位置/多开」，但**手动编写配置文件可以任意自由配置**（动画池、播放权重、事件动画、刷新周期……），只要**格式与包内默认配置 `config.jsonc` 一致**即可，用户配置会**整体覆盖**对应字段的默认值。

### 方式一：设置页（推荐）
DSH 设置 → 「桌宠配置」：

- **大小**：宽度 px（高度自动 = 宽度 × 9/16）
- **位置**：四角（corner）＋ 水平/垂直边距（marginX / marginY）
- **余额功能**：勾选后该宠物才会触发余额动画并显示余额气泡
- **多开**：添加/删除宠物，每只宠物独立 id、大小、位置
- 点「保存」**即时生效**（无需刷新）；「恢复默认」回到 config.jsonc 默认

### 方式二：config.jsonc（单一来源）
插件包内 `dsh-pet/assets/config.jsonc` 的 `pets` 数组定义**默认宠物**：

```jsonc
"pets": [
  { "id": "main", "size": 462, "balanceEnabled": true, "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } }
]
```

- 每只宠物：`id`（标识）／ `size`（宽度 px）／ `balanceEnabled`（是否启用余额功能，必填布尔）／ `position`（corner 四角之一 + marginX/marginY 边距）
- 余额刷新周期：`eventsRefreshSec.balance`（秒）——余额数据刷新与余额动画触发的间隔，启动时立即触发一次，之后按此周期循环（默认 180）
- 设置页的修改保存到用户层 `$DSH_HOME/dsh-pet/main-config.json`（**完整宠物列表**，覆盖包内默认）；「恢复默认」即清除用户层、回落 config.jsonc

### 方式三：手动编辑配置文件（高级，任意自由配置）

用户层配置文件位于 `$DSH_HOME/dsh-pet/main-config.json`。**它和包内默认配置是同一套格式**——想改什么直接照着 `assets/config.jsonc` 的结构写即可，写错的字段/缺失的字段回落默认，无需（也无法）写完整份：

| 字段 | 作用 | 格式与默认一致即可 |
|---|---|---|
| `pets` | 宠物列表（大小/位置/多开/余额开关） | 数组，每项同 `pets[]` 结构 |
| `animations` | **动画池**：idle / turn / drag / clicks / moves / categories / events（余额等事件动画） | 同 `animations` 结构 |
| `animationWeights` | 动画链播放权重（idle / turn / move） | 同 `animationWeights` 结构 |
| `eventsRefreshSec` | 事件刷新周期（秒） | 同 `eventsRefreshSec` 结构 |
| `notificationsEnabled` | 系统通知总开关（布尔） | 同 `notificationsEnabled` |

> 覆盖语义：用户层给出即**整体替换**该字段（如写了 `animations` 就用你的整份动画池，替代默认），没写的字段回落包内默认。校验在插件加载时执行——格式错误会在 DSH 控制台显式报错，不会静默运行残缺配置。

## 运行效果

宠物实际运行在 DSH Web 界面中的样子：

<p>
  <img src="assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet 运行效果 1" title="dsh-pet 运行效果 1">
  <img src="assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet 运行效果 2" title="dsh-pet 运行效果 2">
  <img src="assets/screenshots/dsh-pet-running-3.png" width="380" alt="dsh-pet 运行效果 3" title="dsh-pet 运行效果 3">
  <img src="assets/screenshots/dsh-pet-running-4.png" width="380" alt="dsh-pet 运行效果 4" title="dsh-pet 运行效果 4">
  <img src="assets/screenshots/dsh-pet-running-5.png" width="380" alt="dsh-pet 运行效果 5" title="dsh-pet 运行效果 5">
  <img src="assets/screenshots/dsh-pet-running-6.png" width="380" alt="dsh-pet 运行效果 6" title="dsh-pet 运行效果 6">
</p>

## 效果预览

全部动画（640×360，插件实际播放用的资源）——GIF 预览存放于仓库 `dsh-pet/assets/preview/`（raw 直链渲染，文件名采用拼音便于跨平台）；完整透明视频见插件包 `dsh-pet/assets/webm/`（VP9-alpha，Chrome/Edge/Firefox）与 `dsh-pet/assets/mov/`（HEVC-alpha，Safari）：

**待机 / 转向**

<p>
  <img src="dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="待机呼吸休闲" title="待机呼吸休闲">
  <img src="dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="东张西望" title="东张西望">
</p>

**移动**

<p>
  <img src="dsh-pet/assets/preview/pangxie-zoulu.gif" width="160" alt="螃蟹走路" title="螃蟹走路">
  <img src="dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="原地漂浮踏步" title="原地漂浮踏步">
  <img src="dsh-pet/assets/preview/yuandi-zuozhuan-benpao.gif" width="160" alt="原地左转奔跑" title="原地左转奔跑">
</p>

**小动作**

<p>
  <img src="dsh-pet/assets/preview/youxian-hengga.gif" width="160" alt="悠闲哼歌" title="悠闲哼歌">
  <img src="dsh-pet/assets/preview/chaoda-shenlanyao.gif" width="160" alt="超大伸懒腰" title="超大伸懒腰">
  <img src="dsh-pet/assets/preview/yuandi-qiaoji-zhuomian-hudong.gif" width="160" alt="原地敲击桌面互动" title="原地敲击桌面互动">
  <img src="dsh-pet/assets/preview/yuandi-zhongli-xiadun-yasuo.gif" width="160" alt="原地重力下蹲压缩" title="原地重力下蹲压缩">
  <img src="dsh-pet/assets/preview/haqian-liantian.gif" width="160" alt="哈欠连天" title="哈欠连天">
  <img src="dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="原地小憩沉眠" title="原地小憩沉眠">
  <img src="dsh-pet/assets/preview/nvpu-quxi-liyi.gif" width="160" alt="女仆屈膝礼仪" title="女仆屈膝礼仪">
  <img src="dsh-pet/assets/preview/beixiayitiao-zhamao.gif" width="160" alt="被吓一跳" title="被吓一跳">
  <img src="dsh-pet/assets/preview/xiaofudu-yuandi-360du-xuanzhuan-zhanshi.gif" width="160" alt="小幅度原地360度旋转展示" title="小幅度原地360度旋转展示">
  <img src="dsh-pet/assets/preview/touchi-lingshi-bei-zhuazhu.gif" width="160" alt="偷吃零食被抓住" title="偷吃零食被抓住">
  <img src="dsh-pet/assets/preview/yong-jingyu-weiba-paidadi.gif" width="160" alt="用鲸鱼尾巴拍打地面" title="用鲸鱼尾巴拍打地面">
  <img src="dsh-pet/assets/preview/da-keshui-bei-jingxing.gif" width="160" alt="打瞌睡被惊醒" title="打瞌睡被惊醒">
  <img src="dsh-pet/assets/preview/zhao-jingzi.gif" width="160" alt="照镜子" title="照镜子">
  <img src="dsh-pet/assets/preview/zhengti-huanzhuang-shise.gif" width="160" alt="整体换装试色" title="整体换装试色">
  <img src="dsh-pet/assets/preview/qingkuai-jilu.gif" width="160" alt="轻快记录" title="轻快记录">
  <img src="dsh-pet/assets/preview/xie-daima.gif" width="160" alt="写代码" title="写代码">
  <img src="dsh-pet/assets/preview/yaoshan-naliang.gif" width="160" alt="摇扇纳凉" title="摇扇纳凉">
  <img src="dsh-pet/assets/preview/chenjian-shuaya.gif" width="160" alt="晨间刷牙" title="晨间刷牙">
</p>

**玩耍**

<p>
  <img src="dsh-pet/assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="160" alt="原地专心玩魔方" title="原地专心玩魔方">
  <img src="dsh-pet/assets/preview/yuandi-dunxia-wan-wanju-qiche.gif" width="160" alt="原地蹲下玩玩具汽车" title="原地蹲下玩玩具汽车">
  <img src="dsh-pet/assets/preview/jingyu-tu-paopao-texiao.gif" width="160" alt="鲸鱼吐泡泡特效" title="鲸鱼吐泡泡特效">
  <img src="dsh-pet/assets/preview/yuandi-tiaoyue-zhuasui-touding-wupin.gif" width="160" alt="原地跳跃抓碎头顶物品" title="原地跳跃抓碎头顶物品">
  <img src="dsh-pet/assets/preview/wan-youxi-qijibaituai.gif" width="160" alt="玩游戏气急败坏" title="玩游戏气急败坏">
  <img src="dsh-pet/assets/preview/wan-shuiqiang.gif" width="160" alt="玩水枪" title="玩水枪">
  <img src="dsh-pet/assets/preview/xiaotiqin-yanzou.gif" width="160" alt="小提琴演奏" title="小提琴演奏">
  <img src="dsh-pet/assets/preview/lanjing-xianshi.gif" width="160" alt="蓝鲸现世" title="蓝鲸现世">
  <img src="dsh-pet/assets/preview/youya-nvpuwu.gif" width="160" alt="优雅女仆舞" title="优雅女仆舞">
  <img src="dsh-pet/assets/preview/qingkuai-yaobaiwu.gif" width="160" alt="轻快摇摆舞" title="轻快摇摆舞">
  <img src="dsh-pet/assets/preview/keai-zhaiwu.gif" width="160" alt="可爱宅舞" title="可爱宅舞">
  <img src="dsh-pet/assets/preview/chui-qiqiu.gif" width="160" alt="吹气球" title="吹气球">
  <img src="dsh-pet/assets/preview/dongwu-huanrao.gif" width="160" alt="动物环绕" title="动物环绕">
  <img src="dsh-pet/assets/preview/fang-fengzheng.gif" width="160" alt="放风筝" title="放风筝">
  <img src="dsh-pet/assets/preview/chai-liwu.gif" width="160" alt="拆礼物" title="拆礼物">
  <img src="dsh-pet/assets/preview/bian-gezi.gif" width="160" alt="变鸽子" title="变鸽子">
  <img src="dsh-pet/assets/preview/puke-moshu.gif" width="160" alt="扑克魔术" title="扑克魔术">
  <img src="dsh-pet/assets/preview/chou-tuoluo.gif" width="160" alt="抽陀螺" title="抽陀螺">
  <img src="dsh-pet/assets/preview/chui-dizi.gif" width="160" alt="吹笛子" title="吹笛子">
  <img src="dsh-pet/assets/preview/hudie-mifeng-huanrao-touding-kaihua.gif" width="160" alt="蝴蝶蜜蜂环绕头顶开花" title="蝴蝶蜜蜂环绕头顶开花">
  <img src="dsh-pet/assets/preview/lu-mao.gif" width="160" alt="撸猫" title="撸猫">
  <img src="dsh-pet/assets/preview/pingkong-shenghua.gif" width="160" alt="凭空生花" title="凭空生花">
  <img src="dsh-pet/assets/preview/qi-muma.gif" width="160" alt="骑木马" title="骑木马">
  <img src="dsh-pet/assets/preview/sanqiu-paojie.gif" width="160" alt="三球抛接" title="三球抛接">
  <img src="dsh-pet/assets/preview/ti-jianzi.gif" width="160" alt="踢毽子" title="踢毽子">
  <img src="dsh-pet/assets/preview/xiawuziqi.gif" width="160" alt="下五子棋" title="下五子棋">
  <img src="dsh-pet/assets/preview/dangqiuqian.gif" width="160" alt="荡秋千" title="荡秋千">
</p>

**吃什么**

<p>
  <img src="dsh-pet/assets/preview/chi-baifan.gif" width="160" alt="吃白饭" title="吃白饭">
  <img src="dsh-pet/assets/preview/dakou-chi-lingshi.gif" width="160" alt="大口吃零食" title="大口吃零食">
  <img src="dsh-pet/assets/preview/chi-token.gif" width="160" alt="吃Token" title="吃Token">
  <img src="dsh-pet/assets/preview/chi-zaocan.gif" width="160" alt="吃早餐" title="吃早餐">
  <img src="dsh-pet/assets/preview/chi-wucan.gif" width="160" alt="吃午餐" title="吃午餐">
  <img src="dsh-pet/assets/preview/chi-wancan.gif" width="160" alt="吃晚餐" title="吃晚餐">
  <img src="dsh-pet/assets/preview/chi-bingqilin-ronghua.gif" width="160" alt="吃冰淇淋融化" title="吃冰淇淋融化">
  <img src="dsh-pet/assets/preview/chi-dazhaxie.gif" width="160" alt="吃大闸蟹" title="吃大闸蟹">
  <img src="dsh-pet/assets/preview/chi-tanghulu.gif" width="160" alt="吃糖葫芦" title="吃糖葫芦">
  <img src="dsh-pet/assets/preview/chi-changshoumian.gif" width="160" alt="吃长寿面" title="吃长寿面">
  <img src="dsh-pet/assets/preview/chi-xigua.gif" width="160" alt="吃西瓜" title="吃西瓜">
  <img src="dsh-pet/assets/preview/shuan-huoguo.gif" width="160" alt="涮火锅" title="涮火锅">
</p>

**时节**

<p>
  <img src="dsh-pet/assets/preview/beiluoye-yanmo.gif" width="160" alt="被落叶淹没" title="被落叶淹没">
  <img src="dsh-pet/assets/preview/zhongqiu-shangyue-chi-yuebing.gif" width="160" alt="中秋赏月吃月饼" title="中秋赏月吃月饼">
  <img src="dsh-pet/assets/preview/duixueren.gif" width="160" alt="堆雪人" title="堆雪人">
  <img src="dsh-pet/assets/preview/fang-yanhua.gif" width="160" alt="放烟花" title="放烟花">
  <img src="dsh-pet/assets/preview/chi-zongzi.gif" width="160" alt="吃粽子" title="吃粽子">
  <img src="dsh-pet/assets/preview/chi-niangao.gif" width="160" alt="吃年糕" title="吃年糕">
  <img src="dsh-pet/assets/preview/chi-qingtuan.gif" width="160" alt="吃青团" title="吃青团">
  <img src="dsh-pet/assets/preview/chi-labazhou.gif" width="160" alt="吃腊八粥" title="吃腊八粥">
  <img src="dsh-pet/assets/preview/chi-chongyanggao.gif" width="160" alt="吃重阳糕" title="吃重阳糕">
  <img src="dsh-pet/assets/preview/shou-hongbao.gif" width="160" alt="收红包" title="收红包">
  <img src="dsh-pet/assets/preview/xie-fuzi.gif" width="160" alt="写福字" title="写福字">
  <img src="dsh-pet/assets/preview/chuanzhenqiqiao.gif" width="160" alt="穿针乞巧" title="穿针乞巧">
  <img src="dsh-pet/assets/preview/wu-shitou.gif" width="160" alt="舞狮头" title="舞狮头">
  <img src="dsh-pet/assets/preview/taotang-nanguadeng.gif" width="160" alt="讨糖南瓜灯" title="讨糖南瓜灯">
  <img src="dsh-pet/assets/preview/cha-zhuyu-shangju.gif" width="160" alt="插茱萸赏菊" title="插茱萸赏菊">
  <img src="dsh-pet/assets/preview/fanghedeng.gif" width="160" alt="放河灯" title="放河灯">
  <img src="dsh-pet/assets/preview/menghua-xiaoyouling.gif" width="160" alt="萌化小幽灵" title="萌化小幽灵">
  <img src="dsh-pet/assets/preview/zhuangdian-shengdanshu.gif" width="160" alt="装点圣诞树" title="装点圣诞树">
  <img src="dsh-pet/assets/preview/fang-kongmingdeng.gif" width="160" alt="放孔明灯" title="放孔明灯">
  <img src="dsh-pet/assets/preview/chitangyuan.gif" width="160" alt="吃汤圆" title="吃汤圆">
  <img src="dsh-pet/assets/preview/chijiaozi.gif" width="160" alt="吃饺子" title="吃饺子">
</p>

**文字**

<p>
  <img src="dsh-pet/assets/preview/shia-chishenme.gif" width="160" alt="是啊，吃什么" title="是啊，吃什么">
  <img src="dsh-pet/assets/preview/shendu-sikao-suisuinian.gif" width="160" alt="深度思考碎碎念" title="深度思考碎碎念">
</p>

**点击回应**

<p>
  <img src="dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="点击回应-开心跃动" title="点击回应-开心跃动">
  <img src="dsh-pet/assets/preview/dianji-huiying-haixiu-jingya.gif" width="160" alt="点击回应-害羞惊讶" title="点击回应-害羞惊讶">
  <img src="dsh-pet/assets/preview/dianji-huiying-aojiao-shengqi-ceshen-zhanshi.gif" width="160" alt="点击回应-傲娇生气" title="点击回应-傲娇生气">
  <img src="dsh-pet/assets/preview/dianji-huiying-naoyang-gegexiao.gif" width="160" alt="点击回应-挠痒咯咯笑" title="点击回应-挠痒咯咯笑">
  <img src="dsh-pet/assets/preview/dianji-huiying-yuanqi-huishou.gif" width="160" alt="点击回应-元气挥手" title="点击回应-元气挥手">
</p>

**拖拽**

<p>
  <img src="dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="被鼠标拖拽悬空反馈" title="被鼠标拖拽悬空反馈">
</p>

**余额事件**（按余额已用百分比分档，满格 → 告急 → 耗尽）

<p>
  <img src="dsh-pet/assets/preview/qian-dai-man-yi.gif" width="160" alt="余额-钱袋满溢" title="余额-钱袋满溢">
  <img src="dsh-pet/assets/preview/jin-dai-ding-dang.gif" width="160" alt="余额-金袋叮当" title="余额-金袋叮当">
  <img src="dsh-pet/assets/preview/qian-dai-ru-chang.gif" width="160" alt="余额-钱袋如常" title="余额-钱袋如常">
  <img src="dsh-pet/assets/preview/shu-jin-zhou-mei.gif" width="160" alt="余额-数金皱眉" title="余额-数金皱眉">
  <img src="dsh-pet/assets/preview/dai-kong-ru-xi.gif" width="160" alt="余额-袋空如洗" title="余额-袋空如洗">
  <img src="dsh-pet/assets/preview/fen-wen-bu-sheng.gif" width="160" alt="余额-分文不剩" title="余额-分文不剩">
</p>

> 注：动画为透明背景；GIF 预览中透明部分显示为页面底色，实际 webm 播放为透明。
## 文档

- [设计与实现](DESIGN.md) —— 架构、动画链模型、素材链

## 许可

- 代码：MIT
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
