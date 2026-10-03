"""Tests for red_alert.py. Run: python3 -m unittest discover -s tests

A fake player (a Python one-liner that counts its plays in `<sound>.plays`
and sleeps 0.6 s) stands in for the speakers, so the tests make no sound.
"""

from __future__ import annotations

import argparse
import dataclasses
import http.server
import json
import math
import shlex
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import red_alert as ca  # noqa: E402

SOUND_SECONDS = 0.6
FAKE_PLAYER = (
    f"{shlex.quote(sys.executable)} -c "
    f"'import sys, time; open(sys.argv[1] + \".plays\", \"a\").write(\"x\"); time.sleep({SOUND_SECONDS})' {{file}}"
)


def make_config(tmp: Path, token: str = "", **level_overrides) -> ca.Config:
    for name in ("chirp", "alert", "klaxon"):
        (tmp / f"{name}.wav").write_bytes(b"RIFF")
    raw = {
        "server": {"host": "127.0.0.1", "port": 1, "token": token},
        "audio": {"player": FAKE_PLAYER, "cache_dir": str(tmp / "cache")},
        "levels": [
            {"name": "normal", "priority": 10, "sound": "chirp.wav", "description": "small",
             "duration": 1.5},
            {"name": "yellow", "priority": 50, "sound": "alert.wav", "description": "done"},
            {"name": "red", "priority": 90, "sound": "klaxon.wav", "description": "help",
             **level_overrides},
        ],
    }
    return ca.parse_config(raw, tmp / "config.toml")


class ConfigTests(unittest.TestCase):
    def test_example_config_parses(self):
        config = ca.load_config(ca.EXAMPLE_CONFIG)
        self.assertEqual([l.name for l in config.levels], ["normal", "yellow", "red"])
        red = config.level("RED")
        self.assertEqual(red.style, "klaxon")
        self.assertTrue(red.sound.startswith("https://"))
        self.assertNotIn("\n", red.description)

    def test_defaults_from_priority(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = make_config(Path(tmp))
        styles = {l.name: (l.style, l.notify, l.color) for l in config.levels}
        self.assertEqual(styles["normal"], ("sweep", False, "#99CCFF"))
        self.assertEqual(styles["yellow"], ("pulse", True, "#FFCC00"))
        self.assertEqual(styles["red"], ("klaxon", True, "#FF3333"))

    def test_relative_sound_resolves_against_config_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = make_config(Path(tmp))
            self.assertEqual(Path(config.level("normal").sound), Path(tmp) / "chirp.wav")

    def test_rejects_bad_levels(self):
        bad = [
            {"levels": [{"name": "a", "sound": "x.wav", "duration": 301}]},
            {"levels": [{"name": "a", "sound": "x.wav", "duration": -1}]},
            {"levels": []},
            {"levels": [{"name": "Bad Name", "sound": "x.wav"}]},
            {"levels": [{"name": "a", "sound": "x.wav"}, {"name": "a", "sound": "y.wav"}]},
            {"levels": [{"name": "a"}]},
            {"levels": [{"name": "a", "sound": "x.wav", "style": "disco"}]},
            {"levels": [{"name": "a", "sound": "x.wav", "color": "red"}]},
            {"levels": [{"name": "a", "sound": "x.wav", "volume": 101}]},
        ]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(ca.ConfigError):
                ca.parse_config(raw, None)

    def test_rejects_bad_tables_and_numbers(self):
        ok = {"name": "a", "sound": "x.wav"}
        bad = [
            {"levels": [{**ok, "duration": math.nan}]},
            {"levels": [{**ok, "cooldown_seconds": math.nan}]},
            {"levels": [{**ok, "priority": math.inf}]},
            {"levels": [{**ok, "volume": math.nan}]},
            {"server": {"port": math.inf}, "levels": [ok]},
            {"server": "x", "levels": [ok]},
            {"audio": ["mpv"], "levels": [ok]},
            {"levels": ["red"]},
            {"levels": ok},
            {"audio": {"player": "vlc"}, "levels": [ok]},
        ]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(ca.ConfigError):
                ca.parse_config(raw, None)

    def test_cli_brackets_an_ipv6_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_file = Path(tmp) / "config.toml"
            config_file.write_text('[server]\nhost = "::1"\n[[levels]]\nname = "a"\nsound = "x.wav"\n')
            args = argparse.Namespace(url=None, token=None, config=config_file)
            self.assertEqual(ca.client_from_args(args).url, "http://[::1]:1701")

    def test_legacy_keys_point_to_duration(self):
        for key in ("repeat", "max_seconds"):
            with self.subTest(key=key), self.assertRaisesRegex(ca.ConfigError, "replaced by `duration`"):
                ca.parse_config({"levels": [{"name": "a", "sound": "x.wav", key: 2}]}, None)

    def test_custom_player_template(self):
        player = ca.Player("mpv --volume={volume} --gain={gain} {file}")
        self.assertEqual(
            player.argv("custom", Path("/s/a b.mp3"), 40),
            ["mpv", "--volume=40", "--gain=0.40", "/s/a b.mp3"],
        )
        with self.assertRaises(ca.ConfigError):
            ca.Player("not-a-player")

    def test_sound_cache_names_urls_stably(self):
        cache = ca.SoundCache(Path("/c"))
        url = "https://example.com/audio/red_alert.mp3?x=1"
        self.assertEqual(cache.path_for(url), cache.path_for(url))
        self.assertTrue(cache.path_for(url).name.endswith("-red_alert.mp3"))
        self.assertEqual(cache.path_for("/a/b.wav"), Path("/a/b.wav"))


class DaemonTestCase(unittest.TestCase):
    """A daemon on a free port, with the fake player."""

    token = ""

    def make_config(self, tmp: Path) -> ca.Config:
        return make_config(tmp, token=self.token, cooldown_seconds=1)

    def setUp(self):
        notify, ca.desktop_notify = ca.desktop_notify, lambda *args: None
        self.addCleanup(setattr, ca, "desktop_notify", notify)
        self.tmp = tempfile.TemporaryDirectory()
        config = self.make_config(Path(self.tmp.name))
        self.system = ca.AlertSystem(config)
        self.server = ca.AlertServer(("127.0.0.1", 0), self.system)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.client = ca.Client(self.url, self.token, timeout=5)

    def tearDown(self):
        self.system.playback.stop()
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def wait_for(self, alert_id: str, timeout: float = 5) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for alert in self.client.get("/history?limit=50")["alerts"]:
                if alert["id"] == alert_id and alert["status"] != "playing":
                    return alert
            time.sleep(0.05)
        self.fail(f"alert {alert_id} still playing")

    def plays(self, sound: str) -> int:
        counter = Path(self.tmp.name) / f"{sound}.plays"
        return len(counter.read_text()) if counter.exists() else 0

    def timed(self, body: dict) -> tuple[dict, float]:
        started = time.monotonic()
        alert = self.client.post("/alert", body)["alert"]
        return self.wait_for(alert["id"]), time.monotonic() - started

    def raw(self, request: bytes) -> bytes:
        """Sends `request` as is; reads until the server closes the connection or goes quiet."""
        reply = b""
        with socket.create_connection(self.server.server_address[:2], timeout=3) as sock:
            sock.sendall(request)
            try:
                while chunk := sock.recv(65536):
                    reply += chunk
            except TimeoutError:
                pass
        return reply


class ServerTests(DaemonTestCase):
    def test_health_and_levels(self):
        health = self.client.get("/health")
        self.assertTrue(health["ok"])
        self.assertEqual(health["levels"], ["normal", "yellow", "red"])
        self.assertEqual(len(health["levels_hash"]), 12)
        levels = self.client.get("/levels")["levels"]
        self.assertEqual(levels[2]["name"], "red")
        self.assertEqual([level["duration"] for level in levels], [1.5, 0, 0])
        self.assertTrue(all(level["sound_ready"] for level in levels))

    def test_duration_loops_a_shorter_sound(self):
        alert, elapsed = self.timed({"level": "normal"})  # 1.5 s of a 0.6 s sound
        self.assertEqual((alert["status"], alert["duration"]), ("played", 1.5))
        self.assertEqual(self.plays("chirp.wav"), 3)  # 0.6 + 0.6 + 0.3 cut
        self.assertGreaterEqual(elapsed, 1.4)
        self.assertLess(elapsed, 2.4)

    def test_duration_cuts_a_longer_sound(self):
        alert, elapsed = self.timed({"level": "red", "duration": 0.25})
        self.assertEqual((alert["status"], alert["duration"]), ("played", 0.25))
        self.assertEqual(self.plays("klaxon.wav"), 1)
        self.assertLess(elapsed, SOUND_SECONDS)

    def test_zero_duration_plays_once(self):
        alert, elapsed = self.timed({"level": "yellow"})
        self.assertEqual((alert["status"], alert["duration"]), ("played", 0))
        self.assertEqual(self.plays("alert.wav"), 1)
        self.assertGreaterEqual(elapsed, SOUND_SECONDS - 0.1)

    def test_duration_override_is_validated(self):
        for duration in (-1, 301, "5", True):
            with self.subTest(duration=duration), self.assertRaises(ca.ClientError):
                self.client.post("/alert", {"level": "red", "duration": duration})

    def test_alert_plays_then_finishes(self):
        alert = self.client.post("/alert", {"level": "yellow", "message": "done  with\nit", "source": "t"})["alert"]
        self.assertEqual(alert["status"], "playing")
        self.assertEqual(alert["message"], "done with it")
        self.assertEqual(self.client.get("/health")["playing"]["id"], alert["id"])
        self.assertEqual(self.wait_for(alert["id"])["status"], "played")
        self.assertIsNone(self.client.get("/health")["playing"])

    def test_higher_priority_preempts_lower(self):
        low = self.client.post("/alert", {"level": "normal"})["alert"]
        high = self.client.post("/alert", {"level": "red"})["alert"]
        self.assertEqual(self.wait_for(low["id"])["status"], "preempted")
        self.assertEqual(self.client.get("/health")["playing"]["id"], high["id"])

    def test_lower_priority_is_suppressed_while_higher_plays(self):
        self.client.post("/alert", {"level": "red"})
        low = self.client.post("/alert", {"level": "normal"})["alert"]
        self.assertEqual(low["status"], "suppressed")

    def test_cooldown(self):
        first = self.client.post("/alert", {"level": "red"})["alert"]
        second = self.client.post("/alert", {"level": "red"})["alert"]
        self.assertEqual((first["status"], second["status"]), ("playing", "cooldown"))

    def test_stop_by_id(self):
        alert = self.client.post("/alert", {"level": "yellow"})["alert"]
        self.assertIsNone(self.client.post("/stop", {"id": "someone-else"})["stopped"])
        self.assertEqual(self.client.post("/stop", {"id": alert["id"]})["stopped"], alert["id"])
        self.assertEqual(self.wait_for(alert["id"])["status"], "stopped")

    def test_mute_and_unmute(self):
        self.assertIsNone(self.client.post("/mute", {"minutes": 0})["mute"]["until"])
        self.assertEqual(self.client.post("/alert", {"level": "red"})["alert"]["status"], "muted")
        self.assertIsNotNone(self.client.get("/health")["mute"])
        self.client.post("/unmute")
        self.assertIsNone(self.client.get("/health")["mute"])
        self.assertEqual(self.client.post("/alert", {"level": "red"})["alert"]["status"], "playing")

    def test_unknown_level_lists_levels(self):
        with self.assertRaises(ca.ClientError) as caught:
            self.client.post("/alert", {"level": "purple"})
        self.assertEqual(caught.exception.payload["levels"], ["normal", "yellow", "red"])

    def test_missing_sound_fails_cleanly(self):
        (Path(self.tmp.name) / "alert.wav").unlink()
        alert = self.client.post("/alert", {"level": "yellow"})["alert"]
        self.assertEqual(alert["status"], "failed")
        self.assertIn("sound unavailable", alert["detail"])

    def test_rejects_browser_and_non_json_posts(self):
        for headers in ({"Content-Type": "text/plain"},
                        {"Content-Type": "application/json", "Origin": "https://evil.example"}):
            request = urllib.request.Request(
                self.url + "/alert", data=b'{"level":"red"}', method="POST", headers=headers
            )
            with self.subTest(headers=headers), self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request, timeout=5)
            self.assertIn(caught.exception.code, (403, 415))

    def test_a_refused_request_closes_its_connection(self):
        # Its unread body must not be read as a second request, here one without an Origin.
        inner = b'{"level": "red"}'
        smuggled = (b"POST /alert HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                    b"Content-Length: %d\r\n\r\n%s" % (len(inner), inner))
        for path, kind, origin in (("/alert", b"text/plain", b"Origin: https://evil.example\r\n"),
                                   ("/nowhere", b"application/json", b"")):
            request = (b"POST %s HTTP/1.1\r\nHost: x\r\n%sContent-Type: %s\r\nContent-Length: %d\r\n\r\n"
                       % (path.encode(), origin, kind, len(smuggled))) + smuggled
            with self.subTest(path=path):
                reply = self.raw(request)
                self.assertEqual(reply.count(b"HTTP/1.1 "), 1, reply)
                self.assertIsNone(self.client.get("/health")["playing"])

    def test_rejects_malformed_bodies(self):
        for length, body in (("-1", b'{"level": "red"}'), ("abc", b"{}"), (None, b'{"level": "\xff"}')):
            length = str(len(body)) if length is None else length
            request = (b"POST /alert HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"
                       b"Content-Type: application/json\r\nContent-Length: %s\r\n\r\n%s"
                       % (length.encode(), body))
            with self.subTest(length=length, body=body):
                self.assertTrue(self.raw(request).startswith(b"HTTP/1.1 400 "))

    def test_mute_minutes_must_be_finite_and_in_range(self):
        for body in (b'{"minutes": NaN}', b'{"minutes": Infinity}', b'{"minutes": 1e999}', b'{"minutes": 1e9}'):
            headers = {"Content-Type": "application/json"}
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
            request = urllib.request.Request(self.url + "/mute", data=body, method="POST", headers=headers)
            with self.subTest(body=body), self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(caught.exception.code, 400)
            caught.exception.close()
        self.assertIsNone(self.client.get("/health")["mute"])

    def test_a_stopped_alert_frees_the_speaker_at_once(self):
        red = self.system.sound("red")
        self.assertEqual(self.system.playback.stop(red["id"]), red["id"])
        self.assertEqual(self.system.sound("normal")["status"], "playing")

    def test_a_failed_alert_does_not_start_the_cooldown(self):
        sound = Path(self.tmp.name) / "klaxon.wav"
        sound.unlink()
        self.assertEqual(self.client.post("/alert", {"level": "red"})["alert"]["status"], "failed")
        sound.write_bytes(b"RIFF")
        self.assertEqual(self.client.post("/alert", {"level": "red"})["alert"]["status"], "playing")

    def test_stop_reaches_what_a_player_command_starts(self):
        # sh waits on its sleep, which holds the player's stderr open
        self.system.playback.player = ca.Player("sh -c 'sleep 5; true' {file}")
        cut, elapsed = self.timed({"level": "red", "duration": 0.3})
        self.assertEqual(cut["status"], "played")
        self.assertLess(elapsed, 2)
        alert = self.client.post("/alert", {"level": "yellow"})["alert"]
        time.sleep(0.2)
        self.client.post("/stop", {"id": alert["id"]})
        self.assertEqual(self.wait_for(alert["id"], timeout=2)["status"], "stopped")

    def test_serves_ipv6(self):
        try:
            server = ca.AlertServer(("::1", 0), self.system)
        except OSError:
            self.skipTest("no IPv6 loopback")
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.assertTrue(ca.Client(f"http://[::1]:{server.server_address[1]}", self.token, timeout=5).get("/health")["ok"])

    def test_reload_moves_from_the_example_to_a_new_config(self):
        config_file = Path(self.tmp.name) / "config.toml"
        (Path(self.tmp.name) / "bell.wav").write_bytes(b"RIFF")
        config_file.write_text(
            f'[audio]\nplayer = {json.dumps(FAKE_PLAYER)}\n'
            '[[levels]]\nname = "bell"\nsound = "bell.wav"\n'
        )
        self.system.config = dataclasses.replace(self.system.config, path=ca.EXAMPLE_CONFIG)
        with mock.patch.object(ca, "CONFIG_PATH", config_file):
            levels = self.client.post("/reload")["levels"]
        self.assertEqual([level["name"] for level in levels], ["bell"])

    def test_reload_picks_up_new_levels(self):
        config_file = Path(self.tmp.name) / "config.toml"
        (Path(self.tmp.name) / "bell.wav").write_bytes(b"RIFF")
        config_file.write_text(
            f'[audio]\nplayer = {json.dumps(FAKE_PLAYER)}\n'
            '[[levels]]\nname = "bell"\nsound = "bell.wav"\ndescription = "ding"\n'
        )
        levels = self.client.post("/reload")["levels"]
        self.assertEqual([level["name"] for level in levels], ["bell"])


class TokenTests(ServerTests):
    token = "s3cret"

    def test_token_required(self):
        anonymous = ca.Client(self.url, "", timeout=5)
        self.assertTrue(anonymous.get("/health")["ok"])
        for call in (lambda: anonymous.post("/alert", {"level": "red"}),
                     lambda: anonymous.get("/history")):
            with self.assertRaises(ca.ClientError):
                call()

    def test_health_keeps_the_last_alert_to_token_holders(self):
        self.client.post("/alert", {"level": "yellow", "message": "the prod password is in the vault"})
        self.assertIsNone(ca.Client(self.url, "", timeout=5).get("/health")["last_alert"])
        self.assertEqual(self.client.get("/health")["last_alert"]["level"], "yellow")


class DownloadTests(DaemonTestCase):
    """`normal` plays a URL that takes a second to answer; `yellow` one that is missing until a test says."""

    def make_config(self, tmp: Path) -> ca.Config:
        self.is_flaky_missing = True
        owner = self

        class SoundHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/slow.mp3":
                    time.sleep(1)
                if self.path == "/flaky.mp3" and owner.is_flaky_missing:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", "4")
                self.end_headers()
                self.wfile.write(b"ID3x")

            def log_message(self, *args):
                pass

        sounds = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SoundHandler)
        sounds.daemon_threads = True
        threading.Thread(target=sounds.serve_forever, daemon=True).start()
        self.addCleanup(sounds.server_close)
        self.addCleanup(sounds.shutdown)
        base = f"http://127.0.0.1:{sounds.server_address[1]}"
        config = make_config(tmp, token=self.token)
        normal, yellow, red = config.levels
        return dataclasses.replace(config, levels=(
            dataclasses.replace(normal, sound=f"{base}/slow.mp3", duration=0),
            dataclasses.replace(yellow, sound=f"{base}/flaky.mp3", cooldown_seconds=30),
            red,
        ))

    def tearDown(self):
        for thread in threading.enumerate():  # the startup download, so it ends before its folder goes
            if thread.name == "prefetch":
                thread.join(timeout=5)
        super().tearDown()

    def downloaded_plays(self, name: str) -> int:
        return sum(len(path.read_text()) for path in (Path(self.tmp.name) / "cache").rglob(f"*{name}.plays"))

    def while_downloading(self, then) -> dict:
        """Raises `normal`, whose sound is still downloading, and calls `then` meanwhile."""
        raised = []
        thread = threading.Thread(target=lambda: raised.append(self.client.post("/alert", {"level": "normal"})))
        thread.start()
        time.sleep(0.3)
        then()
        thread.join()
        return raised[0]["alert"]

    def test_a_lower_alert_still_downloading_does_not_cut_off_a_higher_one(self):
        high = []
        low = self.while_downloading(lambda: high.append(self.client.post("/alert", {"level": "red"})["alert"]))
        self.assertEqual(self.wait_for(low["id"])["status"], "preempted")
        self.assertEqual(self.wait_for(high[0]["id"])["status"], "played")
        self.assertEqual(self.downloaded_plays("slow.mp3"), 0)

    def test_mute_reaches_an_alert_still_downloading(self):
        low = self.while_downloading(lambda: self.client.post("/mute", {"minutes": 0}))
        self.assertEqual(self.wait_for(low["id"])["status"], "stopped")
        self.assertEqual(self.downloaded_plays("slow.mp3"), 0)

    def test_stop_reaches_an_alert_still_downloading(self):
        stopped = []
        low = self.while_downloading(lambda: stopped.append(self.client.post("/stop")["stopped"]))
        self.assertEqual(stopped, [low["id"]])
        self.assertEqual(self.wait_for(low["id"], timeout=0.3)["status"], "stopped")  # not once downloaded
        self.assertEqual(self.downloaded_plays("slow.mp3"), 0)

    def test_a_failed_download_does_not_start_the_cooldown(self):
        failed = self.client.post("/alert", {"level": "yellow"})["alert"]
        self.assertIn("sound unavailable", self.wait_for(failed["id"])["detail"])
        self.is_flaky_missing = False
        self.assertEqual(self.client.post("/alert", {"level": "yellow"})["alert"]["status"], "playing")


if __name__ == "__main__":
    unittest.main()
