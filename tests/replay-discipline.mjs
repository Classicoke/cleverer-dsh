/**
 * replay-discipline.mjs — 纪律插件回放验证 harness（M1 验证地基）
 *
 * 把真实 DSH 会话日志（打包任务 session.jsonl）的事件流喂给改进后的纪律插件，
 * 模拟 cordis Context，统计：
 *   - deny 次数（tools/pre-execute 返回 deny）
 *   - reminder 注入次数（agent/pre-step 注入 system-reminder）
 *   - steer 次数（agent/turn-stopping 调 agent.steer）
 *   - 干预覆盖率 = 干预次数 / 失败总数
 *
 * 用法：
 *   node replay-discipline.mjs [插件目录] [日志路径]
 *   插件目录默认 dsh-smart/plugins（可传 ~/.dsh/plugins 对比生产版）
 *
 * 输出：基线 vs 改进的干预统计对比，验收标准 M1：覆盖率 21% → ≥50%
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

// ── 参数（必传，不硬编码本机路径）───────────────────────────────────
// 用法: node replay-discipline.mjs <pluginsDir> <sessionLog>
const pluginsArg = process.argv[2]
const logArg = process.argv[3]
if (!pluginsArg || !logArg) {
  console.error('用法: node replay-discipline.mjs <plugins目录> <session.jsonl路径>')
  process.exit(1)
}
const PLUGINS_DIR = resolve(pluginsArg)
const LOG = resolve(logArg)

// ── 迷你 cordis Context（对齐 test-anti-stuck.mjs 模式 + 增强）──────────
function makeCtx() {
  const listeners = new Map()
  const stats = { deny: 0, reminders: 0, steers: 0, calls: 0, results: 0, fails: 0 }
  const ctx = {
    logger: { info: () => {}, warn: (...a) => console.log('[logger:warn]', ...a) },
    stats,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {
        const arr = listeners.get(event)
        const i = arr.indexOf(handler)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    // emit: 串行 waterfall；handler 签名 (payload, next) 或 (exec, result)
    // next 必须是第 2 个参数（cordis 约定），因此 emit 只传数据参数
    async emit(event, ...args) {
      for (const h of listeners.get(event) || []) {
        // pre-step 系事件期望 downstream 为 enter；pre-execute 系透传
        const next = async () => ({ kind: 'enter', messages: [] })
        const r = await h(...args, next)
        if (r !== undefined) return r
      }
      return undefined
    },
    effect(fn, label) {
      const cleanup = fn()
      return () => (typeof cleanup === 'function' ? cleanup() : undefined)
    },
    // cordis-discipline / dsh-discipline 需要的 systemPrompt stub
    systemPrompt: {
      section() { return () => {} },
      push() {},
    },
    tools: { register() {} },   // 部分插件会注册工具
  }
  return ctx
}

// ── agent 模拟 ────────────────────────────────────────────────────────
function makeAgent(id) {
  const agent = {
    id,
    session: { header: { id }, events: [] },
    steers: [],
    steer(msg) { this.steers.push(msg) },
  }
  return agent
}

// ── 解析 session.jsonl → 事件序列 ─────────────────────────────────────
function parseLog(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const events = []
  for (const ln of lines) {
    if (!ln.trim()) continue
    try {
      const o = JSON.parse(ln)
      events.push(o)
    } catch { /* 宽容跳过坏行 */ }
  }
  return events
}

/** 从 tool/result 提取文本 */
function resultText(o) {
  const d = o.data || {}
  const content = d.message?.content || []
  let txt = ''
  for (const c of content) {
    if (c.type === 'tool-result') {
      const rc = c.content || []
      for (const r of rc) {
        if (r.type === 'text') txt += r.text
      }
    }
  }
  return txt
}

/** 判定 result 是否失败（对齐 anti-stuck.isFailure 逻辑） */
function isFailure(o, txt) {
  const d = o.data || {}
  if (d.error) return true
  if (/\[exit code: [1-9]\d*\]/.test(txt)) return true
  if (/Error:|failed|exception|traceback|command failed|failed to/.test(txt)) return true
  return false
}

// ── 回放主逻辑 ────────────────────────────────────────────────────────
async function replay(pluginFile, events) {
  const ctx = makeCtx()
  const mod = await import(pathToFileURL(pluginFile).href)
  // 回放是毫秒级跑完，cooldown 会阻止连续注入 → 传 0 让每步可注入
  mod.apply(ctx, { reminderCooldownSec: 0 })
  const agent = makeAgent('replay-agent')

  // 事件序列：tools/result 需要对应的 exec（来自最近的 tool/call）
  // 日志里 tool/call 的 arguments 在 data.arguments（字符串 JSON），
  // tools/result 的 message.source.callId 关联
  const callById = new Map()
  const resultSeq = []

  // 第一遍：收集 tool/call
  for (const o of events) {
    if (o.type !== 'tool/call') continue
    const d = o.data || {}
    let args = d.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { args = { raw: args } }
    }
    callById.set(d.callId, { name: d.name, arguments: args || {}, turn: d.turn, step: d.step })
    agent.session.events.push({ type: 'step/start', data: { turn: d.turn, step: d.step } })
  }
  // 第二遍：按序处理 result（同步维护 session events 的 turn 结构）
  let turn = 1
  let lastTurnStart = 0
  for (const o of events) {
    const type = o.type
    const d = o.data || {}
    if (type === 'turn/start') {
      turn = d.turn
      agent.session.events.push({ type: 'turn/start', data: { turn } })
      lastTurnStart = o.seq
    } else if (type === 'tool/call') {
      // pre-execute：当前失败指纹的状态由 result 驱动，这里只统计
      ctx.stats.calls++
    } else if (type === 'tool/result') {
      const txt = resultText(o)
      const callId = d.message?.source?.callId
      const exec = callId ? callById.get(callId) : null
      if (!exec) continue
      const result = {
        isError: isFailure(o, txt),
        content: [{ type: 'text', text: txt }],
        value: /\[exit code: (\d+)\]/.test(txt) ? { exitCode: parseInt(txt.match(/\[exit code: (\d+)\]/)[1]) } : undefined,
      }
      ctx.stats.results++
      if (result.isError) ctx.stats.fails++
      // 模拟 pre-execute → result（只传 exec，next 由 emit 追加为第 2 参数）
      const decision = await ctx.emit('tools/pre-execute', { ...exec, agent })
      if (decision?.kind === 'deny') {
        ctx.stats.deny++
        // deny 后仍发 result（真实世界里 deny 不会有 result，但统计无妨）
        continue
      }
      await ctx.emit('tools/result', { ...exec, agent }, result)
      // 每步后触发 pre-step（模拟 agent 决策前的注入点）
      const stepDecision = await ctx.emit('agent/pre-step', { agent, turn, signal: null })
      if (stepDecision?.messages?.length > 0) {
        const injected = stepDecision.messages.length
        if (injected > 0) ctx.stats.reminders++
      }
    } else if (type === 'turn/end') {
      await ctx.emit('agent/turn-stopping', { agent, turn, signal: null })
      ctx.stats.steers += agent.steers.length
      agent.steers = []
    }
  }
  // 尾部：最后补一次 turn-stopping（日志可能没到 turn/end）
  await ctx.emit('agent/turn-stopping', { agent, turn, signal: null })
  ctx.stats.steers += agent.steers.length

  return ctx.stats
}

// ── 主流程 ────────────────────────────────────────────────────────────
const events = parseLog(LOG)
console.log(`[replay] 日志事件数: ${events.length}`)
const calls = events.filter(o => o.type === 'tool/call').length
const results = events.filter(o => o.type === 'tool/result').length
console.log(`[replay] tool/call: ${calls}, tool/result: ${results}`)

const plugins = readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.mjs'))
for (const f of plugins.sort()) {
  const stats = await replay(join(PLUGINS_DIR, f), events)
  const coverage = stats.fails > 0 ? Math.round((stats.deny + stats.reminders + stats.steers) * 100 / stats.fails) : 0
  console.log(`\n=== ${f} ===`)
  console.log(`  工具结果: ${stats.results} | 失败: ${stats.fails} | deny: ${stats.deny} | reminders: ${stats.reminders} | steers: ${stats.steers}`)
  console.log(`  干预覆盖率((deny+reminder+steer)/失败): ${coverage}%`)
}

// ── 汇总：所有纪律插件的总干预 ────────────────────────────────────────
console.log('\n[replay] 完成。验收对照：M1 目标 = 干预覆盖率 ≥50%（基线 21%≈6/28）')
// 插件 effect 里有 setInterval 保持事件循环 → 显式退出
process.exit(0)
