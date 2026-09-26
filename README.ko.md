[English](README.md) | 한국어

# AI Dispatcher

Claude Code, Codex, 그리고 로컬 모델(Ollama, llama.cpp, OpenAI-compatible 서버) 사이에서 코딩 작업을 라우팅하고, 실제 build/test/lint로 결과를 검증하고, 구현하지 않은 *다른* AI가 독립적으로 리뷰한 뒤에야 성공을 선언하는 CLI — AI Development Control Plane입니다.

`claude`나 `codex`를 그냥 실행해주는 래퍼가 아닙니다. 작업을 분류하고, 실제 health/usage/capability 데이터로 두 provider의 점수를 매기고, retry/fallback/circuit-breaking을 곁들여 디스패치하고, 실제 검증 파이프라인을 돌리고(실패 시 횟수 제한이 있는 자동 fix loop 포함), diff를 독립 리뷰어에게 보내고, 이 모든 과정을 구조화된 audit 로그와 로컬 SQLite history에 기록합니다 — 그래서 "AI가 됐다고 말한 것"과 "시스템이 실제로 검증한 것"이 절대 같은 주장이 되지 않습니다.

## 아키텍처

```
src/
├─ models/        도메인 타입 + DispatcherError (모든 레이어가 공유)
├─ core/           state machine, Orchestrator(runTask() 파이프라인), 실행 연결부
├─ task/           Task Specification 파싱, 입력 리졸버, classifier
├─ providers/      AIProvider 인터페이스 + ProviderRegistry; claude/, codex/, local/ 어댑터
├─ routing/        usage 추적, 스코어링, provider 선택, retry/fallback/circuit-breaker
├─ project/        프로젝트 분석기, memory(JSON), 로그 윈도잉, context builder
├─ validation/     git-diff, build/test/lint/typecheck 러너, 파이프라인, fix loop
├─ review/         리뷰 코디네이터(리뷰어에게 프롬프트, verdict 파싱), 충돌 해소기
├─ safety/         워크스페이스 격리, repository lock, base-revision/content-hash TOCTOU 가드,
│                  risk classifier, Auto-Apply Safety Gate, patch apply
├─ process/        유일한 execa 호출 지점 (process-runner.ts)
├─ logging/        pino 로거, 시크릿 마스킹, audit 이벤트 로그
├─ history/        node:sqlite 기반 task/execution/audit history
├─ config/         `.ai-dispatcher.yml`용 zod 스키마 + YAML 로더
└─ cli/            위 모든 걸 연결하는 commander 기반 CLI
```

**핵심 아키텍처 불변식**: `core/`, `routing/`, `task/classifier.ts`, `validation/`, `review/`는 `ClaudeProvider`/`CodexProvider`를 이름으로 import하거나 provider id 문자열로 분기하지 않습니다. provider 관련 동작은 전부 `ProviderRegistry`를 거친 `AIProvider` 인터페이스로만 접근합니다. 두 구체 클래스를 모두 import하는 곳은 `providers/index.ts`(합성 루트)와 테스트뿐입니다. `tests/unit/orchestrator.test.ts`는 오케스트레이터가 한 번도 본 적 없는 provider id(`"totally-unknown-provider"`)로도 실제 라우팅·실행이 성공하는 걸로 이걸 증명합니다.

## 설치

```bash
pnpm install
pnpm build
```

Node.js 22+ 필요. [`claude`](https://claude.com/product/claude-code)와/또는 [`codex`](https://github.com/openai/codex) CLI가 별도로 설치·인증되어 있어야 합니다 — 아래 참고.

### CLI 실행하기

`pnpm build`는 `dist/cli.js`를 만들 뿐, `ai-dispatcher`라는 명령을 자동으로 PATH에 등록하지 **않습니다**. 둘 중 하나를 선택하세요:

```bash
# 별도 설정 없이 항상 되는 방법 - 직접 실행:
node dist/cli.js doctor
```

또는 `ai-dispatcher`를 PATH에 등록된 실제 명령으로 만들 수 있습니다:

```bash
pnpm add -g .          # pnpm 12+, 이 프로젝트 디렉터리에서 - 끝의 `.`을 빼먹지 마세요
ai-dispatcher doctor   # 이제 새 셸이면 어디서든 동작합니다
harness doctor         # `harness` 명령도 같은 방식으로 등록됩니다
```

pnpm 12에서는 `pnpm link`가 `--global`을 받지 않습니다(`error: unexpected argument '--global' found`). 전역 등록은 `pnpm add -g`로 옮겨졌습니다. 그보다 오래된 pnpm에서는 `pnpm link --global .`을 쓰세요. 전역 설치는 이 디렉터리를 가리키는 심볼릭 링크라서, 이후 `pnpm build`만 하면 재설치 없이 바로 반영됩니다.

이 머신에서 pnpm 전역 링크를 처음 쓰는 경우 겪을 수 있는 두 가지 문제(둘 다 Windows에서 실제로 라이브로 확인했고, 겪는 순서도 이대로입니다):

1. **`The configured global bin directory "..." is not in PATH`**(`ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH`) — `pnpm setup`을 한 번 실행한 뒤 **완전히 새로운 터미널 창**을 여세요(이미 열려 있던 터미널의 새 탭이 아니고, 도구가 재시작한 셸도 아닙니다 — `pnpm setup`의 환경변수 변경은 Windows 레지스트리에 기록되고, 그 이후에 새로 실행되는 프로세스만 이걸 읽습니다).
2. **`Aborted removal of modules directory due to no TTY`**(오래된 pnpm에서 `pnpm link --global` 사용 시) — `pnpm link --global`은 전역 링크에 맞는 구조로 `node_modules`를 재설치해야 하는데, 이때 pnpm이 대화형 확인을 요구합니다. `CI=true pnpm link --global .`을 한 번 실행해서 비대화형으로 답하세요(안전합니다 — lockfile에 고정된 동일한 의존성을 재설치할 뿐, 다운그레이드되거나 바뀌는 건 없습니다). 이후 `--global` 없이 실행한 `pnpm build`/`pnpm test`에서도 같은 "no TTY" 에러가 또 나오면, 그 재설치가 pnpm의 의존성-드리프트 검사가 싫어하는 상태로 `node_modules`를 남긴 겁니다 — `CI=true pnpm install`을 한 번 깨끗하게 돌리면 정리되고, 이후엔 `CI=true` 없이도 평소처럼 됩니다.

이 문서의 나머지 부분에서는 `ai-dispatcher <command>`를 둘 중 어느 쪽을 쓰든 상관없는 축약형으로 사용합니다 — 전역 링크를 안 하셨다면 `node dist/cli.js`로 바꿔 읽으세요. 전역 설치를 해제하려면: `pnpm remove -g ai-dispatcher`(pnpm 12+) 또는 오래된 pnpm에서는 이 프로젝트 디렉터리에서 `pnpm unlink --global`.

## Provider 인증

**Dispatcher는 Credential Manager가 아닙니다.** API 키, OAuth 토큰, 세션 쿠키를 읽거나 저장하거나 건드리는 일이 절대 없습니다. 공식 CLI 자신의 상태 확인 명령(`claude auth status`, `codex login status`)을 실행해서 *당신이* 이미 로그인되어 있는지만 확인합니다.

```bash
claude auth login
codex login
```

provider가 인증되어 있지 않으면 `ai-dispatcher doctor`가 정확히 그렇게 알려주고 멈춥니다 — 로그인 흐름을 자동화하려는 시도는 절대 하지 않습니다.

## CLI 명령어

```bash
ai-dispatcher ask <task-spec>          # 분석/질의응답, 검증·리뷰 없음
ai-dispatcher analyze <task-spec>
ai-dispatcher review <task-spec>
ai-dispatcher fix <task-spec>          # 코드 변경: 검증 + fix loop + 리뷰까지 수행
ai-dispatcher implement <task-spec>    # 코드 변경: 위와 동일

ai-dispatcher doctor [--json]          # 클라우드 provider 두 개 + 로컬 런타임 헬스체크
ai-dispatcher providers [--json]       # capability 목록
ai-dispatcher usage [provider] [--json]# 1h/24h/7d/all 요청·비용 통계
ai-dispatcher history [--limit N]      # 최근 작업 목록
ai-dispatcher inspect <taskId>         # 작업 하나의 전체 상세
ai-dispatcher explain <taskId>         # 왜 이 provider가 선택됐는지, 점수 내역과 함께

ai-dispatcher local status [--json]    # 런타임 도달성 + 설정된 local.profiles[] 헬스
ai-dispatcher local runtimes [--json]  # 로컬 런타임 도달성 (profile 설정과 무관)
ai-dispatcher local models [--json]    # 도달 가능한 런타임별 실제 설치된 모델 목록
ai-dispatcher local start              # manifest에서 선택한 llama.cpp 런타임과 모델 실행
ai-dispatcher preflight [--json]       # CPU/GPU 프로필과 오프라인 런타임·모델 팩 준비 상태
ai-dispatcher local benchmark [name]   # 설정된 로컬 모델 성능 측정 및 처리량 캐시 저장
ai-dispatcher local import-pack <dir>  # 사전 다운로드한 모델 팩을 검증 후 복사
ai-dispatcher portable assemble <dir>  # USB용 오프라인 포터블 키트 생성
ai-dispatcher portable seal <dir>      # 자산 변경 후 검토된 키트 무결성 잠금 재생성
```

### ContextClip 웹 자료를 Harness에 전달하기

ContextClip으로 복사한 웹페이지는 작업 지시와 분리해서 전달합니다. Harness는 웹 자료를
비신뢰 참고자료 영역에 넣은 뒤 에이전트에 전달합니다. 자료 안에 포함된 명령, 역할 변경,
프롬프트는 작업 지시로 취급되지 않습니다. 파일은 프로젝트 내부에 있어야 하며 최대 크기는
1 MiB입니다.

```powershell
# Windows PowerShell: ContextClip이 복사한 내용을 바로 전달
Get-Clipboard -Raw | harness run "이 문서를 검토해줘" --project . --context-stdin
```

```bash
# 프로젝트 안에 Markdown 파일로 저장한 경우
harness run "API 변경점을 정리하고 클라이언트를 수정해줘" \
  --project . --context-file contextclip.md

# macOS 클립보드
pbpaste | harness run "이 문서를 검토해줘" --project . --context-stdin
```

`--context-file`과 `--context-stdin`은 한 번에 하나만 사용합니다.

디스패치 명령(`ask`/`analyze`/`review`/`fix`/`implement`)이 실행되는 동안, provider 선택·각 실행 시도 시작/종료·retry·fallback·검증·리뷰 같은 실시간 상태가 **stderr**로 그때그때 출력됩니다(stdout이 아니라서 `--json`의 기계 판독용 출력은 영향받지 않습니다). 실행 하나가 오래 걸리면 30초마다 "아직 `<provider>` 대기 중 (`Ns` 경과)" 하트비트도 함께 나옵니다. 예전에는 작업 전체가 끝날 때까지 터미널에 아무것도 안 찍혀서, 몇 분씩 걸리는 실행 중에 "정상 진행 중"과 "멈춤"을 구분할 방법이 없었습니다 — 실제로(2026-08-22) 11분 동안 아무 출력도 없이 멈춰있던 걸 겪고 나서 추가했습니다. 마지막에 사람이 읽기 좋은(또는 `--json`) 요약은 기존과 동일하게 출력됩니다.

최종 요약에는 구조화된 **6하 원칙 결과 보고서**가 포함됩니다. 누가 작업을 조정·실행·검토했는지, 언제 어디서 실행했는지, 무엇을 변경했고 그 변경이 반영·정책상 미반영·폐기·작업 디렉터리 잔류 중 어느 상태인지, 왜 해당 provider를 선택했는지, 어떻게 실행·검증·리뷰를 마쳤는지를 함께 보여줍니다. 일반 출력에는 `누가`, `언제`, `어디서`, `무엇을`, `왜`, `어떻게`로 표시하고, `--json`에서는 동일한 정보를 `resultReport`로 제공합니다. 시크릿을 마스킹한 보고서는 `task.report.created` 감사 이벤트로도 보존됩니다.

디스패치 명령은 모두 다음을 지원합니다:

| 플래그 | 의미 |
|---|---|
| `--file <path>` | 파일에서 task specification 읽기 |
| `--stdin` | stdin에서 task specification 읽기 |
| `--path <paths...>` | context로 포함할 관련 파일/디렉터리 경로 |
| `--cwd <path>` | 작업 디렉터리 (기본값: 현재 디렉터리) |
| `--timeout <ms>` | 실행 타임아웃 |
| `--provider <id>` | 라우팅 대신 `claude`, `codex`, 또는 `local-<profile>`을 강제 지정 |
| `--dry-run` | 라우팅 결정과 생성될 명령만 출력, 실행은 안 함 |
| `--json` | 기계 판독용 출력 |
| `--debug` | 애플리케이션 로그를 debug 레벨로 (stdout에 NDJSON) |

### Task Specification 작성법

작업 설명은 한 줄짜리 프롬프트가 아니라, 온전한 인시던트 리포트여도 됩니다. 아래 전부 정상 동작합니다:

```bash
# 짧게
ai-dispatcher fix "로그인 오류를 수정해줘"

# 여러 줄, 오류 코드와 스택 트레이스 포함
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

# 파일에서
ai-dispatcher fix --file bug-report.md

# stdin에서
cat bug-report.md | ai-dispatcher fix

# 조합: 설명 + 첨부 로그 + 관련 경로
ai-dispatcher fix --file error.log --path src/main/java/com/example \
  "이 오류의 근본 원인을 분석하고 회귀 테스트까지 작성해줘"
```

원문 텍스트는 classifier가 추출한 것(오류 코드, 스택 트레이스, 번호 붙은 재현 절차, 불릿 요구사항/제약사항)과 별개로 **항상 그대로 보존**됩니다 — 분류가 잘못되더라도 provider가 활용할 수 있었던 정보를 잃는 일은 없습니다.

대용량 첨부(스택 트레이스, 빌드 로그)는 절대 통째로 전송되지 않습니다. `project/log-windowing.ts`가 에러 키워드/스택 트레이스/실패한 테스트의 앵커 라인을 찾아 그 주변에 context window를 만들고, 가까운 window끼리 병합하고, 중복 블록을 제거하고, 아무것도 못 찾으면 head+tail 윈도잉으로 폴백합니다 — 자세한 내용은 `docs/architecture.md` 참고.

### 셸 안전성

사용자가 입력한 모든 텍스트 — task description, 파일 경로, 로그 내용 — 는 provider에게 `stdin`으로 전달되며, 셸 명령 문자열로 이어붙여지는 일이 절대 없습니다. `process/process-runner.ts`가 프로세스를 스폰할 수 있는 *유일한* 파일이고(ESLint 규칙과, 빌드 결과물에서 위험한 패턴을 grep하는 `tests/security/dist-static-scan.test.ts`로 강제됨), `shell: false`를 명시해서 `execa`를 호출합니다. 이걸 검증하는 전체 페이로드는 `tests/security/shell-injection.test.ts`를 참고하세요 — OS argv 길이 제한에 기대지 않는다는 걸 증명하는 100KB 초과 페이로드도 포함되어 있습니다.

## 라우팅

Provider 선택은 역할 고정이 아니라 가중치 스코어입니다:

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

`ai-dispatcher explain <taskId>`는 그 결정을 만든 정확한 점수 내역을 출력합니다 — 라우팅 로그에서 보게 될 것과 같은 형식으로, 모든 구성요소와 모든 provider에 대해.

## 로컬 LLM Provider (Ollama / llama.cpp / OpenAI-compatible)

로컬 모델은 Claude·Codex가 쓰는 것과 완전히 동일한 `AIProvider`/`ProviderRegistry` 체계에 꽂힙니다 — 라우팅, retry/fallback, audit 로깅, history 전부 특별 취급이 필요 없습니다. 설정된 profile마다 `local-<name>` id를 가진 provider로 등록되며, `--provider local-<name>`을 포함해 다른 provider와 똑같이 라우팅 대상이 됩니다.

```yaml
local:
  runtimes:
    ollama:   { enabled: true,  host: http://127.0.0.1:11434 }
    llamacpp: { enabled: false, host: http://127.0.0.1:8080 } # 기본 비활성 - 알려진 한계 참고
    openai-compatible: { enabled: false, host: http://127.0.0.1:1234 }
  profiles:
    - name: fast
      runtime: ollama
      model: qwen3:4b
```

**로컬 자율 코딩 동작.** 로컬 completion API 자체에 tool calling이 없어도 됩니다. `fix`/`implement`에서는 `LocalProvider`가 런타임 중립적인 dispatcher 도구 루프를 실행합니다. 모델은 파일 목록·읽기·검색·정확 치환·쓰기 중 하나를 JSON Schema로 제한된 action으로 반환하고, dispatcher가 격리 worktree 안에서 실행합니다. 이후 기존 검증·fix-loop·리뷰·Auto-Apply gate가 결과를 처리합니다. 읽기 크기, 경로, 파일 수, turn, 출력 token에 상한이 있고, `.git`·`.dispatcher`·dependency 접근, 경로 탈출, 읽지 않은 파일 덮어쓰기, 동일 변경 반복을 차단합니다. shell은 모델에게 노출하지 않고 기존 검증 파이프라인만 build/lint/test를 실행합니다.

**`<think>` 제거는 장식이 아니라, 실제로 라이브 검증 중에 발견한 진짜 수정 사항입니다.** 요청에 `"think": false`를 넣어도 `qwen3:4b`는 실제 답변 앞에 추론 과정 전체를 여전히 출력했습니다 — 그것도 모델 카드가 암시하는 것처럼 짝이 맞는 `<think>...</think>` 태그로 감싸져 있지 않았습니다: 실제로 관찰된 형태는 여는 태그가 아예 없고, 실제 답변 바로 앞에 고아 상태의 `</think>` 닫는 태그만 있었습니다. `providers/local/local-http-client.ts`의 `stripThinking()`은 문서화된 짝이 맞는 태그 형태와, 실제로 관찰된 이 고아 태그 형태를 모두 처리하므로, 호출하는 쪽에는 항상 답변만 보입니다.

**네트워크 안전성**: `providers/local/local-http-client.ts`가 전역 `fetch()`를 호출할 수 있는 *유일한* 파일입니다(`tests/security/local-fetch-single-chokepoint.test.ts`라는 소스 레벨 정적 스캔으로 강제됨 — `process-runner.ts`가 유일한 프로세스 스폰 지점인 것과 같은 방식). 요청을 보내기 전에 호스트가 `127.0.0.1`/`localhost`/`::1`이 아니면 거부하고, 모든 호출에는 `AbortSignal.timeout()`이 걸립니다.

`llama.cpp` 지원(`providers/local/llamacpp-runtime.ts`)은 **검증되지 않았습니다** — 이 기능을 구현한 머신에는 `llama-server`/`llama-cli` 바이너리가 설치돼 있지 않아서, 이 어댑터는 llama.cpp가 공개한 서버 API(`GET /health`, `GET /v1/models`, `POST /completion`)를 보고 작성했을 뿐 실제 통합 테스트 없이 mock 단위 테스트만 거쳤습니다. `local.runtimes.llamacpp.enabled`가 기본적으로 `false`인 이유가 바로 이것입니다 — 직접 빌드에 대해 실제로 동작하는 걸 확인한 뒤에만 활성화하세요.

### CPU 우선 오프라인 모델 팩

CPU는 GPU 탐지 실패 시의 차선책이 아니라 기본 실행 경로입니다. `ai-dispatcher preflight`는 가능한 범위에서 하드웨어 프로필을 만들고 `CPU_LITE`·`CPU_STANDARD`·`CPU_PLUS`·`GPU_STANDARD`·`AI_WORKSTATION`을 정한 뒤 Metal → CUDA → Vulkan → CPU 순서로 런타임을 고릅니다. Apple Silicon은 통합 메모리를 공유하는 Metal 장치로 감지합니다. ISA가 명확히 확인되지 않으면 AVX/AVX2 전용 바이너리는 고르지 않고 일반 CPU 바이너리만 허용하므로, 알 수 없는 장비에서 Illegal Instruction이 나는 일을 막습니다.

```text
runtime/
  windows-x64-generic/runtime-manifest.json
models/
  cpu-standard/model-pack.json
  cpu-standard/<model>.gguf
```

모델 팩은 RAM/VRAM 조건, 역할, 컨텍스트 권장값, 선택적 SHA-256, 라이선스/출처 메타데이터를 선언합니다. Preflight는 `READY_FAST`·`READY`·`READY_SLOW`·`SUPPORTED_BUT_NOT_RECOMMENDED`·`UNSUPPORTED` 상태를 보여 주며 누락 모델을 다운로드하지 않습니다. `local import-pack <directory>`는 경로 이탈·선택적 라이선스 정책·선언된 SHA-256을 검증한 뒤에만 팩을 복사합니다. `local benchmark [profile]`은 설정된 로컬 엔드포인트의 처리량을 재고, 하드웨어 지문 기준 결과를 `.dispatcher/local/qualification.json`에 저장합니다.

```yaml
local:
  cpu: { maxThreads: auto, reserveCores: 2 }
  bundle:
    runtimeDirectory: runtime
    modelPacksDirectory: models
    offlineKitRequired: true
    requireModelLicenseMetadata: true
```

GPU/NPU 탐지는 선택 사항입니다. 감사된 설치 도구가 `AI_DISPATCHER_GPU_VENDOR`, `AI_DISPATCHER_GPU_MODEL`, `AI_DISPATCHER_GPU_MEMORY_BYTES`, `AI_DISPATCHER_GPU_BACKENDS` 힌트를 제공할 수 있으며, 이 값이 없어도 CPU 실행은 유지됩니다.

### USB 포터블 키트

빌드 후 `ai-dispatcher portable assemble <folder>`를 실행하면 외장 드라이브로 복사할 단일 폴더를 만듭니다. 지원되는 호스트에서는 대상이 자동 선택되며, `--target windows-x64` 또는 `--target macos-arm64`로 명시할 수도 있습니다. `dist`에 포함된 빌드 앱·포터블 설정·대상별 실행 스크립트와 준비된 오프라인 자산을 복사하며, 어떠한 자산도 다운로드하지 않고 다른 운영체제의 실행 파일을 잘못 복사하지도 않습니다.

Windows 대상은 `runtime/node/node.exe`, MinGit, `.cmd` 런처와 Windows llama.cpp 런타임을 사용합니다. Apple Silicon 대상은 `runtime/node/bin/node`, relocatable Git, POSIX 런처와 macOS ARM64 Metal llama.cpp를 사용합니다. Mac 자산은 생성 전 `runtime/macos-arm64/`, Mac 전용 템플릿은 `templates/macos-arm64/`에 준비합니다. 생성 후 자산을 채우거나 교체했다면 키트 루트에서 `bin/ai-dispatcher portable seal .`로 무결성 잠금을 갱신한 뒤 `bin/preflight`가 `READY`인지 확인하세요. `start-local`은 별도 임계값 대신 이 preflight의 launch plan을 그대로 사용합니다. 자세한 내용은 [macOS portable 가이드](docs/PORTABLE-KIT-GUIDE.macos.ko.md)를 참고하세요. 런처는 외장 드라이브를 자산 루트로 유지하고 프로젝트의 `.dispatcher/` 기록은 해당 프로젝트에 남깁니다.

### 폐쇄망 배포

인터넷이 차단된 폐쇄망에서는 두 클라우드 provider를 모두 끄고 loopback 로컬 profile만 등록합니다:

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
      model: 설치된-로컬-모델
  allowAutoDownload: false
  coding:
    enabled: true
    maxTurns: 24
    maxFilesChanged: 20
    maxFileBytes: 1048576
    maxReadLines: 400
    maxOutputTokens: 1024
```

이 설정에서는 클라우드 provider가 아예 등록되지 않으므로 `--provider`로도 되살릴 수 없고, 로컬 HTTP는 loopback으로 제한되며, 로컬 런타임이 닿지 않으면 `NO_AVAILABLE_PROVIDER`로 안전하게 중단됩니다. 분석·리뷰·문서화뿐 아니라 자율 코드 수정도 모두 로컬에서 수행됩니다. dispatcher가 실행하는 검증 명령과 프로젝트 스크립트까지 네트워크를 쓰지 못하게 하는 경계는 호스트 OS/방화벽에서 강제해야 합니다.

로컬 completion API에 자체 tool calling이 없어도 됩니다. `fix`/`implement`에서는 모델이 JSON Schema로 제한된 파일 목록·읽기·검색·정확 치환·쓰기 action을 하나씩 선택하고 dispatcher가 격리 worktree 안에서 실행합니다. 경로 탈출과 `.git`·`.dispatcher`·dependency 접근을 막고, 현재 파일을 읽지 않은 쓰기와 동일 변경 반복을 거부하며, 이후 기존 build/lint/test·fix-loop·review·Auto-Apply gate를 그대로 통과시킵니다. Ollama·llama.cpp·OpenAI-compatible 서버가 모두 같은 코딩 루프를 사용합니다.

LM Studio·vLLM·LocalAI·text-generation-webui처럼 OpenAI API를 제공하는 로컬 서버는 `local.runtimes.openai-compatible`을 활성화하고 profile에 `runtime: openai-compatible`을 지정하면 됩니다. 전용 프로토콜만 제공하는 런타임도 `detect/list/generate`를 구현한 `LocalRuntimeAdapter` 하나만 추가하면 동일한 자율 코딩 루프를 재사용합니다.

## 검증과 fix loop

`fix`/`implement` 작업은 실행 후: `git diff`(protected path 변경 여부 확인) → typecheck → lint → build → test 순서로 진행하며, 첫 실패에서 멈춥니다. 실패하면 실패한 단계의 출력이 후속 작업에 첨부되어 *같은* 구현자에게 다시 보내지고, 검증이 재실행됩니다 — `validation.maxFixAttempts`(기본 2)로 횟수가 제한되며, 절대 무한 반복하지 않습니다.

명령어는 프로젝트에서 자동 감지되지만(`package.json` scripts + lockfile → pnpm/yarn/npm; `pom.xml` → Maven; `build.gradle(.kts)` → Gradle; `pyproject.toml` → pytest/ruff), 명시적인 `.ai-dispatcher.yml`이 항상 우선합니다:

```yaml
validation:
  commands:
    test: [pnpm, run, test]
  maxFixAttempts: 2
```

## 리뷰

검증을 통과하면 diff가 독립 리뷰어에게 전달됩니다 — 기본값은 이번 변경을 구현하지 *않은* provider입니다. 리뷰어에게는 정확성, 요구사항 준수, 회귀, 보안, 동시성, null 처리, 오류 처리, 리소스 누수, 성능, 유지보수성, 테스트 커버리지, 무관한 변경, 아키텍처 일관성을 확인하고 fenced JSON verdict로 답하도록 요청합니다. `request_changes`/`critical` 판정이 나오면 fix→재검증→재리뷰 사이클이 한 번 더 도는데, `review.maxReviewCycles`(기본 2)로 제한됩니다.

`Ready`(installed + authenticated + reachable) 상태인 provider가 하나뿐이면, 막혀서 멈추는 대신 스스로 리뷰합니다 — 다만 결과와 history에 `independentReview: false`가 기록되며, 독립 검수인 것처럼 조용히 위장하지 않습니다.

리뷰어의 말과 검증 결과가 어긋날 때는 다수결이 아니라 증거로 판단합니다(어차피 한 사이클에 활성 리뷰어는 항상 하나뿐이기도 합니다): `review/conflict-resolver.ts`가 최신 `ValidationResult`를 확인해서 계속 남아있는 finding을 경고로 받아들일지 사용자에게 에스컬레이션할지 결정합니다.

## 완전자동 운영: 워크스페이스 격리 + Auto-Apply Safety Gate

기본값(`safety.workspaceIsolation.enabled: true`)에서는 코드 변경 작업(`fix`/`implement`)이 작업 트리에 대해 절대 직접 실행되지 않습니다. 대신 오케스트레이터는:

1. 배타적 **repository lock**(프로세스 내 메모리 — 알려진 한계 참고)을 획득해서, 같은 레포지토리에 대한 두 번째 코드 변경 작업이 경합하는 대신 재시도 가능한 `REPOSITORY_LOCKED` 에러로 거부되게 합니다.
2. 현재 `HEAD`("base revision")에서 체크아웃한 실제 **`git worktree`**를 만들고, 기존의 디스패치 → 검증 → fix loop → 리뷰 파이프라인 *전체*를 이 격리된 사본에 대해 완전히 그대로 실행합니다 — 실제 작업 트리는 이 과정에서 절대 `reset`, `checkout`, `clean`되지 않습니다.
3. 검증을 통과하고 리뷰가 블로킹되지 않으면 변경의 **risk level**을 계산합니다(`safety/risk-classifier.ts`): `safety.protectedPaths` 항목이나 CI/CD 파이프라인 파일(`.github/workflows/**`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `Jenkinsfile`)을 건드리면 크기와 무관하게 무조건 `CRITICAL`이고, 그 외에는 파일/라인 수가 `safety.blastRadius`의 작업 유형별 한도를 얼마나 초과했는지로 `LOW`/`MEDIUM`/`HIGH`가 정해집니다.
4. 실제로 뭔가를 건드리기 직전에, base revision이 그대로인지(`BASE_REVISION_CHANGED`), 그리고 patch가 건드리는 파일이 그 사이에 커밋 없이 실제 작업 트리에서 수정되지 않았는지(`STALE_PATCH` — 커밋 없는 수정은 `HEAD`를 움직이지 않으므로 `git rev-parse HEAD`만으로는 잡을 수 없는 TOCTOU 가드)를 다시 확인합니다.
5. **`AUTO_APPLY` / `BLOCKED_BY_POLICY` / `FAILED`**를 결정합니다(`safety/auto-apply-gate.ts`) — fail-closed 방식입니다: 검증 통과, 리뷰 비블로킹, lock 보유, base revision 일치, content hash 일치, `autoApply.enabled`, risk가 `maxRiskLevel` 이내인지 — 이 전부가 성립해야만 하고, 하나라도 아니면 변경은 폐기됩니다. 기본값이나 추측으로 적용되는 일은 없습니다.
6. `AUTO_APPLY`가 나오면 worktree의 변경을 `git apply`(`safety/patch-apply.ts`)로 실제 작업 트리에 평범한 **커밋되지 않은** diff로 병합합니다 — 당신을 대신해 커밋하는 일은 절대 없습니다. 그 외의 경우 worktree(그 안에서 AI가 바꾼 모든 것 포함)는 그냥 폐기됩니다.

```yaml
safety:
  protectedPaths: [.env, secrets/, production.yml]
  workspaceIsolation:
    enabled: true          # 이 증분 이전의 직접 실행 동작으로 되돌리는 탈출구는 `false`
  blastRadius:
    bugfix:         { maxFiles: 15, maxChangedLines: 400 }
    implementation:  { maxFiles: 30, maxChangedLines: 1000 }
    refactor:       { maxFiles: 50, maxChangedLines: 2000 }
  autoApply:
    enabled: false          # 기본값은 꺼짐 - 아래 설명 꼭 읽으세요
    requireIndependentReview: false # true면 자가 리뷰 변경은 자동 반영하지 않음
    maxRiskLevel: MEDIUM    # CRITICAL은 절대 auto-apply 대상이 아니며, 이를 우회할 방법은 없음
```

**적용하기 전에 꼭 읽으세요**: `safety.autoApply.enabled`의 기본값은 **`false`**입니다. 즉 별다른 설정 없이는, 검증도 통과하고 리뷰도 승인한 — 완전히 성공한 — `fix`/`implement` 작업이 이제 `SUCCESS` 대신 **`BLOCKED_BY_POLICY`**를 보고하고, *레포지토리에 아무것도 반영되지 않습니다*. 이전에는 `safety.autoApply`라는 키 자체가 없었으니 이건 실질적인 동작 변화입니다. 의도된 것입니다: 이 기능 전체의 목적이 안전을 기본값으로 하는 완전자동 운영인데, 업그레이드하는 순간부터 AI 변경사항을 조용히 자동 커밋하기 시작하는 시스템이라면 그 목적에 정반대가 됩니다. 위의 risk/blast-radius 임계값을 검토하고 자신의 threat model에 맞는다고 판단했다면 `safety.autoApply.enabled: true`로 설정하세요. `ai-dispatcher fix "..." --dry-run`과 처음 몇 번의 `BLOCKED_BY_POLICY` 실행 결과(`ai-dispatcher explain <taskId>` / `ai-dispatcher inspect <taskId>`로 확인)를 보는 게 실제로 켜기 전에 *무엇이* 적용됐을지 미리 확인하는 방법입니다.

자동 반영이 구현 모델의 자가 리뷰에 의존해서는 안 된다면 `requireIndependentReview: true`로 설정하세요. 준비된 provider가 하나뿐일 때도 진단을 위한 자가 리뷰는 끝까지 수행하지만, gate는 `independentReview: false`를 기록하고 `BLOCKED_BY_POLICY`로 종료하며 실제 작업 트리는 변경하지 않습니다. 포터블 키트는 이 엄격한 정책을 기본으로 켜므로, 무인 자동 반영을 사용하려면 실제로 분리된 reviewer provider를 추가로 준비해야 합니다.

`workspaceIsolation.enabled: false`는 이 기능이 생기기 전 모든 `fix`/`implement` 작업이 갖고 있던 직접 실행 동작으로의 말 그대로의 opt-out입니다: worktree도, repository lock도, risk gate도 없이, provider가 끝나는 즉시 이전과 똑같이 변경이 반영됩니다.

**격리가 켜져 있는 동안 AI는 당신이 커밋하지 않은 로컬 변경사항을 절대 보지 못합니다.** `git worktree add`는 고정된 base revision — 즉 커밋 — 을 체크아웃하는 것이지, 당신의 작업 트리가 지금 갖고 있는(어쩌면 지저분한) 상태를 체크아웃하는 게 아닙니다. `fix`/`implement`를 실행할 때 커밋 안 된 수정사항이 있다면, AI는 마지막 커밋 기준으로 작업하고 당신이 뭘 고치던 중이었는지 전혀 모릅니다. 이것 때문에 뭔가가 망가지진 않습니다 — AI의 patch와 당신의 커밋 안 된 수정이 *같은* 파일을 건드리면 `STALE_PATCH`가 여전히 apply를 막아줍니다 — 하지만 "코드가 지금 어떤 상태인가"에 대한 AI의 이해가 실제 작업 트리와 어긋나 있을 수 있고, 그래서 당신이 아직 커밋 안 한 작업을 고려하지 않은 수정이 나올 수 있습니다. 이게 중요한 작업이라면 먼저 커밋하거나 stash 해두세요.

## Audit와 History

모든 작업은 `taskId`를 받고, 모든 실행 시도(retry·fallback 포함)는 각자 `executionId`를 받으며, 전부 같은 task에 연결됩니다. 구조화된 audit 이벤트(`task.created`, `provider.selected`, `retry.started`, `validation.failed`, `review.completed` 등)는 `ai-dispatcher`를 실행한 프로젝트 안의 `.dispatcher/history.sqlite`라는 로컬 SQLite 데이터베이스에 추가만 됩니다(다시 쓰이지 않음).

**기본적으로 prompt와 response 텍스트는 절대 저장되지 않습니다** — SHA-256 해시와 길이만 저장됩니다. config에서 `diagnostics.logPrompts: true`로 설정하면 원문 저장을 선택할 수 있는데, 그때도 먼저 시크릿 마스킹을 거칩니다(AWS/OpenAI/Anthropic/GitHub 토큰 형태 문자열, JWT, PEM 블록, `.env` 형태의 시크릿 라인이 `[REDACTED]`로 치환됩니다).

`ai-dispatcher history [--limit N]`은 최근 작업 목록을 보여주고, `ai-dispatcher inspect <taskId>`는 작업 하나와 그에 대한 모든 실행 시도(provider, 타이밍, 토큰/비용 사용량)를 보여주며, `ai-dispatcher explain <taskId>`는 어떤 provider가 왜 선택됐는지 점수 내역을 보여줍니다(위 [라우팅](#라우팅) 참고).

위에서 설명한 6하 원칙 결과 보고서는 별도 파일로 저장되지 않습니다 — 실행 당시의 터미널 출력과, `task.report.created` 감사 이벤트로만 남습니다. `ai-dispatcher inspect <taskId>`가 그 이벤트를 다시 읽어서 같은 보고서를 재출력해주므로, 예전 터미널 출력을 스크롤해서 찾거나 `.dispatcher/history.sqlite`를 직접 쿼리할 필요가 없습니다.

### Failure Artifact

실행 시도가 실패하거나, 타임아웃되거나, 프로세스/파싱 레이어에서 아예 에러가 나면, 전체 상세 정보가 프로젝트 디렉터리의 `.dispatcher/runs/<executionId>/`에 저장됩니다:

```
.dispatcher/runs/<executionId>/
├─ metadata.json   # provider, 명령어, 인자, cwd, exit code, 타이밍
├─ error.json      # DispatcherError(code, message) - 없었으면 생략
├─ stdout.log      # 원본 stdout, 시크릿 마스킹 적용
└─ stderr.log      # 원본 stderr, 시크릿 마스킹 적용
```

이 덕분에 아무것도 다시 실행하지 않고도 실패를 재진단할 수 있습니다: `ai-dispatcher inspect <taskId>`는 실행이 실패했다는 *사실*을 알려주고, 아티팩트 디렉터리는 `diagnostics.logPrompts: true` 없이도 바이트 단위로 *왜* 실패했는지 알려줍니다. task prompt 자체(`stdinContent`)는 audit 로그와 동일한 기본 정책에 따라 여기에도 절대 저장되지 않습니다. `diagnostics.saveFailureArtifacts`(기본 `true`)로 제어되며, 실패한 `TaskResult.rawOutputPath`가 아티팩트를 저장했을 때 그 디렉터리를 가리킵니다. 성공한 실행은 여기에 아무것도 남기지 않습니다.

### `.dispatcher/` 아래에 뭐가 있나

프로젝트를 대상으로 `ai-dispatcher`를 실행하면 그 안에 `.dispatcher/` 디렉터리가 생깁니다: `history.sqlite`(위), `runs/<executionId>/`(Failure Artifact, 위), `project/memory.json`(아래 [Project Memory](#project-memory) 참고). 이 중 커밋할 게 하나도 없습니다 — 그 프로젝트의 `.gitignore`에 `.dispatcher/`를 추가하세요(이 저장소 자신의 `.gitignore`는 dispatcher 자체의 셀프 테스트·도그푸딩용이고, *dispatcher를 적용하는 대상 프로젝트*는 자기 것을 따로 추가해야 합니다).

### Project Memory

`project/memory.ts`는 짧은 결정/요약 스니펫을(전체 소스코드는 절대 저장 안 함) `.dispatcher/project/memory.json`에 저장하고, 현재 작업과의 최신성 + 키워드 중복도로 순위를 매겨(임베딩 없음 — Known Limitations 참고) context builder를 통해 provider에게 전달합니다. **v1.0에서는 디스패치 파이프라인 어디에서도 아직 `remember()`를 호출하지 않습니다** — 읽기 경로(`relevantTo()`)는 모든 작업의 context에 연결돼 있지만, 작업이 끝난 뒤 자동으로 memory 항목을 쓰는 곳은 없습니다. 클래스 자체는 프로그래밍 방식으로 사용 가능하지만(테스트 참고), 기본 상태로는 외부에서 채워주지 않는 한 memory 파일이 비어 있습니다. 숨긴 게 아니라 정직하게 밝히는 갭입니다 — 이걸 메우려면 완료된 작업의 *무엇을* 기억할 가치가 있는지 결정해야 하는데, v1.0 구현 중엔 정하지 않았습니다.

## Config

프로젝트 루트의 `.ai-dispatcher.yml`(또는 `.ai-dispatcher.yaml` — 둘 다 있으면 `.yml`이 우선), 모든 필드는 선택사항입니다(전체 구조와 기본값은 `src/config/schema.ts` 참고):

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
  approval: never                # untrusted | on-request | never (Codex의 -a 플래그)
  maxTaskInputBytes: 8388608     # 8MB - 설명+첨부파일 총 바이트 수, 초과 시 디스패치 전에 거부
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

### 자율 계획과 적응형 실행

일반적인 사용에서 사용자가 provider나 timeout을 지정할 필요가 없습니다. 라우팅 전에 저장소 규모를 제한된 범위에서 측정하고(파일·소스·테스트·패키지 수), 요청 범위를 단일 대상·모듈·저장소 전체로 구분한 다음 구조화된 감독 계획을 만듭니다. 저장소 전체를 확인하고 수정해 달라는 `fix` 요청은 자동으로 `repository-remediation`/`complex`로 분류되어 복합 작업 실행 예산을 받습니다.

`adaptiveTimeout`은 전체 실행 상한과 활동 임대를 분리합니다. stdout/stderr 활동이 감지될 때마다 idle 임대가 갱신되므로, 명령 실행이나 파일 수정을 계속하는 agent가 기존의 고정 5분 제한 때문에 종료되지 않습니다. 출력이 없는 프로세스는 `idleMs` 후 종료하며, 모든 실행에는 별도의 hard 상한이 적용됩니다. `--timeout`은 선택적인 운영자 override로 남고 `maximumMs`를 넘을 수 없습니다.

격리 worktree를 수정한 시도가 timeout에 도달하면 다음 시도는 원래 요청을 처음부터 반복하지 않고 기존 `git status`/`git diff`를 먼저 확인해 이어서 진행합니다. 계획·예산·활동·checkpoint 이벤트는 audit trail에 저장됩니다.

**보안 관련 기본값 — 선언만 하지 않고 이유까지**: `execution.approval: never`는 Codex를 `-a never`로 실행한다는 뜻인데(승인을 절대 묻지 않음), 비대화형 자동화에는 프롬프트에 답할 대상이 없기 때문입니다 — `on-failure`는 Codex 자체에서 deprecated됐고, `untrusted`/`on-request`는 영영 오지 않을 입력을 기다리며 멈춰버립니다. `execution.sandbox: workspace-write`(`danger-full-access`가 아님)는 구현자가 파일을 편집할 수 있는 가장 좁은 모드입니다. 둘 다 조용히 기본값으로 정한 게 아니라 의도적으로 고른 값입니다 — threat model이 더 엄격해야 한다면 config에서 override하세요(순수 분석용 배포라면 `read-only` 등). `safety.autoApply.enabled: false`와 `safety.workspaceIsolation.enabled: true`도 마찬가지로 의도적인 선택입니다 — 이 조합이 `fix`/`implement` 작업의 기본 동작에 정확히 무엇을 의미하는지는 위의 [완전자동 운영](#완전자동-운영-워크스페이스-격리--auto-apply-safety-gate) 참고.

## 개발

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
node dist/cli.js doctor
```

## 알려진 한계

- **Circuit breaker 상태는 프로세스 내 메모리에만 있습니다.** CLI 실행 하나하나가 짧게 끝나기 때문에, 한 실행에서 열린 circuit이 다음 실행에는 보이지 않습니다. 실행 간 영속화(예: SQLite history 활용)는 v1.0 범위 밖입니다.
- **Project memory에는 임베딩/벡터 검색이 없고, 아직 아무도 쓰지 않습니다.** 관련성 순위는 최신성 + 키워드 중복도뿐이고, 읽기 경로는 모든 작업의 context에 완전히 연결돼 있지만 — v1.0 디스패치 파이프라인에 자동 `remember()` 호출이 없어서 외부에서 채우지 않는 한 memory 파일이 비어 있습니다. 위 [Project Memory](#project-memory) 참고.
- **애플리케이션 로그(`logging/logger.ts`, pino)는 최소한으로만 연결돼 있습니다.** `--debug`는 실제로 레벨을 올리고 `cli/commands/dispatch.ts`가 생애주기 이벤트 2개(task 생성, orchestrator 결과)를 남기지만, 파이프라인 대부분(라우팅, 검증, 리뷰, retry/fallback)은 아직 이 로그를 거치지 않습니다 — 지금 실제로 완전한 구조화 기록은 이 로그가 아니라 audit trail(SQLite)과 failure artifact입니다.
- **Codex의 성공 경로 JSONL 이벤트 형태는 실제 출력으로 완전히 검증되지 않았습니다.** 구현 도중 설정된 OpenAI/ChatGPT 계정이 사용량 한도에 걸려서 성공하는 `codex exec --json` 실행을 캡처하지 못했습니다(`docs/fixtures/raw-probes/codex-stderr.log` 참고). 실패 경로 이벤트(`thread.started`, `turn.started`, `error`, `turn.failed`)는 라이브로 검증됐고 엄격하게 검증(validate)합니다. 최종 응답 텍스트는 추측한 성공 경로 JSONL 형태를 파싱하는 대신 Codex의 `--output-last-message` 파일(별도로 문서화된 독립적인 플래그)에서 읽어오기 때문에 정상 동작을 막지는 않지만, 다른 성공 경로 이벤트 타입에 대한 zod 스키마는 실제로 캡처된 샘플이 생기기 전까지 의도적으로 느슨하게(passthrough) 열어뒀습니다.
- **CLI 명령 계층 파일(`cli/commands/*.ts`, `cli/bootstrap.ts`)에는 자동화된 테스트 커버리지가 없습니다.** 다만 구현 중 모든 명령을 실제 설치된 CLI로 end-to-end 라이브 검증했습니다(`doctor`, `providers`, `--dry-run` 라우팅, 실제 `ask` 디스패치, `history`, `usage`를 전부 실행하고 출력을 확인함). 이 얇은 배선 계층의 정식 vitest 커버리지는 시간 제약상 핵심 엔진(라우팅, 검증, 리뷰, 보안) 쪽을 우선하느라 뒤로 미뤘습니다. 모듈별 정확한 커버리지 수치는 최종 구현 보고서를 참고하세요.
- **`node:sqlite`는 Node의 "Experimental" API 등급입니다**(아직 안정 버전 아님). 모든 접근이 `history/db.ts` + `history/repository.ts` 뒤로 격리돼 있어서, 나중에 `better-sqlite3`로 바꾸는 것도(예: 대상 환경에 관리자 권한도 미리 빌드된 바이너리도 없는 경우 — 이 구현이 실제로 맞닥뜨린 바로 그 제약) 파일 2개만 바꾸면 됩니다.
- **CI/`pnpm test:coverage`에 커버리지 임계값 게이트가 없습니다.** 의도적인 선택입니다: 강제 실패하는 임계값은 숫자를 맞추려고 assertion을 약화시키거나 테스트를 건너뛰게 만드는 유인이 되는데, 여기선 명백히 잘못된 트레이드오프이기 때문입니다. 대신 모듈별 실제 퍼센티지를 그대로 보고합니다.
- **`ProviderHealth.reachable`은 독립적인 네트워크 프로브가 아닙니다.** `doctor` 출력에는 `installed`/`authenticated`/`reachable`/`ready`가 별도 필드로 있어서(원칙적으로는 폐쇄망 환경에서 "CLI는 있는데 로그인한 적이 없음"과 "로그인은 됐는데 지금 도달 불가"를 구분할 수 있게 하려는 의도), 지금 구현된 헬스체크에서는 `reachable`이 실제 독립적인 연결성 확인이 아니라 그냥 `authenticated`에서 파생된 값입니다(인증됐으면 `true`, 아니면 `null`) — 불필요한 외부 ping은 안 하지만, 이 필드가 아직 `authenticated`보다 더 많은 정보를 담고 있진 않습니다.
- **`llama.cpp` 지원은 검증되지 않았습니다.** 이 기능을 구현한 머신에는 `llama-server`/`llama-cli` 바이너리가 없어서, `providers/local/llamacpp-runtime.ts`는 공개된 서버 API를 보고 작성했을 뿐 mock 단위 테스트로만 커버되고 실제 통합 실행은 한 번도 거치지 않았습니다. `local.runtimes.llamacpp.enabled`가 기본 `false`인 이유가 바로 이것입니다. 반대로 Ollama는 전 과정을 라이브로 검증했습니다(실제 `/api/tags`, `/api/version`, `/api/generate` 호출을 실제로 실행 중인 인스턴스에 대해 수행 — Ollama가 도달 가능하면 절대 skip되지 않는 `tests/contract/ollama-health.test.ts` 포함).
- **repository lock과 circuit breaker는 같은 한계를 공유합니다: 프로세스 내 메모리에만 있음.** 별도로 실행된 두 번째 `ai-dispatcher` 프로세스와는 조율되지 않습니다 — *한 프로세스 안에서* 동시에 실행되는 코드 변경 작업들이 같은 레포지토리를 두고 경합하는 것만 막아줍니다. 일반적인 일회성 CLI 사용에서는 문제되지 않지만, 이 라이브러리를 감싸는 장수 서버라면 고려해야 합니다.
- **로컬 자율 코딩 품질은 모델 성능에 좌우됩니다.** dispatcher가 안전한 도구와 구조화 출력 제약을 제공해도 작은 모델은 불완전한 수정을 선택할 수 있습니다. 따라서 모든 결과는 클라우드 작업과 동일한 실제 검증·제한된 보정 루프·리뷰·위험도 판정·격리 Auto-Apply gate를 통과합니다. `AI_DISPATCHER_LIVE_LOCAL_CODING=1 pnpm vitest run tests/contract/local-autonomous-coding-live.test.ts`로 CPU 부하가 큰 실제 `qwen3:4b` 임시 파일 수정 계약 테스트를 실행할 수 있으며, 큰 저장소 작업에는 코딩 성능이 충분한 모델과 보수적인 제한값을 권장합니다.
- **Local LLM Adapter + Hardening 증분은 요청받은 ~90개 메커니즘 전체가 아니라, 의도적으로 범위를 좁힌 첫 번째 배치를 다룹니다.** 명시적으로 미룬 것이지 조용히 빠뜨린 게 아닙니다: Model Governance/Qualification(`local qualify`), 우선순위 규칙이 있는 Policy Engine, Data Egress Gateway/Classification, Offline Mode, Restricted Tool Mode, Environment Sanitization, Test-Integrity/anti-gaming 검사, Dependency Change Policy, DB Migration Analyzer, Task Resource Budget, 지금 있는 worktree 폐기 이상의 Crash Recovery/Rollback, Audit Integrity 해시 체이닝, Trust Key Rotation, 서명된 오프라인 번들, 심층 하드웨어/GPU 감지 등 여러 항목이 남아 있습니다(증분 자체의 계획 노트 참고). 이번 배치로 실제 배포된 것 — 로컬 LLM Provider, 워크스페이스 격리, repository lock, base-revision + content-hash TOCTOU 가드, risk classification, Auto-Apply Safety Gate — 는 전부 실제 git 레포지토리와 실제로 실행 중인 Ollama 인스턴스에 대해 end-to-end로 테스트된 진짜 동작이며, 스텁이 아닙니다.
