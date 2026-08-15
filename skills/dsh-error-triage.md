---
name: dsh-error-triage
description: 错误路由表（L1，配合 dsh-error-protocol 六步协议）。按错误域给出精确诊断命令与修复协议——打包/依赖/原生模块/权限/网络/顺序 六大域，每个域配可执行的检查命令。触发条件：dsh-error-protocol 第 2 步需要选诊断动作时。
whenToUse: 错误已分类，需要"该域具体怎么诊断/修"时查本表。
---

# 错误路由表（L1）

> 与 `dsh-error-protocol`（六步协议）配合：协议管流程，本表管"每个错误域的具体命令"。
> 通用入口：`env_check` 工具（安装后为 `node <DSH_HOME>/scripts/dsh-env-check.mjs <检查项>`）

## 路由总表

| 错误域 | 特征 | 诊断命令 | 修复协议 |
|---|---|---|---|
| 打包收集器 | `cannot resolve @deepseek-ai/xxx`、asar 缺包、`boot may fail` | `dsh-env-check.mjs collector-mode` + `dep-consistency` | ①electron-builder 只按 pnpm 依赖树收集——物化包需 `files: node_modules` 显式声明 ②staging 的 `packageManager` 会被仓库根 workspace 覆盖，别在 staging 改 ③确定性方案=fixup 补 asar |
| 依赖缺失 | `ERR_MODULE_NOT_FOUND`、`Cannot find module` | `dsh-env-check.mjs dep-consistency`；`Test-Path node_modules/<pkg>` | 声明进 package.json 依赖/optionalDependencies；pnpm install；平台二进制（sharp/koffi/ripgrep）必须显式 optionalDependencies |
| 原生模块 | `ERR_DLOPEN_FAILED`、`dlopen`、`The specified module could not be found` | `dsh-env-check.mjs native-binaries`；查 `@img/sharp-win32-x64` 是否在 unpacked | **目录级 unpack**（`unpackDir: '**/node_modules/{@img,node-pty,koffi,@vscode}/**'`）——index.cjs 必须与 .node 同级；文件级 glob 会拆散包 |
| 顺序依赖 | `not found` + 产物路径、`ENOENT` + `release/` | `Test-Path staging/release/win-unpacked/resources/app.asar` | 跑前置步骤（--dir）再跑依赖它的步骤（fixup）；流水线顺序固化进 package.mjs |
| 旧快照 | `old_string was not found` | `read` 目标文件 | 重读文件当前内容，用实际文本做 old_string |
| 权限 | `permission denied`、`EACCES`、sandbox escalation 报错 | 查沙箱策略/文件属性 | 权限升级请求必须"严格更宽"；同一请求重复失败换形式（如输出重定向） |
| 网络/镜像 | `ETIMEDOUT`、`download failed`、electron 下载卡住 | `dsh-env-check.mjs network-mirror`；查 `ELECTRON_MIRROR` 环境变量 | 设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` + `ELECTRON_BUILDER_BINARIES_MIRROR` |
| profile 解析 | `cannot resolve @deepseek-ai/xxx from <DSH_HOME>\profiles\desktop` | `dsh-env-check.mjs profile-plugin-resolve` | dev 靠 workspace 源码兜底（掩盖未根治）；打包版必须 fixup 补入 asar；根治=修 profile 解析链 |

## 高频修复协议（打包域）

### 打包流水线（已固化，勿重造）
```
node scripts/package.mjs --nsis --portable
```
内部顺序：pnpm deploy → materialize → **--dir** → **fixup-asar** → --prepackaged。**fixup 必须在 --dir 之后**（它读 win-unpacked/app.asar）。

### asar 缺包排查顺序
1. `dsh-env-check.mjs dep-consistency`（patch 引用插件存在？）
2. `dsh-env-check.mjs collector-mode`（npm 被 pnpm 覆盖？）
3. `node -e "const {listPackage}=require('@electron/asar')..."` 查 asar 内容（探测命令重复 2 次就写脚本）
4. fixup-asar.mjs 补包 → 验证 exe --smoke

### sharp 报错的黄金规则
**目录级 unpack，不是文件级**。`unpackDir: '**/node_modules/{@img,node-pty,koffi,@vscode}/**'`。文件级 `**/*.node` 会把 sharp 拆散，运行时回退 %TEMP% 拷贝 → libvips DLL 缺失 → ERR_DLOPEN_FAILED。

## 纪律提醒

- 路由表不是万能的——**诊断输出要带证据**（哪个文件/命令证明），拿不准就报告用户
- 新错误域出现 → 更新本表 + dsh-env-check.mjs 检查项（第 6 步防复发）
