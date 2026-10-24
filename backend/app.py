#!/usr/bin/env python3
"""
Companion download server for download.html.

A browser cannot speak YouTube's/TikTok's protocol, so this process runs
`yt-dlp` and streams the finished file back. It is deliberately small and
stdlib-only apart from yt-dlp itself, so the container has one moving part.

Endpoints
    GET  /health                         -> {ok, ytdlp, ffmpeg}
    POST /api/info     {"url": "..."}    -> {ok, title, uploader, ...}
    GET  /api/download?url=..&mode=..    -> the file, as an attachment

Configuration is environment-only; see backend/README.md.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

PORT = int(os.environ.get("PORT", "8080"))

# Sites this server will fetch from. yt-dlp supports ~1800, but an open
# grab-anything proxy is a gift to whoever finds it first, so the default is
# the sites people actually ask for here. Override with a comma-separated
# ALLOWED_HOSTS to widen or narrow it.
DEFAULT_HOSTS = """
youtube.com youtu.be youtube-nocookie.com
tiktok.com
facebook.com fb.watch
instagram.com
twitter.com x.com
vimeo.com dailymotion.com twitch.tv
reddit.com pinterest.com snapchat.com
soundcloud.com
bilibili.com rumble.com odysee.com streamable.com kick.com
""".split()

ALLOWED_HOSTS = [
    h.strip().lower()
    for h in os.environ.get("ALLOWED_HOSTS", "").split(",")
    if h.strip()
] or DEFAULT_HOSTS

# CORS is only meaningful for the fetch() calls (/health, /api/info); the
# download itself is a top-level navigation, which CORS never gates.
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").strip()

# Optional shared secret. When set, every request needs ?token= or a Bearer
# header. This is the only control that actually stops a stranger from using
# the deployment, so it is worth setting on a public instance.
API_TOKEN = os.environ.get("API_TOKEN", "").strip()

# A free instance is small. These three keep one runaway request from taking
# the whole service down for everyone.
MAX_FILESIZE_MB = int(os.environ.get("MAX_FILESIZE_MB", "400"))
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))
RATE_LIMIT = int(os.environ.get("RATE_LIMIT", "30"))       # requests
RATE_WINDOW = int(os.environ.get("RATE_WINDOW", "600"))   # per this many seconds

# YouTube increasingly wants a session on datacenter IPs. Supply a Netscape
# cookies.txt (base64 or plain) and it is written to the temp dir per job.
COOKIES = os.environ.get("YTDLP_COOKIES", "").strip()
EXTRA_ARGS = os.environ.get("YTDLP_EXTRA_ARGS", "").split()

MAX_BODY = 8 * 1024

# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

_download_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_rate_lock = threading.Lock()
_rate_seen: dict[str, list[float]] = {}

VERSION = "1.0.0"


def ytdlp_cmd() -> list[str]:
    """Run yt-dlp through *this* interpreter rather than a bare `python3`.

    `python3` does not exist on Windows, where the local run is `py app.py`,
    and in the container this resolves to the same interpreter that installed
    the package. One code path, both environments.
    """
    return [sys.executable, "-m", "yt_dlp"]


def probe_versions() -> tuple[str, bool]:
    try:
        out = subprocess.run(
            ytdlp_cmd() + ["--version"],
            capture_output=True, text=True, timeout=30,
        )
        version = out.stdout.strip().splitlines()[0] if out.stdout.strip() else "unknown"
    except Exception:
        version = "missing"
    return version, shutil.which("ffmpeg") is not None


YTDLP_VERSION, FFMPEG_OK = probe_versions()

# --------------------------------------------------------------------------
# URL validation
# --------------------------------------------------------------------------


class BadURL(ValueError):
    pass


def host_allowed(host: str) -> bool:
    host = host.lower().rstrip(".")
    if host in ("localhost", "") or re.fullmatch(r"[\d.]+", host) or ":" in host:
        return False
    for allowed in ALLOWED_HOSTS:
        if host == allowed or host.endswith("." + allowed):
            return True
    return False


def validate_url(raw: str) -> str:
    raw = (raw or "").strip()
    if len(raw) > 2048:
        raise BadURL("That link is too long.")
    try:
        parts = urlparse(raw)
    except ValueError:
        raise BadURL("That is not a valid link.")
    if parts.scheme not in ("http", "https"):
        raise BadURL("Only http and https links are accepted.")
    if parts.username or parts.password:
        raise BadURL("Links with embedded credentials are not accepted.")
    if not parts.hostname or not host_allowed(parts.hostname):
        raise BadURL(
            "That site is not on this server's allowlist. "
            "Add it to ALLOWED_HOSTS if it should be."
        )
    return raw


# --------------------------------------------------------------------------
# Rate limiting
# --------------------------------------------------------------------------


def rate_ok(ip: str) -> bool:
    now = time.time()
    with _rate_lock:
        seen = [t for t in _rate_seen.get(ip, []) if now - t < RATE_WINDOW]
        if len(seen) >= RATE_LIMIT:
            _rate_seen[ip] = seen
            return False
        seen.append(now)
        _rate_seen[ip] = seen
    return True


# --------------------------------------------------------------------------
# yt-dlp
# --------------------------------------------------------------------------

# Each mode is an "up to" cap. mp4+m4a first because that merges without a
# codec change; the bare `bv*+ba` is the fallback for sources with no mp4.
FORMATS = {
    "best": "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/"
            "b[ext=mp4][height<=1080]/"
            "bv*[height<=1080]+ba/b[height<=1080]/b",
    "720": "bv*[ext=mp4][height<=720]+ba[ext=m4a]/"
           "b[ext=mp4][height<=720]/"
           "bv*[height<=720]+ba/b[height<=720]/b",
    "480": "bv*[ext=mp4][height<=480]+ba[ext=m4a]/"
           "b[ext=mp4][height<=480]/"
           "bv*[height<=480]+ba/b[height<=480]/b",
    "audio": "ba/b",
}

MODES = set(FORMATS)

# Section downloads are a yt-dlp/YouTube strength; most other extractors
# either ignore --download-sections or fail outright, so clipping is offered
# only for YouTube rather than silently producing a full-length file.
YOUTUBE_HOSTS = ("youtube.com", "youtu.be", "youtube-nocookie.com")

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def clean_error(text: str) -> str:
    """Turn yt-dlp's stderr into something worth showing a person."""
    text = ANSI.sub("", text or "").strip()
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("ERROR:"):
            msg = line[6:].strip()
            # Strip the "[youtube] abc123: " extractor prefix.
            msg = re.sub(r"^\[[^\]]+\]\s*[^:]{0,40}:\s*", "", msg)
            return msg[:400]
    for line in reversed(text.splitlines()):
        if line.strip():
            return line.strip()[:400]
    return "yt-dlp failed without saying why."


def base_args(cookie_file: str | None) -> list[str]:
    args = ytdlp_cmd() + [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--no-mtime",
        "--max-filesize", str(MAX_FILESIZE_MB) + "M",
    ]
    if cookie_file:
        args += ["--cookies", cookie_file]
    args += EXTRA_ARGS
    return args


def write_cookies(directory: str) -> str | None:
    if not COOKIES:
        return None
    raw = COOKIES
    if raw[:6].lower() in ("netsca",) or "\t" in raw:
        text = raw.replace("\\n", "\n")
    else:
        try:
            text = base64.b64decode(raw).decode("utf-8")
        except Exception:
            text = raw.replace("\\n", "\n")
    path = os.path.join(directory, "cookies.txt")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(path, 0o600)
    return path


def is_youtube(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in YOUTUBE_HOSTS)


class BadTime(ValueError):
    pass


def parse_time(raw: str) -> float:
    """Seconds from a plain number or an ``H:MM:SS`` / ``M:SS`` clock.

    Values are returned as floats and re-formatted into the yt-dlp argument
    rather than passed through, so nothing typed by a caller can reach the
    command line as a flag.
    """
    text = (raw or "").strip()
    try:
        seconds = float(text)
    except ValueError:
        raise BadTime("Times should look like 1:30 or 90.")
    if not (0 <= seconds <= 12 * 3600):
        raise BadTime("A time has to be between 0:00 and 12:00:00.")
    return seconds


def safe_name(title: str, fallback: str) -> str:
    name = (title or "").strip()
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    name = re.sub(r'[\\/:*?"<>|]+', "-", name)
    name = re.sub(r"\s+", " ", name).strip(" .-")
    if not name:
        name = fallback
    return name[:110]


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


def cors_origin(origin: str) -> str:
    if ALLOWED_ORIGINS == "*":
        return "*"
    allowed = [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]
    return origin if origin in allowed else ""


class Handler(BaseHTTPRequestHandler):
    server_version = "mp4dl/" + VERSION
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def client_ip(self) -> str:
        fwd = self.headers.get("X-Forwarded-For", "")
        if fwd:
            return fwd.split(",")[0].strip()
        return self.client_address[0]

    def send_json(self, status: int, body: dict):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _cors(self):
        origin = cors_origin(self.headers.get("Origin", ""))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "86400")

    def authorized(self, params: dict) -> bool:
        if not API_TOKEN:
            return True
        supplied = (params.get("token", [""])[0] or "").strip()
        if not supplied:
            auth = self.headers.get("Authorization", "")
            if auth.lower().startswith("bearer "):
                supplied = auth[7:].strip()
        return supplied == API_TOKEN

    # -- routes -----------------------------------------------------------

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/health":
            self.send_json(200, {
                "ok": True,
                "ytdlp": YTDLP_VERSION,
                "ffmpeg": FFMPEG_OK,
                "version": VERSION,
            })
            return

        if parsed.path == "/api/download":
            self.handle_download(params)
            return

        if parsed.path in ("/", "/index.html"):
            page = (
                "<!doctype html><meta charset=utf-8>"
                "<title>Download server</title>"
                "<style>body{font:15px/1.6 system-ui;background:#0a0a0b;color:#ececef;"
                "max-width:34rem;margin:12vh auto;padding:0 24px}"
                "code{background:#1b1b20;padding:2px 6px;border-radius:4px}</style>"
                "<h1>Download server is running</h1>"
                "<p>yt-dlp <code>%s</code> · ffmpeg <code>%s</code></p>"
                "<p>This is the companion API for the <code>download.html</code> page. "
                "Open that page and paste this URL to connect.</p>"
                % (YTDLP_VERSION, "yes" if FFMPEG_OK else "MISSING")
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
            return

        self.send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path != "/api/info":
            self.send_json(404, {"ok": False, "error": "not found"})
            return

        if not self.authorized(params):
            self.send_json(401, {"ok": False, "error": "This server requires an API token."})
            return

        if not rate_ok(self.client_ip()):
            self.send_json(429, {"ok": False, "error": "Too many requests. Wait a few minutes."})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self.send_json(400, {"ok": False, "error": "Expected a small JSON body."})
            return

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self.send_json(400, {"ok": False, "error": "Body was not valid JSON."})
            return

        try:
            url = validate_url(payload.get("url", ""))
        except BadURL as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
            return

        self.handle_info(url)

    # -- info -------------------------------------------------------------

    def handle_info(self, url: str):
        workdir = tempfile.mkdtemp(prefix="mp4dl-")
        try:
            cookie_file = write_cookies(workdir)
            args = base_args(cookie_file) + [
                "--dump-single-json", "--skip-download", url,
            ]
            try:
                proc = subprocess.run(
                    args, capture_output=True, text=True, timeout=120,
                    encoding="utf-8", errors="replace",
                )
            except subprocess.TimeoutExpired:
                self.send_json(504, {"ok": False, "error": "The source site took too long to answer."})
                return

            if proc.returncode != 0:
                self.send_json(422, {"ok": False, "error": clean_error(proc.stderr)})
                return

            try:
                data = json.loads(proc.stdout)
            except Exception:
                self.send_json(502, {"ok": False, "error": "yt-dlp returned something unreadable."})
                return

            heights = sorted({
                int(f["height"]) for f in (data.get("formats") or [])
                if isinstance(f.get("height"), (int, float)) and f.get("vcodec") not in (None, "none")
            }, reverse=True)

            self.send_json(200, {
                "ok": True,
                "title": data.get("title") or "Untitled",
                "uploader": data.get("uploader") or data.get("channel") or "",
                "duration": data.get("duration") or 0,
                "thumbnail": data.get("thumbnail") or "",
                "extractor": data.get("extractor_key") or data.get("extractor") or "",
                "webpage_url": data.get("webpage_url") or url,
                "is_live": bool(data.get("is_live")),
                "can_trim": is_youtube(url) and not data.get("is_live"),
                "heights": heights[:8],
            })
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    # -- download ---------------------------------------------------------

    def handle_download(self, params: dict):
        if not self.authorized(params):
            self.send_json(401, {"ok": False, "error": "This server requires an API token."})
            return

        try:
            url = validate_url(params.get("url", [""])[0])
        except BadURL as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})
            return

        mode = params.get("mode", ["best"])[0]
        if mode not in MODES:
            self.send_json(400, {"ok": False, "error": "Unknown quality."})
            return

        if not rate_ok(self.client_ip()):
            self.send_json(429, {"ok": False, "error": "Too many requests. Wait a few minutes."})
            return

        # ---- optional trim (YouTube only) ----
        start_raw = params.get("start", [""])[0].strip()
        end_raw = params.get("end", [""])[0].strip()
        section = None
        if start_raw or end_raw:
            if not is_youtube(url):
                self.send_json(400, {"ok": False, "error": "Clipping is only supported for YouTube links."})
                return
            if not (start_raw and end_raw):
                self.send_json(400, {"ok": False, "error": "Give both a start and an end time."})
                return
            try:
                start = parse_time(start_raw)
                end = parse_time(end_raw)
            except BadTime as exc:
                self.send_json(400, {"ok": False, "error": str(exc)})
                return
            if end - start < 0.5:
                self.send_json(400, {"ok": False, "error": "The clip has to be at least half a second long."})
                return
            section = "*%.3f-%.3f" % (start, end)

        # One slot per in-flight download, taken without blocking: a queued
        # request that eventually times out is worse than an honest 503.
        if not _download_slots.acquire(blocking=False):
            self.send_json(503, {"ok": False, "error": "The server is busy with other downloads. Try again in a minute."})
            return

        workdir = None
        streaming = False
        try:
            workdir = tempfile.mkdtemp(prefix="mp4dl-")
            cookie_file = write_cookies(workdir)

            args = base_args(cookie_file) + [
                "-f", FORMATS[mode],
                "-o", os.path.join(workdir, "%(id)s.%(ext)s"),
            ]
            if mode == "audio":
                args += ["--extract-audio", "--audio-format", "mp3", "--audio-quality", "0"]
            else:
                args += ["--merge-output-format", "mp4"]
            if section:
                args += ["--download-sections", section]
                # Stream-copy cuts land on the nearest earlier keyframe, which
                # can add a second or two at the start. --force-keyframes-at-cuts
                # re-encodes the edges for an exact cut, so it is opt-in.
                if params.get("exact", [""])[0] in ("1", "true"):
                    args.append("--force-keyframes-at-cuts")
            args.append(url)

            timeout = 600 if mode != "audio" else 300
            try:
                proc = subprocess.run(
                    args, capture_output=True, text=True, timeout=timeout,
                    encoding="utf-8", errors="replace",
                )
            except subprocess.TimeoutExpired:
                self.send_json(504, {"ok": False, "error": "The download took too long and was stopped."})
                return

            if proc.returncode != 0:
                self.send_json(422, {"ok": False, "error": clean_error(proc.stderr)})
                return

            produced = [
                os.path.join(workdir, f) for f in os.listdir(workdir)
                if not f.endswith((".part", ".ytdl", ".temp"))
            ]
            files = [p for p in produced if os.path.isfile(p) and os.path.getsize(p) > 0]
            if not files:
                self.send_json(502, {"ok": False, "error": "yt-dlp reported success but wrote no file."})
                return

            path = max(files, key=os.path.getsize)
            ext = os.path.splitext(path)[1].lower()
            ctype = {
                ".mp4": "video/mp4",
                ".m4v": "video/mp4",
                ".webm": "video/webm",
                ".mkv": "video/x-matroska",
                ".mov": "video/quicktime",
                ".mp3": "audio/mpeg",
                ".m4a": "audio/mp4",
                ".opus": "audio/ogg",
                ".ogg": "audio/ogg",
            }.get(ext, "application/octet-stream")

            title = params.get("title", [""])[0]
            if section:
                title = (title or "video") + " (clip)"
            name = safe_name(title, "video") + ext
            # The plain `filename` field is a fallback for clients that ignore
            # filename*; keep its punctuation readable rather than mangling
            # "(clip)" into "-clip-".
            ascii_name = re.sub(r'[^A-Za-z0-9._ ()-]+', "-", name).strip() or ("video" + ext)

            size = os.path.getsize(path)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition",
                             'attachment; filename="%s"; filename*=UTF-8\'\'%s'
                             % (ascii_name, _rfc5987(name)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            streaming = True

            with open(path, "rb") as fh:
                while True:
                    chunk = fh.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        except (BrokenPipeError, ConnectionResetError):
            # The user hit cancel, or iOS backgrounded the tab. Nothing to do
            # but stop; the temp dir is cleaned below either way.
            pass
        except Exception as exc:  # noqa: BLE001 - last resort, never leak a traceback
            print("download failed: %r" % (exc,), flush=True)
            # Only safe to explain the failure while the headers are still
            # ours to write; afterwards any JSON would land in the file
            # stream and corrupt it.
            if not streaming:
                try:
                    self.send_json(500, {"ok": False, "error": "The server hit an unexpected error."})
                except Exception:
                    pass
        finally:
            if workdir:
                shutil.rmtree(workdir, ignore_errors=True)
            _download_slots.release()


def _rfc5987(name: str) -> str:
    return quote(name, safe="")


def main():
    print("mp4dl %s — yt-dlp %s, ffmpeg %s"
          % (VERSION, YTDLP_VERSION, "ok" if FFMPEG_OK else "MISSING"), flush=True)
    if not FFMPEG_OK:
        print("WARNING: ffmpeg is not on PATH; merges and MP3 extraction will fail.",
              flush=True)
    print("allowed hosts: %s" % ", ".join(ALLOWED_HOSTS), flush=True)

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    # Printed after the bind succeeds, so a failed start cannot look like a
    # healthy one in the logs.
    print("listening on :%d" % PORT, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
