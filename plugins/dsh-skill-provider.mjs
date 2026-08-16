/**
 * dsh-skill-provider — runtime skill provider for the bundled skills/ directory
 *
 * Why: cleverer-dsh ships 6 markdown skills (skills/*.md) alongside its
 * plugins. When installed as a DSH bundle (`dsh plugin add ...`), the package
 * lives in the profile's node_modules — nothing copies skills/ into
 * ~/.dsh/skills/, so the filesystem provider never sees them. This plugin
 * registers each skill directly into the running skill registry via
 * `ctx.skills.register()`, giving them RUNTIME_RANK (250) — above the
 * user-dsh filesystem rank (400) — with zero file copies.
 *
 * Skill bodies are read from `../skills/` relative to this plugin file, so
 * they travel with the package (works identically in a repo checkout and in
 * node_modules/cleverer-dsh). A malformed file logs a warning and is skipped;
 * one bad skill never breaks the suite.
 *
 * Zero-dependency pure ESM (node builtins only).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-skill-provider'
/** The skill registry service (provided by @deepseek-ai/dsh-skill). */
export const inject = ['skills']

const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Parse the YAML-ish frontmatter block (--- delimited) of a skill file.
 * Only the three fields cleverer-dsh skills use are read: name, description,
 * whenToUse. Any other frontmatter is ignored; a file without a leading
 * frontmatter block is treated as body-only.
 * @param {string} text - raw skill file content.
 * @returns {{ frontmatter: Record<string, string>, body: string }}
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { frontmatter: {}, body: text.trimStart() }
  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) frontmatter[kv[1]] = kv[2].trim()
  }
  return { frontmatter, body: match[2].trimStart() }
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled ?? true
  if (!enabled) return
  // Testable seam: default resolves inside this package (../skills), an
  // explicit config.skillsDir overrides it.
  const skillsDir = config.skillsDir ?? DEFAULT_SKILLS_DIR

  let files
  try {
    files = readdirSync(skillsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
  } catch (error) {
    ctx.logger?.warn?.(`dsh-skill-provider: cannot read skills dir ${skillsDir}: ${String(error)}`)
    return
  }

  let registered = 0
  for (const file of files) {
    const fullPath = join(skillsDir, file)
    let raw
    try {
      raw = readFileSync(fullPath, 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`dsh-skill-provider: skip ${file} — read failed: ${String(error)}`)
      continue
    }
    const { frontmatter, body } = parseFrontmatter(raw)
    const skillName = frontmatter.name
    if (!skillName || !SKILL_NAME_RE.test(skillName)) {
      ctx.logger?.warn?.(`dsh-skill-provider: skip ${file} — invalid kebab-case name in frontmatter`)
      continue
    }
    const description = frontmatter.description
    if (!description) {
      ctx.logger?.warn?.(`dsh-skill-provider: skip ${file} — missing description in frontmatter`)
      continue
    }
    const registration = {
      name: skillName,
      description,
      ...(frontmatter.whenToUse ? { whenToUse: frontmatter.whenToUse } : {}),
      content: body,
      // 'bundled' = shipped with a package; visible in prompt-facing metadata.
      source: 'bundled',
      path: fullPath,
    }
    ctx.effect(() => ctx.skills.register(registration))
    registered += 1
    ctx.logger?.info?.(`dsh-skill-provider: registered ${skillName} (${file})`)
  }
  ctx.logger?.info?.(`dsh-skill-provider: loaded (${registered}/${files.length} skills registered)`)
}
