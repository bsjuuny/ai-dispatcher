# AI Dispatcher

English | [한국어](README.ko.md)

An AI Development Control Plane: a CLI that routes coding tasks between Claude Code, Codex, and local models (Ollama, llama.cpp, or OpenAI-compatible servers), verifies the result with real build/test/lint, and has the *other* AI independently review the change before declaring success.

This is not a wrapper that just runs `claude` or `codex` for you. It classifies the task, scores both providers against real health/usage/capability data, dispatches with retry/fallback/circuit-breaking, runs your actual validation pipeline (with a bounded automatic fix loop on failure), routes the diff to an independent reviewer, and records everything to a structured audit log and a local SQLite history — so "the AI said it worked" and "the system verified it worked" are never the same claim.

## AI Development Harness V4

V4 adds the `harness` command and the **AI Development Control Center**. Responsibility is deliberately separated: Jev decides routing, Claude plans and reviews, Codex implements, Herdr runs agent sessions, Git worktrees isolate changes, command exit codes decide quality, and the Harness persists and resumes workflow state.

### Requirements and installation

- Node.js 22 or newer, Git, and this repository's pnpm dependencies.
- [Herdr](https://herdr.dev/docs/cli-reference/) 0.8.x, with a named `ai-harness` session running.
- Authenticated `claude` and `codex` CLIs.
- Optional Jev API access through `TYPESAFE_API_KEY`. Without it, routing and the final gate use an explicitly labelled deterministic fallback.
- GitHub CLI (`gh auth login`) when automatic push/PR/CI tracking is enabled.

```bash
pnpm install
pnpm build
pnpm link --global .

# In a separate terminal, create or attach the persistent runtime session.
herdr --session ai-harness

harness doctor --project .
```

Credentials and tokens are never placed in `harness.config.yaml`; provider CLIs and environment variables own authentication.

### Quick start

Create `harness.config.yaml` (see [`harness.config.example.yaml`](harness.config.example.yaml)), then run:

```bash
harness run "Fix login token refresh bug" --project .
harness status TASK-001 --project .
harness diff TASK-001 --project .
harness logs TASK-001 --project .
```

`harness run` creates `ai/TASK-001/integration` plus one branch/worktree per DAG task. It never modifies or pushes main/master directly. Independent DAG nodes run in parallel up to the budget; dependent worktrees are created only after their prerequisites have passed quality and merged into the integration branch.

The quality gate runs configured `lint`, `typecheck`, `test`, `integration`, `build`, and `security` commands with `shell:false`. If no quality command is configured it fails closed; individual unconfigured stages are reported as `SKIPPED`. An AI response can never turn a non-zero exit code into PASS. Bounded retries pass failure evidence back to Codex, while requirement/security/architecture findings are escalated to Claude before another Codex attempt.

### Harness CLI

```text
harness run "task" [--project .]
harness list [--project .]
harness status TASK-001 [--project .]
harness resume TASK-001 [--project .]
harness retry TASK-001 [--project .]
harness abort TASK-001 [--project .]
harness finish TASK-001 [--project .]
harness diff TASK-001 [--project .]
harness logs TASK-001 [--project .]
harness cleanup TASK-001 [--project .]
harness doctor [--project .] [--json]
harness dashboard [--project .] [--port 4321]
```

State and structured artifacts live under `.ai-harness/`. Raw task requests are not persisted: the state database stores their SHA-256 and length, while planning, quality, review, final-gate, and CI artifacts store only the structured evidence needed by later phases. JSON state writes are transactional in SQLite; JSON artifact writes use temporary files followed by atomic rename.

### Dashboard

```bash
harness dashboard --project . --port 4321
```

Open `http://127.0.0.1:4321`. The dependency-free TypeScript/Node dashboard reuses this repository's stack rather than introducing Next.js. It provides Overview, Tasks, Task Detail, Agents, Usage, and Settings views; SSE updates every three seconds. The common actions are Run, Retry, and Merge. Merge remains disabled until required GitHub checks pass and always requires an explicit browser confirmation. V4 never performs production deployment or automatic merge.

### Harness architecture and workflow

```text
CLI / Dashboard
  -> persistent Task Manager + budget/telemetry
  -> Jev route (or labelled fallback)
  -> Claude Architect / Specialist when routed
  -> dependency-aware Codex worker pool
  -> isolated subtask worktrees -> integration worktree
  -> deterministic quality commands
  -> independent Claude Reviewer
  -> Jev final gate
  -> guarded commit/push/PR -> required CI checks
  -> explicit human merge gate
```

The Claude reviewer is a separate Herdr agent and receives only the requirement, diff, changed files, and quality evidence—not the Architect conversation. The safety layer rejects force push, protected-branch delivery, unsafe automatic conflict resolution, shell operators in quality commands, oversized Herdr argv prompts, and CI-bypassing merge attempts. Sensitive paths such as `.github/**`, `infra/**`, migrations, security, auth, and payment are marked protected for future auto-merge policy; auto-merge is off by default and is not executed by V4.

### Troubleshooting

- `HERDR_NOT_INSTALLED` / session errors: install Herdr and keep `herdr --session ai-harness` running.
- Claude or Codex missing: install and authenticate the corresponding CLI, then rerun `harness doctor`.
- Jev unavailable: set `TYPESAFE_API_KEY`, or inspect `route.json` for the labelled deterministic fallback reason.
- `QUALITY_COMMAND_MISSING`: add at least one real quality command to `harness.config.yaml`; production projects should configure every applicable stage.
- Worktree conflict: the Harness aborts the merge and records failure instead of choosing conflict resolutions automatically.
- GitHub authentication/PR failure: run `gh auth status`, fix the credential or remote, then use the bounded retry/resume flow.
- `BUDGET_BLOCKED` or `ACTION REQUIRED`: inspect Task Detail. The Harness never auto-approves a blocked agent or destructive request.

## Architecture

```
src/
├─ models/        Domain types + DispatcherError (shared by every layer)
├─ core/           State machine, Orchestrator (the runTask() pipeline), execution glue
├─ task/           Task Specification parsing, input resolution, classifier
├─ providers/      AIProvider interface + ProviderRegistry; claude/, codex/, and local/ adapters
├─ routing/        Usage tracking, scoring, provider selection, retry/fallback/circuit-breaker
├─ project/        Project analyzer, memory (JSON), log windowing, context builder
├─ validation/     git-diff, build/test/lint/typecheck runners, pipeline, fix loop
├─ review/         Review coordinator (prompts a reviewer, parses its verdict), conflict resolver
├─ safety/         Workspace isolation, repository lock, base-revision/content-hash TOCTOU guards,
│                  risk classifier, Auto-Apply Safety Gate, patch apply
├─ process/        The single execa call site (process-runner.ts)
├─ logging/        pino logger, secret redaction, audit event log
├─ history/        node:sqlite-backed task/execution/audit history
├─ config/         zod schema + YAML loader for `.ai-dispatcher.yml`
└─ cli/            commander-based CLI wiring the above together
```

**The core architectural invariant**: `core/`, `routing/`, `task/classifier.ts`, `validation/`, `review/` never import `ClaudeProvider`/`CodexProvider` by name and never branch on a provider id string. Everything provider-specific is reached only through the `AIProvider` interface via `ProviderRegistry`. Only `providers/index.ts` (the composition root) and tests import both concrete classes. `tests/unit/orchestrator.test.ts` proves this by successfully routing to and executing against a fake provider whose id (`"totally-unknown-provider"`) the orchestrator has never seen before.

## Install

```bash
pnpm install
pnpm build
```

Requires Node.js 22+. Requires the [`claude`](https://claude.com/product/claude-code) and/or [`codex`](https://github.com/openai/codex) CLIs to be installed and authenticated separately — see below.

### Running the CLI

`pnpm build` produces `dist/cli.js` — it is **not** automatically put on your PATH as a bare `ai-dispatcher` command. Pick one:

```bash
# Always works, no setup - run it directly:
node dist/cli.js doctor
```

Or make `ai-dispatcher` available as a real command on PATH:

```bash
pnpm link --global .   # from this project's directory - note the trailing `.`
ai-dispatcher doctor   # now works in any new shell
```

Two things this can hit on a machine where pnpm's global linking has never been used before (both verified live, in that order, on Windows):

1. **`The configured global bin directory "..." is not in PATH`** — run `pnpm setup` once, then **open a brand new terminal window** (not just a new tab in an already-running terminal host, and not a shell restarted by a tool - env var changes from `pnpm setup` are written to the Windows registry and are only picked up by processes launched fresh afterward).
2. **`Aborted removal of modules directory due to no TTY`** — `pnpm link --global` needs to reinstall `node_modules` into a layout suited for global linking, and pnpm wants interactive confirmation for that. Run `CI=true pnpm link --global .` once to answer non-interactively (safe: it just reinstalls the same lockfile-pinned dependencies, nothing is downgraded or changed). If a *later* `pnpm build`/`pnpm test` starts hitting the same "no TTY" error even without `--global`, that reinstall left `node_modules` in a state pnpm's own dependency-drift check doesn't like — one clean `CI=true pnpm install` resettles it, and normal commands go back to working without `CI=true` afterward.

The rest of this README uses `ai-dispatcher <command>` as shorthand for whichever of the two you're using — substitute `node dist/cli.js` if you haven't linked it globally. To undo the global link: `pnpm unlink --global` (run from this project's directory).

## Provider authentication

**The dispatcher is not a credential manager.** It never reads, stores, or touches an API key, OAuth token, or session cookie. It only shells out to the official CLIs' own health/status commands (`claude auth status`, `codex login status`) to check whether *you* are already logged in.

```bash
claude auth login
codex login
```

If a provider isn't authenticated, `ai-dispatcher doctor` tells you exactly that and stops — it never attempts to automate a login flow.

## CLI commands

```bash
ai-dispatcher ask <task-spec>          # analysis / Q&A, no validation or review
ai-dispatcher analyze <task-spec>
ai-dispatcher review <task-spec>
ai-dispatcher fix <task-spec>          # code-changing: runs validation + fix loop + review
ai-dispatcher implement <task-spec>    # code-changing: same as above

ai-dispatcher doctor [--json]          # health-check both cloud providers + local runtimes
ai-dispatcher providers [--json]       # list capabilities
ai-dispatcher usage [provider] [--json]# 1h/24h/7d/all request+cost stats
ai-dispatcher history [--limit N]      # recent tasks
ai-dispatcher inspect <taskId>         # full detail for one task
ai-dispatcher explain <taskId>         # why a provider was selected, with score breakdown

ai-dispatcher local status [--json]    # runtime reachability + configured local.profiles[] health
ai-dispatcher local runtimes [--json]  # local runtime reachability, independent of any profile
ai-dispatcher local models [--json]    # real installed model inventory per reachable runtime
ai-dispatcher local start              # start the manifest-selected llama.cpp runtime and model
ai-dispatcher preflight [--json]       # CPU/GPU profile + offline runtime/model-pack readiness
ai-dispatcher local benchmark [name]   # qualify a configured local model and cache throughput
ai-dispatcher local import-pack <dir>  # verify and copy a pre-downloaded model pack
ai-dispatcher portable assemble <dir>  # create a USB-portable offline kit
ai-dispatcher portable seal <dir>      # regenerate the reviewed kit integrity lock after asset changes
```

While a dispatch command (`ask`/`analyze`/`review`/`fix`/`implement`) is running, live status - provider selection, each execution attempt starting/finishing, retries, fallback, validation, review - is streamed to **stderr** as it happens (never stdout, so `--json`'s machine-readable output is untouched). A long-running single execution also gets a periodic "still waiting on `<provider>` (`Ns` elapsed)" heartbeat every 30s. This exists because the CLI used to print nothing at all until the entire task finished, which for a multi-minute run left no way to tell "still working" from "hung" - found live (2026-08-22) during an 11-minute stall with zero terminal output the whole time. A final human-readable (or `--json`) summary still prints at the end regardless.

The final summary includes a structured **5W1H result report**: who dispatched, implemented, and reviewed the task; when and where it ran; what changed and whether those changes were applied, withheld, discarded, or left in place; why the provider was selected; and how execution, validation, and review completed. Human output uses concise Korean labels (`누가`, `언제`, `어디서`, `무엇을`, `왜`, `어떻게`). `--json` exposes the same data under `resultReport`, and the sanitized report is persisted as the append-only `task.report.created` audit event.

Every dispatch command accepts:

| Flag | Meaning |
|---|---|
| `--file <path>` | Read the task specification from a file |
| `--stdin` | Read the task specification from stdin |
| `--path <paths...>` | Related file/directory paths to include as context |
| `--cwd <path>` | Working directory (default: current directory) |
| `--timeout <ms>` | Execution timeout |
| `--provider <id>` | Force `claude`, `codex`, or `local-<profile>` instead of routing |
| `--dry-run` | Print the routing decision and built command, execute nothing |
| `--json` | Machine-readable output |
| `--debug` | Raise the application log to debug level (NDJSON to stdout) |

### Writing a Task Specification

A task description is not a one-line prompt — it can be a full incident report. All of these work:

```bash
# Short
ai-dispatcher fix "로그인 오류를 수정해줘"

# Multi-line, with an error code and a stack trace
ai-dispatcher fix "
로그인 API 호출 시 다음 오류가 발생한다.

ERR-USER-1042

java.lang.NullPointerException:
Cannot invoke User.getId() because user is null
    at com.example.service.UserService.findUser(UserService.java:128)

요구사항:
- 기존 API 변경 금지
- Regression Test 추가
"

# From a file
ai-dispatcher fix --file bug-report.md

# From stdin
cat bug-report.md | ai-dispatcher fix

# Combined: description + attached log + related path
ai-dispatcher fix --file error.log --path src/main/java/com/example \
  "이 오류의 근본 원인을 분석하고 회귀 테스트까지 작성해줘"
```

The raw text is **always preserved verbatim** alongside whatever the classifier extracts (error codes, stack traces, numbered reproduction steps, bulleted requirements/constraints) — a misclassification never loses information a provider could otherwise have used.

Large attachments (stack traces, build logs) are never sent whole. `project/log-windowing.ts` finds error-keyword/stack-trace/failed-test anchor lines, expands a context window around each, merges nearby windows, dedupes repeated blocks, and falls back to head+tail windowing when nothing is found — see `docs/architecture.md`.

### Shell safety

Every piece of user-controlled text — the task description, file paths, log content — is sent to providers via `stdin`, never concatenated into a shell command string. `process/process-runner.ts` is the *only* file allowed to spawn a process (enforced by an ESLint rule and by `tests/security/dist-static-scan.test.ts`, which greps the built output for unsafe patterns), and it calls `execa` with `shell: false` explicit. See `tests/security/shell-injection.test.ts` for the full payload matrix this is tested against, including a >100KB payload proving there's no reliance on OS argv-length limits.

## Routing

Provider selection is a weighted score, not role-fixed:

```yaml
routing:
  weights:
    capability: 0.35
    usage: 0.20
    successRate: 0.20
    latency: 0.10
    availability: 0.10
    failurePenalty: 0.05
```

`ai-dispatcher explain <taskId>` prints the exact score breakdown that produced a decision — every component, every provider, in the same format you'd see in the routing log.

## Local LLM Provider (Ollama / llama.cpp / OpenAI-compatible)

Local models plug into the exact same `AIProvider`/`ProviderRegistry` system Claude and Codex use — routing, retry/fallback, audit logging, and history need no special-casing. Each configured profile is registered as a provider with id `local-<name>` and is routable like any other, including via `--provider local-<name>`.

```yaml
local:
  runtimes:
    ollama:   { enabled: true,  host: http://127.0.0.1:11434 }
    llamacpp: { enabled: false, host: http://127.0.0.1:8080 } # off by default - see Known Limitations
    openai-compatible: { enabled: false, host: http://127.0.0.1:1234 }
  profiles:
    - name: fast
      runtime: ollama
      model: qwen3:4b
```

**How autonomous local coding works.** Local completion APIs do not need native tool calling. For `fix`/`implement`, `LocalProvider` runs a runtime-neutral dispatcher tool loop: the model emits one schema-constrained JSON action to list/read/search/replace/write files, the dispatcher executes it inside the isolated worktree, and the normal validation/fix-loop/review/Auto-Apply gate handles the result. Reads are bounded, path traversal and `.git`/`.dispatcher`/dependency access are rejected, writes require the current file version to have been read, repeated mutations are blocked, and file/turn/token limits are configurable under `local.coding`. Shell execution is deliberately not exposed to the model; the existing validation pipeline owns build/lint/test commands. This loop is used identically by Ollama, llama.cpp, and OpenAI-compatible local servers.

**The `<think>` stripping is not a decoration — it's a real, live-discovered fix.** Even with `"think": false` in the request, `qwen3:4b` still emitted a full reasoning preamble ahead of the actual answer — and not wrapped in a matching `<think>...</think>` pair the way the model card implies: the observed shape has no opening tag at all, only an orphaned `</think>` immediately before the real answer. `providers/local/local-http-client.ts`'s `stripThinking()` handles both the documented balanced-tag shape and this actually-observed orphaned-tag shape, so a caller only ever sees the answer.

**Network safety**: `providers/local/local-http-client.ts` is the *only* file allowed to call the global `fetch()` (enforced by `tests/security/local-fetch-single-chokepoint.test.ts`, a source-level static scan mirroring how `process-runner.ts` is the sole process-spawn chokepoint). It rejects any host that isn't `127.0.0.1`/`localhost`/`::1` before making a request, and every call carries an `AbortSignal.timeout()`.

`llama.cpp` support (`providers/local/llamacpp-runtime.ts`) is **unverified** — `llama-server`/`llama-cli` were not installed on the machine this was implemented on, so the adapter is written from llama.cpp's published server API (`GET /health`, `GET /v1/models`, `POST /completion`) with no real integration test, only mocked unit tests. `local.runtimes.llamacpp.enabled` defaults to `false` for exactly this reason — enable it only after confirming it actually works against your own build.

### CPU-first offline model packs

CPU is the baseline, not a fallback after GPU detection. `ai-dispatcher preflight` builds a best-effort hardware profile, assigns `CPU_LITE`, `CPU_STANDARD`, `CPU_PLUS`, `GPU_STANDARD`, or `AI_WORKSTATION`, and selects runtime artifacts in Metal → CUDA → Vulkan → CPU order. Apple Silicon is detected as integrated Metal hardware with unified memory. An ISA-specific binary is selected only when its ISA is positively detected; otherwise only a generic CPU binary is safe. This avoids illegal-instruction failures on unknown machines.

```text
runtime/
  windows-x64-generic/runtime-manifest.json
models/
  cpu-standard/model-pack.json
  cpu-standard/<model>.gguf
```

Model packs declare RAM/VRAM requirements, roles, context recommendations, optional SHA-256, and licence/source metadata. Preflight reports `READY_FAST`, `READY`, `READY_SLOW`, `SUPPORTED_BUT_NOT_RECOMMENDED`, or `UNSUPPORTED` and never downloads a missing model. `local import-pack <directory>` validates path containment, optional licence policy, and each declared SHA-256 before copying. `local benchmark [profile]` measures the configured local endpoint and stores a hardware-fingerprint-qualified result at `.dispatcher/local/qualification.json`.

```yaml
local:
  cpu: { maxThreads: auto, reserveCores: 2 }
  bundle:
    runtimeDirectory: runtime
    modelPacksDirectory: models
    offlineKitRequired: true
    requireModelLicenseMetadata: true
```

GPU/NPU discovery is optional. An audited installer can supply GPU hints through `AI_DISPATCHER_GPU_VENDOR`, `AI_DISPATCHER_GPU_MODEL`, `AI_DISPATCHER_GPU_MEMORY_BYTES`, and `AI_DISPATCHER_GPU_BACKENDS`; CPU execution remains valid when they are absent.

### USB-portable kit

After building, run `ai-dispatcher portable assemble <folder>`. The default target follows a supported host, or can be selected explicitly with `--target windows-x64` or `--target macos-arm64`. Copy that single generated folder to the external drive. It contains the built app with JavaScript dependencies bundled into `dist`, portable configuration, target-specific launch scripts, and reviewed offline assets already present in the source checkout. It never downloads assets and never copies a host executable into a different target.

The Windows target uses `runtime/node/node.exe`, MinGit, `.cmd` launchers, and a reviewed Windows llama.cpp runtime. The Apple Silicon target uses `runtime/node/bin/node`, relocatable Git, POSIX launchers, and a macOS arm64 Metal llama.cpp distribution. Prepare Mac assets under `runtime/macos-arm64/` and Mac-native templates under `templates/macos-arm64/` before assembly. If assets are filled or changed after assembly, run `bin/ai-dispatcher portable seal .` from the kit root before `bin/preflight`; the latter must report `READY`. `start-local` consumes that same preflight launch plan instead of maintaining separate model thresholds. See [the macOS portable guide](docs/PORTABLE-KIT-GUIDE.macos.ko.md). The launcher keeps the external bundle as the asset root while the target project remains the workspace and owner of `.dispatcher/` history.

### Closed-network deployment

For an air-gapped or firewall-denied environment, disable both cloud providers and register only loopback local profiles:

```yaml
providers:
  claude: { enabled: false }
  codex: { enabled: false }
local:
  runtimes:
    ollama: { enabled: true, host: http://127.0.0.1:11434 }
    llamacpp: { enabled: false }
    openai-compatible: { enabled: false, host: http://127.0.0.1:1234 }
  profiles:
    - name: airgap
      runtime: ollama
      model: your-installed-model
  allowAutoDownload: false
  coding:
    enabled: true
    maxTurns: 24
    maxFilesChanged: 20
    maxFileBytes: 1048576
    maxReadLines: 400
    maxOutputTokens: 1024
```

With this configuration, cloud providers are not registered and cannot be restored with `--provider`; local HTTP is restricted to loopback, and an unreachable local runtime fails closed with `NO_AVAILABLE_PROVIDER`. Analysis, review, documentation, and autonomous code editing all remain local. The host OS/firewall must still enforce the network boundary for validation commands and project scripts, which the dispatcher executes but cannot prove are network-free.

For LM Studio, vLLM, LocalAI, text-generation-webui, or another server exposing the OpenAI API, enable `local.runtimes.openai-compatible` and set a profile's `runtime: openai-compatible`. A proprietary local protocol needs only a `LocalRuntimeAdapter` implementing detect/list/generate; the autonomous coding loop is shared and requires no backend-specific rewrite.

## Validation and the fix loop

For `fix`/`implement` tasks, after execution: `git diff` (checks for protected-path modifications) → typecheck → lint → build → test, in that order, stopping at the first failure. On failure, the failed stage's output is attached to a follow-up task sent back to the *same* implementer, and validation re-runs — bounded by `validation.maxFixAttempts` (default 2). It never loops unboundedly.

Commands are auto-detected from the project (`package.json` scripts + lockfile → pnpm/yarn/npm; `pom.xml` → Maven; `build.gradle(.kts)` → Gradle; `pyproject.toml` → pytest/ruff) but an explicit `.ai-dispatcher.yml` always wins:

```yaml
validation:
  commands:
    test: [pnpm, run, test]
  maxFixAttempts: 2
```

## Review

Once validation passes, the diff goes to an independent reviewer — by default, the provider that *didn't* implement the change. The reviewer is asked to check correctness, requirement compliance, regressions, security, concurrency, null handling, error handling, resource leaks, performance, maintainability, test coverage, unrelated changes, and architecture consistency, and to return a fenced JSON verdict. `request_changes`/`critical` findings trigger another fix→re-validate→re-review cycle, bounded by `review.maxReviewCycles` (default 2).

If only one provider is `Ready` (installed + authenticated + reachable), the dispatcher self-reviews rather than blocking — but `independentReview: false` is recorded on the result and in history, never silently presented as an independent check.

Disagreement between what a reviewer says and what validation shows is resolved by evidence, not majority vote (there's only ever one active reviewer per cycle anyway): `review/conflict-resolver.ts` checks the latest `ValidationResult` before deciding whether a persisting finding gets accepted as a warning or escalated to the user.

## Autonomous operation: workspace isolation + the Auto-Apply Safety Gate

By default (`safety.workspaceIsolation.enabled: true`), a code-changing task (`fix`/`implement`) never executes directly against your working tree. Instead, the orchestrator:

1. Acquires an exclusive **repository lock** (in-memory, per-process — see Known Limitations) so a second code-changing task on the same repository is rejected with a retryable `REPOSITORY_LOCKED` error rather than racing.
2. Creates a real **`git worktree`** checked out at the current `HEAD` (the "base revision") and runs the *entire* existing dispatch → validate → fix-loop → review pipeline against that isolated copy, completely unmodified — your real working tree is never `reset`, `checkout`ed, or `clean`ed by any of this.
3. Once validation passes and review is non-blocking, computes the **risk level** of the change (`safety/risk-classifier.ts`): any touch to a `safety.protectedPaths` entry or a CI/CD pipeline file (`.github/workflows/**`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `Jenkinsfile`) is `CRITICAL` regardless of size; otherwise it's `LOW`/`MEDIUM`/`HIGH` based on how far the file/line counts are over `safety.blastRadius`'s per-task-type limits.
4. Re-checks, immediately before touching anything real, that the base revision hasn't moved (`BASE_REVISION_CHANGED`) and that no file the patch touches was edited in your real working tree without a commit in the meantime (`STALE_PATCH` — a TOCTOU guard `git rev-parse HEAD` alone can't catch, since an uncommitted edit doesn't move `HEAD`).
5. Decides **`AUTO_APPLY` / `BLOCKED_BY_POLICY` / `FAILED`** (`safety/auto-apply-gate.ts`) — fail-closed: every one of validation-passed, review-non-blocking, lock-held, base-revision-matches, content-hashes-match, `autoApply.enabled`, optional independent-review policy, and risk-within-`maxRiskLevel` must hold, or the change is discarded, never applied by default or by guesswork.
6. On `AUTO_APPLY`, merges the worktree's changes into your real working tree as an ordinary **uncommitted** diff via `git apply` (`safety/patch-apply.ts`) — it never commits on your behalf. On anything else, the worktree (and whatever the AI changed inside it) is simply discarded.

```yaml
safety:
  protectedPaths: [.env, secrets/, production.yml]
  workspaceIsolation:
    enabled: true          # the escape hatch back to pre-increment direct-execution behavior is `false`
  blastRadius:
    bugfix:         { maxFiles: 15, maxChangedLines: 400 }
    implementation:  { maxFiles: 30, maxChangedLines: 1000 }
    refactor:       { maxFiles: 50, maxChangedLines: 2000 }
  autoApply:
    enabled: false          # ships OFF - see the callout below
    requireIndependentReview: false # set true to prevent self-reviewed changes from landing
    maxRiskLevel: MEDIUM    # CRITICAL is never auto-appliable, no override exists
```

**Read this before you rely on it**: `safety.autoApply.enabled` defaults to **`false`**. That means, out of the box, a `fix`/`implement` task that fully succeeds — validation passes, review approves — now reports **`BLOCKED_BY_POLICY`** instead of `SUCCESS`, and *nothing lands in your repository*, a real behavior change from a config that previously had no `safety.autoApply` key at all to react to. This is intentional: the whole point of this capability is safe-by-default autonomous operation, and a system that silently starts auto-committing AI changes the moment you upgrade would be the opposite of that. Set `safety.autoApply.enabled: true` once you've reviewed the risk/blast-radius thresholds above and decided they match your threat model; `ai-dispatcher fix "..." --dry-run` and a first few `BLOCKED_BY_POLICY` runs (check `ai-dispatcher explain <taskId>` / `ai-dispatcher inspect <taskId>`) are the way to see exactly what *would* have been applied before turning it on for real.

Set `requireIndependentReview: true` when auto-apply must never rely on the implementing model reviewing its own work. A single ready provider may still complete a self-review for diagnostics, but the gate records `independentReview: false`, returns `BLOCKED_BY_POLICY`, and leaves the real working tree unchanged. Portable kits enable this stricter policy by default; configure a genuinely separate ready reviewer before expecting unattended apply.

`workspaceIsolation.enabled: false` is the literal opt-out back to the direct-execution behavior every `fix`/`implement` task had before this capability existed: no worktree, no repository lock, no risk gate — the change lands the moment the provider finishes, exactly as before.

**The AI never sees your uncommitted local changes while isolation is on.** `git worktree add` checks out the pinned base revision — a commit — not your working tree's current (possibly dirty) state. If you have uncommitted edits when you run `fix`/`implement`, the AI works from the last commit, unaware of what you were in the middle of changing. This can't corrupt anything — `STALE_PATCH` still blocks the apply if the AI's patch and your uncommitted edit land on the *same* file — but the AI's understanding of "what the code currently looks like" can be stale relative to your actual working tree, which may produce a fix that doesn't account for work you hadn't committed yet. Commit or stash first if that matters for the task at hand.

## Audit and history

Every task gets a `taskId`; every execution attempt (including retries and fallbacks) gets its own `executionId`, all linked to the same task. Structured audit events (`task.created`, `provider.selected`, `retry.started`, `validation.failed`, `review.completed`, ...) are appended (never rewritten) to a local SQLite database at `.dispatcher/history.sqlite` in the project you ran `ai-dispatcher` against.

**By default, prompt and response text are never stored** — only their SHA-256 hash and length. Set `diagnostics.logPrompts: true` in config to opt into storing raw text, and even then it passes through secret scrubbing first (AWS/OpenAI/Anthropic/GitHub-token-shaped strings, JWTs, PEM blocks, `.env`-style secret lines are replaced with `[REDACTED]`).

`ai-dispatcher history [--limit N]` lists recent tasks; `ai-dispatcher inspect <taskId>` shows one task plus every execution attempt made for it (provider, timing, token/cost usage); `ai-dispatcher explain <taskId>` shows the routing score breakdown that led to the provider that was picked (see [Routing](#routing) above).

The 5W1H result report (above) is not saved as a separate file — it lives only in the terminal output at the time, and as the `task.report.created` audit event. `ai-dispatcher inspect <taskId>` reads that event back and reprints the same report, so you don't need to scroll back through old terminal output or query `.dispatcher/history.sqlite` directly to see it again.

### Failure artifacts

When an execution attempt fails, times out, or errors out of the process/parsing layer entirely, the full detail is written to `.dispatcher/runs/<executionId>/` in the project directory:

```
.dispatcher/runs/<executionId>/
├─ metadata.json   # provider, command, args, cwd, exit code, timing
├─ error.json      # the DispatcherError (code, message) - omitted if there wasn't one
├─ stdout.log      # raw stdout, secret-scrubbed
└─ stderr.log      # raw stderr, secret-scrubbed
```

This is what makes a failure re-diagnosable without re-running anything: `ai-dispatcher inspect <taskId>` tells you *that* an execution failed, the artifact directory tells you *why*, byte-for-byte, without needing `diagnostics.logPrompts: true`. The task prompt itself (`stdinContent`) is deliberately never written here, matching the audit log's default policy. Controlled by `diagnostics.saveFailureArtifacts` (default `true`); a failed `TaskResult.rawOutputPath` points at the directory when one was written. A successful execution never writes anything here.

### What lives under `.dispatcher/`

Running `ai-dispatcher` against a project creates a `.dispatcher/` directory inside it: `history.sqlite` (above), `runs/<executionId>/` (failure artifacts, above), and `project/memory.json` (see [Project memory](#project-memory) below). None of this is meant to be committed — add `.dispatcher/` to that project's `.gitignore` (this repository's own `.gitignore` already does this for the dispatcher's own self-tests and dogfooding runs, but a *project you point the dispatcher at* needs its own entry).

### Project memory

`project/memory.ts` stores short decision/summary snippets (never full source) in `.dispatcher/project/memory.json`, ranked by recency + keyword overlap against the current task (no embeddings — see Known Limitations) and surfaced to providers via the context builder. **In v1.0, nothing in the dispatch pipeline calls `remember()` yet** — the read path (`relevantTo()`) is wired into every task's context, but nothing automatically writes a memory entry after a task completes. The class is usable programmatically (see its tests), but out of the box the memory file stays empty unless something external populates it. This is an honest gap, not a hidden one — closing it means deciding *what* about a completed task is worth remembering, which wasn't settled during v1.0 implementation.

## Config

`.ai-dispatcher.yml` (or `.ai-dispatcher.yaml` — `.yml` wins if both exist) in the project root, all fields optional (see `src/config/schema.ts` for the full shape and defaults):

```yaml
execution:
  timeoutMs: 300000
  adaptiveTimeout:
    enabled: true
    simpleMs: 300000
    normalMs: 900000
    complexMs: 1800000
    idleMs: 300000
    maximumMs: 3600000
  sandbox: workspace-write      # read-only | workspace-write | danger-full-access
  approval: never                # untrusted | on-request | never (Codex's -a flag)
  maxTaskInputBytes: 8388608     # 8MB - total bytes across description + attachments, rejected before dispatch
retry:
  maxRetries: 1
circuitBreaker:
  failureThreshold: 4
  sampleSize: 5
  cooldownMs: 600000
validation:
  maxFixAttempts: 2
review:
  maxReviewCycles: 2
  preferIndependentReviewer: true
safety:
  protectedPaths: [.env, secrets/, production.yml]
  workspaceIsolation:
    enabled: true
  blastRadius:
    bugfix: { maxFiles: 15, maxChangedLines: 400 }
    implementation: { maxFiles: 30, maxChangedLines: 1000 }
    refactor: { maxFiles: 50, maxChangedLines: 2000 }
  autoApply:
    enabled: false
    requireIndependentReview: false
    maxRiskLevel: MEDIUM
local:
  runtimes:
    ollama: { enabled: true, host: http://127.0.0.1:11434 }
    llamacpp: { enabled: false, host: http://127.0.0.1:8080 }
  profiles: []
  allowAutoDownload: false
```

### Autonomous planning and adaptive execution

The CLI does not require operators to choose a provider or timeout for normal use. Before routing, it measures the repository (bounded file/source/test/package counts), infers whether the request is targeted, module-wide, or repository-wide, and creates a structured supervisor plan. A repository-wide `fix` request is classified as `repository-remediation`/`complex` and receives the complex execution budget automatically.

`adaptiveTimeout` separates a hard ceiling from an activity lease. stdout/stderr activity renews the idle lease, so an agent that is still issuing commands or editing files is not killed merely because the old fixed five-minute timer elapsed. A silent process is stopped after `idleMs`; every process still has a bounded hard ceiling. `--timeout` remains an optional operator override and is capped by `maximumMs`.

If an attempt reaches a timeout after changing the isolated worktree, the retry prompt explicitly inspects and continues the existing diff instead of replaying the original task from scratch. The plan, budget, activity, and checkpoint event are persisted in the audit trail.

**Security-relevant defaults, explained, not just declared**: `execution.approval: never` means Codex is run with `-a never` (never prompts for approval) because nothing is present to answer a prompt in non-interactive automation — `on-failure` is deprecated by Codex itself, and `untrusted`/`on-request` would hang waiting for input that will never come. `execution.sandbox: workspace-write` (not `danger-full-access`) is the narrowest mode that still lets an implementer edit files. Both are deliberately chosen, not silently defaulted — override them in config if your threat model needs something stricter (e.g. `read-only` for a pure-analysis deployment). `safety.autoApply.enabled: false` and `safety.workspaceIsolation.enabled: true` are equally deliberate — see [Autonomous operation](#autonomous-operation-workspace-isolation--the-auto-apply-safety-gate) above for exactly what that combination means for a `fix`/`implement` task's default behavior.

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
node dist/cli.js doctor
```

## Known Limitations

- **Circuit breaker state is per-process, in-memory only.** Each CLI invocation is short-lived, so a circuit opened in one invocation is not visible to the next. Cross-invocation persistence (e.g. via the SQLite history) is out of scope for v1.0.
- **Project memory has no embeddings/vector search, and nothing writes to it yet.** Relevance ranking is recency + keyword overlap only, and the read path is fully wired into every task's context — but no automatic `remember()` call exists in the dispatch pipeline in v1.0, so the memory file stays empty unless populated externally. See [Project memory](#project-memory) above.
- **The application log (`logging/logger.ts`, pino) is minimally wired.** `--debug` correctly raises its level and `cli/commands/dispatch.ts` emits two lifecycle events (task built, orchestrator outcome), but most of the pipeline (routing, validation, review, retry/fallback) does not yet log through it — the audit trail (SQLite) and failure artifacts are the actually-complete structured records right now, not this log.
- **Codex's success-path JSONL event shape is not fully verified against live output.** During implementation, the configured OpenAI/ChatGPT account hit its usage limit before a successful `codex exec --json` run could be captured (see `docs/fixtures/raw-probes/codex-stderr.log`). The error-path events (`thread.started`, `turn.started`, `error`, `turn.failed`) *were* verified live and are strictly validated; the final response text is instead read from Codex's `--output-last-message` file (a separate, independently-documented flag) rather than parsed from a guessed success-path JSONL shape, so this doesn't block correct operation — but the zod schema for other success-path event types is intentionally loose (passthrough) pending a real captured sample.
- **CLI command-layer files (`cli/commands/*.ts`, `cli/bootstrap.ts`) have no automated test coverage**, though every command was manually verified end-to-end against the real installed CLIs during implementation (`doctor`, `providers`, `--dry-run` routing, a real `ask` dispatch, `history`, `usage` were all run and their output inspected). Formal vitest coverage for this thin wiring layer was deprioritized under time constraints in favor of the core engine (routing, validation, review, security). See the final implementation report for exact coverage numbers per module.
- **`node:sqlite` is Node's "Experimental" API tier** (not yet stable). All access is isolated behind `history/db.ts` + `history/repository.ts`, so swapping to `better-sqlite3` later (e.g. if a target environment has no admin rights and no prebuilt binary available, mirroring the exact constraint this implementation hit) is a two-file change.
- **No coverage threshold gate in CI/`pnpm test:coverage`.** This is deliberate: a hard-failing threshold creates an incentive to weaken assertions or skip tests to hit a number, which is explicitly the wrong tradeoff here. Real per-module percentages are reported instead.
- **`ProviderHealth.reachable` is not an independent network probe.** `doctor`'s output has separate `installed`/`authenticated`/`reachable`/`ready` fields (so a restricted-network deployment can in principle distinguish "CLI present, never logged in" from "logged in, but currently unreachable"), but in the current health-check implementations `reachable` is simply derived from `authenticated` (`true` if authenticated, `null` otherwise) rather than from a real independent connectivity check — no unnecessary external ping is made, but the field doesn't yet carry more signal than `authenticated` does.
- **`llama.cpp` support is unverified.** No `llama-server`/`llama-cli` binary was available on the machine this was implemented on; `providers/local/llamacpp-runtime.ts` is written from the published server API and covered only by mocked unit tests, never a real integration run. `local.runtimes.llamacpp.enabled` defaults to `false` for this exact reason. Ollama, by contrast, was live-verified throughout (real `/api/tags`, `/api/version`, `/api/generate` calls against an actually-running instance, including `tests/contract/ollama-health.test.ts`, which is never skipped when Ollama is reachable).
- **The repository lock and circuit breaker share the same limitation: per-process, in-memory only.** A second, separately-invoked `ai-dispatcher` process is not coordinated with — only concurrent code-changing tasks *within one process* are protected against racing on the same repository. Not a concern for typical one-shot CLI usage; would matter for a long-running server wrapping this library.
- **Local autonomous coding quality depends on the model.** The dispatcher supplies safe tools and structured output constraints, but a small model can still choose an incomplete edit. Every result therefore goes through the same real validation, bounded correction loop, review, risk classification, and isolated Auto-Apply gate as cloud-provider work. `AI_DISPATCHER_LIVE_LOCAL_CODING=1 pnpm vitest run tests/contract/local-autonomous-coding-live.test.ts` runs the CPU-heavy live contract that edits a temporary file with `qwen3:4b`; larger repository work should use a capable coding model and conservative limits.
- **The Local LLM Adapter + Hardening increment covers a deliberately scoped first batch, not the full ~90-mechanism spec it was requested against.** Explicitly deferred, not silently dropped: Model Governance/Qualification (`local qualify`), a Policy Engine with precedence rules, Data Egress Gateway/Classification, Offline Mode, Restricted Tool Mode, Environment Sanitization, Test-Integrity/anti-gaming checks, Dependency Change Policy, DB Migration Analyzer, Task Resource Budgets, Crash Recovery/Rollback beyond the worktree-discard already in place, Audit Integrity hash-chaining, Trust Key Rotation, signed offline bundles, deep hardware/GPU detection, and several more (see the increment's own planning notes). Everything shipped in this batch — Local LLM Provider, workspace isolation, repository lock, base-revision + content-hash TOCTOU guards, risk classification, and the Auto-Apply Safety Gate — is real and tested end-to-end against a real git repository and a real running Ollama instance, not stubbed.
