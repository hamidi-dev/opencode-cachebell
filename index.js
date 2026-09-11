import childProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BACKGROUND_AGENTS = new Set(["title", "summary", "compaction"]);

function settings(options = {}) {
  const config = {
    warningSeconds: 120,
    sound: true,
    notification: true,
    ttlSeconds: {},
    ...options,
    ...JSON.parse(process.env.OPENCODE_CACHEBELL || "{}"),
  };
  if (!Number.isFinite(config.warningSeconds) || config.warningSeconds <= 0 ||
      typeof config.sound !== "boolean" || typeof config.notification !== "boolean" ||
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
      childProcess.execFile(command, args, { timeout: 10_000, windowsHide: true },
        (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

async function notify(title, message, config) {
  const results = [];
  if (os.platform() === "darwin") {
    if (config.notification) {
      results.push(run("osascript", ["-e", "on run argv", "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run", title, message]));
    }
    if (config.sound) results.push(run("afplay", ["/System/Library/Sounds/Glass.aiff"]));
  } else if (os.platform() === "win32" ||
      (os.platform() === "linux" && /microsoft|wsl/i.test(os.release()))) {
    // Encode both data and program: titles never become executable PowerShell.
    const data = Buffer.from(JSON.stringify({ title, message }), "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json`,
      ...(config.sound ? ["[System.Media.SystemSounds]::Exclamation.Play()"] : []),
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
      ] : ["Start-Sleep -Milliseconds 500"]),
    ].join("\n");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    let ok = await run("powershell.exe", args);
    if (!ok && os.platform() === "linux") {
      ok = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", args);
    }
    return ok;
  } else {
    // Optional ordinary Linux support; these commands are not needed on WSL.
    if (config.notification) results.push(run("notify-send", ["--", title, message]));
    if (config.sound) results.push(run("canberra-gtk-play", ["-i", "message-new-instant"]));
  }
  return (await Promise.all(results)).every(Boolean);
}

/** A single-file OpenCode plugin. No SDK import or runtime npm dependencies. */
export default async function CacheBellPlugin({ client, directory }, options) {
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
        if (!ok) log("A CacheBell sound/notification failed. Check OS notification permissions and platform commands.");
      }).catch(() => log("CacheBell notification failed."));
      return;
    }
    // Recheck wall time after sleep/clock changes instead of playing stale alarms.
    state.timer = setTimeout(() => schedule(state), Math.min(delay, 10_000));
    state.timer.unref?.();
  }

  function metadata(state, info) {
    state.root = !info.parentID;
    state.title = info.title;
    schedule(state);
  }

  const dispose = async () => {
    disposed = true;
    for (const state of sessions.values()) cancel(state);
    sessions.clear();
  };

  return {
    "chat.headers": async (input) => {
      if (disposed || deleted.has(input.sessionID) || BACKGROUND_AGENTS.has(input.agent)) return;
      const state = stateFor(input.sessionID);
      cancel(state);
      state.status = "busy";
      const ttl = cacheTTL(input.model, config);
      state.request = ttl > 0 ? {
        started: Date.now(),
        deadline: Date.now() + ttl,
        messageID: state.messageID,
        model: input.model.id,
      } : undefined;
      if (state.root === undefined && !state.lookup) {
        // Resumed sessions need ancestry lookup. Do not block model dispatch on it.
        state.lookup = true;
        Promise.resolve().then(() => client.session.get({ path: { id: state.id } }))
          .then(({ data }) => {
            if (!disposed && sessions.get(state.id) === state && data) metadata(state, data);
          }).catch(() => {}).finally(() => { state.lookup = false; });
      }
    },
    event: async ({ event }) => {
      if (disposed) return;
      const p = event.properties;
      if (event.type === "server.instance.disposed") {
        if (!p.directory || p.directory === directory) await dispose();
        return;
      }
      if (event.type === "session.deleted") {
        deleted.add(p.info.id);
        const state = sessions.get(p.info.id);
        if (state) cancel(state);
        sessions.delete(p.info.id);
        return;
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        if (deleted.has(p.info.id)) return;
        metadata(stateFor(p.info.id), p.info);
        return;
      }
      if (event.type === "message.updated") {
        const info = p.info;
        if (deleted.has(info.sessionID)) return;
        if (info.role !== "assistant" || info.summary || BACKGROUND_AGENTS.has(info.agent)) return;
        const state = stateFor(info.sessionID);
        if (!info.time.completed) {
          state.messageID = info.id;
          return;
        }
        const request = state.request;
        if (!request || (request.messageID && request.messageID !== info.id) ||
            info.modelID !== request.model || info.time.completed < request.started) return;
        if (info.error) {
          cancel(state);
          state.request = undefined;
          return;
        }
        // Only reported cache reads/writes confirm a useful window. Completion
        // may follow slow tools; it must never move the request-start deadline.
        const cache = info.tokens?.cache;
        request.confirmed = (cache?.read > 0 || cache?.write > 0);
        schedule(state);
        return;
      }
      if (event.type === "session.status" || event.type === "session.idle" ||
          event.type === "permission.asked" || event.type === "question.asked") {
        const state = sessions.get(p.sessionID);
        if (!state) return;
        state.status = event.type === "session.idle" ? "idle" :
          event.type === "session.status" ? p.status.type : "waiting";
        schedule(state);
      }
    },
    dispose,
  };
}

// Smoke-test native delivery without an API request or an OpenCode session.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url &&
    process.argv.includes("--test-notification")) {
  const ok = await notify("CacheBell", "Test: ~2 minutes of cache window remaining", settings());
  if (!ok) {
    console.error("Notification command failed. Check OS permissions and platform commands in README.md.");
    process.exitCode = 1;
  }
}
