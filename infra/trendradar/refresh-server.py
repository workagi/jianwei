#!/usr/bin/env python3
"""Internal-only TrendRadar refresh helper.

The main TrendRadar container serves a static report page and runs collection
via cron. It does not expose an HTTP "refresh now" endpoint. This tiny sidecar
shares the same config/output volumes and runs one fixed command
(`python -m trendradar`) when 见微 asks for an immediate refresh.

It deliberately does not mount the Docker socket, so the web app never gets
host-level Docker control.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = os.environ.get("TREND_REFRESH_HOST", "0.0.0.0")
PORT = int(os.environ.get("TREND_REFRESH_PORT", "8090"))
TOKEN = os.environ.get("TREND_REFRESH_TOKEN", "")
TIMEOUT_SECONDS = int(os.environ.get("TREND_REFRESH_TIMEOUT_SECONDS", "900"))

_lock = threading.Lock()


class RefreshHandler(BaseHTTPRequestHandler):
    server_version = "TrendRadarRefresh/0.1"

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            print(
                f"[trendradar-refresh] client disconnected before response status={status}",
                flush=True,
            )

    def _authorized(self) -> bool:
        if not TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler naming
        if self.path == "/health":
            self._json(200, {"ok": True})
            return
        self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler naming
        if self.path != "/refresh":
            self._json(404, {"ok": False, "error": "not_found"})
            return
        if not self._authorized():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        if not _lock.acquire(blocking=False):
            self._json(409, {"ok": False, "error": "refresh_already_running"})
            return

        try:
            result = subprocess.run(
                ["python", "-m", "trendradar"],
                cwd="/app",
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
            tail = result.stdout[-4000:] if result.stdout else ""
            self._json(
                200 if result.returncode == 0 else 500,
                {
                    "ok": result.returncode == 0,
                    "exitCode": result.returncode,
                    "logTail": tail,
                },
            )
        except subprocess.TimeoutExpired as exc:
            self._json(
                504,
                {
                    "ok": False,
                    "error": "refresh_timeout",
                    "logTail": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
                },
            )
        finally:
            _lock.release()

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[trendradar-refresh] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"[trendradar-refresh] listening on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), RefreshHandler).serve_forever()
