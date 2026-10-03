import childProcess from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

function run(command, args, signal) {
  return new Promise((resolve) => {
    try {
      childProcess.execFile(command, args, {
        timeout: 10_000, windowsHide: true, encoding: "utf8", ...(signal ? { signal } : {}),
      }, (error, stdout) => resolve({ ok: !error, code: error?.code, stdout: stdout || "" }));
    } catch (error) {
      resolve({ ok: false, code: error.code, stdout: "" });
    }
  });
}

export async function notify(title, message, config, delivery = {}) {
  const active = () => !delivery.signal?.aborted && (!delivery.active || delivery.active());
  if (!active()) return true;
  if (!config.sound && !config.notification) return true;
  const soundFile = config.sound ? fileURLToPath(new URL(
    `./sounds/${config.sound === true ? "pulse" : config.sound === "sheep" ? "sheep-field" : config.sound}.wav`, import.meta.url,
  )) : undefined;
  const results = [];
  if (os.platform() === "darwin") {
    if (config.notification) {
      results.push(run("osascript", ["-e", "on run argv", "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run", title, message], delivery.signal));
    }
    if (soundFile) results.push(run("afplay", [soundFile], delivery.signal));
  } else if (os.platform() === "win32" ||
      (os.platform() === "linux" && /microsoft|wsl/i.test(os.release()))) {
    let windowsSound = soundFile;
    if (soundFile && os.platform() === "linux") {
      // Cached npm files live inside WSL; Windows SoundPlayer needs a host path.
      const translated = await run("wslpath", ["-w", soundFile], delivery.signal);
      windowsSound = translated.ok ? translated.stdout.trim() : undefined;
    }
    if (!active()) return true;
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
    let result = await run("powershell.exe", args, delivery.signal);
    if (result.code === "ENOENT" && os.platform() === "linux") {
      if (!active()) return true;
      result = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", args, delivery.signal);
    }
    return result.ok && (!soundFile || Boolean(windowsSound));
  } else {
    // Optional ordinary Linux support; these commands are not needed on WSL.
    if (config.notification) results.push(run("notify-send", ["--", title, message], delivery.signal));
    if (soundFile) results.push(run("canberra-gtk-play", ["-f", soundFile], delivery.signal));
  }
  return (await Promise.all(results)).every((result) => result.ok);
}
