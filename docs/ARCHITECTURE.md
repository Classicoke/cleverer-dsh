# 架构文档

## 三层结构

cleverer-dsh 把"让 agent 变聪明"拆成三层，每层用不同的注入机制：

```
┌─ skill 层（知识，按需加载）─────────────────────────────┐
│  dsh-error-protocol (L0 协议)                            │
│  dsh-error-triage (L1 路由表)                            │
│  dsh-fast-lookup / debug / local-first / plan / report   │
└──────────────────────────────────────────────────────────┘
┌─ 插件层（行为，事件驱动）───────────────────────────────┐
│  事件钩子: tools/result · tools/pre-execute ·           │
│           agent/pre-step · agent/turn-stopping          │
│  系统提示词: dsh-discipline 11 条 (每轮注入)             │
└──────────────────────────────────────────────────────────┘
┌─ 协作中枢（状态，共享）─────────────────────────────────┐
│  discipline-hub: __errLog 聚合 + __reminder 仲裁 +       │
│                  __hubStats turn 统计                    │
└──────────────────────────────────────────────────────────┘
```

- **skill 层**：零 token 成本（按需加载），管"遇到 X 该怎么做"
- **插件层**：事件驱动（失败才触发）或常驻注入（每轮），管"行为约束"
- **协作中枢**：多插件共享状态，消灭"各写各的"数据流断裂

## 协作框架（O 系列，来自多插件体系审查）

多插件挂同一事件会冲突（同一步塞多条提醒、失败记录分散、职责重叠）。discipline-hub 实现四个协作原语：

| 原语 | 实现 | 解决 |
|---|---|---|
| **O1 统一失败记录** | `ctx.__errLog` 数组，hub 在 tools/result 聚合 `{at, turn, tool, fp, errorClass, text}`（上限 500 条），错误分类按特异性排序（stale-snapshot 先于 order-dep） | 数据流断裂（各插件重算失败） |
| **O2 提醒仲裁** | `ctx.__reminder(agentId, {priority, text})` 排队；pre-step 按优先级取前 2 条注入 | 同一步多条 reminder 刷屏 |
| **O3 职责分层** | anti-stuck=工具级（同参 deny/旧快照/顺序依赖）；env-triage=方案级（换参溯源/3 方案报告/复盘），触发条件互斥 | 双重提醒 |
| **O4 根因回写** | env-triage 在 turn-stopping 给 `__errLog` 同分类记录打 `rootCause` 标记；skill-evolver 只沉淀带标记记录 | 垃圾 skill（无根因不沉淀） |
| **O7 turn 生命周期** | turn 失败数统计（`__hubStats.turnFails`）+ steer 去重（同 turn 只 steer 一次） | 单 turn 长会话循环刷屏 |

> O5（干预反馈回路）/ O6（沉淀/记忆路由）为预留扩展点。

## 事件挂载地图

| 事件 | 监听插件 | 顺序保证 |
|---|---|---|
| `tools/result` | hub（聚合）、anti-stuck（指纹）、env-triage（方案）、skill-evolver（沉淀取料） | hub 最先（聚合是基础） |
| `tools/pre-execute` | anti-stuck（deny）、cordis-discipline（前置条件） | 任一 deny 即拦截 |
| `agent/pre-step` | hub（仲裁注入）、anti-stuck（提醒）、env-triage（卡）、plan-discipline（todo）、skill-loader（点名） | hub 仲裁限流 |
| `agent/turn-stopping` | env-triage（复盘+O4 回写）、skill-evolver（沉淀）、cordis（遗留检查） | 各司其职 |

## 设计原则

1. **能常驻的必须常驻**：行为准则进 system-prompt（与 Hermes 底座同构），程序强制才用事件钩子
2. **可观测性**：`env_check` 检查插件语法/装配一致性/skill 合规；`dsh-deploy.ps1` 部署闭环（同步→验证→重启→复验）杜绝"改了没生效"
3. **触发宁缺毋滥**：误判是纯损失，分类表只放高置信模式
4. **诊断≠修复**：工具给事实（env_check），AI 做修复决策
5. **零依赖**：所有插件只用 node 内置模块（`node:crypto` 等），本地文件挂载无包管理负担
