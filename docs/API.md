# red-alert HTTP API

The daemon speaks JSON over HTTP, by default on `http://127.0.0.1:1701`.
The Claude Code mod and the `red-alert` CLI are both clients of this API;
anything else that can send an HTTP request can raise alerts too.

## Conventions

- Every response is JSON with `"ok": true` on success, or `"ok": false` and an
  `"error"` message with a 4xx/5xx status.
- `POST` requests must send `Content-Type: application/json` (an empty body is
  fine where nothing is required). Requests carrying an `Origin` header are
  refused, so a web page in a browser cannot sound alarms through the API.
- When `server.token` is set in the config, every `POST` and `GET /history`
  needs `Authorization: Bearer <token>`. `GET /health` and `GET /levels` stay
  open so a client can always tell whether the daemon is up.

## `GET /health`

Liveness and current state. The mod polls this to draw the online indicator.

```json
{
  "ok": true,
  "service": "red-alert",
  "version": "0.2.0",
  "hostname": "bridge",
  "time": 1760000000.0,
  "uptime_s": 3600.2,
  "player": "auto (pw-play, ffplay, aplay)",
  "levels": ["normal", "yellow", "red"],
  "levels_hash": "4f9c2a1b7e30",
  "playing": { "id": "f71458edfe38", "level": "red" },
  "mute": { "until": 1760001800.0 },
  "last_alert": { "...": "an alert, see below" }
}
```

`playing` and `last_alert` are `null` when there is none; `mute` is `null` when
not muted, and `{"until": null}` when muted until unmuted. `levels_hash`
changes whenever the level definitions change, so clients know to re-read
`/levels`.

## `GET /levels`

The configured levels, lowest priority first.

```json
{
  "ok": true,
  "levels": [
    {
      "name": "red",
      "priority": 90,
      "description": "The user is needed now: ...",
      "color": "#FF3333",
      "style": "klaxon",
      "sound": "https://www.trekcore.com/audio/redalertandklaxons/tng_red_alert1.mp3",
      "sound_ready": true,
      "volume": 100,
      "duration": 12.0,
      "cooldown_seconds": 0.0,
      "notify": true
    }
  ]
}
```

`duration` is how long the level sounds, in seconds: a longer sound is cut
there, a shorter one loops until then; `0` plays the sound once, in full.
`sound_ready` says whether the sound file is on disk (URLs are downloaded in
the background at startup and on first use).

## `POST /alert`

Sound an alert.

```json
{ "level": "red", "message": "Need your decision on the schema", "source": "claude-code:myproject", "title": "RED ALERT", "duration": 30 }
```

Only `level` is required. `message` is cut at 500 characters; `title`
defaults to `<LEVEL> ALERT` and is used for the desktop notification.
`duration` (seconds, 0 to 300) overrides the level's own for this alert.

```json
{
  "ok": true,
  "alert": {
    "id": "f71458edfe38",
    "level": "red",
    "priority": 90,
    "color": "#FF3333",
    "style": "klaxon",
    "title": "RED ALERT",
    "message": "Need your decision on the schema",
    "source": "claude-code:myproject",
    "time": 1760000000.0,
    "duration": 30.0,
    "status": "playing",
    "detail": null
  }
}
```

An unknown level is a `404` whose body lists the valid ones in `levels`.

### Alert status

| status | meaning |
| --- | --- |
| `playing` | the sound is playing now |
| `played` | it played to the end, or for its `duration` |
| `stopped` | someone stopped it (`POST /stop`; `0` in Claude Code) |
| `preempted` | a higher- or equal-priority alert took over the speaker |
| `suppressed` | not played: a higher-priority alert was playing |
| `cooldown` | not played: the same level sounded within `cooldown_seconds` |
| `muted` | not played: the daemon is muted (desktop notification still shown) |
| `failed` | the sound could not be fetched or no player could play it; see `detail` |

The status in the `POST /alert` response is the one at that moment; read
`/history` for how it ended.

## `POST /stop`

Stop the sound that is playing. With `{"id": "..."}` it stops only that alert,
so one session cannot silence another session's alert by accident.

```json
{ "ok": true, "stopped": "f71458edfe38" }
```

`stopped` is `null` when nothing (or a different alert) was playing.

## `POST /mute` / `POST /unmute`

`{"minutes": 30}` mutes for 30 minutes (the default), `{"minutes": 0}` until
`/unmute`. Muting also stops the current sound. While muted, alerts are still
recorded, shown by the mod and sent as desktop notifications, but make no
sound.

## `GET /history?limit=20`

Recent alerts, newest first (at most `server.history_size` are kept, in
memory).

## `POST /reload`

Re-read the config file; the same as `systemctl --user reload red-alert` or
`kill -HUP`. A config with errors is rejected (`400`) and the old one stays in
force. Changing `server.host` or `server.port` needs a restart.
