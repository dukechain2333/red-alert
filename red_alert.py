#!/usr/bin/env python3
"""red-alert: audible alerts for Claude Code.

One file, standard library only (Python 3.11+ for the TOML config):

    red-alert serve              run the alert daemon (systemd runs this)
    red-alert send red "msg"     raise an alert
    red-alert status | levels | history | stop | mute | unmute | test | reload

The daemon listens on 127.0.0.1:1701 by default, exposes a small JSON API
(docs/API.md) and plays each alert level's sound on this machine's speakers.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import logging
import math
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import deque
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ModuleNotFoundError:
        tomllib = None  # type: ignore[assignment]

VERSION = "0.2.0"
PROJECT_URL = "https://github.com/dukechain2333/red-alert"
USER_AGENT = f"red-alert/{VERSION} (+{PROJECT_URL})"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 1701
STYLES = ("sweep", "pulse", "klaxon")
DEFAULT_COLORS = {"sweep": "#99CCFF", "pulse": "#FFCC00", "klaxon": "#FF3333"}
LEVEL_NAME = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_BODY = 64 * 1024
MAX_MESSAGE = 500
HARD_CAP_SECONDS = 300  # no alert sounds longer than this
MIN_LOOP_SECONDS = 0.05  # a play shorter than this ends a loop (an empty file)

log = logging.getLogger("red-alert")


def _xdg(var: str, fallback: str) -> Path:
    return Path(os.environ.get(var) or Path.home() / fallback)


CONFIG_PATH = _xdg("XDG_CONFIG_HOME", ".config") / "red-alert" / "config.toml"
CACHE_DIR = _xdg("XDG_CACHE_HOME", ".cache") / "red-alert"
EXAMPLE_CONFIG = Path(__file__).resolve().with_name("config.example.toml")


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Level:
    name: str
    sound: str
    priority: int
    description: str
    color: str
    style: str
    volume: int
    duration: float  # seconds: cut a longer sound, loop a shorter one; 0 = play once
    cooldown_seconds: float
    notify: bool

    def public(self, sound_ready: bool) -> dict:
        return {
            "name": self.name,
            "priority": self.priority,
            "description": self.description,
            "color": self.color,
            "style": self.style,
            "sound": self.sound,
            "sound_ready": sound_ready,
            "volume": self.volume,
            "duration": self.duration,
            "cooldown_seconds": self.cooldown_seconds,
            "notify": self.notify,
        }


@dataclass(frozen=True)
class Config:
    path: Path | None
    host: str
    port: int
    token: str
    player: str
    cache_dir: Path
    history_size: int
    levels: tuple[Level, ...]

    def level(self, name: str) -> Level:
        wanted = name.strip().lower()
        for level in self.levels:
            if level.name == wanted:
                return level
        raise KeyError(name)


def is_url(source: str) -> bool:
    return source.startswith(("http://", "https://"))


def _number(table: dict, key: str, default, where: str, lo=None, hi=None, kind=int):
    value = table.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"{where}.{key} must be a number")
    value = kind(value)
    if (lo is not None and value < lo) or (hi is not None and value > hi):
        raise ConfigError(f"{where}.{key} must be between {lo} and {hi}")
    return value


def parse_config(raw: dict, path: Path | None) -> Config:
    server = raw.get("server", {})
    audio = raw.get("audio", {})
    base = path.parent if path else Path.cwd()

    levels: list[Level] = []
    for index, item in enumerate(raw.get("levels", [])):
        where = f"levels[{index}]"
        name = str(item.get("name", "")).strip().lower()
        if not LEVEL_NAME.match(name):
            raise ConfigError(f"{where}.name {name!r} must match {LEVEL_NAME.pattern}")
        if any(level.name == name for level in levels):
            raise ConfigError(f"{where}: duplicate level name {name!r}")
        where = f"level '{name}'"
        for legacy in ("repeat", "max_seconds"):
            if legacy in item:
                raise ConfigError(
                    f"{where}: `{legacy}` was replaced by `duration` (seconds: a longer "
                    "sound is cut, a shorter one loops; 0 plays it once)"
                )

        sound = item.get("sound")
        if not isinstance(sound, str) or not sound.strip():
            raise ConfigError(f"{where}: sound (a URL or a file path) is required")
        sound = sound.strip()
        if not is_url(sound):
            sound_path = Path(os.path.expanduser(sound))
            sound = str(sound_path if sound_path.is_absolute() else base / sound_path)

        priority = _number(item, "priority", (index + 1) * 10, where)
        style = item.get("style") or (
            "klaxon" if priority >= 80 else "pulse" if priority >= 40 else "sweep"
        )
        if style not in STYLES:
            raise ConfigError(f"{where}.style must be one of {', '.join(STYLES)}")
        color = item.get("color", DEFAULT_COLORS[style])
        if not isinstance(color, str) or not HEX_COLOR.match(color):
            raise ConfigError(f"{where}.color must look like #RRGGBB")
        notify = item.get("notify", priority >= 40)
        if not isinstance(notify, bool):
            raise ConfigError(f"{where}.notify must be true or false")

        levels.append(
            Level(
                name=name,
                sound=sound,
                priority=priority,
                description=" ".join(str(item.get("description", "")).split())
                or f"The '{name}' alert.",
                color=color.upper(),
                style=style,
                volume=_number(item, "volume", 100, where, 0, 100),
                duration=_number(item, "duration", 0, where, 0, HARD_CAP_SECONDS, float),
                cooldown_seconds=_number(item, "cooldown_seconds", 0, where, 0, 86400, float),
                notify=notify,
            )
        )
    if not levels:
        raise ConfigError("define at least one [[levels]] table")
    levels.sort(key=lambda level: level.priority)

    player = audio.get("player", "auto")
    if not isinstance(player, str):
        raise ConfigError("audio.player must be a string")
    cache_dir = Path(os.path.expanduser(str(audio.get("cache_dir", CACHE_DIR))))
    token = server.get("token", "")
    if not isinstance(token, str):
        raise ConfigError("server.token must be a string")

    return Config(
        path=path,
        host=str(server.get("host", DEFAULT_HOST)),
        port=_number(server, "port", DEFAULT_PORT, "server", 1, 65535),
        token=token,
        player=player,
        cache_dir=cache_dir,
        history_size=_number(server, "history_size", 200, "server", 1, 10000),
        levels=tuple(levels),
    )


def load_config(path: Path | None = None) -> Config:
    if tomllib is None:
        raise ConfigError("reading the TOML config needs Python 3.11+ (or `pip install tomli`)")
    if path is None:
        path = CONFIG_PATH if CONFIG_PATH.exists() else EXAMPLE_CONFIG
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"config file not found: {path}") from None
    except tomllib.TOMLDecodeError as err:
        raise ConfigError(f"{path}: {err}") from None
    return parse_config(raw, path)


# --------------------------------------------------------------------------
# Sounds and players
# --------------------------------------------------------------------------


class SoundCache:
    """Maps a level's `sound` to a local file, downloading URLs once."""

    def __init__(self, cache_dir: Path):
        self.dir = cache_dir / "sounds"
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def path_for(self, source: str) -> Path:
        if not is_url(source):
            return Path(source)
        name = Path(urllib.parse.urlparse(source).path).name or "sound"
        digest = hashlib.sha256(source.encode()).hexdigest()[:12]
        return self.dir / f"{digest}-{name}"

    def is_ready(self, source: str) -> bool:
        path = self.path_for(source)
        return path.is_file() and path.stat().st_size > 0

    def fetch(self, source: str, timeout: float = 30) -> Path:
        path = self.path_for(source)
        if self.is_ready(source):
            return path
        if not is_url(source):
            raise FileNotFoundError(f"sound file not found: {path}")
        with self._guard:
            lock = self._locks.setdefault(source, threading.Lock())
        with lock:
            if self.is_ready(source):
                return path
            self.dir.mkdir(parents=True, exist_ok=True)
            partial = path.with_name(path.name + ".part")
            request = urllib.request.Request(
                source, headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
            )
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    kind = response.headers.get("Content-Type", "")
                    if kind.startswith("text/"):
                        raise ValueError(f"server sent {kind}, not audio")
                    with open(partial, "wb") as out:
                        shutil.copyfileobj(response, out)
                os.replace(partial, path)
            finally:
                partial.unlink(missing_ok=True)
            log.info("cached %s -> %s", source, path)
            return path


def _volume_scale(volume: int, full: int) -> str:
    return str(round(volume / 100 * full))


PLAYERS = {
    "pw-play": lambda file, v: ["pw-play", f"--volume={v / 100:.2f}", file],
    "paplay": lambda file, v: ["paplay", f"--volume={_volume_scale(v, 65536)}", file],
    "ffplay": lambda file, v: [
        "ffplay", "-nodisp", "-autoexit", "-loglevel", "error", "-volume", str(v), file,
    ],
    "mpv": lambda file, v: ["mpv", "--no-video", "--really-quiet", f"--volume={v}", file],
    "mpg123": lambda file, v: ["mpg123", "-q", "-f", _volume_scale(v, 32768), file],
    "afplay": lambda file, v: ["afplay", "-v", f"{v / 100:.2f}", file],
    "aplay": lambda file, v: ["aplay", "-q", file],
}
AUTO_ORDER = ("pw-play", "paplay", "ffplay", "mpv", "mpg123", "afplay", "aplay")


class Player:
    """Builds the command that plays a file, falling back across players."""

    def __init__(self, spec: str):
        self.spec = spec.strip() or "auto"
        if "{file}" in self.spec:
            self.candidates = ["custom"]
        elif self.spec == "auto":
            self.candidates = [name for name in AUTO_ORDER if shutil.which(name)]
        elif self.spec in PLAYERS:
            self.candidates = [self.spec]
        else:
            raise ConfigError(
                f"audio.player {spec!r}: use auto, one of {', '.join(PLAYERS)}, "
                "or a command containing {file}"
            )
        self.working: dict[str, str] = {}  # file suffix -> player that played it

    def describe(self) -> str:
        if self.spec == "auto":
            return f"auto ({', '.join(self.candidates) or 'none found'})"
        return self.spec

    def order(self, path: Path) -> list[str]:
        known = self.working.get(path.suffix.lower())
        return ([known] if known else []) + [c for c in self.candidates if c != known]

    def argv(self, player: str, path: Path, volume: int) -> list[str]:
        if player == "custom":
            values = {"{file}": str(path), "{volume}": str(volume), "{gain}": f"{volume / 100:.2f}"}
            argv = []
            for part in shlex.split(self.spec):
                for placeholder, value in values.items():
                    part = part.replace(placeholder, value)
                argv.append(part)
            return argv
        return PLAYERS[player](str(path), volume)


class _Job:
    def __init__(self, alert_id: str, level: Level, path: Path, duration: float):
        self.alert_id = alert_id
        self.level = level
        self.path = path
        self.duration = duration
        self.stop = threading.Event()
        self.reason: str | None = None
        self.proc: subprocess.Popen | None = None


class Playback:
    """Plays one alert at a time; a new alert takes over the speaker."""

    def __init__(self, player: Player, on_done):
        self.player = player
        self.on_done = on_done
        self._lock = threading.Lock()
        self._current: _Job | None = None

    def current(self) -> _Job | None:
        with self._lock:
            return self._current

    def start(self, alert_id: str, level: Level, path: Path, duration: float) -> None:
        job = _Job(alert_id, level, path, duration)
        with self._lock:
            previous, self._current = self._current, job
        if previous:
            self._halt(previous, "preempted")
        threading.Thread(target=self._run, args=(job,), name=f"play-{alert_id}", daemon=True).start()

    def stop(self, alert_id: str | None = None) -> str | None:
        with self._lock:
            job = self._current
        if job is None or (alert_id and job.alert_id != alert_id):
            return None
        self._halt(job, "stopped")
        return job.alert_id

    @staticmethod
    def _halt(job: _Job, reason: str) -> None:
        job.reason = job.reason or reason
        job.stop.set()
        proc = job.proc
        if proc and proc.poll() is None:
            proc.terminate()

    def _run(self, job: _Job) -> None:
        """Plays the sound once, or loops it until `duration` runs out, cutting the last play."""
        status, detail = "played", None
        start = time.monotonic()
        deadline = start + (job.duration or HARD_CAP_SECONDS)
        try:
            while not job.stop.is_set() and time.monotonic() < deadline:
                began = time.monotonic()
                ok, detail = self._play_once(job, deadline)
                if not ok:
                    status = "failed"
                    break
                if not job.duration or time.monotonic() - began < MIN_LOOP_SECONDS:
                    break
        except Exception as err:  # never let a playback thread die silently
            status, detail = "failed", str(err)
        finally:
            with self._lock:
                if self._current is job:
                    self._current = None
            if job.stop.is_set():
                status = job.reason or "stopped"
            self.on_done(job.alert_id, status, detail)

    def _play_once(self, job: _Job, deadline: float) -> tuple[bool, str | None]:
        errors = []
        for player in self.player.order(job.path):
            if job.stop.is_set():
                return True, None
            argv = self.player.argv(player, job.path, job.level.volume)
            try:
                proc = subprocess.Popen(
                    argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
                )
            except OSError as err:
                errors.append(f"{player}: {err}")
                continue
            job.proc = proc
            if job.stop.is_set():
                proc.terminate()
            try:
                _, stderr = proc.communicate(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:  # duration reached: cut the sound
                proc.terminate()
                try:
                    proc.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                return True, None
            if proc.returncode == 0 or job.stop.is_set():
                self.player.working[job.path.suffix.lower()] = player
                return True, None
            message = stderr.decode(errors="replace").strip().splitlines()
            errors.append(f"{player} exited {proc.returncode}: {message[-1] if message else ''}")
        if not errors:
            errors.append("no audio player found (install pipewire, pulseaudio-utils, ffmpeg or mpv)")
        return False, "; ".join(errors)


def desktop_notify(level: Level, title: str, message: str) -> None:
    if not shutil.which("notify-send"):
        return
    urgency = "critical" if level.style == "klaxon" else "normal" if level.style == "pulse" else "low"
    argv = ["notify-send", "-a", "Red Alert", "-u", urgency, title, message]

    def run() -> None:
        try:
            subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=10)
        except (OSError, subprocess.SubprocessError) as err:
            log.debug("notify-send failed: %s", err)

    threading.Thread(target=run, name="notify", daemon=True).start()


# --------------------------------------------------------------------------
# The alert system
# --------------------------------------------------------------------------


class AlertSystem:
    def __init__(self, config: Config):
        self.started = time.time()
        self._lock = threading.RLock()
        self.history: deque[dict] = deque(maxlen=config.history_size)
        self.last_sounded: dict[str, float] = {}
        self.mute_until: float | None = None
        self.config = config
        self.player = Player(config.player)
        self.sounds = SoundCache(config.cache_dir)
        self.playback = Playback(self.player, self._finished)
        self.prefetch()

    # -- configuration -----------------------------------------------------

    def reload(self) -> Config:
        config = load_config(self.config.path)
        player = Player(config.player)
        with self._lock:
            if (config.host, config.port) != (self.config.host, self.config.port):
                log.warning("server.host/port changed: restart the service to apply it")
            self.config = config
            self.player = self.playback.player = player
            self.sounds = SoundCache(config.cache_dir)
            self.history = deque(self.history, maxlen=config.history_size)
        self.prefetch()
        log.info("config reloaded: levels %s", ", ".join(l.name for l in config.levels))
        return config

    def prefetch(self) -> None:
        levels, sounds = self.config.levels, self.sounds

        def run() -> None:
            for level in levels:
                try:
                    sounds.fetch(level.sound)
                except Exception as err:
                    log.warning("level %s: cannot fetch %s: %s", level.name, level.sound, err)

        threading.Thread(target=run, name="prefetch", daemon=True).start()

    # -- state -------------------------------------------------------------

    def is_muted(self, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            if self.mute_until is not None and now >= self.mute_until:
                self.mute_until = None
            return self.mute_until is not None

    def mute(self, minutes: float) -> dict:
        with self._lock:
            self.mute_until = math.inf if minutes <= 0 else time.time() + minutes * 60
        self.playback.stop()
        return self.mute_state()

    def unmute(self) -> None:
        with self._lock:
            self.mute_until = None

    def mute_state(self) -> dict | None:
        if not self.is_muted():
            return None
        until = self.mute_until
        return {"until": None if until is None or math.isinf(until) else until}

    def levels_public(self) -> list[dict]:
        return [level.public(self.sounds.is_ready(level.sound)) for level in self.config.levels]

    def levels_hash(self) -> str:
        public = [level.public(False) for level in self.config.levels]
        return hashlib.sha256(json.dumps(public, sort_keys=True).encode()).hexdigest()[:12]

    def health(self) -> dict:
        now = time.time()
        job = self.playback.current()
        with self._lock:
            last = dict(self.history[-1]) if self.history else None
        return {
            "ok": True,
            "service": "red-alert",
            "version": VERSION,
            "hostname": socket.gethostname(),
            "time": now,
            "uptime_s": round(now - self.started, 1),
            "player": self.player.describe(),
            "levels": [level.name for level in self.config.levels],
            "levels_hash": self.levels_hash(),
            "playing": {"id": job.alert_id, "level": job.level.name} if job else None,
            "mute": self.mute_state(),
            "last_alert": last,
        }

    def recent(self, limit: int) -> list[dict]:
        with self._lock:
            return [dict(alert) for alert in list(self.history)[-limit:]][::-1]

    # -- alerts ------------------------------------------------------------

    def sound(
        self,
        level_name: str,
        message: str = "",
        title: str = "",
        source: str = "",
        duration: float | None = None,
    ) -> dict:
        """Sounds `level`; `duration` overrides the level's own for this alert."""
        level = self.config.level(level_name)
        if duration is None:
            duration = level.duration
        now = time.time()
        alert = {
            "id": uuid.uuid4().hex[:12],
            "level": level.name,
            "priority": level.priority,
            "color": level.color,
            "style": level.style,
            "title": title[:120] or f"{level.name.upper()} ALERT",
            "message": message[:MAX_MESSAGE],
            "source": source[:120],
            "time": now,
            "duration": duration,
            "status": "playing",
            "detail": None,
        }
        current = self.playback.current()
        with self._lock:
            if self.is_muted(now):
                alert["status"] = "muted"
            elif now - self.last_sounded.get(level.name, -math.inf) < level.cooldown_seconds:
                alert["status"] = "cooldown"
            elif current and current.level.priority > level.priority:
                alert["status"] = "suppressed"
                alert["detail"] = f"a {current.level.name} alert is playing"
            else:
                self.last_sounded[level.name] = now
            self.history.append(alert)

        if alert["status"] == "playing":
            try:
                path = self.sounds.fetch(level.sound, timeout=10)
            except Exception as err:
                self._finished(alert["id"], "failed", f"sound unavailable: {err}")
            else:
                self.playback.start(alert["id"], level, path, duration)
        if level.notify and alert["status"] != "cooldown":
            desktop_notify(level, alert["title"], alert["message"] or alert["title"])

        log.info(
            "%s alert %s from %s: %s [%s]",
            level.name, alert["id"], source or "?", message or "-", alert["status"],
        )
        with self._lock:
            return dict(alert)

    def _finished(self, alert_id: str, status: str, detail: str | None) -> None:
        with self._lock:
            for alert in self.history:
                if alert["id"] == alert_id:
                    alert["status"] = status
                    alert["detail"] = detail
                    break
        if status == "failed":
            log.error("alert %s failed to play: %s", alert_id, detail)


# --------------------------------------------------------------------------
# HTTP API
# --------------------------------------------------------------------------


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


class AlertServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, system: AlertSystem):
        super().__init__(address, Handler)
        self.system = system


class Handler(BaseHTTPRequestHandler):
    server: AlertServer
    server_version = f"red-alert/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:  # noqa: A002 (stdlib name)
        log.debug("%s %s", self.address_string(), format % args)

    # -- plumbing ------------------------------------------------------------

    def _reply(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _require_token(self) -> None:
        token = self.server.system.config.token
        if not token:
            return
        given = self.headers.get("Authorization", "")
        if not hmac.compare_digest(given.encode(), f"Bearer {token}".encode()):
            raise ApiError(401, "missing or wrong bearer token")

    def _json_body(self) -> dict:
        # Browsers always send Origin on cross-site requests and cannot send
        # application/json without a preflight we never answer: both together
        # keep web pages from sounding alarms through a visitor's browser.
        if self.headers.get("Origin"):
            raise ApiError(403, "requests from web pages are not accepted")
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            raise ApiError(415, "send Content-Type: application/json")
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "body too large")
        raw = self.rfile.read(length) if length else b""
        if not raw.strip():
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            raise ApiError(400, "body is not valid JSON") from None
        if not isinstance(data, dict):
            raise ApiError(400, "body must be a JSON object")
        return data

    def _handle(self, routes: dict) -> None:
        path, _, query = self.path.partition("?")
        route = routes.get(path.rstrip("/") or "/")
        try:
            if route is None:
                raise ApiError(404, f"no route {self.command} {path}")
            self._reply(200, route(urllib.parse.parse_qs(query)))
        except ApiError as err:
            self._reply(err.status, {"ok": False, "error": str(err), **err.extra})
        except Exception as err:
            log.exception("error handling %s %s", self.command, path)
            self._reply(500, {"ok": False, "error": f"internal error: {err}"})

    # -- routes --------------------------------------------------------------

    def do_GET(self) -> None:
        system = self.server.system

        def history(query: dict) -> dict:
            self._require_token()
            try:
                limit = max(1, min(int(query.get("limit", ["20"])[0]), 1000))
            except ValueError:
                raise ApiError(400, "limit must be an integer") from None
            return {"ok": True, "alerts": system.recent(limit)}

        self._handle(
            {
                "/": lambda q: {"ok": True, "service": "red-alert", "version": VERSION},
                "/health": lambda q: system.health(),
                "/levels": lambda q: {"ok": True, "levels": system.levels_public()},
                "/history": history,
            }
        )

    def do_POST(self) -> None:
        system = self.server.system

        def body() -> dict:
            data = self._json_body()
            self._require_token()
            return data

        def text(data: dict, key: str) -> str:
            value = data.get(key, "")
            if not isinstance(value, str):
                raise ApiError(400, f"{key} must be a string")
            return " ".join(value.split())

        def alert(_: dict) -> dict:
            data = body()
            level = text(data, "level")
            if not level:
                raise ApiError(400, "level is required", levels=[l.name for l in system.config.levels])
            duration = data.get("duration")
            if duration is not None and (
                isinstance(duration, bool)
                or not isinstance(duration, (int, float))
                or not 0 <= duration <= HARD_CAP_SECONDS
            ):
                raise ApiError(400, f"duration must be a number of seconds from 0 to {HARD_CAP_SECONDS}")
            try:
                result = system.sound(
                    level,
                    text(data, "message"),
                    text(data, "title"),
                    text(data, "source"),
                    None if duration is None else float(duration),
                )
            except KeyError:
                raise ApiError(
                    404, f"unknown level {level!r}", levels=[l.name for l in system.config.levels]
                ) from None
            return {"ok": True, "alert": result}

        def stop(_: dict) -> dict:
            data = body()
            alert_id = text(data, "id") or None
            return {"ok": True, "stopped": system.playback.stop(alert_id)}

        def mute(_: dict) -> dict:
            minutes = body().get("minutes", 30)
            if isinstance(minutes, bool) or not isinstance(minutes, (int, float)) or minutes < 0:
                raise ApiError(400, "minutes must be a number >= 0 (0 mutes until unmuted)")
            return {"ok": True, "mute": system.mute(float(minutes))}

        def unmute(_: dict) -> dict:
            body()
            system.unmute()
            return {"ok": True, "mute": None}

        def reload(_: dict) -> dict:
            body()
            try:
                system.reload()
            except ConfigError as err:
                raise ApiError(400, f"config not reloaded: {err}") from None
            return {"ok": True, "levels": system.levels_public()}

        self._handle(
            {"/alert": alert, "/stop": stop, "/mute": mute, "/unmute": unmute, "/reload": reload}
        )


def serve(args: argparse.Namespace) -> int:
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )
    try:
        config = load_config(args.config)
    except ConfigError as err:
        log.error("%s", err)
        return 2
    system = AlertSystem(config)
    host, port = args.host or config.host, args.port or config.port
    try:
        server = AlertServer((host, port), system)
    except OSError as err:
        log.error("cannot listen on %s:%d: %s", host, port, err)
        return 1

    def on_hup(*_) -> None:
        def run() -> None:
            try:
                system.reload()
            except ConfigError as err:
                log.error("config not reloaded: %s", err)

        threading.Thread(target=run, daemon=True).start()

    def on_term(*_) -> None:
        system.playback.stop()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGHUP, on_hup)
    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    log.info(
        "red-alert %s listening on http://%s:%d (config %s, player %s, levels %s)",
        VERSION, host, port, config.path, system.player.describe(),
        ", ".join(level.name for level in config.levels),
    )
    if host not in ("127.0.0.1", "localhost", "::1") and not config.token:
        log.warning("listening beyond localhost without server.token: anyone on the network can sound alerts")
    server.serve_forever()
    server.server_close()
    log.info("stopped")
    return 0


# --------------------------------------------------------------------------
# Client / CLI
# --------------------------------------------------------------------------


class Offline(Exception):
    pass


class ClientError(Exception):
    def __init__(self, message: str, payload: dict):
        super().__init__(message)
        self.payload = payload


class Client:
    def __init__(self, url: str, token: str = "", timeout: float = 15):
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def get(self, path: str) -> dict:
        return self._request("GET", path)

    def post(self, path: str, body: dict | None = None) -> dict:
        return self._request("POST", path, body or {})

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        data = None
        if method == "POST":
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as err:
            try:
                payload = json.loads(err.read())
            except ValueError:
                payload = {}
            raise ClientError(payload.get("error") or str(err), payload) from None
        except (urllib.error.URLError, OSError) as err:
            reason = getattr(err, "reason", err)
            raise Offline(f"alert daemon not reachable at {self.url} ({reason})") from None


def client_from_args(args: argparse.Namespace) -> Client:
    url = args.url or os.environ.get("RED_ALERT_URL")
    token = args.token or os.environ.get("RED_ALERT_TOKEN", "")
    if not url or not token:
        try:
            config = load_config(args.config)
        except ConfigError:
            config = None
        if config and not url:
            host = "127.0.0.1" if config.host in ("0.0.0.0", "::", "") else config.host
            url = f"http://{host}:{config.port}"
        if config and not token:
            token = config.token
    return Client(url or f"http://{DEFAULT_HOST}:{DEFAULT_PORT}", token)


def _paint(text: str, color: str | None = None, bold: bool = False) -> str:
    if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
        return text
    codes = ["1"] if bold else []
    if color and HEX_COLOR.match(color):
        r, g, b = (int(color[i : i + 2], 16) for i in (1, 3, 5))
        codes.append(f"38;2;{r};{g};{b}")
    return f"\033[{';'.join(codes)}m{text}\033[0m" if codes else text


def _ago(seconds: float) -> str:
    seconds = max(0, int(seconds))
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if seconds >= size:
            return f"{seconds // size}{unit} ago"
    return f"{seconds}s ago"


def _duration(seconds: float) -> str:
    seconds = int(seconds)
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes = seconds // 60
    return f"{days}d{hours}h" if days else f"{hours}h{minutes:02d}m" if hours else f"{minutes}m"


def _length(duration: float) -> str:
    return "plays once" if not duration else f"sounds {duration:g}s"


def _print_alert(alert: dict, now: float) -> None:
    level = _paint(f"{alert['level'].upper():<8}", alert.get("color"), bold=True)
    when = time.strftime("%H:%M:%S", time.localtime(alert["time"]))
    message = alert.get("message") or "-"
    source = f"  ({alert['source']})" if alert.get("source") else ""
    print(f"{when}  {level} {alert['status']:<10} {message}{source}  {_ago(now - alert['time'])}")


def cli(args: argparse.Namespace) -> int:
    client = client_from_args(args)
    as_json = getattr(args, "json", False)

    def show(payload: dict) -> None:
        print(json.dumps(payload, indent=2))

    if args.command == "send":
        message = " ".join(args.message)
        body = {"level": args.level, "message": message, "title": args.title or "", "source": args.source}
        if args.duration is not None:
            body["duration"] = args.duration
        reply = client.post("/alert", body)
        if as_json:
            show(reply)
        else:
            alert = reply["alert"]
            print(f"{_paint(alert['level'].upper(), alert['color'], True)} alert {alert['id']}: {alert['status']}")
        return 0

    if args.command == "status":
        health = client.get("/health")
        if as_json:
            show(health)
            return 0
        print(
            f"red-alert {_paint('● online', '#66DD66', True)}  v{health['version']} on "
            f"{health['hostname']}, up {_duration(health['uptime_s'])}, player {health['player']}"
        )
        print(f"levels   {', '.join(health['levels'])}")
        mute = health.get("mute")
        if mute:
            until = mute.get("until")
            print(f"muted    {'until unmuted' if until is None else time.strftime('until %H:%M', time.localtime(until))}")
        if health.get("playing"):
            print(f"playing  {health['playing']['level']} ({health['playing']['id']})")
        if health.get("last_alert"):
            print("last     ", end="")
            _print_alert(health["last_alert"], health["time"])
        return 0

    if args.command == "levels":
        levels = client.get("/levels")["levels"]
        if as_json:
            show({"levels": levels})
            return 0
        for level in levels:
            ready = "" if level["sound_ready"] else _paint("  (sound not cached yet)", "#FF9966")
            print(
                f"{_paint(level['name'].upper(), level['color'], True):<20} priority {level['priority']:<4} "
                f"{level['style']:<7} {_length(level['duration'])}{ready}"
            )
            print(f"    {level['description']}")
        return 0

    if args.command == "history":
        reply = client.get(f"/history?limit={args.limit}")
        if as_json:
            show(reply)
            return 0
        now = time.time()
        for alert in reply["alerts"]:
            _print_alert(alert, now)
        if not reply["alerts"]:
            print("no alerts yet")
        return 0

    if args.command == "stop":
        stopped = client.post("/stop", {"id": args.id or ""})["stopped"]
        print(f"stopped {stopped}" if stopped else "nothing was playing")
        return 0

    if args.command == "mute":
        mute = client.post("/mute", {"minutes": args.minutes})["mute"]
        until = mute and mute.get("until")
        print("muted until unmuted" if not until else time.strftime("muted until %H:%M", time.localtime(until)))
        return 0

    if args.command == "unmute":
        client.post("/unmute")
        print("unmuted")
        return 0

    if args.command == "reload":
        levels = client.post("/reload")["levels"]
        print(f"reloaded: {', '.join(level['name'] for level in levels)}")
        return 0

    if args.command == "test":
        names = [args.level] if args.level else client.get("/health")["levels"]
        for name in names:
            alert = client.post("/alert", {"level": name, "message": f"Test of the {name} alert", "source": "red-alert test"})["alert"]
            print(f"{_paint(name.upper(), alert['color'], True)}: {alert['status']}", flush=True)
            deadline = time.time() + (alert.get("duration") or HARD_CAP_SECONDS) + 5
            while alert["status"] == "playing" and time.time() < deadline:
                time.sleep(0.3)
                playing = client.get("/health").get("playing")
                if not playing or playing["id"] != alert["id"]:
                    break
            if name != names[-1]:
                time.sleep(0.8)
        return 0

    raise AssertionError(args.command)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="red-alert", description="Audible alerts for Claude Code: daemon and client."
    )
    parser.add_argument("--version", action="version", version=f"red-alert {VERSION}")
    parser.add_argument("--config", type=Path, help=f"config file (default {CONFIG_PATH})")
    parser.add_argument("--url", help="daemon URL (default from config, or $RED_ALERT_URL)")
    parser.add_argument("--token", help="bearer token (default from config, or $RED_ALERT_TOKEN)")
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    run = commands.add_parser("serve", help="run the alert daemon")
    run.add_argument("--host", help="override server.host")
    run.add_argument("--port", type=int, help="override server.port")
    run.add_argument("-v", "--verbose", action="store_true", help="log every request")

    send = commands.add_parser("send", help="sound an alert: send LEVEL [MESSAGE...]")
    send.add_argument("level")
    send.add_argument("message", nargs="*")
    send.add_argument("--title", help="notification title (default: '<LEVEL> ALERT')")
    send.add_argument("--source", default=f"cli@{socket.gethostname()}", help="who is alerting")
    send.add_argument(
        "-d", "--duration", type=float, metavar="SECONDS",
        help="sound for this long, looping or cutting the sound (0 = once; default: the level's)",
    )
    send.add_argument("--json", action="store_true")

    for name, text in (("status", "show daemon status"), ("levels", "list alert levels")):
        sub = commands.add_parser(name, help=text)
        sub.add_argument("--json", action="store_true")

    history = commands.add_parser("history", help="show recent alerts")
    history.add_argument("-n", "--limit", type=int, default=20)
    history.add_argument("--json", action="store_true")

    stop = commands.add_parser("stop", help="silence the alert that is playing")
    stop.add_argument("id", nargs="?", help="only stop this alert id")

    mute = commands.add_parser("mute", help="mute for MINUTES (0 = until unmuted)")
    mute.add_argument("minutes", nargs="?", type=float, default=30)

    commands.add_parser("unmute", help="unmute")
    commands.add_parser("reload", help="reload the daemon's config")
    test = commands.add_parser("test", help="play one level, or every level in turn")
    test.add_argument("level", nargs="?")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "serve":
        return serve(args)
    try:
        return cli(args)
    except Offline as err:
        print(f"red-alert: {err}", file=sys.stderr)
        print("start it with: systemctl --user start red-alert", file=sys.stderr)
        return 3
    except ClientError as err:
        levels = err.payload.get("levels")
        hint = f" (levels: {', '.join(levels)})" if levels else ""
        print(f"red-alert: {err}{hint}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
