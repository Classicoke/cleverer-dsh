# cleverer-dsh

[English](README.md) | 中文

让 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 变聪明的插件套件——把执行纪律、实用工具和技能库一次性装进 DSH。

---

## ✨ 功能总结

| 图标 | 功能 |
|---|---|
| ⚡ | **实测更快更省**：同一任务对比裸 DSH，**速度提升 49%**、估算 token -44%（小样本，未大规模测试） |
| 🧠 | **执行纪律**：失败自动拦截、强制反思、任务规划提醒、记忆自动去重、经验自动沉淀成技能 |
| 🛠️ | **开箱即用工具**：秒级找文件 + 9 项环境体检，遇到问题不再靠猜 |
| 📦 | **一条命令安装/卸载**（走 DSH 自带插件管理器） |
| 🧪 | **478 项单元测试全绿**，语句/行覆盖率 100%；纯代码、零依赖，不碰 DSH 本体 |
| 📚 | **6 个内置技能**：错误处理六步法、错误速查表、快速找文件、根因排查、本地优先、先计划再执行 |

---

## 效果对比

我们用同一个真实任务（分析一份软件打包日志），分别跑**装了本套件的 DSH** 和**什么都没装的裸 DSH**，结果：

| 指标 | 装套件 | 裸 DSH | 差距 |
|---|---|---|---|
| **总耗时** | 8.6 分钟 | 12.8 分钟 | **速度提升 49%** |
| LLM 调用次数 | 51 次 | 61 次 | 少 20% |
| 工具调用次数 | 59 次 | 67 次 | 少 14% |
| **估算总 token** | ~41,000 | ~73,000 | **省 44% 流量** |
| 反复推理次数 | 401 | 1,163 | 少 65% |

**实际体验差距**：装套件后，遇到问题不硬磕（会自动换思路）、把好用的命令沉淀成脚本复用、关键节点会先问你再动手；裸 DSH 会在同一个问题上反复试 13 次、不沉淀方法、也不征求你意见。

> ⚠️ **声明**：每组只测了 1 次（n=1），token 是按日志估算的（误差约 ±20%），**还没有大规模测试**——方向有证据，具体数字等更多样本和真实账单校准。

---

## 解决什么问题

DSH 功能齐全，但**不够聪明**：系统提示词是空的、失败了会死磕、技能装了不用、规划工具爱用不用。本套件用四层补齐：

| 层 | 作用 |
|---|---|
| **纪律层**（8 个插件） | 失败拦截、强制反思、任务规划、记忆去重 |
| **协作中枢**（discipline-hub） | 统一失败记录 + 提醒限流——插件不打架、问题可追溯 |
| **工具层**（2 个插件） | 秒级找文件、环境体检 |
| **技能层**（6 个技能） | 按需自动加载——出错知道怎么办、找东西快 |

---

## 架构

```
cordis.patch.yml
├─ discipline-hub          协作中枢（失败记录 / 提醒限流 / 回合统计）
├─ anti-stuck              死磕拦截：同样的错误不让重复试、强制换思路
├─ dsh-env-triage          问题溯源：几个方案都失败就停下来报告
├─ dsh-plan-discipline     任务规划：多步骤任务提醒建计划
├─ dsh-memory              跨会话记忆：自动去重、防膨胀
├─ skill-evolver           经验沉淀：失败→解法→自动存成技能
├─ dsh-discipline          执行规则：每轮注入 11 条做事纪律
├─ dsh-skill-loader        技能调用：按需提醒用技能
├─ dsh-skill-provider      技能注册：6 个内置技能随包直接可用
├─ dsh-cordis-discipline   插件使用规范：防止乱装乱卸载
├─ dsh-fast-locate         找文件工具：一次扫描多个目录
└─ dsh-env-check-tool      环境体检工具：9 项检查
```

---

## 安装

**前置要求**：已安装 DSH 并初始化过 `~/.dsh`；需要 `pnpm`（DSH 插件管理器）。

### 方式一：DSH 插件管理器安装（推荐）

```bash
dsh plugin --profile web add github:Classicoke/cleverer-dsh
# headless 用户：  dsh plugin --profile headless add github:Classicoke/cleverer-dsh
```

无需构建——命令跑完插件和技能直接可用。卸载：

```bash
dsh plugin --profile web remove cleverer-dsh
```

### 方式二：一键脚本安装（需 PowerShell 7+）

在 PowerShell 里粘贴这一行（自动下载发布包 → 解压 → 安装 → 清理临时文件）：

```powershell
$u = 'https://github.com/Classicoke/cleverer-dsh/archive/refs/tags/v1.2.zip'
$z = "$env:TEMP\cleverer-dsh.zip"; $d = "$env:TEMP\cleverer-dsh-install"
Invoke-WebRequest $u -OutFile $z
Expand-Archive $z $d -Force
pwsh -File "$d\cleverer-dsh-1.2\install.ps1"
Remove-Item $z, $d -Recurse -Force
```

> ⚠️ **两种安装方式二选一。** 同时安装 = 每个插件被加载两次（行为重复、提前误判）。切换方式前先卸载另一种。

---

## 插件一览

| 插件 | 解决什么问题 | 什么时候触发 |
|---|---|---|
| `anti-stuck` | 死磕：同一个命令反复失败还硬试 | 同一错误 ≥2 次 → 拦住；一次任务失败 ≥3 次 → 提醒；≥5 次 → 强制停下来反思 |
| `dsh-env-triage` | 换着参数试错、绕圈圈 | ≥2 个方案都失败 → 提示查原因；≥3 个 → 停下报告 |
| `dsh-plan-discipline` | 任务规划工具爱用不用 | 多步骤任务没建计划 → 提醒；失败 ≥3 次且计划没更新 → 强制刷新 |
| `dsh-memory` | 记忆重复膨胀、乱用强制写入 | 写入前查重 + 60 秒窗口去重 |
| `skill-evolver` | 沉淀垃圾技能 | 存技能前过"泛化门槛"，路径名/临时内容直接拒收 |
| `dsh-discipline` | 系统提示词是空的 | 每轮注入 11 条执行纪律 |
| `dsh-skill-loader` | 技能装了从来不用 | 任务开头提醒可用技能 + 关键词点名 |
| `dsh-cordis-discipline` | 动态插件乱装乱卸 | 前置检查（没定义不许运行、没停止不许卸载） |
| `discipline-hub` | 插件各管各的、提醒刷屏 | 统一记录失败 + 提醒限流 |
| `dsh-fast-locate` | 找文件慢 | 一条命令并行扫描多个目录 |
| `dsh-env-check-tool` | 环境问题全靠猜 | 一键跑 9 项环境体检 |

---

## 内置技能

| 技能 | 用途 |
|---|---|
| `dsh-error-protocol` | 出错后的六步处理流程（分类→诊断→决策→验证→沉淀） |
| `dsh-error-triage` | 错误速查表：什么错对应什么命令 |
| `dsh-fast-lookup` | 快速找文件的方法论 |
| `debug-by-root-cause` | 排查问题先找根因，不盲目试 |
| `local-first` | 能本地验证就不上网猜 |
| `plan-before-execute` | 动手前先列计划，边做边更新 |

---

## 已知限制

- 只在 **Windows + PowerShell** 上验证过；Linux/macOS 没测（插件本身跨平台，安装脚本是 PowerShell）
- 不修改 DSH 源码；只通过配置注入和技能注入
- headless 模式部分功能受限（无网页服务 → 部分网页相关功能跳过）

---

## 许可证

MIT © 2026 cleverer-dsh contributors
