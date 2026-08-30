import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

interface Config {
  enabled: boolean
  message: string
  delayMs: number
  throttleMs: number
  maxConsecutive: number
  ignoreSubagents: boolean
  errorPatterns: string[]
  excludePatterns: string[]
}

const DEFAULT_ERROR_PATTERNS = [
  "bad request",
  "reasoning_opaque",
  "prefill",
  "reasoning_content",
  "thinking mode and tool_calls",
  "content filter",
  "contentfiltererror",
  "sse read timed out",
  "idle timeout",
  "timeout",
  "contextoverflowerror",
  "too large to compact",
  "econnrefused",
  "econnreset",
  "econnaborted",
  "fetch failed",
  "socket hang up",
  "connection closed",
  "connection error",
  "overloaded",
  "rate limit",
  "unavailable",
  "upstream request failed",
  "server error",
  "bad gateway",
  "gateway timeout",
  "invalid diff",
  "json parsing failed",
  "tool_use ids were found without tool_result",
]

const DEFAULT_EXCLUDE_PATTERNS = [
  "MessageAbortedError",
  "AbortError",
  "operation was aborted",
  "aborted by user",
]

const DEFAULTS: Config = {
  enabled: true,
  message: "continue",
  delayMs: 1000,
  throttleMs: 5000,
  maxConsecutive: 5,
  ignoreSubagents: true,
  errorPatterns: DEFAULT_ERROR_PATTERNS,
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
}

interface SessionState {
  pendingContinue: boolean
  lastErrorTime: number
  lastContinueTime: number
  consecutiveCount: number
}

const CONFIG_FILE = "still-going.json"

function globalConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config")
  return join(xdgConfig, "opencode", CONFIG_FILE)
}

function projectConfigPath(directory: string): string {
  return join(directory, ".opencode", CONFIG_FILE)
}

async function readConfigFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function applyParsed(config: Config, parsed: Record<string, unknown>) {
  if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled
  if (typeof parsed.message === "string") config.message = parsed.message
  if (typeof parsed.delayMs === "number") config.delayMs = parsed.delayMs
  if (typeof parsed.throttleMs === "number") config.throttleMs = parsed.throttleMs
  if (typeof parsed.maxConsecutive === "number") config.maxConsecutive = parsed.maxConsecutive
  if (typeof parsed.ignoreSubagents === "boolean") config.ignoreSubagents = parsed.ignoreSubagents
  if (Array.isArray(parsed.errorPatterns)) {
    config.errorPatterns = parsed.errorPatterns.filter((p): p is string => typeof p === "string")
  }
  if (Array.isArray(parsed.excludePatterns)) {
    config.excludePatterns = parsed.excludePatterns.filter((p): p is string => typeof p === "string")
  }
}

async function loadConfig(directory: string): Promise<Config> {
  const config: Config = { ...DEFAULTS }
  const global = await readConfigFile(globalConfigPath())
  if (global) applyParsed(config, global)
  const project = await readConfigFile(projectConfigPath(directory))
  if (project) applyParsed(config, project)
  return config
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return ""
  const err = error as Record<string, unknown>
  const data = err.data as Record<string, unknown> | undefined
  const message =
    (typeof data?.message === "string" && data.message) ||
    (typeof err.message === "string" && err.message) ||
    ""
  return `${String(err.name ?? "")}: ${message}`.toLowerCase()
}

function isRetryableError(error: unknown, config: Config): boolean {
  const text = errorText(error)
  if (!text) return false
  for (const pattern of config.excludePatterns) {
    if (text.includes(pattern.toLowerCase())) return false
  }
  const err = error as Record<string, unknown>
  const data = err.data as Record<string, unknown> | undefined
  if (data?.isRetryable === true) return true
  if (typeof data?.statusCode === "number") {
    const code = data.statusCode
    if (code === 408 || code === 429 || code >= 500) return true
  }
  for (const pattern of config.errorPatterns) {
    if (text.includes(pattern.toLowerCase())) return true
  }
  return false
}

const plugin: Plugin = async ({ client, directory }) => {
  const config = await loadConfig(directory)
  await client.app
    .log({
      body: {
        service: "still-going",
        level: "info",
        message: `loaded (enabled=${config.enabled}, delay=${config.delayMs}ms, throttle=${config.throttleMs}ms, max=${config.maxConsecutive}, message="${config.message}")`,
      },
    })
    .catch(() => {})
  const sessions = new Map<string, SessionState>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function getState(sessionID: string): SessionState {
    let state = sessions.get(sessionID)
    if (!state) {
      state = {
        pendingContinue: false,
        lastErrorTime: 0,
        lastContinueTime: 0,
        consecutiveCount: 0,
      }
      sessions.set(sessionID, state)
    }
    return state
  }

  function resetState(sessionID: string) {
    sessions.delete(sessionID)
    const timer = timers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      timers.delete(sessionID)
    }
  }

  async function isBusy(sessionID: string): Promise<boolean> {
    try {
      const res = (await client.session.status()) as any
      const status = res?.data?.[sessionID] ?? res?.[sessionID]
      const type = status?.type ?? status?.status
      return type === "busy" || type === "retry"
    } catch {
      return false
    }
  }

  async function isSubagent(sessionID: string): Promise<boolean> {
    if (!config.ignoreSubagents) return false
    try {
      const res = (await client.session.get({ path: { id: sessionID } })) as any
      const info = res?.data ?? res
      return Boolean(info?.parentID)
    } catch {
      return false
    }
  }

  async function getStatus(sessionID: string): Promise<string> {
    try {
      const res = (await client.session.status()) as any
      const status = res?.data?.[sessionID] ?? res?.[sessionID]
      return String(status?.type ?? status?.status ?? "unknown")
    } catch {
      return "unknown"
    }
  }

  async function lastMessageHasError(sessionID: string): Promise<boolean | null> {
    try {
      const res = (await client.session.messages({
        path: { id: sessionID },
        query: { limit: 1 },
      })) as any
      const messages = res?.data ?? res
      const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined
      const info = last?.info ?? last
      if (!info) return null
      return info.role === "assistant" && Boolean(info.error)
    } catch {
      return null
    }
  }

  function log(level: "debug" | "info" | "warn" | "error", message: string) {
    return client.app
      .log({ body: { service: "still-going", level, message } })
      .catch(() => {})
  }

  async function sendContinue(sessionID: string) {
    const state = sessions.get(sessionID)
    if (!state?.pendingContinue) return

    const now = Date.now()
    if (now - state.lastContinueTime < config.throttleMs) return

    if (config.maxConsecutive > 0 && state.consecutiveCount >= config.maxConsecutive) {
      state.pendingContinue = false
      await log("warn", `max consecutive (${config.maxConsecutive}) reached for ${sessionID}, giving up`)
      return
    }

    if (await isBusy(sessionID)) {
      await log("debug", `skip send ${sessionID}: busy`)
      return
    }

    const hasError = await lastMessageHasError(sessionID)
    if (hasError === false) {
      await log("debug", `skip send ${sessionID}: last message has no error (stale pending), resetting`)
      resetState(sessionID)
      return
    }

    if (await isSubagent(sessionID)) {
      state.pendingContinue = false
      return
    }

    state.lastContinueTime = now
    state.consecutiveCount++
    state.pendingContinue = false

    await log(
      "info",
      `sending "${config.message}" to ${sessionID} (attempt ${state.consecutiveCount}/${config.maxConsecutive > 0 ? config.maxConsecutive : "\u221e"})`,
    )

    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: config.message }],
        },
      })
      await log("info", `sent "${config.message}" to ${sessionID}`)
      setTimeout(async () => {
        const status = await getStatus(sessionID)
        await log("debug", `post-send check ${sessionID}: status=${status}`)
        if (status === "idle") {
          await log("warn", `possible dropped generation: ${sessionID} still idle after send`)
        }
      }, 4000)
    } catch (err) {
      await log("error", `failed to send continue to ${sessionID}: ${err}`)
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.error") {
        const { sessionID, error } = event.properties ?? {}
        if (!sessionID || !config.enabled) return
        await log("debug", `event session.error ${sessionID}: ${errorText(error).slice(0, 150)}`)
        if (isRetryableError(error, config)) {
          const state = getState(sessionID)
          state.lastErrorTime = Date.now()
          state.pendingContinue = true
          await log("info", `retryable error in ${sessionID}: ${errorText(error).slice(0, 200)}`)
        }
        return
      }

      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID
        if (!sessionID || !config.enabled) return

        const state = sessions.get(sessionID)
        await log("debug", `event session.idle ${sessionID}: pending=${Boolean(state?.pendingContinue)}`)
        if (!state?.pendingContinue) {
          resetState(sessionID)
          return
        }

        const existing = timers.get(sessionID)
        if (existing) clearTimeout(existing)

        timers.set(
          sessionID,
          setTimeout(() => {
            timers.delete(sessionID)
            sendContinue(sessionID).catch(() => {})
          }, config.delayMs),
        )
        return
      }

      if (event.type === "session.deleted") {
        const sessionID = event.properties?.info?.id ?? event.properties?.sessionID
        if (sessionID) resetState(sessionID)
        return
      }

      if (event.type === "message.updated") {
        const info = event.properties?.info
        if (!info?.sessionID || info.role !== "assistant") return

        if (isRetryableError(info.error, config)) {
          const state = getState(info.sessionID)
          state.pendingContinue = true
          state.lastErrorTime = Date.now()
          return
        }

        if (info.finish && !info.error) {
          resetState(info.sessionID)
        }
      }
    },
  }
}

export default plugin
