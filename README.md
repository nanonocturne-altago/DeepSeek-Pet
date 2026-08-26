# DeepSeek娘 · 桌宠插件（dsh-pet 整合版）

在 DeepSeek Harness（DSH）Web 界面中生活的透明动画桌宠：97 套生成动画、点击互动、拖拽、漫游、余额展示、记账、音效与汉堡菜单，开箱即用。本仓库为整合与增强版本，代码与素材来源见下文。

---

## 一、代码与内容来源

本产品是多方成果的整合体，各部分归属如下：

| 部分 | 来源 | 作者 |
| --- | --- | --- |
| 插件骨架、动画引擎（动画链/双缓冲切换）、漫游与拖拽、余额事件动画（6 档）、系统通知、三层配置体系、设置页、`/balance` 命令，以及全部 97 套动画素材（webm/mov 双格式）、配套字体与图标、动画与余额风格设计 | 原版 **dsh-pet** 开源包（MIT License，包内署名为 PC2005-cloud）——本整合版魔改的基底 | @宇宙之外的浩瀚宇（bilibili） |
| 桌宠角色形象设计 | @ZipZipPipe（bilibili） |
| 汉堡菜单、点击显示余额、记账模式（本地记账 / 实时·令牌）、按压/松手音效、峰谷定价换算 | 移植自 **DSH 小鲸鱼余额挂件**（dsh-whale-widget） | @月匠（bilibili） |
| Safari 兼容（自动切换 HEVC-alpha mov）、汉堡菜单集成、动画频率（间隔）滑块、贴边优化、音效目录动态扫描、鸣谢弹窗、API key 管理弹窗、界面细节调整 | 本整合版的本地开发部分 | nanonocturne-altago（github） |
| 余额数据 | DeepSeek 官方 API（`/user/balance` 文档化接口） | DeepSeek |
| 运行宿主 | DeepSeek Harness（DSH，v0.1.1-rc.2+） | DeepSeek |

> 鸣谢信息与插件内的「鸣谢」弹窗保持一致；上游原版 dsh-pet 的 MIT License 文件随包保留。

## 二、与原版 dsh-pet 相比的变化

### 新增功能

- **悬停汉堡菜单**（悬停宠物时在角色头部右上方浮现）：大小、音效、音量、动画间隔、用量模式五项设置，即调即生效并持久化
- **点击显示余额**：点击宠物立即刷新余额并弹出气泡（余额 + 今日已用），叠加原有点击互动动画
- **双模式用量统计**：「本地记账（推荐）」= 余额差值自动累计（免令牌、跨天归档）；「API 实时」= 平台实时用量按峰谷价换算（需平台令牌，缺失时自动回落记账）
- **按压/松手音效**：两套自带音效，支持自定义——向 `assets/sound/` 丢入 `名称1.mp3`+`名称2.mp3`（1=点击声、2=松手声）即成对识别，每次打开菜单实时扫描目录（详见下文命名规则）
- **打开音效目录按钮**：音效行右侧「···」按钮，一键在系统文件管理器打开音频目录（路径随插件自身位置解析，整体搬家不失效）
- **动画间隔滑块**：0–90 秒线性调节动画之间的停顿（最左 +90s，最右保持原有无缝衔接；交互触发不受间隔影响）
- **Safari 兼容**：运行时自动识别 Safari 并切换 HEVC-alpha `.mov` 素材，杜绝 VP9-alpha webm 在 Safari 下的黑底问题
- **贴边优化**：统一贴边边距 + 10px 安全垫，宠物可贴近窗口边缘站立（约 60px 处），动画切换零跳跃、零闪烁（极端宽幅动画仅峰值帧微量截断）
- **鸣谢弹窗**：菜单内「鸣谢」按钮，展示全部贡献者（含 B 站主页超链接）
- **API key 管理弹窗**：在界面内输入/更新/清空插件本地保存的 DeepSeek API key（本地优先，清空回落 DSH 凭据存储）
- **细节调整**：悬停提示显示「DeepSeek娘」、用量下拉改为双按钮切换、菜单按钮贴近角色头部等

### 完善与修复

- 菜单顶部空间不足时自动翻转到按钮下方弹出（不再超出视口）
- 菜单/弹窗 z-index 提升，避免被宠物命中层拦截
- 设置加载后菜单控件与持久化值同步（修复滑块 UI 不刷新问题）
- DSH 宿主 React jsx 工厂 `null` props 兼容（`h('div', null)` 运行时崩溃修复）

### 无删减

原版 dsh-pet 的全部功能（动画链、点击互动、拖拽、漫游、余额 6 档事件动画、系统通知、三层配置、设置页、`/balance` 命令）均完整保留。

## 三、安装与构建

```bash
# 1. 安装依赖
npm install
# 2. 构建（生成 lib/ 并注入 .webm 播放扩展名）
npm run prepare:webm
# 3. 装入 DSH web profile（DSH ≥ 0.1.1-rc.2）
dsh plugin --profile web add link:<本目录绝对路径>
# 4. 启动
dsh --profile web
```

余额功能需要 DSH 凭据存储中存在 `DEEPSEEK_API_KEY`（或在插件菜单的 API 弹窗中直接保存）。

## 四、自定义音效命名规则

向 `assets/sound/` 目录放入成对文件：

```
小熊猫1.mp3   ← 点击声
小熊猫2.mp3   ← 松手声
```

- `名称` 即下拉菜单中的显示名（支持中文），`1`/`2` 为固定后缀（分别对应点击/松手）
- 必须成对齐全才会出现在列表中；菜单每次打开时实时扫描，增删即时生效
- 名称请勿以数字 1/2 结尾（与后缀规则冲突）

## 五、许可说明

- 本仓库保留原版 dsh-pet 的 MIT License（上游包内署名 PC2005-cloud，即 @宇宙之外的浩瀚宇）
- 角色形象（@ZipZipPipe）、菜单/记账/音效移植（@月匠）与本地整合开发（nanonocturne-altago）归各自作者所有，仅限随本插件使用
- 余额数据来自 DeepSeek 官方 API，使用时请遵守 DeepSeek 平台条款

## 六、支持原作者

本整合版建立在以下作者的开放分享之上，请支持他们：

- **@ZipZipPipe**（形象设计）· Bilibili：<https://space.bilibili.com/4168597>
- **@宇宙之外的浩瀚宇**（原版 dsh-pet 作者）· Bilibili：<https://space.bilibili.com/1364176066> · GitHub：<https://github.com/Vast-Beyond-Space/pet-app>
- **@月匠**（菜单/记账/音效移植来源）· Bilibili：<https://space.bilibili.com/345797244> · GitHub：<https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget> · Gitee：<https://gitee.com/meteornox/DeepSeek-Balance-Whale-Widget>

请大家支持原作者，Bilibili关注+投币，谢谢！

## 七、与原包相比移除的内容

本整合包只保留插件**运行所需**的部分（源码、动画素材、音效、字体、图标、构建脚本）。原 UP 主附带的非运行内容已完整导出到本仓库的 **`原UP主的资源文件/`** 目录（按作者分文件夹、保持原目录结构）：

**@宇宙之外的浩瀚宇**（原版 dsh-pet 三层项目）移除的内容：

- 项目介绍与设计文档（README.md / README.en.md / DESIGN.md，含工作流介绍）
- `prompts/` 生成提示词（桌面宠物 10 秒动作提示词、系统通知图标 AI 生成提示词）
- `scripts/` 素材生成流水线脚本（抠图/水印/填充/规范化/HEVC-alpha 编码等 11 个脚本）
- `tools/preview.html` 动画预览工具、`video/watermark_mask_v5.mkv` 水印遮罩源视频
- `assets/screenshots/` 运行截图、`.github/workflows/hevc-alpha.yml` 云端 mov 转码工作流
- 插件包内原版 README（`dsh-pet/README.md`、`dsh-pet/README.en.md`）

**@月匠**（dsh-whale-widget 小鲸鱼余额挂件）移除的内容：

- `README.md` 项目介绍
- `whale-widget-prompt.md` 生成提示词

以上资源的完整副本均随本仓库保留于 `原UP主的资源文件/` 中，供学习、复现素材流水线或二次开发使用。
