# red-alert

**Audible alerts for Claude Code.** Claude decides when its work deserves your
attention and sounds an alert through your server's speakers: a chirp for a
milestone, a yellow alert when a big task is done, a red alert klaxon when
it's blocked and needs you. A Claude Code mod shows whether the alert system is
online and animates every alert in the terminal.

![The red-alert band in Claude Code: idle, red alert, yellow alert and normal alert](docs/preview.svg)

- **Claude chooses the level.** The mod gives Claude an `alert` tool whose
  levels and their "when to use" descriptions come from your config, so
  Claude picks among the levels you define.
- **Any number of levels, any sounds.** Define levels in one TOML file: name,
  sound (URL or file), priority, color, animation, volume and more.
- **Runs in the background.** A small Python daemon (standard library only)
  runs as a systemd user service and starts at boot.
- **LCARS UI in Claude Code.** An online/offline status band above the
  prompt, animated alert banners (klaxon, pulse, sweep), a console pane with
  the alert log, and an `/alert` command.

```
┌───────────────────────── your server ─────────────────────────┐
│                                                               │
│  Claude Code ── red-alert mod ──HTTP──▶ red-alert daemon ──▶ 🔊│
│   (terminal)     · alert tool           127.0.0.1:1701        │
│                  · status band          · levels from TOML    │
│                  · /alert console       · systemd user unit   │
│                                         · desktop notification│
│  red-alert CLI / curl / scripts ──HTTP──▶                     │
└───────────────────────────────────────────────────────────────┘
```

## Default alert levels

| Level | Sound | Claude uses it when… |
| --- | --- | --- |
| `normal` | [TNG communicator chirp](https://www.trekcore.com/audio/communicator/tng_chirp_clean.mp3) | a small milestone or FYI: a long build or test run finished, a progress checkpoint |
| `yellow` | [computer alert](https://www.trekcore.com/audio/computer/alert09.mp3) | a significant body of work is complete and ready for review |
| `red` | [TNG red alert klaxon](https://www.trekcore.com/audio/redalertandklaxons/tng_red_alert1.mp3) | it is blocked, needs a decision, credentials or approval, or something failed badly |

## Requirements

- Linux with systemd and a sound server: PipeWire (`pw-play`) or PulseAudio
  (`paplay`); `ffplay`, `mpv` and `mpg123` also work.
- Python 3.11 or newer (the system Python on Ubuntu 24.04 and Debian 12 is fine).
- Claude Code with mod support (function-hook plugins).

## Install

```bash
git clone https://github.com/dukechain2333/red-alert.git
cd red-alert
./install.sh
red-alert test          # plays every level in turn
```

`install.sh` installs, for your user only:

| What | Where |
| --- | --- |
| daemon and CLI | `~/.local/share/red-alert/`, `~/.local/bin/red-alert` |
| config (kept if it exists) | `~/.config/red-alert/config.toml` |
| systemd user service, started now and at boot | `~/.config/systemd/user/red-alert.service` |
| Claude Code mod | `~/.claude/skills/red-alert/` (loads as `red-alert@skills-dir`) |

The service starts at boot because the installer enables lingering
(`loginctl enable-linger`), which starts your user's services without a
login. Sounds are downloaded once, on first start, to `~/.cache/red-alert/`.

Options: `--no-service` (files only), `--no-mod` (no Claude Code mod),
`--link-mod` (symlink the mod to the checkout while you develop it).

### Install the mod from GitHub instead

The repository is also a plugin marketplace:

```bash
claude plugin marketplace add dukechain2333/red-alert
claude plugin install red-alert@red-alert
```

You still need the daemon: `./install.sh --no-mod`.

## Using it with Claude Code

Start a new Claude Code session after installing. Then:

- **Claude raises alerts by itself.** The mod adds the
  `mcp__red-alert__alert` tool and a short system-prompt note: Claude calls
  it once, as the last step of a turn that did substantial work, or right
  before it stops to ask you something. It skips quick back-and-forth while
  you are at the keyboard. To change how often it alerts, tell it ("only red
  alerts today", "no alerts for this task") or edit the level descriptions.
  The tool never asks for permission, since all it does is play a sound on
  your own machine.
- **The band above the prompt** shows the link status: `● ONLINE`,
  `○ OFFLINE` (with a **Start** button), or `◐ MUTED 25M` (with **Unmute**),
  plus your levels and the last alert. When an alert sounds, the band turns
  into an animated banner:
  - **klaxon** (red): two rows of light bars above and below, with waves
    running outward from the center, and a banner that flashes with marching
    chevrons;
  - **pulse** (yellow): one bar above and below, and the panel breathes;
  - **sweep** (normal): a scanner line passes once.

  After the animation, a red or yellow alert that Claude raised in this
  session stays lit until you acknowledge it: press **Acknowledge** (`a`
  while the band is focused) or just type your next prompt. Either one also
  stops a klaxon that is still sounding.
  Alerts raised elsewhere (another session, the CLI, a script) animate too,
  with their source shown, so every open session sees them.
- **The alert console** (`/alert`) is a pane with the system status, your
  levels (with **Test** buttons on hotkeys `1`–`9`) and the alert log.
  Hotkeys: `s` stop sound, `m` mute 30 min, `u` unmute, `r` refresh,
  `x` close.
- **`/alert` subcommands:** `status`, `test [level]`, `stop`,
  `mute [minutes]` (`0` = until unmuted), `unmute`, `start` (starts the
  systemd service).

```
▐ LCARS 1701 ▌ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ▐ ALERT CONDITION ▌

SYSTEM     ● ONLINE  http://127.0.0.1:1701 · v0.1.0 · bridge · up 3h · auto (pw-play)
CONDITION  GREEN · STANDING BY

▐ LEVELS ▌ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1: Test ▐ NORMAL   ▌ p10  sweep  A light ping: a small milestone or an FYI…
2: Test ▐ YELLOW   ▌ p50  pulse  A significant body of work is complete…
3: Test ▐ RED      ▌ p90  klaxon The user is needed now: you are blocked…

▐ LOG ▌ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
21:04:11  RED     stopped    Need the prod DB password  · claude-code:shop
20:51:37  YELLOW  played     Checkout refactor done, 214 tests pass  · claude-code:shop
20:12:02  NORMAL  played     Nightly build finished  · cli@bridge

[ Stop sound ] [ Mute 30m ] [ Unmute ] [ Refresh ] [ Close ]
```

### Mod settings

Set these in `/config` (or `claude plugin configure red-alert`):

| Setting | Default | |
| --- | --- | --- |
| `url` | `http://127.0.0.1:1701` | where the daemon listens |
| `token` | empty | the daemon's `server.token`, if you set one |
| `pollSeconds` | `5` | how often the band checks the daemon and picks up alerts raised elsewhere |
| `permissionPromptLevel` | `off` | sound this level whenever Claude Code waits on a permission prompt, the one wait Claude cannot announce itself (e.g. `red`) |
| `idleBand` | `true` | show the status strip while no alert is up |

## Customizing levels

Edit `~/.config/red-alert/config.toml`, then run `red-alert reload`.
Claude Code picks up the change on its own: the mod rebuilds the alert tool
from the daemon's levels.

```toml
[[levels]]
name = "deploy"                     # what Claude passes as the level
priority = 40                       # higher wins when alerts overlap
sound = "~/sounds/fanfare.ogg"      # https:// URL or a file path
style = "pulse"                     # sweep | pulse | klaxon
color = "#33CC99"
volume = 70                         # 0-100
repeat = 2                          # play it twice
max_seconds = 8                     # cut long sounds short (0 = no limit)
cooldown_seconds = 30               # ignore repeats within 30 s
notify = true                       # also show a desktop notification
description = "A deployment or release finished successfully."
```

Claude reads each `description` to decide which level to use, so write it as
advice on **when** to use the level. Overlapping alerts: a higher-priority
alert cuts off a lower one that is still playing, and a lower one is skipped
while a higher one plays. See [`config.example.toml`](config.example.toml)
for every option, including `audio.player` (choose a player or give your
own command line) and `server.token`.

## CLI

```
red-alert send LEVEL [MESSAGE...]   sound an alert (--title, --source, --json)
red-alert status                    is the daemon up? what is playing?
red-alert levels                    the configured levels
red-alert history [-n 20]           recent alerts
red-alert test [LEVEL]              play one level, or all of them in turn
red-alert stop [ID]                 silence the alert that is playing
red-alert mute [MINUTES]            mute (default 30; 0 = until unmuted)
red-alert unmute
red-alert reload                    re-read the config
red-alert serve                     run the daemon in the foreground
```

The CLI finds the daemon through the config file, `$RED_ALERT_URL` or `--url`
(and `$RED_ALERT_TOKEN` or `--token`). It exits with 3 when the daemon is
unreachable.

## HTTP API

```bash
curl -s localhost:1701/health
curl -s -X POST localhost:1701/alert -H 'Content-Type: application/json' \
     -d '{"level": "yellow", "message": "Backup finished", "source": "cron"}'
```

Endpoints: `GET /health`, `GET /levels`, `GET /history`, `POST /alert`,
`POST /stop`, `POST /mute`, `POST /unmute`, `POST /reload`. See
[docs/API.md](docs/API.md).

## Without the mod

Any Claude Code session that can run shell commands can use the CLI. Put
this in your `CLAUDE.md`:

```markdown
## Alerts
This machine runs red-alert. When you finish a significant task, or right
before you stop to ask me something, run exactly one of:
- `red-alert send normal "<what finished>"`: small milestone or FYI
- `red-alert send yellow "<summary>"`: a big task is done and ready for review
- `red-alert send red "<what you need>"`: you are blocked and need me now
Skip it for quick back-and-forth while I'm at the keyboard.
```

## Claude Code on another machine

The simplest setup is an SSH tunnel, which keeps the daemon on localhost:

```bash
ssh -N -L 1701:127.0.0.1:1701 you@your-server
```

To expose the daemon on the network instead, set `server.host = "0.0.0.0"`
**and** a `server.token` in the config, restart the service, and set the
mod's `url` and `token` to match.

## Troubleshooting

- **`red-alert status` says offline.** Run `systemctl --user status red-alert`
  and `journalctl --user -u red-alert -e`.
- **No sound, but the status says `played`.** The player reached the sound
  server; check the default output and its volume with `wpctl status` (or
  `pactl info`). Try `pw-play some.wav` yourself.
- **Status `failed`.** `red-alert history` shows the reason. Usually a sound
  could not be downloaded (`red-alert levels` flags uncached sounds) or no
  player could decode it: install `ffmpeg` or set `audio.player`.
- **Silent after a reboot until someone logs in.** Lingering starts the
  service at boot, but some setups only give the sound card to the user
  logged in at the console. Enable automatic login for the desktop, or point
  `audio.player` at a player that writes to ALSA directly.
- **Downloading from trekcore.com fails with 406.** The site rejects some user
  agents; the daemon sends its own (`red-alert/<version>`), which works. If
  it changes, download the files yourself and point `sound` at them.

## Uninstall

```bash
./uninstall.sh            # keeps ~/.config/red-alert
./uninstall.sh --purge    # also removes the config and cached sounds
```

## Development

```bash
python3 -m unittest discover -s tests       # daemon tests (a fake player, no sound)
claude plugin validate plugin               # the mod's manifest and hooks
claude plugin test plugin                   # the mod's tests (mocked daemon and clock)
```

To type-check the mod, run `/plugin-types plugin/.claude/types` in Claude
Code, then `npx -p typescript tsc -p plugin`.

Layout: `red_alert.py` (daemon and CLI), `config.example.toml`,
`systemd/`, `install.sh`, `plugin/` (the Claude Code mod: `hooks/register.tsx`
hooks and UI, `hooks/frames.ts` animation frames, `hooks/api.ts` API types,
`types/index.d.ts` its state contract), `tests/`.

## Credits

The default sounds are fetched from [TrekCore](https://www.trekcore.com/audio/)
when the daemon first starts. They are not part of this repository. Star Trek
and its sounds belong to their respective owners; swap in your own sounds if
you need to. The UI borrows the look of LCARS, the Star Trek computer
interface.

## License

[MIT](LICENSE)
