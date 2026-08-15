---
name: dsh-fast-lookup
description: 找文件/查东西/定位实体时，先 fast_locate 一步扫描（并行多根、跳过噪音目录），别串行 grep→pwsh。含 DSH 本机环境地图与查找陷阱。
---

# dsh-fast-lookup — 实体优先查找（找东西先想"在哪"，不先想"怎么查"）

## 什么时候用

- 用户问"xxx 文件在哪 / 找一下 / 查查 / 搜 / 定位"
- 需要确定某个文件/目录的绝对路径（先定位再读，别 grep 猜）
- 不知道东西在哪就准备开始改 → 先定位实体

## 核心纪律：实体优先

**先 fast_locate 一步定位，再决定读/改/查**。不要串行 Grep→Pwsh→HELLO 三步走
（那是"查东西慢"的根因：串行 + 先查定义后查实体 + 无环境先验）。

```text
fast_locate(pattern="host-boot", roots=["D:/deepseek-harness-master"])
# → 1 次调用返回 [{path, type, size, mtime}]，mtime 倒序
```

- pattern 含 `*`/`?` 按 glob（`*.mjs` 命中任意深度），否则子串匹配，大小写不敏感
- 自动跳过 node_modules/.git/dist/.venv/__pycache__ 等噪音目录
- 可同时传多个 roots（并行扫描）
- 结果按修改时间倒序——最新改的文件排最前

## 本机环境地图（DSH 部署拓扑）

| 要找的东西 | 位置 |
|---|---|
| DSH 会话日志 | `~/.dsh/sessions/<项目key>/<会话id>/session.jsonl.zstd`（**zstd 压缩**，后缀不是 .jsonl，root 由部署配置决定，按 LastWriteTime 找最新） |
| 跨会话记忆 | `~/.dsh/memories/MEMORY.md`（agent 笔记）/ `USER.md`（用户档案） |
| home patch | `~/.dsh/cordis.patch.yml`（唯一全局加载点） |
| 纪律子板 | `~/.dsh/discipline-board.cordis.yml`（8 个纪律插件） |
| 功能子板 | `~/.dsh/tools-board.cordis.yml`（fast_locate / env_check） |
| 已装插件 | `~/.dsh/plugins/*.mjs`（与开发副本 dsh-smart 保持哈希一致） |
| 环境诊断 | `env_check` 工具（检查项注册表，9 项） |
| DSH 源码 | `<DSH_REPO>`（环境变量或常见路径，只读不修改） |
| 本项目 | `cleverer-dsh`（插件/skill/脚本源码，发布在 GitHub） |

## 陷阱

- **node_modules 递归会卡死**：`Get-ChildItem -Recurse` 遇嵌套 symlink 会卡死。
  fast_locate 自动跳过；手写递归时同样跳过 node_modules/.git
- **~/.dsh 用绝对路径**：DSH 的 cwd 不是用户主目录，别假设相对路径
- **Windows 路径分隔符**：日志/配置里路径可能是正斜杠，匹配时归一化
- **先定位再读**：改文件前先确认文件确实在那个路径（环境地图 vs 实际状态可能漂移）
