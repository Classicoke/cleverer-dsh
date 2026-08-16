# cleverer-dsh

English | [中文](README.zh.md)

A plugin suite that makes [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) actually smart — execution discipline, practical tools, and a skill library, installed in one shot.

---

## ✨ Feature Highlights

| Icon | Feature |
|---|---|
| ⚡ | **Faster & cheaper (measured)**: same task vs bare DSH — **49% faster**, 44% fewer estimated tokens (small sample, not yet broadly tested) |
| 🧠 | **Execution discipline**: automatic failure interception, forced reflection, task-planning reminders, memory dedup, experience auto-distilled into skills |
| 🛠️ | **Ready-made tools**: instant multi-directory file lookup + 9-point environment health check — stop guessing |
| 📦 | **One-command install/uninstall** via DSH's own plugin manager |
| 🧪 | **478 unit tests green**, statement & line coverage 100%; pure code, **zero dependencies**, never touches DSH itself |
| 📚 | **6 built-in skills**: 6-step error handling, error lookup table, fast file lookup, root-cause debugging, local-first, plan-before-execute |

---

## Measured results

We ran the same real task (analyzing a software packaging log) on **DSH with this suite** vs a **bare DSH** (nothing installed):

| Metric | With suite | Bare DSH | Diff |
|---|---|---|---|
| **Total time** | 8.6 min | 12.8 min | **49% faster** |
| LLM calls | 51 | 61 | -20% |
| Tool calls | 59 | 67 | -14% |
| **Estimated total tokens** | ~41,000 | ~73,000 | **44% fewer** |
| Reasoning chunks | 401 | 1,163 | -65% |

**What you notice in practice**: with the suite, the agent stops retrying the same broken approach (it automatically switches), distills working commands into reusable scripts, and asks you before acting at key decision points. Bare DSH retried the same problem 13 times, never distilled anything, and never consulted you.

> ⚠️ **Disclaimer**: n=1 per group; tokens are character-estimated (±20%); **not broadly tested yet** — the direction is evidenced, exact numbers await more samples and real API billing data.

---

## What it fixes

DSH is full-featured but **not smart by default**: empty system prompt, stubborn retries on failure, skills installed but never used, todo tool ignored. This suite fixes it:

| Layer | What it does |
|---|---|
| **Discipline layer** (8 plugins) | failure interception, forced reflection, task planning, memory dedup |
| **Hub** (discipline-hub) | shared failure log + reminder throttling — plugins don't collide, issues are traceable |
| **Tools layer** (2 plugins) | instant file lookup, env health check |
| **Skill layer** (6 skills) | on-demand auto-loading — know what to do on errors, find things fast |

---

## Architecture

```
cordis.patch.yml
├─ discipline-hub          hub (failure log / reminder throttle / turn stats)
├─ anti-stuck              stuck-loop guard: no repeat same-arg retries, force new approach
├─ dsh-env-triage          problem tracing: stop & report when several schemes fail
├─ dsh-plan-discipline     task planning: remind to create a plan for multi-step tasks
├─ dsh-memory              cross-session memory: auto-dedup, anti-bloat
├─ skill-evolver           experience distillation: failure → solution → saved skill
├─ dsh-discipline          11 execution rules injected every turn
├─ dsh-skill-loader        skill usage boost: on-demand catalog + keyword summoning
├─ dsh-skill-provider      runtime skill registry: the 6 bundled skills resolve in-package
├─ dsh-cordis-discipline   dynamic-plugin guardrail: no run before define, no undefine before stop
├─ dsh-fast-locate         file lookup: parallel multi-directory scan
└─ dsh-env-check-tool      env health check: 9 checks
```

---

## Installation

**Prerequisites**: DSH installed and initialized; `pnpm` available (DSH's plugin manager).

### Option 1: via DSH's plugin manager (recommended)

```bash
dsh plugin --profile web add github:Classicoke/cleverer-dsh
# headless instead:  dsh plugin --profile headless add github:Classicoke/cleverer-dsh
```

No build step — plugins and skills are ready as soon as the command finishes. Uninstall:

```bash
dsh plugin --profile web remove cleverer-dsh
```

### Option 2: one-command script (PowerShell 7+)

Paste this into PowerShell (auto-downloads the release zip → extracts → installs → cleans up):

```powershell
$u = 'https://github.com/Classicoke/cleverer-dsh/archive/refs/tags/v1.2.zip'
$z = "$env:TEMP\cleverer-dsh.zip"; $d = "$env:TEMP\cleverer-dsh-install"
Invoke-WebRequest $u -OutFile $z
Expand-Archive $z $d -Force
pwsh -File "$d\cleverer-dsh-1.2\install.ps1"
Remove-Item $z, $d -Recurse -Force
```

> ⚠️ **Pick ONE install method.** Installing both applies every plugin twice (duplicated behavior, premature denials). Uninstall one before switching to the other.

---

## Plugins

| Plugin | Problem it solves | When it triggers |
|---|---|---|
| `anti-stuck` | stubbornly retrying the same failing command | ≥2 same-arg fails → deny; ≥3 turn fails → remind; ≥5 → force reflection |
| `dsh-env-triage` | param-tweaking loops, going in circles | ≥2 schemes fail → trace card; ≥3 → stop & report |
| `dsh-plan-discipline` | todo tool ignored | multi-step task without plan → remind; ≥3 fails & stale plan → refresh |
| `dsh-memory` | memory bloat, force-write abuse | dedup before write + 60s window dedup |
| `skill-evolver` | junk skills being saved | generalization gate before persisting |
| `dsh-discipline` | empty system prompt | injects 11 execution rules every turn |
| `dsh-skill-loader` | skills installed but never used | available-skills reminder at task start + keyword summoning |
| `dsh-cordis-discipline` | dynamic-plugin misuse | precondition checks (no run before define, no undefine before stop) |
| `discipline-hub` | plugins each doing their own thing, reminder spam | unified failure log + reminder throttle |
| `dsh-fast-locate` | slow file lookup | one call, parallel multi-directory scan |
| `dsh-env-check-tool` | guessing at environment issues | one-shot 9-point env health check |

---

## Built-in skills

| Skill | Purpose |
|---|---|
| `dsh-error-protocol` | 6-step error handling (classify → diagnose → decide → verify → distill) |
| `dsh-error-triage` | error lookup table: which error maps to which command |
| `dsh-fast-lookup` | fast file lookup methodology |
| `debug-by-root-cause` | find the root cause first, don't blindly retry |
| `local-first` | verify locally before guessing online |
| `plan-before-execute` | plan before acting, keep the plan updated |

---

## Known limitations

- Verified on **Windows + PowerShell** only; Linux/macOS untested (plugins are cross-platform, install scripts are PowerShell)
- Never modifies DSH source code; only config injection and skill injection
- Headless mode: some features limited (no web server → some web-dependent features skipped)

---

## License

MIT © 2026 cleverer-dsh contributors
