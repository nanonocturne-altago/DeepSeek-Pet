# Dock 图标隐藏问题 Handoff（给新对话）

> 背景会话（2026-09-14 深夜 → 09-15 凌晨）：先完成「归中」功能（已完成、已验证），随后攻坚 macOS「程序坞显示」隐藏按钮失效问题，至今**未完全解决**。用户要开新对话，本文档是交接。

## 一句话现状

macOS「程序坞显示」（隐藏 Dock 图标）按钮：**运行时方案全部不可靠；LSUIElement 持久方案已实现但用户实测「还是不生效」**。源码已提交（commit 69a770e），正式版 /Applications 已部署同款代码，plist 当前 LSUIElement=true、设置 dockVisible=false（隐藏意图状态）。v0.2.2 未发 Release，Windows 产物未重新打包（用户要求不自动打包）。

## 项目关键信息（快速对齐）

- 项目：DeepSeekPet 桌宠（Electron 独立版 + DSH 插件版双构建），工作区 `/Users/dante/Agent_tools/Project_workspace/Prepared_files/Deepseek_pet_for_windows`
- 交接文档 `PROJECT_HANDOFF.md`（新会话必读）、`update log.md`（用户会亲自润色）
- **Electron 40.10.2 定版**（31 不稳定、44 上隐藏完全失效）
- 用户偏好：不自动打 Windows 包（明确要求才打包）；产物先本地验证再发 Release；凌晨工作节奏
- 本会话已完成的「归中」功能（Windows 托盘右键 + macOS Dock 右键菜单，点宠物移到鼠标所在屏中心）已通过全部验证

## 问题演化史（避免新对话重踩坑）

1. **原始报告**：Windows 用户找不到宠物 → 加「归中」（✓ 已完成）。顺手发现 mac「程序坞显示」隐藏按钮失效（图标留存）。
2. **运行时方案 A（accessory）**：`app.setActivationPolicy('accessory')` 隐藏。第一次有效，之后轮次失效（图标留存只有运行点消失）。
3. **运行时方案 B（关 NSW + accessory）**：`setVisibleOnAllWorkspaces(false)` 再 accessory。单轮验证「隐藏 vs 退出 Dock 差异≈0」很干净，但循环后 show 恢复失效（NSW(true) 会隐式隐藏图标，dock.show 也救不回）。
4. **运行时方案 C（killall Dock 兜底）**：hide/show 都重启 Dock。图标能回来但每次切换 Dock 闪动 1-2 秒，且 hide 后图标依然留存（用户实测）。用户明确不接受闪动。
5. **LSUIElement 持久方案（当前代码）**：用户给参考——Macs Fan Control 的做法：设置里勾选隐藏 → 手动重启后图标不再显示。实现：点按钮 → 写 `widget-settings.json` 的 `dockVisible` → PlistBuddy 改 Info.plist `LSUIElement`（隐藏=true）→ codesign 重签（「Deepseek Local」证书）→ `lsregister -f` 强制重注册 → **不重启当前会话**（下次启动生效）。启动时若 plist 与设置不一致则同步 plist（也只下次生效）。菜单按钮 title 已改「下次启动应用时生效」。
6. **LSUIElement 验证情况**：临时副本 `/tmp/lsuitest.app`（ditto 复制 + 手动加 LSUIElement，**新路径首次注册**）实测有效——启动后 Dock 无图标。但正式版（/Applications，早已注册过的路径）**改 plist + lsregister -f 后仍不生效**（用户目视 Dock 鲸鱼还在）。

## 下一步排查方向（建议）

1. **确认 LSUIElement 是否真的进了注册数据库**：
   ```bash
   /usr/libexec/PlistBuddy -c "Print :LSUIElement" /Applications/DeepSeekPet.app/Contents/Info.plist
   mdls -name kMDItemLSUIElement /Applications/DeepSeekPet.app   # 看 Spotlight 元数据
   lsappinfo list | grep -i deepseek                              # 看运行实例注册
   ```
2. **怀疑点**：Electron 应用启动时可能自己处理/覆盖了激活策略（LSUIElement 对 Electron 主进程的 NSApplication 注册方式是否被 setActivationPolicy/其它调用覆盖？代码里现在还有没有残留的 dock 相关运行时调用——main.cjs 已删干净，但 createPetWindow 里 `setVisibleOnAllWorkspaces(true)` 仍在，它会不会把 LSUIElement 应用拉回常规注册？**值得先试：临时在 createPetWindow 注释掉 NSW，再启动看 Dock 图标是否消失**）。
3. 兜底方案：与用户商量「接受 Dock 闪动」或「mac 版移除该按钮」（用户此前拒绝过闪动方案，但那是运行时切换的闪动；LSUIElement 若搞不定，重启 Dock 是唯一可靠的）。
4. 试 `app.setActivationPolicy('prohibited')`？——会连窗口交互一起禁，不适合桌宠。

## 血泪教训（务必遵守）

1. **视觉模型对 Dock 图标的识别完全不可靠**：曾幻觉「Docker 鲸鱼」「问号人像」「两个鲸鱼」并因此误判根因。**用户 Dock 里没有 Docker 图标，那个鲸鱼就是 DeepSeekPet**。一切结论以用户目视为准。
2. **像素 diff 验证只适用于严格受控实验**：Dock 重启动画、鼠标悬停放大、用户桌面活动（最小化窗口等）都会污染 diff。多实例会互相干扰（bundle 级 activation policy）——实验前 `pgrep -f DeepSeekPet` 确认只有一个主实例，杀掉 release/ 里的副本。
3. **改 Info.plist 必须重签 + lsregister -f**：否则 Gatekeeper「已损坏」+ LSUIElement 被注册缓存忽略。
4. **electron-builder 卡死**：`--timestamp` 连 Apple 时间戳服务器在当前网络下无限卡（每次卡在 signing 之后）。已设 `build.mac.timestamp = null`（是否真正生效未确认）。绕法：`--mac dir` 出 app 后手动 `codesign --force --deep -s "Deepseek Local"`（无 --timestamp，0.5 秒完成）+ 需要 dmg 时用 hdiutil 手工打包。Electron zip 下载走 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（GitHub 源会卡）。
5. **快速迭代法（免 electron-builder）**：`npx @electron/asar extract app.asar /tmp/stage` → 替换文件 → `asar pack` → codesign 重签 → 直接装/重启应用。asar 校验用整包 extract 再 grep（extract-file 会静默输出空）。
6. **关键文件位置**：
   - Dock 逻辑：`electron/main.cjs`（readDockSetting/writeDockSetting/plistHasLSUIElement/setPlistLSUIElement/resignApp/reregisterApp/applyDockSetting + whenReady 里的启动同步）
   - 设置存储：`~/Library/Application Support/DeepSeek.Pet/widget-settings.json` 的 `dockVisible` 字段（与 server.cjs 的 USER_DATA 同源，支持 DSH_PET_USER_DATA 隔离）
   - 按钮文案/行为：`src/client/menu.ts`（行为行，平台自适应：Win=托盘即时、mac=Dock 下次生效）
7. **测试隔离**：`DSH_PET_USER_DATA=/tmp/xxx` 环境变量隔离用户数据（server.cjs 与 main.cjs 都遵循）。
8. 会话超长教训：每轮「改了→构建→装→验证」要快，多轮叠加时先杀干净实例、确认 /Applications 只有一个版本、release/ 里的副本要删（用户曾在 Launchpad/Finder 看到两个 DeepSeekPet 造成困惑）。

## 当前文件/产物状态

- 源码已全部提交推送（main 分支最新 69a770e）
- /Applications/DeepSeekPet.app = 最新代码（LSUIElement 方案 + lsregister），plist 当前 LSUIElement=true（隐藏意图）
- release/ 已清空（electron-builder 产物删除），pack_output/MAC 里是最新 dmg（LSUIElement 之前的版本，非最新代码）——**未重新打正式 dmg**
- Windows zip 未重新打包（用户要求不自动打包）
- v0.2.2 未发 GitHub Release（等 Dock 问题解决 + 用户本地验证）
