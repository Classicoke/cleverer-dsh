# cleverer-dsh

> **让 DeepSeek Harness (DSH) 变聪明的插件套件** / *Make DeepSeek Harness (DSH) actually smart — a plugin suite that ports Hermes-grade execution discipline into the DSH ecosystem.*

---

## ✨ 功能总结 / Feature Highlights

| 中文 | English |
|---|---|
| 🧠 **执行纪律**：失败拦截、强制反思、todo 纪律、记忆查重、skill 自动沉淀——把 Hermes 级自律移植进 DSH | **Execution discipline**: failure interception, forced reflection, todo discipline, memory dedup, self-evolving skills — Hermes-grade self-discipline for DSH |
| 🛠️ **开箱即用工具**：`fast_locate` 秒级多根扫描 + `env_check` 9 项环境诊断，不再靠猜 | **Ready-made tools**: `fast_locate` instant multi-root scan + `env_check` 9-point env diagnostics — stop guessing |
| 📦 **一键安装**：`install.ps1` 幂等安装（自动备份/合并 patch/生成子板），**卸载一条命令还原** | **One-command install**: idempotent `install.ps1` (auto backup / patch merge / board generation), one-command uninstall |
| 🧪 **426 项单元测试全绿**，覆盖率 99.7%+；纯 ESM、**零依赖**，不碰 DSH 源码 | **426 unit tests green**, 99.7%+ coverage; pure ESM, **zero dependencies**, never touches DSH source |
| 📚 **7 个自研 skill**：错误协议 L0/L1、查文件方法论、报告交付协议，按需自动加载 | **7 handcrafted skills**: error protocol L0/L1, file-lookup methodology, report delivery — auto-loaded on demand |
| ⚡ **实测净收益**：同任务对比裸 DSH，耗时 -33%、估算 token -44%（小样本，未大规模测试）| **Measured gains**: same task vs bare DSH — 33% less time, 44% fewer estimated tokens (small sample, not yet broadly tested) |

---

## 案例分析 / Case study

同一真实任务（桌面应用打包的日志分析），v1.2 插件套件 vs **裸 DSH 实例**（隔离 DSH_HOME，无插件、无 skill）对比。*The same real task (desktop-app packaging log analysis), v1.2 plugin suite vs a **bare DSH instance** (isolated DSH_HOME, no plugins, no skills).*

| 指标 / Metric | v1.2 | 裸 / bare | 差异 / diff |
|---|---|---|---|
| **总耗时 / total time** | 514.5s (8.58min) | 765.2s (12.75min) | **-33%** |
| LLM 调用 / LLM calls | 51 | 61 | -20% |
| 工具调用 / tool calls | 59 | 67 | -14% |
| **估算总 token / est. total tokens** | ~40,980 | ~73,211 | **-44%** |
| 其中推理块 / reasoning chunks | 401 | 1,163 | -65% |

**过程质量差异 / process quality**：v1.2 无死磕、有脚本化、卡点征求用户；裸实例 13 次内联试错未沉淀、未征求卡点决策。*v1.2: no stuck loops, scripted approaches, checkpoint consultation; bare: 13 inline retries, no checkpoint consultation.*

> ⚠️ **声明 / disclaimer**：样本量各 1 次（n=1），token 为日志字符估算口径（±20%），**未大规模测试**——收益方向有证据，数值待更多样本与 API 后台真实用量校准。*n=1 per group; tokens are character-estimated (±20%); NOT broadly tested — direction is evidenced, magnitudes await more samples and real API usage data.*

---

## 这是什么 / What is this

DSH（DeepSeek Harness）功能齐全但"默认不聪明"：系统提示词是空的、失败会死磕、skill 装而不用、计划工具爱用不用。cleverer-dsh 用 **cordis 插件 + skill 两层**补齐。

*DSH is full-featured but "not smart by default": empty system prompt, stubborn retries on failure, skills installed but never used, todo tool ignored. cleverer-dsh fixes this with two layers: cordis plugins + skills.*

| 层 / Layer | 机制 / Mechanism | 效果 / Effect |
|---|---|---|
| **纪律层**（8 插件）/ *Discipline layer (8 plugins)* | 事件钩子 + system-prompt 注入 / *event hooks + system-prompt injection* | 失败拦截、强制反思、todo 纪律、记忆查重 / *failure interception, forced reflection, todo discipline, memory dedup* |
| **协作中枢**（discipline-hub）/ *Hub* | 共享 `__errLog` + 提醒仲裁 + turn 统计 / *shared `__errLog` + reminder arbitration + turn stats* | 多插件不冲突、失败数据可观测 / *plugins don't collide, failure data is observable* |
| **功能层**（2 插件）/ *Tools layer (2 plugins)* | 新工具注册 / *new tool registration* | `fast_locate` 秒级多根扫描、`env_check` 环境诊断 / *instant multi-root scan, env diagnostics* |
| **skill 层**（7 个）/ *Skill layer (7 skills)* | 按需加载 / *on-demand loading* | 错误协议 L0/L1、查文件方法论、报告交付协议 / *error protocols, lookup methodology, report delivery* |

---

## 架构 / Architecture

```
cordis.patch.yml (主 patch / main patch)
├─ discipline-hub          协作中枢（O1 失败聚合 / O2 提醒仲裁 / O7 turn 统计）
│                          Hub (O1 failure aggregation / O2 reminder arbitration / O7 turn stats)
├─ discipline-board        纪律层子板（cordis:include）/ Discipline sub-board
│  ├─ anti-stuck           死磕拦截：同参重试 deny / 工具级密度 / 顺序依赖 / 旧快照
│  │                       Stuck-loop guard: same-arg retry deny / density / order-dep / stale snapshot
│  ├─ dsh-env-triage       方案级溯源：溯源卡 / 绕圈卡（3 方案全败→报告）/ turn 复盘
│  │                       Scheme-level tracing: trace card / loop card (3 fails → report) / turn review
│  ├─ dsh-plan-discipline  todo 纪律：多步骤提醒 + 试错期强制刷新
│  │                       Todo discipline: multi-step reminders + forced refresh during trial-and-error
│  ├─ dsh-memory           跨会话记忆：add 查重 / 时间窗去重 / force 分级
│  │                       Cross-session memory: add dedup / time-window dedup / force tiers
│  ├─ skill-evolver        自动沉淀：失败→解法→skill（泛化门槛防垃圾）
│  │                       Self-evolving: failure → solution → skill (generalization gate)
│  ├─ dsh-discipline       系统提示词 11 条执行纪律（每轮注入）
│  │                       11 execution rules injected into system prompt every turn
│  ├─ dsh-skill-loader     skill 加载促进：条件化清单 + 关键词点名
│  │                       Skill loading boost: conditional catalog + keyword summoning
│  └─ dsh-cordis-discipline 动态插件护栏（define→run→stop 流程强制）
│                          Dynamic-plugin guardrail (define→run→stop enforced)
├─ tools-board             功能层子板 / Tools sub-board
│  ├─ dsh-fast-locate      fast_locate 工具：多根并行扫描、跳 node_modules、glob
│  │                       fast_locate: parallel multi-root scan, skips node_modules, glob
│  └─ dsh-env-check-tool   env_check 工具：环境诊断注册表（9 项检查）
│                          env_check: env diagnostics registry (9 checks)
└─ 官方功能包（schedule/lsp/...）保持独立 / official packages stay untouched
```

---

## 安装 / Installation

```powershell
# 1. 克隆 / Clone（发布后把 <owner> 换成真实仓库所有者 / replace <owner> after publishing）
git clone https://github.com/<owner>/cleverer-dsh
cd cleverer-dsh

# 2. 安装 / Install（自动：备份现有 patch → 复制插件/skill/env-check 脚本 → 生成子板 → 幂等合并）
#    Auto: backup existing patch → copy plugins/skills/env-check script → generate boards → idempotent merge
pwsh -File install.ps1

# 3. 重启 DSH 生效 / Restart DSH to activate（重开桌面应用 / restart the desktop app, or restart the dsh web process）
```

> **前置要求 / Prerequisites**：DeepSeek Harness 已安装并初始化 `~/.dsh`；`node` 可用（插件零依赖，仅校验用 / plugins are zero-dep, node only used for validation）。
> **可选 / Optional**：设置 `DSH_REPO` 环境变量指向 DSH checkout（env_check 的打包检查项需要 / needed for env_check's packaging checks）。

**install.ps1 会向 DSH home 安装 / What install.ps1 installs into your DSH home:**

| 组件 / Component | 说明 / Description |
|---|---|
| `plugins/` | 12 个文件：11 插件 + `_shared.mjs` 公共模块（相对导入必须全量）/ 11 plugins + `_shared.mjs` shared module (relative imports — copy ALL) |
| `skills/` | 7 个纪律 skill（同内容跳过）/ 7 discipline skills (skipped if identical) |
| `scripts/dsh-env-check.mjs` | env_check 工具的检查项注册表，装到 `<DSH_HOME>/scripts/` / check registry for env_check tool |
| 2 个子板 / sub-boards | `discipline-board.cordis.yml` / `tools-board.cordis.yml`（`{{DSH_HOME}}` 替换为本机路径 / placeholder replaced with your path) |
| patch 合并 / patch merge | 幂等：已有 id 不重复加；原文件备份为 `.bak-cleverer-*` / idempotent; original backed up as `.bak-cleverer-*` |

### 安装后验证 / Post-install verification

```powershell
# 全部单测（426 项）/ all unit tests
pwsh -File tests/run-all.ps1        # 或 cd tests; node test-anti-stuck.mjs; ...

# 环境健康检查（9 项）/ env health check
node scripts/dsh-env-check.mjs all
```

### 卸载 / Uninstall

```powershell
# 1. 还原 install 备份（或手工删除 cordis.patch.yml 中 discipline-hub/discipline-board/tools-board 三项）
#    Restore the install backup (or manually remove the 3 mount entries from cordis.patch.yml)
Copy-Item "$HOME\.dsh\cordis.patch.yml.bak-cleverer-*" "$HOME\.dsh\cordis.patch.yml" -Force

# 2. 删除安装文件 / remove installed files（12 插件 + 7 skill + 2 子板 + env-check 脚本）
Remove-Item "$HOME\.dsh\plugins\*.mjs" -ErrorAction SilentlyContinue   # 若目录是纯 cleverer-dsh 可整目录删 / safe to remove whole dir if dedicated
Remove-Item "$HOME\.dsh\discipline-board.cordis.yml","$HOME\.dsh\tools-board.cordis.yml" -ErrorAction SilentlyContinue
Remove-Item "$HOME\.dsh\scripts\dsh-env-check.mjs" -ErrorAction SilentlyContinue

# 3. 重启 DSH / restart DSH
```

---

## 插件职责速查 / Plugin cheat sheet

| 插件 / Plugin | 治什么病 / Fixes | 怎么触发 / Trigger |
|---|---|---|
| `anti-stuck` | 死磕（同命令失败 N 次）、盲改、无反思 / stubborn retries, blind edits, no reflection | 失败 ≥2 同参 → deny；turn 失败 ≥3 → 提醒；≥5 → 强制反思 / ≥2 same-arg fails → deny; ≥3 turn fails → remind; ≥5 → force reflection |
| `dsh-env-triage` | 换参试错（同根因多方案）、绕圈 / param-tweaking, looping | ≥2 方案失败 → 溯源卡；≥3 → 绕圈卡（停下报告）/ ≥2 schemes fail → trace card; ≥3 → loop card (stop & report) |
| `dsh-plan-discipline` | todo 爱用不用、试错期计划中断 / todo ignored, plan drift | 多步骤信号 + 无 todo → 提醒；失败 ≥3 且 todo 未更新 → 刷新 / multi-step + no todo → remind; ≥3 fails & stale todo → refresh |
| `dsh-memory` | 记忆重复膨胀、force 滥用 / memory bloat, force abuse | add 查重（0.62 阈值）+ 60s 时间窗 + force 分级 / dedup (0.62) + 60s window + force tiers |
| `skill-evolver` | 垃圾 skill（路径名/工具串/XML 残留）/ junk skills | turn 结束沉淀前过泛化门槛 / generalization gate before persisting |
| `dsh-discipline` | system 提示词为空 / empty system prompt | 每轮注入 11 条执行纪律 / injects 11 rules every turn |
| `dsh-skill-loader` | skill 装了不用（0 次调用）/ skills unused | 首步注入条件化清单 + 关键词点名 / conditional catalog + keyword summon |
| `dsh-cordis-discipline` | 动态插件乱用 / dynamic-plugin misuse | 前置条件拦截（run 前必须 define 等）/ precondition interception |
| `discipline-hub` | 插件各写各的、提醒刷屏 / plugin chaos, reminder spam | `__errLog` 聚合 + 仲裁限流（单步 ≤2 条）/ aggregation + throttling (≤2/step) |
| `dsh-fast-locate` | 查文件慢（串行 grep）/ slow file lookup | `fast_locate` 工具：一次调用并行多根扫描 / one call, parallel multi-root scan |
| `dsh-env-check-tool` | 环境问题靠猜 / guessing at env issues | `env_check` 工具：9 项检查注册表 / 9-check registry |

---

## skill 清单 / Skill catalog

| skill | 作用 / Purpose |
|---|---|
| `dsh-error-protocol` (L0) | 错误处理六步协议（分类→诊断→决策→验证→沉淀）/ 6-step error protocol |
| `dsh-error-triage` (L1) | 错误路由表（错误域→诊断命令→修复协议，8 域）/ error routing table (8 domains) |
| `dsh-fast-lookup` | 查文件方法论（实体优先 + 环境地图）/ file-lookup methodology |
| `debug-by-root-cause` | 失败根因分析（新环境读源码、pwsh exitCode 判定）/ root-cause debugging |
| `local-first` | 本地优先（探测命令沉淀为脚本）/ local-first verification |
| `plan-before-execute` | 先计划再执行（试错期持续更新 todo）/ plan before executing |
| `annotated-report` | 报告交付双格式协议（md + 批注 HTML）/ dual-format report delivery |

---

## 测试 / Testing

```powershell
pwsh -File tests/run-all.ps1        # 全部 426 项 / all 426 tests
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
# 合计 / total: 426 项
```

**覆盖率 / Coverage（c8 全量合并测量，v1.2 重构后 / measured after the v1.2 refactor）**：全局语句 100% / 分支 96.74% / 函数 98.91% / 行 100%；7 个源文件全维度 100%（dsh-cordis-discipline / dsh-discipline / dsh-env-check-tool / dsh-env-check.mjs / dsh-plan-discipline / dsh-skill-loader / dsh-fast-locate）。公共工具抽到 `plugins/_shared.mjs`。其余未覆盖项全部为已确认的死分支/不可安全测试项（详见 `docs/TESTING.md` 第二节 / see docs/TESTING.md §2）。

另有 `tests/replay-discipline.mjs`（回放验证 harness）：把真实 DSH 会话日志喂给插件统计干预覆盖率——量化"改进前 vs 改进后"（实测干预 4→11 次，+175%）。*A replay harness that feeds real DSH session logs through the plugins to quantify before/after intervention coverage (+175% measured).*

---

## 方法论 / Methodology（本项目的灵魂 / the soul of this project）

- **取证驱动 / Forensics-driven**：每个插件都来自真实长任务日志分析（死磕次数、该用未用检测、失败归因），不是拍脑袋 / every plugin comes from real long-task log analysis, not guesswork
- **无意识功能测验 / Unconscious capability test**：验收测试的提示词不含任何"记得用插件/skill"字样——只有 agent 在无提示下自发使用，才证明能力内化 / acceptance prompts never mention the plugins — spontaneous use is the only proof of internalization
- **可观测性 / Observability**：env_check 健康检查（插件语法/装配一致性/skill 合规）+ deploy 部署闭环（同步→验证→重启→复验），杜绝"改了没生效" / health checks + deploy loop (sync → verify → restart → re-verify), no more "it didn't take effect"

---

## 已知限制 / Known limitations & non-goals

- 仅验证于 **Windows + PowerShell**；Linux/macOS 未测（插件本体跨平台，部署脚本是 pwsh）/ *Verified on Windows + PowerShell only; plugin code is cross-platform, deploy scripts are pwsh*
- `annotated-report` 的批注工具（md2annotate.py）是外部依赖，不随本仓库分发 / *annotation tool is an external dependency, not bundled*
- 不修改 DSH 源码（`packages/client/*` 等是白屏高危区）；纯 home patch + skill 注入 / *never modifies DSH source; pure home-patch + skill injection*
- headless 模式部分功能受限（无 webServer → 批注 web 版跳过）/ *headless mode: some features limited (no webServer → web annotation skipped)*

---

## 许可证 / License

MIT © 2026 cleverer-dsh contributors

---

*文档详细版 / Extended docs：`docs/ARCHITECTURE.md`（三层架构与协作框架 / 3-layer architecture & collaboration）、`docs/TESTING.md`（验证方法论 / testing methodology）*
