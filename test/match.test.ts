import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CONFIG_DIR = mkdtempSync(join(tmpdir(), "still-going-test-"))
mkdirSync(join(CONFIG_DIR, "opencode"), { recursive: true })
writeFileSync(
  join(CONFIG_DIR, "opencode", "still-going.json"),
  JSON.stringify({ delayMs: 30, throttleMs: 100, maxConsecutive: 2 }),
)
process.env.XDG_CONFIG_HOME = CONFIG_DIR

const { default: createPlugin } = await import("../src/index.ts")

const REAL_503_ERROR = {
  name: "APIError",
  data: {
    message: "Error from provider (Console Go): Upstream request failed: Endpoint is unavailable.",
    statusCode: 503,
    isRetryable: true,
  },
}

const REASONING_CONTENT_ERROR = {
  name: "APIError",
  data: {
    message: "If thinking mode and tool_calls, reasoning_content must be passed back to the API.",
    statusCode: 400,
    isRetryable: false,
  },
}

const CONTENT_FILTER_ERROR = {
  name: "ContentFilterError",
  data: {
    message: "The response was blocked by the provider's content filter",
  },
}

const ABORT_ERROR = { name: "MessageAbortedError", data: { message: "The operation was aborted" } }

function makeClient(sessionID: string, opts: { busy?: boolean; parentID?: string | null; lastMessageError?: boolean } = {}) {
  const prompts: any[] = []
  return {
    prompts,
    client: {
      app: { log: async () => {} },
      session: {
        status: async () => ({ data: { [sessionID]: { type: opts.busy ? "busy" : "idle" } } }),
        get: async () => ({ data: { id: sessionID, parentID: opts.parentID ?? null } }),
        messages: async () => ({
          data: [
            {
              info: {
                sessionID,
                role: "assistant",
                ...(opts.lastMessageError === false ? {} : { error: REAL_503_ERROR }),
              },
            },
          ],
        }),
        promptAsync: async (o: any) => {
          prompts.push(o)
        },
      },
    },
  }
}

async function fire(hook: any, type: string, properties: unknown) {
  await hook.event({ event: { type, properties } })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failed = 0
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}: ${err}`)
  }
}

await test("real 503 error -> sends continue once", async () => {
  const sid = "ses_a"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].path.id, sid)
  assert.equal(prompts[0].body.parts[0].text, "continue")
})

await test("manual abort -> never sends", async () => {
  const sid = "ses_b"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "session.error", { sessionID: sid, error: ABORT_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 0)
})

await test("natural idle without error -> never sends", async () => {
  const sid = "ses_c"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 0)
})

await test("max consecutive reached -> stops sending", async () => {
  const sid = "ses_d"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  for (let i = 0; i < 4; i++) {
    await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
    await fire(hook, "session.idle", { sessionID: sid })
    await wait(200)
  }
  assert.ok(prompts.length <= 2, `expected at most 2 prompts, got ${prompts.length}`)
})

await test("subagent session -> skipped", async () => {
  const sid = "ses_e"
  const { client, prompts } = makeClient(sid, { parentID: "ses_parent" })
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 0)
})

await test("session busy again after delay -> skipped", async () => {
  const sid = "ses_f"
  const { client, prompts } = makeClient(sid, { busy: true })
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 0)
})

await test("assistant message error also marks pending", async () => {
  const sid = "ses_g"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "message.updated", {
    info: { sessionID: sid, role: "assistant", error: REAL_503_ERROR },
  })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 1)
})

await test("counter resets after natural idle -> can continue again", async () => {
  const sid = "ses_h"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  for (let i = 0; i < 2; i++) {
    await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
    await fire(hook, "session.idle", { sessionID: sid })
    await wait(200)
  }
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(100)
  await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(200)
  assert.equal(prompts.length, 3)
})

await test("stale pending from recovered transient error -> NOT sent after successful finish", async () => {
  const sid = "ses_i"
  const { client, prompts } = makeClient(sid, { busy: true })
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 0)
  await fire(hook, "message.updated", { info: { sessionID: sid, role: "assistant", finish: "stop" } })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 0)
})

await test("real error after a successful turn -> still sent", async () => {
  const sid = "ses_j"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "message.updated", { info: { sessionID: sid, role: "assistant", finish: "stop" } })
  await wait(150)
  await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 1)
})

await test("reasoning_content tool_calls 400 error (aggregate provider) -> sent", async () => {
  const sid = "ses_k"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "session.error", { sessionID: sid, error: REASONING_CONTENT_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 1)
})

await test("stale pending but last message has NO error -> NOT sent (authoritative check)", async () => {
  const sid = "ses_l"
  const { client, prompts } = makeClient(sid, { lastMessageError: false })
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 0)
})

await test("content filter error (aggregate provider false positive) -> sent", async () => {
  const sid = "ses_m"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "session.error", { sessionID: sid, error: CONTENT_FILTER_ERROR })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 1)
})

await test("content filter error on message with finish:content-filter -> sent, not reset", async () => {
  const sid = "ses_n"
  const { client, prompts } = makeClient(sid)
  const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
  await fire(hook, "message.updated", {
    info: { sessionID: sid, role: "assistant", finish: "content-filter", error: CONTENT_FILTER_ERROR },
  })
  await fire(hook, "session.idle", { sessionID: sid })
  await wait(300)
  assert.equal(prompts.length, 1)
})

await test("auto-creates global config with defaults when missing, then works", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "still-going-fresh-"))
  process.env.XDG_CONFIG_HOME = fresh
  try {
    const sid = "ses_o"
    const { client, prompts } = makeClient(sid)
    const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
    const created = join(fresh, "opencode", "still-going.json")
    assert.equal(existsSync(created), true)
    const parsed = JSON.parse(readFileSync(created, "utf-8"))
    assert.equal(parsed.enabled, true)
    assert.equal(parsed.delayMs, 1000)
    await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
    await fire(hook, "session.idle", { sessionID: sid })
    await wait(1600)
    assert.equal(prompts.length, 1)
  } finally {
    process.env.XDG_CONFIG_HOME = CONFIG_DIR
  }
})

await test("BOM-prefixed config file is still parsed (delay respected)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "still-going-bom-"))
  mkdirSync(join(dir, "opencode"), { recursive: true })
  writeFileSync(
    join(dir, "opencode", "still-going.json"),
    "\uFEFF" + JSON.stringify({ delayMs: 2000 }, null, 2),
  )
  process.env.XDG_CONFIG_HOME = dir
  try {
    const sid = "ses_p"
    const { client, prompts } = makeClient(sid)
    const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
    await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
    await fire(hook, "session.idle", { sessionID: sid })
    await wait(1500)
    assert.equal(prompts.length, 0, "default 1000ms would have fired by now; BOM must not break parsing")
    await wait(1000)
    assert.equal(prompts.length, 1)
  } finally {
    process.env.XDG_CONFIG_HOME = CONFIG_DIR
  }
})

await test("invalid JSON config -> defaults used, no crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "still-going-invalid-"))
  mkdirSync(join(dir, "opencode"), { recursive: true })
  writeFileSync(join(dir, "opencode", "still-going.json"), "0{\"enabled\": true,}")
  process.env.XDG_CONFIG_HOME = dir
  try {
    const sid = "ses_q"
    const { client, prompts } = makeClient(sid)
    const hook = await createPlugin({ client, directory: CONFIG_DIR } as any)
    await fire(hook, "session.error", { sessionID: sid, error: REAL_503_ERROR })
    await fire(hook, "session.idle", { sessionID: sid })
    await wait(1600)
    assert.equal(prompts.length, 1)
  } finally {
    process.env.XDG_CONFIG_HOME = CONFIG_DIR
  }
})

await test("module exports satisfy opencode loader (functions or {server} only)", async () => {
  const mod = (await import("../src/index.ts")) as Record<string, unknown>
  for (const [name, entry] of Object.entries(mod)) {
    const ok =
      typeof entry === "function" ||
      (entry && typeof entry === "object" && "server" in (entry as object))
    assert.ok(ok, `export "${name}" would make opencode throw "Plugin export is not a function"`)
  }
})

console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
