import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import os from "node:os";
import plugin from "../index.js";

const NOW = 1_800_000_000_000;
const claude = { providerID: "anthropic", id: "claude-sonnet-4-6" };
const gpt = { providerID: "openai", id: "gpt-6-astra" };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function setup(t, { config, platform = "darwin", release = "", get, fail = () => false } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  t.mock.method(os, "platform", () => platform);
  t.mock.method(os, "release", () => release);
  const calls = [];
  const logs = [];
  t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(fail(command) ? new Error("not available") : null);
  });
  const hooks = await plugin({
    directory: "/projects/example",
    client: {
      session: { get: get || (async ({ path }) => ({ data: { id: path.id, title: "Resumed" } })) },
      app: { log: async ({ body }) => { logs.push(body.message); } },
    },
  }, config);
  t.after(() => hooks.dispose?.());
  const event = (type, properties) => hooks.event({ event: { type, properties } });
  const create = (id = "root", parentID) => event("session.created", { info: { id, parentID, title: id } });
  const status = (type, id = "root") => event("session.status", { sessionID: id, status: { type } });
  const start = async (model = claude, id = "root", messageID = "message", agent = "build") => {
    await event("message.updated", { info: {
      id: messageID, sessionID: id, role: "assistant", modelID: model.id,
      agent, time: { created: Date.now() },
    } });
    await hooks["chat.headers"]({ sessionID: id, model, agent }, { headers: {} });
  };
  const complete = (model = claude, id = "root", messageID = "message", extra = {}) =>
    event("message.updated", { info: {
      id: messageID, sessionID: id, role: "assistant", modelID: model.id,
      time: { created: NOW, completed: Date.now() }, tokens: { cache: { read: 100, write: 0 } },
      ...extra,
    } });
  const finish = async (...args) => { await complete(...args); await status("idle", args[1]); };
  const advance = async (ms) => { t.mock.timers.tick(ms); await flush(); };
  return { hooks, calls, logs, event, create, status, start, complete, finish, advance };
}

test("Claude warns from request start, once, not from response completion", async (t) => {
  const s = await setup(t);
  await s.create();
  await s.start();
  await s.advance(120_000);
  await s.finish();
  await s.advance(59_999);
  assert.equal(s.calls.length, 0);
  await s.advance(1);
  assert.deepEqual(s.calls.map((c) => c.command), ["osascript", "afplay"]);
  assert.equal(s.calls[0].args.at(-2), "CacheBell - example");
  assert.match(s.calls[0].args.at(-1), /~2m 0s/);
  await s.complete();
  await s.status("idle");
  await s.advance(500_000);
  assert.equal(s.calls.length, 2);
});

test("modern OpenAI uses a 28-minute warning", async (t) => {
  const s = await setup(t);
  await s.create();
  await s.start(gpt);
  await s.finish(gpt);
  await s.advance(1_679_999);
  assert.equal(s.calls.length, 0);
  await s.advance(1);
  assert.equal(s.calls.length, 2);
});

test("each tool-loop request replaces the deadline; tools and status do not refresh it", async (t) => {
  const s = await setup(t);
  await s.create();
  await s.start();
  await s.complete();
  await s.advance(120_000);
  await s.start(claude, "root", "next");
  await s.advance(120_000);
  await s.finish(claude, "root", "next");
  await s.advance(59_999);
  assert.equal(s.calls.length, 0);
  await s.advance(1);
  assert.equal(s.calls.length, 2);
});

test("busy defers warning and idle reports actual remaining time", async (t) => {
  const s = await setup(t);
  await s.create();
  await s.start();
  await s.advance(240_000);
  assert.equal(s.calls.length, 0);
  await s.finish();
  assert.match(s.calls[0].args.at(-1), /~1m 0s/);
});

test("expired responses and sleep past expiry never ring", async (t) => {
  const s = await setup(t);
  await s.create();
  await s.start();
  await s.advance(360_000);
  await s.finish();
  await s.start(claude, "root", "next");
  await s.finish(claude, "root", "next");
  await s.advance(360_000);
  assert.equal(s.calls.length, 0);
});

test("real busy without a conversational request suppresses alerts until idle", async (t) => {
  const s = await setup(t);
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(170_000);
  await s.status("busy");
  await s.advance(60_000);
  assert.equal(s.calls.length, 0);
  await s.status("idle");
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[0].args.at(-1), /~1m 10s/);
});

test("compaction does not refresh the timer or let alerts through while busy", async (t) => {
  const s = await setup(t);
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(170_000);
  await s.status("busy");
  await s.hooks["chat.headers"]({ sessionID: "root", model: gpt, agent: "compaction" });
  await s.advance(180_000);
  await s.status("idle");
  assert.equal(s.calls.length, 0);
});

test("subagents and title requests do not change the root model or deadline", async (t) => {
  const s = await setup(t);
  await s.create();
  await s.create("child", "root");
  await s.start(gpt);
  await s.finish(gpt);
  await s.advance(60_000);
  await s.start(claude, "child");
  await s.finish(claude, "child");
  await s.hooks["chat.headers"]({ sessionID: "root", model: claude, agent: "title" });
  await s.advance(180_000);
  assert.equal(s.calls.length, 0);
  await s.advance(1_440_000);
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[0].args.at(-1), /gpt-6-astra/);
});

test("resumed roots are resolved without blocking requests, unknown ancestry stays silent", async (t) => {
  const s = await setup(t, { get: async ({ path }) => {
    if (path.id === "unknown") throw new Error("offline");
    return { data: { id: path.id, parentID: path.id === "child" ? "root" : undefined } };
  } });
  for (const id of ["root", "child", "unknown"]) {
    await s.start(claude, id);
    await s.finish(claude, id);
  }
  await flush();
  await s.advance(180_000);
  assert.equal(s.calls.length, 2);
});

test("failed/uncached requests and retry backoff do not arm warnings", async (t) => {
  const s = await setup(t);
  for (const id of ["error", "uncached", "retry"]) {
    await s.create(id);
    await s.start(claude, id);
  }
  await s.finish(claude, "error", "message", { error: { name: "APIError" } });
  await s.finish(claude, "uncached", "message", { tokens: { cache: { read: 0, write: 0 } } });
  await s.status("retry", "retry");
  await s.advance(180_000);
  assert.equal(s.calls.length, 0);
});

test("model switches replace timers; aliases use API ids; overrides take precedence", async (t) => {
  const s = await setup(t, { config: { ttlSeconds: { "proxy/my-model": 600 } } });
  await s.create();
  await s.start(claude);
  await s.finish(claude);
  await s.advance(60_000);
  const model = { providerID: "proxy", id: "my-model", api: { id: "claude-opus-5" } };
  await s.start(model, "root", "next");
  await s.finish(model, "root", "next");
  await s.advance(479_999);
  assert.equal(s.calls.length, 0);
  await s.advance(1);
  assert.equal(s.calls.length, 2);
});

test("unknown/older models are skipped unless explicitly configured", async (t) => {
  const s = await setup(t, { config: { ttlSeconds: { "openai/gpt-5.4": 1800 } } });
  for (const id of ["gpt-5.4", "gpt-5.5", "llama-4"]) {
    const model = { providerID: "openai", id };
    await s.create(id);
    await s.start(model, id);
    await s.finish(model, id);
  }
  await s.advance(1_680_000);
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[0].args.at(-1), /gpt-5.4/);
});

test("deletion and disposal cancel timers and ignore late lookups", async (t) => {
  let resolve;
  const s = await setup(t, { get: () => new Promise((r) => { resolve = r; }) });
  await s.start();
  await s.finish();
  await s.event("session.deleted", { info: { id: "root" } });
  resolve({ data: { id: "root" } });
  await flush();
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(180_000);
  assert.equal(s.calls.length, 0);
  await s.create("second");
  await s.start(claude, "second");
  await s.finish(claude, "second");
  await s.hooks.dispose();
  await s.advance(180_000);
  assert.equal(s.calls.length, 0);
});

test("WSL uses encoded Windows PowerShell, falling back when PATH omits it", async (t) => {
  const s = await setup(t, { platform: "linux", release: "6.6.87.2-microsoft-standard-WSL2",
    fail: (command) => command === "powershell.exe" });
  await s.create();
  await s.event("session.updated", { info: { id: "root", title: "Quotes ' ; $(bad)\nUnicode: 日本語" } });
  await s.start();
  await s.finish();
  await s.advance(180_000);
  assert.deepEqual(s.calls.map((c) => c.command), ["powershell.exe",
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"]);
  const script = Buffer.from(s.calls[0].args.at(-1), "base64").toString("utf16le");
  assert.match(script, /SystemSounds/);
  assert.match(script, /ShowBalloonTip/);
  assert.ok(!script.includes("$(bad)"));
  const data = JSON.parse(Buffer.from(script.match(/FromBase64String\('([^']+)'/)[1], "base64").toString());
  assert.match(data.message, /日本語/);
  assert.equal(s.calls[0].options.windowsHide, true);
});

test("native Windows uses PowerShell and honors sound-only configuration", async (t) => {
  const s = await setup(t, { platform: "win32", config: { notification: false } });
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(180_000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].command, "powershell.exe");
  const script = Buffer.from(s.calls[0].args.at(-1), "base64").toString("utf16le");
  assert.match(script, /SystemSounds/);
  assert.doesNotMatch(script, /ShowBalloonTip/);
});

test("notification failures are logged, never retried or thrown into OpenCode", async (t) => {
  const s = await setup(t, { fail: () => true });
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(180_000);
  assert.equal(s.logs.length, 1);
  await s.status("idle");
  assert.equal(s.calls.length, 2);
});

test("invalid options disable the plugin without breaking OpenCode", async (t) => {
  const s = await setup(t, { config: { warningSeconds: -1 } });
  assert.deepEqual(s.hooks, {});
  assert.equal(s.logs.length, 1);
});
