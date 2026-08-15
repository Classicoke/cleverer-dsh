# cleverer-dsh

English | [中文](README.zh.md)

A plugin suite that makes [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) actually smart — execution discipline, practical tools, and a skill library, installed in one shot.

---

## ✨ Feature Highlights

| Icon | Feature |
|---|---|
| ⚡ | **Faster & cheaper (measured)**: same task vs bare DSH — 33% less time, 44% fewer estimated tokens (small sample, not yet broadly tested) |
| 🧠 | **Execution discipline**: automatic failure interception, forced reflection, task-planning reminders, memory dedup, experience auto-distilled into skills |
| 🛠️ | **Ready-made tools**: instant multi-directory file lookup + 9-point environment health check — stop guessing |
| 📦 | **One-command install/uninstall**: auto-backup, auto-config-merge, one-command restore |
| 🧪 | **426 tests green**, 99.7%+ coverage; pure code, **zero dependencies**, never touches DSH itself |
| 📚 | **6 built-in skills**: 6-step error handling, error lookup table, fast file lookup, root-cause debugging, local-first, plan-before-execute |

---

## Case study / Measured results

We ran the same real task (analyzing a software packaging log) on **DSH with this suite** vs a **bare DSH** (nothing installed):

| Metric | With suite | Bare DSH | Diff |
|---|---|---|---|
| **Total time** | 8.6 min | 12.8 min | **33% faster** |
| LLM calls | 51 | 61 | -20% |
| Tool calls | 59 | 67 | -14% |
| **Estimated total tokens** | ~41,000 | ~73,000 | **44% fewer** |
| Reasoning chunks | 401 | 1,163 | -65% |

**Experience gap**: with the suite, the agent doesn't stubbornly retry the same broken approach (it automatically switches), distills working commands into reusable scripts, and asks you before acting at key decision points. Bare DSH retried the same problem 13 times, never distilled anything, and never consulted you.

> ⚠️ **Disclaimer**: n=1 per group; tokens are character-estimated (±20%); **NOT broadly tested yet** — the direction is evidenced, exact numbers await more samples and real API billing data.

---

## What is this

DSH is full-featured but **not smart by default**: empty system prompt, stubborn retries on failure, skills installed but never used, todo tool ignored. This suite fixes it with two layers:

| Layer | Mechanism | Effect |
|---|---|---|
| **Discipline layer** (8 plugins) | event hooks + system-prompt injection | failure interception, forced reflection, task planning, memory dedup |
| **Hub** (discipline-hub) | shared failure log + reminder throttling + stats | plugins don't collide, issues are traceable |
| **Tools layer** (2 plugins) | new tool registration | instant file lookup, env health check |
| **Skill layer** (7 skills) | on-demand auto-loading | know what to do on errors, find things fast, deliver reports properly |

---

## Architecture

```
cordis.patch.yml (main config)
├─ discipline-hub          hub (failure log / reminder throttle / turn stats)
├─ discipline-board        discipline plugins
│  ├─ anti-stuck           stuck-loop guard: no repeat same-arg retries, force new approach
│  ├─ dsh-env-triage       problem tracing: stop & report when several schemes fail
│  ├─ dsh-plan-discipline  task planning: remind to create a plan for multi-step tasks
│  ├─ dsh-memory           cross-session memory: auto-dedup, anti-bloat
│  ├─ skill-evolver        experience distillation: failure → solution → saved skill
│  ├─ dsh-discipline       11 execution rules injected every turn
│  ├─ dsh-skill-loader     skill usage boost: on-demand catalog + keyword summoning
│  └─ dsh-cordis-discipline dynamic-plugin guardrail: no run before define, no undefine before stop
├─ tools-board             tools
│  ├─ dsh-fast-locate      file lookup: parallel multi-directory scan
│  └─ dsh-env-check-tool   env health check: 9 checks
└─ official packages (schedule/lsp/...) stay untouched
```

---

## Installation

**Prerequisites**: DSH installed and `~/.dsh` initialized; `node` available (plugins are zero-dep, node only for validation). Optional: set `DSH_REPO` to your DSH source checkout (needed for the packaging check in env health).

### Option 1: One-command install (recommended)

Paste this into PowerShell (auto-downloads the release zip → extracts → installs → cleans up):

```powershell
# Download and install in one go (PowerShell 7+)
$u = 'https://github.com/Classicoke/cleverer-dsh/archive/refs/tags/v1.2.zip'
$z = "$env:TEMP\cleverer-dsh.zip"; $d = "$env:TEMP\cleverer-dsh-install"
Invoke-WebRequest $u -OutFile $z
Expand-Archive $z $d -Force
pwsh -File "$d\cleverer-dsh-1.2\install.ps1"
Remove-Item $z, $d -Recurse -Force
```

### Option 2: Install from source

```powershell
# 1. Clone
git clone https://github.com/Classicoke/cleverer-dsh
cd cleverer-dsh

# 2. Install (auto: backup existing config → copy plugins/skills/scripts → generate config files → merge; never duplicates)
pwsh -File install.ps1

# 3. Restart DSH to activate (reopen the desktop app, or restart the dsh web process)
```

**What you get**:

| Component | Description |
|---|---|
| `plugins/` | 12 files (11 plugins + 1 shared module — copy the whole set) |
| `skills/` | 7 skills (identical files skipped) |
| `scripts/dsh-env-check.mjs` | env health script, installed to `<DSH_HOME>/scripts/` |
| 2 config files | plugin group configs (your local paths auto-filled) |
| config merge | never duplicated; original backed up as `.bak-cleverer-*` |

### Post-install verification

```powershell
# Run all tests (426)
pwsh -File tests/run-all.ps1

# Environment health check (9 items)
node scripts/dsh-env-check.mjs all
```

### Uninstall

```powershell
# 1. Restore the install backup (auto-created during install; if you had no
#    cordis.patch.yml before, the backup is an empty [] patch = pre-install state)
Copy-Item "$HOME\.dsh\cordis.patch.yml.bak-cleverer-*" "$HOME\.dsh\cordis.patch.yml" -Force

# 2. Remove installed files (plugins/skills/configs/health script)
Remove-Item "$HOME\.dsh\plugins\*.mjs" -ErrorAction SilentlyContinue
Remove-Item "$HOME\.dsh\discipline-board.cordis.yml","$HOME\.dsh\tools-board.cordis.yml" -ErrorAction SilentlyContinue
Remove-Item "$HOME\.dsh\scripts\dsh-env-check.mjs" -ErrorAction SilentlyContinue

# 3. Restart DSH
```

---

## Plugin overview

| Plugin | Problem it solves | When it triggers |
|---|---|---|
| `anti-stuck` | stubbornly retrying the same failing command | ≥2 same-arg fails → deny; ≥3 turn fails → remind; ≥5 → force reflection |
| `dsh-env-triage` | param-tweaking loops, going in circles | ≥2 schemes fail → trace card; ≥3 → stop & report |
| `dsh-plan-discipline` | todo tool ignored | multi-step task without plan → remind; ≥3 fails & stale plan → refresh |
| `dsh-memory` | memory bloat, force-write abuse | dedup before write (similarity > 0.62 rejected) + 60s window dedup |
| `skill-evolver` | junk skills being saved | generalization gate before persisting (path names / temp content rejected) |
| `dsh-discipline` | empty system prompt | injects 11 execution rules every turn |
| `dsh-skill-loader` | skills installed but never used | available-skills reminder at task start + keyword summoning |
| `dsh-cordis-discipline` | dynamic-plugin misuse | precondition checks (no run before define, no undefine before stop) |
| `discipline-hub` | plugins each doing their own thing, reminder spam | unified failure log + reminder throttle (≤2 per step) |
| `dsh-fast-locate` | slow file lookup | one call, parallel multi-directory scan |
| `dsh-env-check-tool` | guessing at environment issues | one-shot 9-point env health check |

## Skill catalog

| Skill | Purpose |
|---|---|
| `dsh-error-protocol` | 6-step error handling (classify→diagnose→decide→verify→distill) |
| `dsh-error-triage` | error lookup table: which error maps to which command (8 categories) |
| `dsh-fast-lookup` | fast file lookup methodology |
| `debug-by-root-cause` | find the root cause first, don't blindly retry |
| `local-first` | verify locally before guessing online |
| `plan-before-execute` | plan before acting, keep the plan updated |

---

## Testing

```powershell
pwsh -File tests/run-all.ps1        # all 426 tests
cd tests
node test-anti-stuck.mjs        # 41
node test-cordis-discipline.mjs # 44
node test-discipline-hub.mjs    # 35
node test-dsh-discipline.mjs    # 24
node test-dsh-memory.mjs        # 48
node test-env-check.mjs         # 61
node test-env-check-tool.mjs    # 15
node test-env-triage.mjs        # 22
node test-fast-locate.mjs       # 32
node test-plan-discipline.mjs   # 29
node test-skill-evolver.mjs     # 33
node test-skill-loader.mjs      # 42
# total: 426
```

**Coverage** (measured after the v1.2 refactor): global statements 100% / branches 96.74% / functions 98.91% / lines 100%; 7 source files at 100% across all dimensions. The uncovered items are all confirmed dead branches or items not safely testable (see `docs/TESTING.md` §2).

There is also a replay harness, `tests/replay-discipline.mjs`: feeds real DSH session logs through the plugins to measure intervention coverage, quantifying before/after (measured: interventions 4 → 11, +175%).

---

## Design principles

- **Forensics-driven**: every plugin comes from real long-task failure analysis (how many retries, what should have been used, why it failed) — not guesswork
- **Unconscious capability testing**: acceptance prompts never mention the plugins — only spontaneous use proves the agent truly internalized them
- **Observability**: env health checks (plugin syntax / config consistency / skill compliance) + deploy loop (sync → verify → restart → re-verify) — no more "it didn't take effect"

---

## Known limitations

- Verified on **Windows + PowerShell** only; Linux/macOS untested (plugins are cross-platform, install scripts are PowerShell)
- Never modifies DSH source code (high-risk area); only config injection and skill injection
- Headless mode: some features limited (no web server → some web-dependent features skipped)

---

## License

MIT © 2026 cleverer-dsh contributors

---

*Extended docs: `docs/ARCHITECTURE.md` (architecture & collaboration), `docs/TESTING.md` (testing methodology)*
