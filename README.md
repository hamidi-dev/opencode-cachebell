# CacheBell

Get a reminder before your OpenCode prompt cache expires. Continuing the
conversation while the cache is available means paying less for repeated input.

CacheBell plays a short sound and shows a desktop notification about **two minutes
beforehand**, while the agent is idle.

## Install

Add to `plugin` in `~/.config/opencode/opencode.json`, keeping your other entries:

```json
{
  "plugin": ["opencode-cachebell@0.2.0"]
}
```

**Restart OpenCode.** It installs the package automatically.

Supports macOS and WSL, with best-effort native Windows and Linux desktop support.

## Sounds

Three original sounds are included:

| Sound | Style |
| --- | --- |
| **Pulse** (default) | Short, rising electronic signal |
| Chime | Two warm bell notes |
| Knock | Soft, woody double-tap |

To choose a sound, replace the plugin entry with:

```json
{
  "plugin": [["opencode-cachebell@0.2.0", { "sound": "chime" }]]
}
```

Use `"pulse"`, `"chime"`, `"knock"`, or `false` for silence. Restart after changes.

## Timing

Defaults: **5 minutes for Claude**, **30 minutes for GPT-5.6+**. The clock starts
with the model request, not when its answer finishes. Other models and custom
cache durations need an override. These are estimates, not guaranteed cache hits.

[Configuration and troubleshooting](docs/guide.md) |
[npm](https://www.npmjs.com/package/opencode-cachebell) | MIT
