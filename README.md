# CacheBell

Get a reminder before your OpenCode prompt cache expires. Continuing the
conversation while the cache is available means paying less for repeated input.

CacheBell plays a short sound and shows a desktop notification about **two minutes
beforehand**, while the agent is idle.

## Install

Add to `plugin` in `~/.config/opencode/opencode.json`, keeping your other entries:

```json
{
  "plugin": ["opencode-cachebell@0.3.0"]
}
```

**Restart OpenCode.** It installs the package automatically.

Works with OpenCode 1 and OpenCode 2 from the same package. Supports macOS and
WSL, with best-effort native Windows and Linux desktop support.

## Sounds

Five sounds are included:

| Sound | Style |
| --- | --- |
| **Pulse** (default) | Short, rising electronic signal |
| Chime | Two warm bell notes |
| Knock | Soft, woody double-tap |
| Sheep Field | Real, 2.5-second field bleat |
| Sheep Close | Real, 1.36-second close-up bleat |

To choose a sound, replace the plugin entry with:

```json
{
  "plugin": [["opencode-cachebell@0.3.0", { "sound": "sheep-close" }]]
}
```

Use `"pulse"`, `"chime"`, `"knock"`, `"sheep-field"`, `"sheep-close"`, or `false` for silence.
`"sheep"` remains an alias for `"sheep-field"`. Restart after changes.

Sheep Field is an excerpt of a [public-domain recording by earthcalling](https://commons.wikimedia.org/wiki/File:Sheep_bleating.ogg).
Sheep Close is a [CC0 recording by TheKingOfGeeks360](https://freesound.org/people/TheKingOfGeeks360/sounds/803460/),
converted from its publicly available high-quality MP3 preview. Both are mono PCM WAVs for desktop playback.

## Timing

Defaults: **5 minutes for Claude**, **30 minutes for GPT-5.6+**. The clock starts
with the model request, not when its answer finishes. Other models and custom
cache durations need an override. These are estimates, not guaranteed cache hits.

[Configuration and troubleshooting](docs/guide.md) |
[npm](https://www.npmjs.com/package/opencode-cachebell) | MIT
