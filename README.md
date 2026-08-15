# cleverer-dsh

让 DeepSeek Harness (DSH) 变聪明的插件套件 —— 把 Hermes 级执行纪律移植进 DSH 生态。

> 基于真实长任务取证（一次 2.5 小时、18 次失败的桌面打包任务）开发，每个插件都针对取证中暴露的具体缺陷。**零依赖、纯 ESM、单测 426 项全绿（覆盖率全局 99.7%+）。**

## 这是什么

DSH（DeepSeek Harness）功能齐全但"默认不聪明"：系统提示词是空的、失败会死磕、skill 装而不用、计划工具爱用不用。cleverer-dsh 用 cordis 插件 + skill 两层补齐：

| 层 | 机制 | 效果 |
|---|---|---|
| **纪律层**（8 插件） | 事件钩子 + system-prompt 注入 | 失败拦截、强制反思、todo 纪律、记忆查重 |
| **协作中枢**（discipline-hub） | 共享 `__errLog` + 提醒仲裁 + turn 统计 | 多插件不冲突、失败数据可观测 |
| **功能层**（2 插件） | 新工具注册 | `fast_locate` 秒级多根扫描、`env_check` 环境诊断 |
| **skill 层**（7 个） | 按需加载 | 错误协议 L0/L1、查文件方法论、报告交付协议 |

## 架构

```
cordis.patch.yml (主 patch)
├─ discipline-hub          协作中枢（O1 失败聚合 / O2 提醒仲裁 / O7 turn 统计）
├─ discipline-board        纪律层子板（cordis:include）
│  ├─ anti-stuck           死磕拦截：同参重试 deny / 工具级密度 / 顺序依赖 / 旧快照
│  ├─ dsh-env-triage       方案级溯源：溯源卡 / 绕圈卡（3 方案全败→报告） / turn 复盘
│  ├─ dsh-plan-discipline  todo 纪律：多步骤提醒 + 试错期强制刷新
│  ├─ dsh-memory           跨会话记忆：add 查重 / 时间窗去重 / force 分级
│  ├─ skill-evolver        自动沉淀：失败→解法→skill（泛化门槛防垃圾）
│  ├─ dsh-discipline       系统提示词 11 条执行纪律（每轮注入）
│  ├─ dsh-skill-loader     skill 加载促进：条件化清单 + 关键词点名
│  └─ dsh-cordis-discipline 动态插件护栏（define→run→stop 流程强制）
├─ tools-board             功能层子板
│  ├─ dsh-fast-locate      fast_locate 工具：多根并行扫描、跳 node_modules、glob
│  └─ dsh-env-check-tool   env_check 工具：环境诊断注册表（9 项检查）
└─ 官方功能包（schedule/lsp/...）保持独立
```

## 安装

```powershell
# 1. 克隆（发布后把 <owner> 换成真实仓库所有者）
git clone https://github.com/<owner>/cleverer-dsh
cd cleverer-dsh

# 2. 安装（自动：备份现有 patch → 复制插件/skill/env-check 脚本 → 生成子板 → 幂等合并）
pwsh -File install.ps1

# 3. 重启 DSH 生效（或重开 DSH 桌面应用 / 重启 dsh web 进程）
```

> 前置要求：DeepSeek Harness 已安装并初始化 `~/.dsh`；`node` 可用（插件零依赖，仅校验用）。
> 可选：设置 `DSH_REPO` 环境变量指向 DSH checkout（env_check 的打包检查项需要）。

install.ps1 会向 DSH home 安装：
- `plugins/`（12 个文件：11 插件 + `_shared.mjs` 公共模块，相对导入必须全量）
- `skills/`（7 个纪律 skill，同内容跳过）
- `scripts/dsh-env-check.mjs`（env_check 工具的检查项注册表，安装到 `<DSH_HOME>/scripts/`）
- 生成 `discipline-board.cordis.yml` / `tools-board.cordis.yml` 子板（`{{DSH_HOME}}` 替换为本机路径）
- 合并 `cordis.patch.yml`（幂等：已有 id 不重复加；备份原文件为 `.bak-cleverer-*`）

### 安装后验证

```powershell
# 全部单测（426 项）
pwsh -File tests/run-all.ps1        # 或 cd tests; node test-anti-stuck.mjs; ...

# 环境健康检查（9 项）
node scripts/dsh-env-check.mjs all
```

### 卸载

```powershell
# 1. 移除挂载：还原 install 备份（或手工删除 cordis.patch.yml 中的
#    discipline-hub / discipline-board / tools-board 三项）
Copy-Item "$HOME\.dsh\cordis.patch.yml.bak-cleverer-*" "$HOME\.dsh\cordis.patch.yml" -Force

# 2. 删除安装文件（12 个插件 + 7 个 skill + 2 个子板 + env-check 脚本）
Remove-Item "$HOME\.dsh\plugins\*.mjs" -ErrorAction SilentlyContinue   # 若该目录是纯 cleverer-dsh 可整目录删
Remove-Item "$HOME\.dsh\discipline-board.cordis.yml","$HOME\.dsh\tools-board.cordis.yml" -ErrorAction SilentlyContinue
Remove-Item "$HOME\.dsh\scripts\dsh-env-check.mjs" -ErrorAction SilentlyContinue

# 3. 重启 DSH
```

## 插件职责速查

| 插件 | 治什么病 | 怎么触发 |
|---|---|---|
| `anti-stuck` | 死磕（同命令失败 N 次）、盲改、无反思 | 失败 ≥2 同参 → deny；turn 失败 ≥3 → 提醒；≥5 → 强制反思 |
| `dsh-env-triage` | 换参试错（同根因多方案）、绕圈 | ≥2 方案失败 → 溯源卡；≥3 → 绕圈卡（停下报告） |
| `dsh-plan-discipline` | todo 爱用不用、试错期计划中断 | 多步骤信号 + 无 todo → 提醒；失败 ≥3 且 todo 未更新 → 刷新 |
| `dsh-memory` | 记忆重复膨胀、force 滥用 | add 查重（0.62 阈值）+ 60s 时间窗 + force 分级 |
| `skill-evolver` | 垃圾 skill（路径名/工具串/XML 残留） | turn 结束沉淀前过泛化门槛（路径名拒绝/清洗/语义校验） |
| `dsh-discipline` | system 提示词为空 | 每轮注入 11 条执行纪律 |
| `dsh-skill-loader` | skill 装了不用（0 次调用） | 首步注入条件化清单 + 关键词点名 |
| `dsh-cordis-discipline` | 动态插件乱用 | 前置条件拦截（run 前必须 define 等） |
| `discipline-hub` | 插件各写各的、提醒刷屏 | `__errLog` 聚合 + 仲裁限流（单步 ≤2 条） |
| `dsh-fast-locate` | 查文件慢（串行 grep） | `fast_locate` 工具：一次调用并行多根扫描 |
| `dsh-env-check-tool` | 环境问题靠猜 | `env_check` 工具：9 项检查注册表 |

## skill 清单

| skill | 作用 |
|---|---|
| `dsh-error-protocol` (L0) | 错误处理六步协议（分类→诊断→决策→验证→沉淀） |
| `dsh-error-triage` (L1) | 错误路由表（错误域→诊断命令→修复协议，8 域） |
| `dsh-fast-lookup` | 查文件方法论（实体优先 + 环境地图） |
| `debug-by-root-cause` | 失败根因分析（补强：新环境读源码、pwsh exitCode 判定） |
| `local-first` | 本地优先（补强：探测命令沉淀为脚本） |
| `plan-before-execute` | 先计划再执行（补强：试错期持续更新 todo） |
| `annotated-report` | 报告交付双格式协议（md + 批注 HTML，工具为外部依赖） |

## 测试

```powershell
pwsh -File tests/run-all.ps1        # 全部 426 项
cd tests
node test-anti-stuck.mjs        # 41 项：deny/成功清零/指纹归一化/注入/steer 去重/边界
node test-cordis-discipline.mjs # 44 项：cordis 生命周期纪律/result 确认/steer
node test-discipline-hub.mjs    # 35 项：errLog 聚合/仲裁限流/错误分类/容量/清理
node test-dsh-discipline.mjs    # 24 项：纪律段注册/覆盖
node test-dsh-memory.mjs        # 48 项：查重/时间窗/force 分级/损坏文件/nudge
node test-env-check.mjs         # 61 项：9 项检查注册表全分支（mock fs）
node test-env-check-tool.mjs    # 15 项：工具注册/超时/混合输出
node test-env-triage.mjs        # 22 项：溯源卡/绕圈卡/turn 复盘/hub 仲裁
node test-fast-locate.mjs       # 32 项：并行扫描/glob/截断/junction/stat 失败
node test-plan-discipline.mjs   # 29 项：多步骤信号/todo 判定/限流
node test-skill-evolver.mjs     # 33 项：学习/查重/泛化门槛/异常
node test-skill-loader.mjs      # 42 项：清单注入/点名/限流/清理
# 合计 426 项
```

**覆盖率（c8 全量合并测量，v1.2 重构后）**：全局语句 100% / 分支 96.74% / 函数 98.91% / 行 100%；7 个源文件全维度 100%（dsh-cordis-discipline / dsh-discipline / dsh-env-check-tool / dsh-env-check.mjs / dsh-plan-discipline / dsh-skill-loader / dsh-fast-locate）。公共工具抽到 `plugins/_shared.mjs`（fingerprint/isFailure/extractText/classifyError/similarity/currentTurn/cleanupTimer 统一 4 处复制）。其余未覆盖项全部为已确认的死分支/不可安全测试项（详见 `docs/TESTING.md` 第二节）。

另有 `tests/replay-discipline.mjs`（回放验证 harness）：把真实 DSH 会话日志喂给插件统计干预覆盖率——量化"改进前 vs 改进后"（实测干预 4→11 次，+175%）。

## 方法论（本项目的灵魂）

- **取证驱动**：每个插件都来自真实长任务日志分析（死磕次数、该用未用检测、失败归因），不是拍脑袋
- **无意识功能测验**：验收测试的提示词不含任何"记得用插件/skill"字样——只有 agent 在无提示下自发使用，才证明能力内化
- **可观测性**：env_check 健康检查（插件语法/装配一致性/skill 合规）+ deploy 部署闭环（同步→验证→重启→复验），杜绝"改了没生效"

## 已知限制 / 非目标

- 仅验证于 Windows + PowerShell；Linux/macOS 未测（插件本体跨平台，部署脚本是 pwsh）
- `annotated-report` 的批注工具（md2annotate.py）是外部依赖，不随本仓库分发
- 不修改 DSH 源码（`packages/client/*` 等是白屏高危区，见 `docs/`）；纯 home patch + skill 注入
- headless 模式部分功能受限（无 webServer → 批注 web 版跳过）

## 许可证

MIT © 2026 cleverer-dsh contributors

## 发布前检查（铁律）

推送 GitHub 前必须：
1. `pwsh -File scripts/publish-audit.ps1` —— 审计**全绿**才允许（扫描个人信息：真名/拼音邮箱/本机路径/ID/单位/地点）
2. 确认 git 身份为匿名（`cleverer-dsh@users.noreply.github.com`）
3. 确认版本 tag（预发布 `v0.9.0-rcN`，正式 `v1.0.0`）

---

*文档详细版：`docs/ARCHITECTURE.md`（三层架构与协作框架）、`docs/TESTING.md`（验证方法论）*
