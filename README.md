# CacheBell

An OpenCode plugin that rings before your estimated prompt-cache window ends.
Get a sound and desktop notification so you can continue the conversation while
its cached context is still reusable. Package name: `opencode-cachebell`.

**One JavaScript file. Zero npm dependencies. No tmux, WorkMux, dotfiles,
external helper scripts, or keepalive requests.**

```text
CacheBell - my-project
Fix checkout validation - claude-sonnet-4-6: ~2m 0s cache window remaining
```

## Platforms

| Platform | Sound | Desktop Notification | Requirements |
| --- | --- | --- | --- |
| macOS | Built-in Glass sound via `afplay` | Native `osascript` notification | macOS built-ins only |
| WSL 1/2 | Windows system sound | Windows notification-area balloon | Windows PowerShell and WSL interop enabled |
| Windows | Windows system sound | Windows notification-area balloon | Windows PowerShell; best-effort support |
| Desktop Linux | `canberra-gtk-play` | `notify-send` | Optional system packages and a desktop session |

WSL delivery runs on the **Windows host**, not through a Linux audio server or
WSLg. No PowerShell module installation is needed. Native Windows and WSL share
the same notification implementation.

## Install

Add CacheBell to the `plugin` array in your OpenCode configuration
(`~/.config/opencode/opencode.json` for a global installation):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cachebell@0.1.0"]
}
```

Keep your existing settings and other plugin entries. **Quit and restart
OpenCode.** It downloads the published package from npm automatically: no clone,
manual `npm install`, helper script, or build step is needed. This installation
works the same on macOS, WSL, and native Windows. If you use `XDG_CONFIG_HOME`,
substitute that directory for `~/.config`.

The version pin makes upgrades deliberate: change `@0.1.0` to the desired
published version and restart OpenCode. Do not also install a local copy of the
plugin, or you may receive duplicate notifications.

Package: [opencode-cachebell on npm](https://www.npmjs.com/package/opencode-cachebell).

### Manual Installation

For development or an installation without npm, you can instead use the single
JavaScript file directly. Do not combine this with the npm installation above.

Download `index.js` from this repository and put it in OpenCode's plugin directory
as `cachebell.js`:

```sh
mkdir -p ~/.config/opencode/plugins
cp index.js ~/.config/opencode/plugins/cachebell.js
```

For native Windows, from PowerShell in the downloaded repository:

```powershell
New-Item -ItemType Directory -Force "$HOME/.config/opencode/plugins" | Out-Null
Copy-Item ./index.js "$HOME/.config/opencode/plugins/cachebell.js"
```

Alternatively, point `plugin` in your OpenCode configuration at an absolute path
to `index.js`. On Windows use a `file:///C:/.../index.js` URL. Use **one** install
method, not both, to avoid duplicate notifications.

**Quit and restart OpenCode.** It discovers the local plugin automatically. No
`npm install` or build step is required. If you use `XDG_CONFIG_HOME`, substitute
that directory for `~/.config`.

## Timing

| Default Detection (API Model ID) | Estimated TTL | Warning After Request Start |
| --- | --- | --- |
| Claude models | 5 minutes | 3 minutes |
| GPT-5.6 and later, including GPT-6 | 30 minutes | 28 minutes |
| Older GPT models / unknown models | Disabled | Configure an explicit override |

The plugin records `chat.headers` for each conversational LLM request, including
tool-loop requests and OpenCode-managed retries. A successful completed assistant
message with **reported cache reads or writes** confirms the estimate. The timer
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
    ["opencode-cachebell@0.1.0", {
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
| `sound` | `true` | Play the platform sound. |
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

MIT licensed.
