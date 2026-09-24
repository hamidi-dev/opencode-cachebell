import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BACKGROUND_AGENTS = new Set(["title", "summary", "compaction"]);

function settings(options = {}) {
  const config = {
    warningSeconds: 120,
    sound: "pulse",
    notification: true,
    ttlSeconds: {},
    ...options,
    ...JSON.parse(process.env.OPENCODE_CACHEBELL || "{}"),
  };
  if (!Number.isFinite(config.warningSeconds) || config.warningSeconds <= 0 ||
      ![true, false, "pulse", "chime", "knock", "sheep", "sheep-close", "sheep-field"].includes(config.sound) ||
      typeof config.notification !== "boolean" ||
      !config.ttlSeconds || typeof config.ttlSeconds !== "object" ||
      Array.isArray(config.ttlSeconds) ||
      Object.values(config.ttlSeconds).some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error("Invalid CacheBell settings");
  }
  return config;
}

function cacheTTL(model, config) {
  const provider = model.providerID;
  const apiID = model.api?.id || model.id || "";
  for (const key of [`${provider}/${model.id}`, apiID, provider]) {
    if (Object.hasOwn(config.ttlSeconds, key)) return config.ttlSeconds[key] * 1000;
  }
  if (/(?:^|[/.-])claude(?:[-.]|$)/i.test(apiID)) return 300_000;
  const gpt = apiID.match(/(?:^|\/)gpt-(\d+)(?:\.(\d+))?(?:[-.]|$)/i);
  if (gpt && (+gpt[1] >= 6 || (+gpt[1] === 5 && +gpt[2] >= 6))) return 1_800_000;
  return 0;
}

function run(command, args) {
  return new Promise((resolve) => {
    try {
      childProcess.execFile(command, args, { timeout: 10_000, windowsHide: true, encoding: "utf8" },
        (error, stdout) => resolve({ ok: !error, code: error?.code, stdout: stdout || "" }));
    } catch (error) {
      resolve({ ok: false, code: error.code, stdout: "" });
    }
  });
}

async function notify(title, message, config) {
  if (!config.sound && !config.notification) return true;
  const soundFile = config.sound ? fileURLToPath(new URL(
    `./sounds/${config.sound === true ? "pulse" : config.sound === "sheep" ? "sheep-field" : config.sound}.wav`, import.meta.url,
  )) : undefined;
  const results = [];
  if (os.platform() === "darwin") {
    if (config.notification) {
      results.push(run("osascript", ["-e", "on run argv", "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run", title, message]));
    }
    if (soundFile) results.push(run("afplay", [soundFile]));
  } else if (os.platform() === "win32" ||
      (os.platform() === "linux" && /microsoft|wsl/i.test(os.release()))) {
    let windowsSound = soundFile;
    if (soundFile && os.platform() === "linux") {
      // Cached npm files live inside WSL; Windows SoundPlayer needs a host path.
      const translated = await run("wslpath", ["-w", soundFile]);
      windowsSound = translated.ok ? translated.stdout.trim() : undefined;
    }
    // Encode data separately: session titles and file paths are never code.
    const data = Buffer.from(JSON.stringify({ title, message, soundFile: windowsSound }), "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$soundFailed = $false",
      `$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json`,
      ...(windowsSound ? [
        "$player = $null",
        "try {",
        "$player = New-Object System.Media.SoundPlayer",
        "$player.SoundLocation = $data.soundFile",
        "$player.PlaySync()",
        "} catch { $soundFailed = $true } finally { if ($player) { $player.Dispose() } }",
      ] : []),
      ...(config.notification ? [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "$icon = New-Object System.Windows.Forms.NotifyIcon",
        "try {",
        "$icon.Icon = [System.Drawing.SystemIcons]::Information",
        "$icon.Visible = $true",
        "$icon.ShowBalloonTip(5000, $data.title, $data.message, [System.Windows.Forms.ToolTipIcon]::None)",
        "Start-Sleep -Seconds 5",
        "} finally { $icon.Dispose() }",
      ] : []),
      "if ($soundFailed) { exit 1 }",
    ].join("\n");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    let result = await run("powershell.exe", args);
    if (result.code === "ENOENT" && os.platform() === "linux") {
      result = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", args);
    }
    return result.ok && (!soundFile || Boolean(windowsSound));
  } else {
    // Optional ordinary Linux support; these commands are not needed on WSL.
    if (config.notification) results.push(run("notify-send", ["--", title, message]));
    if (soundFile) results.push(run("canberra-gtk-play", ["-f", soundFile]));
  }
  return (await Promise.all(results)).every((result) => result.ok);
}

/**
 * The plugin's state machine, shared by both OpenCode generations.
 *
 * `host` is the thin layer that differs between them: how a session is looked
 * up, and how a warning is logged. Everything else -- when a cache window
 * starts, when it is confirmed, and when the bell is due -- is the same.
 */
function createBell(config, directory, host) {
  const sessions = new Map();
  const deleted = new Set();
  let disposed = false;
  const project = path.basename(directory || "OpenCode");
  const stateFor = (id) => {
    if (!sessions.has(id)) sessions.set(id, { id, status: "busy" });
    return sessions.get(id);
  };
  const cancel = (state) => {
    clearTimeout(state.timer);
    state.timer = undefined;
  };

  function schedule(state) {
    cancel(state);
    const request = state.request;
    if (disposed || state.root !== true || state.status !== "idle" ||
        !request?.confirmed || request.notified) return;
    const remaining = request.deadline - Date.now();
    if (remaining <= 0) return;
    const delay = remaining - config.warningSeconds * 1000;
    if (delay <= 0) {
      request.notified = true;
      const seconds = Math.ceil(remaining / 1000);
      const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
      const title = `CacheBell - ${project}`;
      const message = `${state.title || state.id} - ${request.model}: ~${time} cache window remaining`;
      void notify(title, message, config).then((ok) => {
        if (!ok) host.log("A CacheBell sound/notification failed. Check OS notification permissions and platform commands.");
      }).catch(() => host.log("CacheBell notification failed."));
      return;
    }
    // Recheck wall time after sleep/clock changes instead of playing stale alarms.
    state.timer = setTimeout(() => schedule(state), Math.min(delay, 10_000));
    state.timer.unref?.();
  }

  function metadata(state, info) {
    // A session belongs to exactly one directory. OpenCode 2 runs one plugin
    // instance per location against one shared event stream, so without this
    // every instance would ring for the same window.
    const owned = !info.directory || !directory || info.directory === directory;
    state.root = owned && !info.parentID;
    state.title = info.title;
    schedule(state);
  }

  function lookup(state) {
    // Resumed sessions need ancestry lookup. Do not block model dispatch on it.
    if (state.root !== undefined || state.lookup) return;
    state.lookup = true;
    Promise.resolve(host.session(state.id))
      .then((info) => {
        if (!disposed && sessions.get(state.id) === state && info) metadata(state, info);
      })
      .catch(() => {})
      .finally(() => { state.lookup = false; });
  }

  return {
    /** A model request started: a fresh cache window, if the model has one. */
    request(sessionID, model) {
      if (disposed || deleted.has(sessionID)) return;
      const state = stateFor(sessionID);
      cancel(state);
      state.status = "busy";
      const ttl = cacheTTL(model, config);
      state.request = ttl > 0 ? {
        started: Date.now(),
        deadline: Date.now() + ttl,
        messageID: state.messageID,
        model: model.id,
      } : undefined;
      lookup(state);
    },
    /** Only reported cache reads/writes confirm a window worth warning about. */
    confirm(sessionID, cache) {
      if (disposed || deleted.has(sessionID)) return;
      const state = sessions.get(sessionID);
      const request = state?.request;
      if (!request || request.notified) return;
      if (!(cache?.read > 0 || cache?.write > 0)) return;
      request.confirmed = true;
      schedule(state);
    },
    /** The window only counts down while nobody is working in the session. */
    status(sessionID, status) {
      if (disposed) return;
      const state = sessions.get(sessionID);
      if (!state) return;
      state.status = status;
      schedule(state);
    },
    /** A failed or interrupted run leaves no window to warn about. */
    abandon(sessionID) {
      const state = sessions.get(sessionID);
      if (!state) return;
      cancel(state);
      state.request = undefined;
    },
    info(sessionID, info) {
      if (disposed || deleted.has(sessionID)) return;
      metadata(stateFor(sessionID), info);
    },
    /** A title change says nothing about ancestry or ownership; only relabel. */
    rename(sessionID, title) {
      const state = sessions.get(sessionID);
      if (disposed || !state) return;
      state.title = title;
    },
    remove(sessionID) {
      deleted.add(sessionID);
      const state = sessions.get(sessionID);
      if (state) cancel(state);
      sessions.delete(sessionID);
    },
    /** Assistant message bookkeeping, OpenCode 1 only. */
    message(sessionID, id) {
      if (disposed || deleted.has(sessionID)) return;
      stateFor(sessionID).messageID = id;
    },
    matches(sessionID, info) {
      const request = sessions.get(sessionID)?.request;
      return Boolean(request) &&
        (!request.messageID || request.messageID === info.id) &&
        info.modelID === request.model &&
        info.completed >= request.started;
    },
    dispose() {
      disposed = true;
      for (const state of sessions.values()) cancel(state);
      sessions.clear();
    },
  };
}

/** OpenCode 2 entrypoint: a plugin definition with an id and a setup function. */
async function setup(ctx) {
  let config;
  const log = (message) => {
    try {
      console.warn(`cachebell: ${message}`);
    } catch { /* A notification must never interrupt the agent. */ }
  };
  try {
    config = settings(ctx.options);
  } catch {
    log("Invalid CacheBell configuration; plugin disabled. Check OPENCODE_CACHEBELL/options.");
    return;
  }
  if (!config.sound && !config.notification) return;

  const directory = ctx.location?.directory;
  const bell = createBell(config, directory, {
    log,
    session: async (sessionID) => {
      const info = await ctx.session.get({ sessionID });
      return info && {
        id: info.id,
        parentID: info.parentID,
        title: info.title,
        directory: info.location?.directory,
      };
    },
  });

  await ctx.session.hook("model.request", (event) => {
    // Titles, summaries and compactions are the agent's own bookkeeping; only
    // a primary request is a cache window the user is sitting on.
    if (event.kind !== "primary") return;
    bell.request(event.sessionID, event.model);
  });

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event.data ?? {};
        switch (event.type) {
          case "session.usage.updated":
            bell.confirm(data.sessionID, data.tokens?.cache);
            break;
          case "session.execution.started":
            bell.status(data.sessionID, "busy");
            break;
          case "session.execution.succeeded":
            bell.status(data.sessionID, "idle");
            break;
          case "session.execution.failed":
          case "session.execution.interrupted":
            bell.abandon(data.sessionID);
            break;
          // Someone at the keyboard does not need a bell.
          case "permission.asked":
          case "form.created":
            bell.status(data.sessionID, "waiting");
            break;
          case "session.created":
            bell.info(data.sessionID, {
              id: data.sessionID,
              parentID: data.parentID,
              title: data.title,
              directory: data.location?.directory,
            });
            break;
          case "session.renamed":
            bell.rename(data.sessionID, data.title);
            break;
          case "session.deleted":
            bell.remove(data.sessionID);
            break;
          default:
            break;
        }
      }
    } catch {
      // The stream ends with the plugin.
    }
  })();

  return () => {
    controller.abort();
    bell.dispose();
  };
}

/** OpenCode 1 entrypoint, kept so one package serves both generations. */
async function server({ client, directory }, options) {
  const log = (message) => {
    try {
      Promise.resolve(client.app?.log?.({ body: {
        service: "cachebell", level: "warn", message,
      } })).catch(() => {});
    } catch { /* A notification must never interrupt the agent. */ }
  };
  let config;
  try {
    config = settings(options);
  } catch {
    log("Invalid CacheBell configuration; plugin disabled. Check OPENCODE_CACHEBELL/options.");
    return {};
  }
  if (!config.sound && !config.notification) return {};

  const bell = createBell(config, directory, {
    log,
    session: async (id) => {
      const { data } = await client.session.get({ path: { id } });
      return data && { id: data.id, parentID: data.parentID, title: data.title };
    },
  });

  return {
    "chat.headers": async (input) => {
      if (BACKGROUND_AGENTS.has(input.agent)) return;
      bell.request(input.sessionID, input.model);
    },
    event: async ({ event }) => {
      const p = event.properties;
      if (event.type === "server.instance.disposed") {
        if (!p.directory || p.directory === directory) bell.dispose();
        return;
      }
      if (event.type === "session.deleted") {
        bell.remove(p.info.id);
        return;
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        bell.info(p.info.id, p.info);
        return;
      }
      if (event.type === "message.updated") {
        const info = p.info;
        if (info.role !== "assistant" || info.summary || BACKGROUND_AGENTS.has(info.agent)) return;
        if (!info.time.completed) {
          bell.message(info.sessionID, info.id);
          return;
        }
        if (!bell.matches(info.sessionID, {
          id: info.id, modelID: info.modelID, completed: info.time.completed,
        })) return;
        if (info.error) {
          bell.abandon(info.sessionID);
          return;
        }
        // Completion may follow slow tools; it must never move the deadline.
        bell.confirm(info.sessionID, info.tokens?.cache);
        return;
      }
      if (event.type === "session.status" || event.type === "session.idle" ||
          event.type === "permission.asked" || event.type === "question.asked") {
        bell.status(p.sessionID, event.type === "session.idle" ? "idle" :
          event.type === "session.status" ? p.status.type : "waiting");
      }
    },
    dispose: async () => bell.dispose(),
  };
}

/**
 * One package, both OpenCode generations: version 2 reads `id` and `setup`,
 * version 1 calls `server()` and ignores the rest.
 */
export default { id: "cachebell", setup, server };

// Smoke-test native delivery without an API request or an OpenCode session.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url &&
    process.argv.includes("--test-notification")) {
  const ok = await notify("CacheBell", "Test: ~2 minutes of cache window remaining", settings());
  if (!ok) {
    console.error("Notification command failed. Check OS permissions and platform commands in README.md.");
    process.exitCode = 1;
  }
}
