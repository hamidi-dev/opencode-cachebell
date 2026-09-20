import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import os from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "../index.js";

const NOW = 1_800_000_000_000;
const claude = { providerID: "anthropic", id: "claude-sonnet-4-6" };
const gpt = { providerID: "openai", id: "gpt-6-astra" };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function setup(t, { config, platform = "darwin", release = "", get,
    fail = () => false, failureCode = "ENOENT" } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  t.mock.method(os, "platform", () => platform);
  t.mock.method(os, "release", () => release);
  const calls = [];
  const logs = [];
  t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(fail(command) ? Object.assign(new Error("not available"), { code: failureCode }) : null,
      command === "wslpath" ? "\\\\wsl.localhost\\Ubuntu\\home\\User Name\\sounds\\pulse.wav\n" : "");
  });
  const hooks = await plugin.server({
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
  assert.equal(s.calls[1].args[0], fileURLToPath(new URL("../sounds/pulse.wav", import.meta.url)));
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
  assert.deepEqual(s.calls.map((c) => c.command), ["wslpath", "powershell.exe",
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"]);
  assert.equal(s.calls[0].args[0], "-w");
  assert.equal(s.calls[0].args[1], fileURLToPath(new URL("../sounds/pulse.wav", import.meta.url)));
  const script = Buffer.from(s.calls[1].args.at(-1), "base64").toString("utf16le");
  assert.match(script, /SoundPlayer/);
  assert.match(script, /PlaySync/);
  assert.match(script, /ShowBalloonTip/);
  assert.ok(!script.includes("$(bad)"));
  const data = JSON.parse(Buffer.from(script.match(/FromBase64String\('([^']+)'/)[1], "base64").toString());
  assert.match(data.message, /日本語/);
  assert.equal(data.soundFile, "\\\\wsl.localhost\\Ubuntu\\home\\User Name\\sounds\\pulse.wav");
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
  assert.match(script, /SoundPlayer/);
  assert.match(script, /PlaySync/);
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

for (const sound of ["pulse", "chime", "knock", true, false]) {
  test(`macOS sound selection: ${sound}`, async (t) => {
    const s = await setup(t, { config: { sound } });
    await s.create();
    await s.start();
    await s.finish();
    await s.advance(180_000);
    assert.equal(s.calls[0].command, "osascript");
    if (sound === false) {
      assert.equal(s.calls.length, 1);
    } else {
      assert.equal(s.calls[1].command, "afplay");
      assert.equal(s.calls[1].args[0], fileURLToPath(new URL(
        `../sounds/${sound === true ? "pulse" : sound}.wav`, import.meta.url,
      )));
    }
  });
}

test("invalid sound names and path traversal disable the plugin", async (t) => {
  const s = await setup(t, { config: { sound: "../../other" } });
  assert.deepEqual(s.hooks, {});
  assert.equal(s.logs.length, 1);
  assert.equal(s.calls.length, 0);
});

test("Linux plays the selected bundled WAV", async (t) => {
  const s = await setup(t, { platform: "linux", config: { sound: "knock" } });
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(180_000);
  assert.equal(s.calls[1].command, "canberra-gtk-play");
  assert.deepEqual(s.calls[1].args, ["-f", fileURLToPath(new URL("../sounds/knock.wav", import.meta.url))]);
});

test("Windows passes the chosen bundled sound as data, not executable code", async (t) => {
  const s = await setup(t, { platform: "win32", config: { sound: "chime" } });
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(180_000);
  const script = Buffer.from(s.calls[0].args.at(-1), "base64").toString("utf16le");
  const data = JSON.parse(Buffer.from(script.match(/FromBase64String\('([^']+)'/)[1], "base64").toString());
  assert.equal(data.soundFile, fileURLToPath(new URL("../sounds/chime.wav", import.meta.url)));
  assert.doesNotMatch(script, /chime\.wav/);
  assert.match(script, /catch \{ \$soundFailed = \$true \}/);
});

test("WSL path translation failure still delivers a notification and logs failed sound", async (t) => {
  const s = await setup(t, { platform: "linux", release: "microsoft",
    fail: (command) => command === "wslpath" });
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(180_000);
  assert.deepEqual(s.calls.map((c) => c.command), ["wslpath", "powershell.exe"]);
  const script = Buffer.from(s.calls[1].args.at(-1), "base64").toString("utf16le");
  assert.match(script, /ShowBalloonTip/);
  assert.doesNotMatch(script, /SoundPlayer/);
  assert.equal(s.logs.length, 1);
});

test("WSL sound off needs no path translation", async (t) => {
  const s = await setup(t, { platform: "linux", release: "microsoft", config: { sound: false } });
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(180_000);
  assert.deepEqual(s.calls.map((c) => c.command), ["powershell.exe"]);
  const script = Buffer.from(s.calls[0].args.at(-1), "base64").toString("utf16le");
  assert.doesNotMatch(script, /SoundPlayer/);
});

test("PowerShell runtime failures do not retry and duplicate notifications", async (t) => {
  const s = await setup(t, { platform: "linux", release: "microsoft",
    fail: (command) => command === "powershell.exe", failureCode: 1 });
  await s.create();
  await s.start();
  await s.finish();
  await s.advance(180_000);
  assert.deepEqual(s.calls.map((c) => c.command), ["wslpath", "powershell.exe"]);
  assert.equal(s.logs.length, 1);
});

test("bundled sounds are short, non-clipping PCM WAVs usable by Windows SoundPlayer", () => {
  for (const sound of ["pulse", "chime", "knock"]) {
    const wav = readFileSync(new URL(`../sounds/${sound}.wav`, import.meta.url));
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
    assert.equal(wav.readUInt32LE(16), 16);
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.toString("ascii", 36, 40), "data");
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.ok((wav.length - 44) / 88200 <= 1);
    let peak = 0;
    for (let offset = 44; offset < wav.length; offset += 2) {
      peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
    }
    assert.ok(peak > 1000 && peak < 20000);
  }
});

// --- OpenCode 2 ------------------------------------------------------------
//
// The same state machine, driven through the version 2 surface: a model.request
// hook instead of chat.headers, an event stream instead of an event hook, and a
// session lookup that also reports which directory a session belongs to.

function stream() {
  const queued = [];
  let waiting;
  return {
    push(event) {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ value: event, done: false });
        return;
      }
      queued.push(event);
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => queued.length
          ? Promise.resolve({ value: queued.shift(), done: false })
          : new Promise((resolve) => { waiting = resolve; }),
        return: () => Promise.resolve({ value: undefined, done: true }),
      }),
    },
  };
}

async function setupV2(t, { config, directory = "/projects/example", get } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  t.mock.method(os, "platform", () => "darwin");
  t.mock.method(os, "release", () => "");
  const calls = [];
  const logs = [];
  t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, "");
  });
  t.mock.method(console, "warn", (message) => { logs.push(message); });

  const events = stream();
  const hooks = {};
  const cleanup = await plugin.setup({
    options: config,
    location: { directory },
    session: {
      get: get || (async ({ sessionID }) => ({
        id: sessionID, title: "Resumed", location: { directory },
      })),
      hook: async (name, handler) => { hooks[name] = handler; },
    },
    event: { subscribe: () => events.iterable },
  });
  t.after(() => cleanup?.());
  await flush();

  const emit = async (type, data) => { events.push({ type, data }); await flush(); };
  const request = async (model = claude, sessionID = "root", kind = "primary") => {
    // A disabled plugin registers no hook; the callers still drive the sequence.
    await hooks["model.request"]?.({ sessionID, model, kind, agent: "build", headers: {} });
    await flush();
  };
  const cached = (sessionID = "root", cache = { read: 100, write: 0 }) =>
    emit("session.usage.updated", { sessionID, tokens: { cache } });
  const idle = (sessionID = "root") => emit("session.execution.succeeded", { sessionID });
  const advance = async (ms) => { t.mock.timers.tick(ms); await flush(); };
  const notifications = () => calls.filter((call) => call.command === "osascript");
  return { calls, logs, emit, request, cached, idle, advance, notifications };
}

test("OpenCode 2: a confirmed Claude window rings two minutes before it closes", async (t) => {
  const s = await setupV2(t);
  await s.emit("session.created", {
    sessionID: "root", title: "Root", location: { directory: "/projects/example" },
  });
  await s.request();
  await s.cached();
  await s.idle();
  await s.advance(179_000);
  assert.equal(s.notifications().length, 0);
  await s.advance(1_000);
  assert.equal(s.notifications().length, 1);
  assert.match(s.notifications()[0].args.at(-1), /claude-sonnet-4-6: ~2m 0s cache window remaining/);
  // Once per window, not once per timer tick.
  await s.advance(60_000);
  assert.equal(s.notifications().length, 1);
});

test("OpenCode 2: an unconfirmed window stays silent", async (t) => {
  const s = await setupV2(t);
  await s.emit("session.created", {
    sessionID: "root", location: { directory: "/projects/example" },
  });
  await s.request();
  await s.idle();
  await s.advance(600_000);
  assert.equal(s.notifications().length, 0);
});

test("OpenCode 2: auxiliary requests never arm a window", async (t) => {
  const s = await setupV2(t);
  await s.emit("session.created", {
    sessionID: "root", location: { directory: "/projects/example" },
  });
  for (const kind of ["title", "compaction", "generate"]) await s.request(claude, "root", kind);
  await s.cached();
  await s.idle();
  await s.advance(600_000);
  assert.equal(s.notifications().length, 0);
});

test("OpenCode 2: only the instance owning the session rings", async (t) => {
  // Version 2 runs one plugin instance per location against one shared event
  // stream, so every other instance must ignore this session entirely.
  const s = await setupV2(t, { directory: "/projects/other" });
  await s.emit("session.created", {
    sessionID: "root", location: { directory: "/projects/example" },
  });
  await s.request();
  await s.cached();
  await s.idle();
  await s.advance(600_000);
  assert.equal(s.notifications().length, 0);
});

test("OpenCode 2: subagent sessions never ring", async (t) => {
  const s = await setupV2(t);
  await s.emit("session.created", {
    sessionID: "child", parentID: "root", location: { directory: "/projects/example" },
  });
  await s.request(claude, "child");
  await s.cached("child");
  await s.idle("child");
  await s.advance(600_000);
  assert.equal(s.notifications().length, 0);
});

test("OpenCode 2: work defers the bell, and a modern OpenAI window is longer", async (t) => {
  const s = await setupV2(t);
  await s.emit("session.created", {
    sessionID: "root", title: "Root", location: { directory: "/projects/example" },
  });
  await s.request(gpt);
  await s.cached();
  // Still working when the warning would have been due.
  await s.emit("session.execution.started", { sessionID: "root" });
  await s.advance(1_700_000);
  assert.equal(s.notifications().length, 0);
  await s.idle();
  await s.advance(0);
  assert.equal(s.notifications().length, 1);
  assert.match(s.notifications()[0].args.at(-1), /gpt-6-astra: ~1m 40s cache window remaining/);
});

test("OpenCode 2: someone at the keyboard is not told about their own window", async (t) => {
  const s = await setupV2(t);
  await s.emit("session.created", {
    sessionID: "root", location: { directory: "/projects/example" },
  });
  await s.request();
  await s.cached();
  await s.emit("permission.asked", { sessionID: "root" });
  await s.advance(600_000);
  assert.equal(s.notifications().length, 0);
});

for (const type of ["session.execution.interrupted", "session.execution.failed"]) {
  test(`OpenCode 2: ${type} abandons the window`, async (t) => {
    const s = await setupV2(t);
    await s.emit("session.created", {
      sessionID: "root", location: { directory: "/projects/example" },
    });
    await s.request();
    await s.cached();
    await s.emit(type, { sessionID: "root" });
    await s.idle();
    await s.advance(600_000);
    assert.equal(s.notifications().length, 0);
  });
}

test("OpenCode 2: a resumed session is resolved through the session lookup", async (t) => {
  const s = await setupV2(t, {
    get: async ({ sessionID }) => ({
      id: sessionID, title: "Resumed", location: { directory: "/projects/example" },
    }),
  });
  await s.request();
  await s.cached();
  await s.idle();
  await s.advance(180_000);
  assert.equal(s.notifications().length, 1);
  assert.match(s.notifications()[0].args.at(-1), /Resumed - claude-sonnet-4-6/);
});

test("OpenCode 2: invalid options disable the plugin without breaking OpenCode", async (t) => {
  const s = await setupV2(t, { config: { warningSeconds: -1 } });
  await s.request();
  await s.cached();
  await s.idle();
  await s.advance(600_000);
  assert.equal(s.notifications().length, 0);
  assert.match(s.logs.join("\n"), /Invalid CacheBell configuration/);
});

test("OpenCode 2: a rename never adopts a session this instance does not own", async (t) => {
  const s = await setupV2(t, { directory: "/projects/other" });
  await s.emit("session.created", {
    sessionID: "root", location: { directory: "/projects/example" },
  });
  await s.request();
  await s.cached();
  await s.emit("session.renamed", { sessionID: "root", title: "Renamed" });
  await s.idle();
  await s.advance(600_000);
  assert.equal(s.notifications().length, 0);
});
