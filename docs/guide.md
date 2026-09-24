# CacheBell Guide

For installation and sound selection, see the [README](../README.md).

## Platforms

| Platform | Sound | Desktop Notification | Requirements |
| --- | --- | --- | --- |
| macOS | Bundled WAV via `afplay` | Native `osascript` notification | macOS built-ins only |
| WSL 1/2 | Bundled WAV via Windows `SoundPlayer` | Windows notification-area balloon | Windows PowerShell, `wslpath`, and WSL interop enabled |
| Windows | Bundled WAV via `SoundPlayer` | Windows notification-area balloon | Windows PowerShell; best-effort support |
| Desktop Linux | `canberra-gtk-play` | `notify-send` | Optional system packages and a desktop session |

WSL delivery runs on the **Windows host**, not through a Linux audio server or
WSLg. No PowerShell module installation is needed. Native Windows and WSL share
the same notification implementation.

## Installation Details

Use `XDG_CONFIG_HOME` instead of `~/.config` if configured. Keep other plugins
and settings when adding CacheBell. Pin a published version and change the pin
when upgrading; restart OpenCode after changes.

For local development, replace the npm entry with an absolute path to the
checkout's `index.js`. On Windows use a `file:///C:/.../index.js` URL. Keep the
`sounds/` directory alongside `index.js`: since 0.2.0, copying just the JavaScript
file is not enough. Remove any older auto-discovered `plugins/cachebell.js` copy
to avoid duplicate notifications. No build or `npm install` is required.

## Timing

| Default Detection (API Model ID) | Estimated TTL | Warning After Request Start |
| --- | --- | --- |
| Claude models | 5 minutes | 3 minutes |
| GPT-5.6 and later, including GPT-6 | 30 minutes | 28 minutes |
| Older GPT models / unknown models | Disabled | Configure an explicit override |

The plugin records every conversational LLM request, including tool-loop
requests and OpenCode-managed retries: `chat.headers` on OpenCode 1, the
`model.request` session hook on OpenCode 2. Titles, summaries and compactions
are excluded, since nobody is waiting on them. **Reported cache reads or writes**
confirm the estimate — from the completed assistant message on OpenCode 1, from
`session.usage.updated` on OpenCode 2. The timer
is anchored to request preparation, **never** to response completion or tool
completion. This is an approximation of provider request arrival, not a
transport-level timestamp.

- One alert per confirmed request, only while the main session is idle.
- A new model request replaces its previous deadline.
- Subagents and internal title/summary/compaction requests do not refresh the
  main conversation's timer or produce their own alerts.
- While generating, running tools, retrying, or awaiting a permission/question,
  reminders are suppressed. On returning to idle, a late alert shows the actual
  estimated time remaining, if any.
- A long response or waking from sleep after expiry does not produce a stale alert.
- Notifications are not suppressed just because the terminal is focused.
- Sessions are tracked independently. Notifications include project, session, and
  model so you can identify which conversation needs attention.
- Deleting a session or disposing the plugin cancels its timers. State is
  in-memory: restarting OpenCode starts tracking with the next request, not with
  historical messages. OpenCode must remain running for reminders to fire.

**An unexpired timer does not guarantee a cache hit.** Prefix changes, compaction,
model/provider changes, and routing can prevent reuse. OpenAI's 30-minute window
is a minimum eligibility lifetime for newer models, not an exact eviction time.
Older OpenAI models have different retention policies. Claude's default lifetime
is measured from **request start**, and explicit 1-hour caching needs an override.
Custom endpoints/subscription routes may differ from the providers' public APIs.

If OpenCode or your provider does not report cache usage, the plugin stays silent
rather than claiming a cache exists. It never sends prompts, changes caching
options, or generates API charges itself.

References: [OpenAI prompt caching](https://platform.openai.com/docs/guides/prompt-caching)
and [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Configure

Defaults need no configuration. For either installation method, set
`OPENCODE_CACHEBELL` to a JSON object before starting OpenCode:

```sh
export OPENCODE_CACHEBELL='{"warningSeconds":120,"sound":true,"notification":true,"ttlSeconds":{"anthropic":300,"openai/gpt-5.4":1800}}'
```

Native PowerShell:

```powershell
$env:OPENCODE_CACHEBELL = '{"warningSeconds":120,"sound":true,"notification":true}'
```

OpenCode versions supporting plugin option tuples can also use:

```json
{
  "plugin": [
    ["opencode-cachebell@0.4.0", {
      "warningSeconds": 120,
      "ttlSeconds": { "anthropic": 3600 }
    }]
  ]
}
```

That example assumes you have **already enabled 1-hour caching** for your
Anthropic requests. The plugin's override only changes reminders, not the API's
cache policy. It cannot infer TTLs on individual cache breakpoints.

| Option | Default | Meaning |
| --- | --- | --- |
| `warningSeconds` | `120` | Lead time; positive number. If longer than the TTL, warn as soon as an eligible session becomes idle. |
| `sound` | `"pulse"` | Bundled `"pulse"`, `"chime"`, `"knock"`, `"sheep-field"`, or `"sheep-close"`. `"sheep"` aliases Sheep Field; `true` uses Pulse; `false` disables sound. |
| `notification` | `true` | Show the platform notification. Set both booleans to false to disable the plugin. |
| `ttlSeconds` | `{}` | Override TTL by `providerID/modelID`, API model ID, or provider ID, in that precedence order. `0` disables a match. |

Model detection uses the underlying API model ID when available, so configuration
aliases work. Environment values override tuple options (the `ttlSeconds` map is
replaced, not deep-merged). Invalid configuration disables the plugin and logs a
warning instead of breaking OpenCode.

## Test Delivery

From the downloaded repository, with Node.js 22+ installed:

```sh
npm run test:notification
```

This plays a real sound and notification immediately, without an API request.
`node index.js --test-notification` works too. It runs on the machine hosting the
OpenCode process, not on a remote attached browser/terminal client.

- **macOS:** allow notifications for the app macOS attributes the AppleScript
  notification to. Focus modes can hide banners; system volume controls sound.
- **WSL:** `powershell.exe` must be executable via WSL interop. If it is absent
  from `PATH`, the plugin tries the standard `/mnt/c/Windows/...` path. For a
  nonstandard Windows mount, add its Windows PowerShell directory to `PATH`.
  `wslpath -w` translates the bundled sound's Linux path into a Windows-readable
  path. If translation fails, the desktop notification still runs and the sound
  failure is logged.
- **Windows/WSL:** notification policy, Focus Assist, and sound settings can
  suppress delivery even when PowerShell succeeds. These are short-lived tray
  balloons, not persistent Action Center reminders or click-to-open links.
- **Desktop Linux:** install your distribution's packages providing `notify-send`
  and `canberra-gtk-play`, or disable the unavailable channel.

Command failures are logged and never interrupt the agent. A successful smoke
test exit only confirms that the commands ran; verify you actually heard/saw it.

## Development

```sh
npm test
```

Uses Node's built-in test runner, fake clocks, and mocked OS commands. No package
installation is needed. Tests cover deadlines, tool loops, model switching,
subagents, resumed sessions, errors, sleep, disposal, and platform command
construction. Windows/WSL command tests are not a substitute for testing actual
desktop delivery on those systems.

Pulse, Chime, and Knock are synthesized by `scripts/generate-sounds.mjs` and are
covered by the MIT license. Run `npm run sounds:generate` to reproduce them.
Sheep Field is a 2.5-second excerpt of a [public-domain field recording](https://commons.wikimedia.org/wiki/File:Sheep_bleating.ogg)
by earthcalling. Sheep Close is a 1.36-second [CC0 recording](https://freesound.org/people/TheKingOfGeeks360/sounds/803460/)
by TheKingOfGeeks360, converted from the public high-quality MP3 preview. The
generator does not overwrite either recording.
The npm package includes mono, 44.1 kHz, 16-bit PCM WAV files; users do not
run the generator. The synthesized sounds are under one second; the sheep clips
are 1.36 and 2.5 seconds. Each has a -5.2 dBFS peak ceiling. Custom audio files are not currently
supported.

MIT licensed.
