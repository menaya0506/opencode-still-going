# opencode-still-going

An [OpenCode](https://opencode.ai) plugin that automatically sends a `"continue"` prompt when the model stops because repeated retries were exhausted — so long-running tasks keep moving without you babysitting the session.

It **never** fires in two cases:

- **Natural completion** — the assistant finished its answer normally.
- **Manual abort** — you pressed `Esc` / clicked stop.

## Why

OpenCode already retries transient provider errors (timeouts, overloaded responses, dropped connections, etc.) internally. But when every retry fails, the session just stops and waits for you to type something. This plugin detects that exact moment — *retries exhausted → session idle* — and resumes it for you.

| Situation | Detected via | Action |
| --- | --- | --- |
| Stopped after retryable errors | `session.error` / assistant message error | sends `"continue"` after 1s |
| You aborted manually | `MessageAbortedError`, `AbortError`, … | ignored (exclude list wins) |
| Assistant finished normally | `session.idle` with no pending error | ignored |

## Features

- Zero runtime dependencies — one TypeScript file.
- Three-layer error detection:
  1. **Exclude patterns first** (manual aborts can never trigger a resume)
  2. **Structured fields** — OpenCode's own `isRetryable: true` flag, or HTTP `statusCode` 408/429/5xx
  3. **Case-insensitive substring patterns** as a fallback
- Re-verifies session status right before sending (closes the race window between error and idle events).
- Per-session throttle plus a consecutive-attempt cap to prevent infinite loops.
- Subagent sessions are skipped by default (`ignoreSubagents`).
- Runs inside the OpenCode server core, so it works identically in the **TUI, desktop app, and IDE extensions**.
- All logging goes through `client.app.log()` — no console noise.

## Install

### Option A — single file

Copy [`src/index.ts`](./src/index.ts) into your plugins directory:

```bash
# global (all projects)
~/.config/opencode/plugins/still-going.ts

# or project-level
<your-project>/.opencode/plugins/still-going.ts
```

Restart OpenCode. Done.

### Option B — npm

```jsonc
// opencode.json
{
  "plugin": ["opencode-still-going"]
}
```

## Configuration

Optional. Two locations are supported — the project file overrides the global file, which overrides the defaults:

```bash
# global (all projects)
~/.config/opencode/still-going.json

# project-level (overrides global)
<your-project>/.opencode/still-going.json
```

```json
{
  "enabled": true,
  "message": "continue",
  "delayMs": 1000,
  "throttleMs": 5000,
  "maxConsecutive": 5,
  "ignoreSubagents": true
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Enable/disable without removing the plugin |
| `message` | `string` | `"continue"` | The text injected as a user message |
| `delayMs` | `number` | `1000` | Delay after `session.idle` before sending |
| `throttleMs` | `number` | `5000` | Minimum ms between auto-continues per session |
| `maxConsecutive` | `number` | `5` | Max consecutive auto-continues before giving up (`0` = unlimited) |
| `ignoreSubagents` | `boolean` | `true` | Skip child/subagent sessions |
| `errorPatterns` | `string[]` | see below | Substrings that mark an error as resumable |
| `excludePatterns` | `string[]` | see below | Substrings that **never** resume (checked first) |

Setting `errorPatterns` or `excludePatterns` replaces the entire default list.

### Default match patterns

```
bad request · reasoning_opaque · prefill · sse read timed out · idle timeout ·
timeout · contextoverflowerror · too large to compact · econnrefused · econnreset ·
econnaborted · fetch failed · socket hang up · connection closed · connection error ·
overloaded · rate limit · unavailable · upstream request failed · server error ·
bad gateway · gateway timeout · invalid diff · json parsing failed ·
tool_use ids were found without tool_result
```

### Default exclude patterns

```
MessageAbortedError · AbortError · operation was aborted · aborted by user
```

## How it works

```
session.error ────► exclude check ────► isRetryable flag / HTTP 408·429·5xx /
message.updated                      substring pattern ────► mark session pending
(assistant error) ──────────────────────────────────────►

session.idle ────► pending? ──no──► reset counter, do nothing
                     │yes
                     ▼
               wait delayMs (1s)
                     ▼
         status still busy/retry? ──yes──► skip
                     │no
           subagent session? ──yes──► skip
                     │no
         throttle ok && under max? ──no──► give up (until next natural end)
                     │yes
                     ▼
         client.session.promptAsync("continue")
```

The consecutive counter resets whenever a session goes idle without a pending error (i.e. a successful turn), so normal usage never accumulates toward the cap.

## Development

```bash
git clone <repo-url>
cd opencode-still-going
npm install
npm run typecheck
npm test
```

This repository doubles as a live dev environment: the `.opencode/plugins/` shim loads `src/index.ts` automatically when you start OpenCode here.

> **Note:** OpenCode treats *every* module export as a plugin factory — export only functions (or `{ server }` objects). Exporting anything else (e.g. a plain config object) makes the loader fail with `Plugin export is not a function`. The loader-compatibility test in `npm test` guards against this.

## Related

- [opencode-auto-resume](https://github.com/Mte90/opencode-auto-resume) — broader stall/stuck detection
- [OpenCode plugin docs](https://opencode.ai/docs/plugins/)

## Buy Me a Coffee

If still-going saves you from babysitting stuck sessions, feel free to send some coffee money:

**ETH (EVM)**: `0xAe42D0d8a25530fCb99B906f42a0eE6DF1830EA9`

## License

[MIT](./LICENSE)
