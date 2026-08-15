/**
 * dsh-env-check-tool — env_check 工具（功能层 tools-board 首批，2026-08-16）
 *
 * 问题：dsh-env-check.mjs（环境检查项注册表，M2-2）是 CLI 脚本，agent 得
 * \"记得去跑脚本\"——溯源卡提醒\"先跑诊断\"后，agent 经常不知道去哪跑、怎么跑。
 *
 * 本工具：把现成 CLI 脚本注册成 env_check 工具，agent 工具清单直接可调。
 * 逻辑不重写（单一事实源仍在 dsh-env-check.mjs），本插件只是\"工具外壳\"：
 * 子进程 execFile 跑脚本 + 读 stdout/stderr + 返回文本。
 *
 * 与 env-triage 闭环：溯源卡/绕圈卡提醒\"先跑环境诊断\" → agent 直接调 env_check
 * （不再\"记得去跑脚本\"）。
 *
 * 零依赖纯 ESM（node 内置 only）。挂载：
 *   ~/.dsh/tools-board.cordis.yml → - id: dsh-env-check-tool
 *                                    name: 'file:///.../dsh-env-check-tool.mjs'
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-env-check-tool'
/** 需要 tools 服务来注册工具（cordis inject 机制，同 dsh-memory） */
export const inject = ['tools']

const DEFAULT_CONFIG = {
  /**
   * dsh-env-check.mjs 路径。不硬编码：默认相对本插件位置推导
   * （repo 开发 = <repo>/scripts/，安装后 = <DSH_HOME>/scripts/），
   * 显式配置优先（boards/tools-board.cordis.yml 的 scriptPath 覆盖）。
   */
  scriptPath: fileURLToPath(new URL('../scripts/dsh-env-check.mjs', import.meta.url)),
  /** 单次执行超时 ms */
  timeoutMs: 60000,
  /** stdout 最大缓冲 */
  maxBuffer: 2 * 1024 * 1024,
}

/** execFile 包装成 Promise；合并 stdout/stderr */
function runCheck(nodeBin, scriptPath, item, cfg) {
  return new Promise((resolve) => {
    execFile(
      nodeBin,
      [scriptPath, item],
      { timeout: cfg.timeoutMs, maxBuffer: cfg.maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim()
        const errOut = String(stderr || '').trim()
        if (err && !out) {
          // 脚本根本没跑起来（ENOENT 等）或超时
          resolve({ ok: false, text: `env_check 执行失败: ${String(err).slice(0, 300)}${errOut ? `\nstderr: ${errOut.slice(0, 500)}` : ''}` })
          return
        }
        const code = typeof err?.code === 'number' ? err.code : 0
        const tail = errOut ? `\n[stderr] ${errOut.slice(0, 500)}` : ''
        resolve({ ok: true, text: `${out}${tail}\n(exit ${code})` })
      },
    )
  })
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  ctx.logger?.info?.('dsh-env-check-tool: plugin loaded (env_check tool)')

  ctx.effect(() => ctx.tools.register({
    name: 'env_check',
    description: '运行环境诊断检查（检查项注册表：dep-consistency/native-binaries/collector-mode/profile-plugin-resolve/network-mirror/pack-artifacts）。agent 遇到环境类错误（依赖缺失、原生二进制、打包、镜像、profile 解析）时，先调本工具拿事实再决策，不要猜。返回每项 ✅/❌ + 具体证据文本。',
    parameters: {
      type: 'object',
      properties: {
        item: {
          type: 'string',
          description: '检查项 id（单个）或 all（全部）。可用: dep-consistency, native-binaries, collector-mode, profile-plugin-resolve, network-mirror, pack-artifacts',
        },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const item = String(args?.item || 'all').trim() || 'all'
      const r = await runCheck(process.execPath, cfg.scriptPath, item, cfg)
      return r.text
    },
  }), 'dsh-env-check-tool: register env_check tool')
}
