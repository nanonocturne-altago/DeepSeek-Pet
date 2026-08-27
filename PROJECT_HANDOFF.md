# DeepSeekPet 项目交接文档（给新对话的引导）

## 项目是什么
- 「DeepSeek 娘」桌面宠物：从 DSH 插件（dsh-pet）演进出的独立 Electron 应用（macOS + Windows）
- 功能：透明置顶宠物、动画播放引擎（webm/GIF/APNG/PNG）、余额气泡（DeepSeek API 实时 / 本地记账）、汉堡菜单、音效、DIY 动画与音效、系统托盘（Win）/程序坞（mac）

## 关键路径
- **工作目录（唯一源码树）**：/Users/dante/Agent_tools/Agent_Plugin/Deepseek_pet_for_windows
- 原 dsh-pet：/Users/dante/Agent_tools/Agent_Plugin/dsh-pet —— **只读存档**，未经用户同意不得修改
- **打包产物目录（用户指定）**：/Users/dante/Agent_tools/pack_output —— dmg 进 MAC/、Windows zip 进 WIN/
- **备份目录**：/Users/dante/Agent_tools/Agent_Plugin/BackUP —— 备份 Deepseek_pet_for_windows 内的所有文件与文件夹。**未经用户明确要求更新备份时，严禁修改此备份的任何内容**
- GitHub：https://github.com/nanonocturne-altago/DeepSeek-Pet（public，gh CLI 已登录）

## 架构
- Electron 31 + esbuild + 轻量 h() 渲染（src/client/*）
- electron/main.cjs：窗口（透明置顶、点击穿透、多屏虚拟桌面联合区域）、托盘、IPC
- electron/server.cjs：本地 HTTP 服务（/dsh-pet-7340/* 路由：动画、音效、余额、设置、SSE）
- 渲染入口：http://127.0.0.1:<port>/index.html；动画双 video 槽 + 双 img 槽交叉淡入淡出（webm 走视频、GIF/APNG/PNG 走图片，时长解析驱动动画链）

## 数据目录
- macOS：~/Library/Application Support/DeepSeek.Pet/{anime, sound}（设置/账本/API Key 同目录）
- Windows：exe 同级 motion/ sound/ data/（绿色便携；只读目录回落 %APPDATA%/DeepSeek.Pet 并弹确认窗）
- 11 个中文动画分类文件夹：待机/转身/移动/点击/拖曳/余额/小动作/玩耍/吃什么/时节/文字
- DIY 刷新：fs.watch + SSE 事件驱动（约 1 秒生效）+ 每小时兜底扫描；idle/转身/拖曳 按文件夹实际文件数纯随机

## 当前状态
- 版本 v0.2.1；GitHub Release 已发布（mac dmg + win x64/arm64 zip，本地验证后上传）
- 已修复：多屏拖动、API 弹窗输入、便携 exe 临时目录、托盘图标、菜单外点关闭等
- 待办：无硬性待办（用户需求驱动）

## 构建与发布流程（血泪教训）
- 串行重建脚本 /tmp/rebuild-pet.sh：mac dmg → win x64 zip → win arm64 zip → 复制 pack_output → 校验 asar
- ⚠️ electron-builder 并发写 release/ 会竞态产生含旧代码的 asar → 必须串行 + 构建后 asar extract-file 校验新代码
- ⚠️ esbuild 产物中中文是 \uXXXX 转义（grep 中文会误判缺失，用 node includes 或搜大写 uXXXX）
- 环境变量：CSC_NAME="Deepseek Local"、npmmirror 镜像加速
- 每次修复/发版：更新 update log.md（用户会亲自润色去歧义）→ git push → 重建产物 → 本地验证 → 更新 Release

## 测试方式
- 纯 node 起 server.cjs 起测试服务器；Playwright（/Users/dante/deepseek-harness 内已装）做真实交互测试
- 临时测试脚本放 /Users/dante/deepseek-harness/ 下（.xxx-test.mjs），用完即删
- 测试隔离：DSH_PET_USER_DATA=/tmp/xxx 环境变量隔离用户数据

## 用户偏好（务必遵守）
- 无编程基础，先讲原理再动手；UI 调整用精确几何描述并期望截图/实测验证
- 稳定性优先于极致效果（拒绝跳跃/闪烁）；应用数据要"可见、可清理"，反对写入 C 盘隐藏目录
- 打包产物先本地验证通过才上传 GitHub；README/鸣谢/版本更新内容由用户自己撰写润色
- 工作节奏：常在深夜结束工作、留"最后一任务"次日检查
- 向日葵远程会注入虚拟显示器（多屏联合区域已含主屏锚定逻辑，勿回归）
