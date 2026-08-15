---
name: local-first
description: 需要查事实时使用。先在本地源码、配置文件、node_modules、文档里找答案，禁止动不动联网搜索。
whenToUse: 任何"这个版本是什么""这个配置在哪""这个功能怎么用"类的问题
---

# 本地优先，搜索最后

## 铁律

**能在本地查到的，绝不联网搜索。** 搜索是最后手段，不是第一手段。

## 本地排查顺序

1. **源码**：项目自己的 `src/`、`packages/`、`apps/`——答案往往就在你手边的代码里
2. **配置**：`package.json`、`tsconfig*.json`、`pnpm-workspace.yaml`、`*.cordis.yml`、`electron-builder.yml`、`.env*`
3. **依赖**：`node_modules/<包名>/package.json` 看版本；`node_modules/<包名>/README.md` 看用法
4. **内置文档**：项目 `docs/`、`README*.md`、`*.agents/notes/`
5. **运行环境**：`node --version`、`pnpm --version`、`process.versions`（Electron 内置 Node 版本直接 `node -e "console.log(process.versions)"` 一条命令查到）

## 什么时候才搜索

- 本地完全没有线索（全新领域、未知 API、第三方服务）
- 错误信息指向外部服务（注册表、镜像站、云 API）
- 你已经读过错误并确认本地无解

## 反模式（禁止）

- ❌ 查"Electron 内置 Node 版本"去搜 6 次网（`node_modules/electron/package.json` 里就有）
- ❌ 报错 TS2307 却不去查 tsconfig/依赖图
- ❌ 先搜索后读源码
