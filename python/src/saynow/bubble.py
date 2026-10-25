"""The floating bubble, for the pip build.

A port of src/bubble.js. The page itself is shared verbatim — bubble.html is
copied into this package rather than reimplemented, so the two builds cannot
drift into looking or behaving differently.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, quote, urlparse

from .markdown import render as render_markdown

WIDTH = 420
INITIAL_HEIGHT = 200

BROWSERS = {
    "darwin": [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    "linux": ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"],
}


# Images a reply can carry, and the extension each is saved under. Raster
# formats only, and handed to the page so that it attaches nothing this would
# then drop. WebKit turns a TIFF on the clipboard into a PNG before the page
# sees it, which is why a screenshot copied with ctrl-shift-cmd-4 arrives as
# image/png.
IMAGE_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/tiff": "tiff",
    "image/bmp": "bmp",
}

_DATA_URL = re.compile(r"^data:([\w./+-]+);base64,(.*)$", re.S)


def save_images(images: Any) -> List[str]:
    """Write the images a reply carried to disk, and return their paths.

    The caller only ever reads text from us, so a picture has to become a file
    it can open. Each reply gets a fresh directory only this user can read,
    left in the system temp folder for the OS to clear away.

    Never raises. An image that cannot be saved is reported and skipped, since
    the words of the reply are still worth delivering on their own.
    """
    if not isinstance(images, list):
        return []
    saved: List[str] = []
    directory: Optional[str] = None
    for image in images:
        match = _DATA_URL.match(str(image or ""))
        ext = IMAGE_TYPES.get(match.group(1).lower()) if match else None
        if not ext:
            continue
        try:
            data = base64.b64decode(match.group(2))
            directory = directory or tempfile.mkdtemp(prefix="saynow-reply-")
            path = os.path.join(directory, f"image-{len(saved) + 1}.{ext}")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            saved.append(path)
        except (OSError, binascii.Error, ValueError) as err:
            sys.stderr.write(f"saynow: could not save a pasted image: {err}\n")
    return saved


def cache_dir() -> Path:
    override = os.environ.get("SAYNOW_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "saynow"
    base = os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")
    return Path(base) / "saynow"


def available() -> Optional[str]:
    """Which window shell can be used, if any."""
    if sys.platform == "darwin" and shutil.which("swiftc"):
        return "panel"
    for candidate in BROWSERS.get(sys.platform, []):
        if Path(candidate).exists() or shutil.which(candidate):
            return "browser"
    return None


def resolve_asset(directory: Path, relative: str) -> Optional[Path]:
    """Resolve a document-relative path, or None if it climbs out.

    A document is shown with the reader's own files reachable behind it, so
    this is the only thing stopping "../../../.ssh/id_rsa" from being served
    to a page whose content an agent wrote.
    """
    root = Path(directory).resolve()
    full = (root / relative).resolve()
    if full == root or not str(full).startswith(str(root) + os.sep):
        return None
    return full


def _page(state: Dict[str, Any]) -> bytes:
    html = (Path(__file__).parent / "bubble.html").read_text(encoding="utf-8")
    injected = "<script>window.__SAYNOW__ = {};</script>".format(
        json.dumps(state).replace("<", "\\u003c")
    )
    return html.replace("<!--SAYNOW_STATE-->", injected).encode("utf-8")


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def show_bubble(
    text: str,
    ask: bool = False,
    sender: Optional[str] = None,
    audio: Optional[bytes] = None,
    audio_ext: str = "wav",
    document: Optional[Dict[str, Any]] = None,
    rate: Optional[float] = None,
    dismiss_ms: Optional[int] = None,
    # Off by default: nothing takes the bubble away on a clock. Tests set it to
    # bound a headless server that no one is ever going to answer.
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """Show the bubble and wait.

    Returns {"reason": "reply"|"dismiss", "text": ..., "images": [...]}, where
    images holds the path of each picture pasted into the reply.
    """

    # A secret for this bubble alone. POST /reply is what the caller reads back
    # as the user's answer, so anything able to reach the port could otherwise
    # answer on their behalf. Declared before the asset callback that closes
    # over it — in the npm build a reference from above threw for documents
    # carrying a relative image and left every other one working.
    token = secrets.token_hex(24)
    document_dir = Path(document["dir"]) if document and document.get("dir") else None

    def asset(src: str) -> Optional[str]:
        # An unknown scheme is dropped rather than guessed at.
        if re.match(r"^[a-z][\w+.-]*:", src, re.I):
            return None
        return f"/asset?t={token}&p={quote(src, safe='')}"

    state = {
        "text": text,
        "ask": ask,
        "from": sender or None,
        "rate": rate or 175,
        # The same for a question as for a statement. Being present is what
        # holds a bubble open, not what it happens to be asking.
        "dismissMs": dismiss_ms or 5000,
        "imageTypes": list(IMAGE_TYPES) if ask else [],
        "hasAudio": bool(audio),
        # Rendered here rather than in the page: the renderer escapes its input
        # and emits only tags it built, so the page never parses agent text.
        "html": render_markdown(document["markdown"], asset=asset) if document else None,
        "chunks": None,
    }
    page = _page(state)

    settled: Dict[str, Any] = {}
    done = threading.Event()

    def settle(reason: str, body: Optional[Dict[str, Any]] = None) -> None:
        if not done.is_set():
            body = body if isinstance(body, dict) else {}
            settled.update(
                {
                    "reason": reason,
                    "text": str(body.get("text") or "").strip(),
                    "images": save_images(body.get("images")),
                }
            )
            done.set()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # noqa: D401 - silence the default logging
            pass

        def _authorised(self) -> bool:
            supplied = self.headers.get("X-Saynow-Token") or (
                parse_qs(urlparse(self.path).query).get("t", [""])[0]
            )
            return secrets.compare_digest(str(supplied), token)

        def _send(self, code: int, body: bytes = b"", content_type: str = "text/plain"):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_GET(self):  # noqa: N802 - required by BaseHTTPRequestHandler
            if not self._authorised():
                self._send(403)
                return
            route = urlparse(self.path).path

            if route == "/audio" and audio:
                self._send(
                    200, audio, "audio/mpeg" if audio_ext == "mp3" else "audio/wav"
                )
                return

            if route == "/asset" and document_dir:
                rel = parse_qs(urlparse(self.path).query).get("p", [""])[0]
                full = resolve_asset(document_dir, rel)
                if full is None:
                    self._send(403)
                    return
                try:
                    self._send(
                        200,
                        full.read_bytes(),
                        mimetypes.guess_type(str(full))[0] or "application/octet-stream",
                    )
                except OSError:
                    self._send(404)
                return

            if route == "/events":
                # Held open but silent: with audio present the page drives the
                # transcript from the audio clock and never needs this.
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                try:
                    while not done.is_set():
                        time.sleep(0.2)
                except OSError:
                    pass
                return

            self._send(200, page, "text/html; charset=utf-8")

        def do_POST(self):  # noqa: N802
            if not self._authorised():
                self._send(403)
                return
            route = urlparse(self.path).path
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except (json.JSONDecodeError, ValueError):
                body = {}
            self._send(204)

            if route == "/reply":
                settle("reply", body)
            elif route in ("/dismiss", "/close"):
                settle("dismiss")

    server = _Server(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    url = f"http://127.0.0.1:{port}/?t={token}"
    window, is_panel = _open_window(url)

    # Nothing here ends the bubble on a timer. It closes when the page says so
    # — dismissed, answered, or counted down in front of someone who was not
    # there. The one exception is the shell vanishing: the panel draws no close
    # button of its own, so its process ending means it died rather than was
    # dismissed, and there is nothing left on screen for anyone to answer with.
    # Deliberately not wired for the browser fallback: a Chromium spawned
    # against a profile that is already running hands its window to the
    # existing instance and exits at once, which would read as a dismissal.
    if window is None and not os.environ.get("SAYNOW_NO_WINDOW"):
        # Neither shell opened, so nothing was put on the screen and no one can
        # ever answer. With no clock left to fall back on, saying so at once is
        # what stops the caller waiting for a bubble that does not exist.
        settle("dismiss")
    elif window is not None and is_panel:

        def watch(proc=window) -> None:
            proc.wait()
            settle("dismiss")

        threading.Thread(target=watch, daemon=True).start()

    try:
        done.wait(timeout=timeout)
        return settled or {"reason": "dismiss", "text": "", "images": []}
    finally:
        if window:
            window.terminate()
        server.shutdown()
        server.server_close()


def _open_window(url: str):
    """Prefer the native panel; fall back to a Chromium app window.

    Returns (process, is_panel). The caller treats the two shells differently
    when they exit, so it has to be able to tell them apart.
    """
    # Tests need the server without putting a window on someone's screen.
    if os.environ.get("SAYNOW_NO_WINDOW"):
        return None, False
    if sys.platform == "darwin" and shutil.which("swiftc"):
        source = Path(__file__).parent / "SaynowPanel.swift"
        digest = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
        binary = cache_dir() / f"panel-{digest}"

        if not binary.exists():
            cache_dir().mkdir(parents=True, exist_ok=True)
            built = subprocess.run(
                ["swiftc", "-O", "-o", str(binary), str(source)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=120,
            )
            if built.returncode != 0:
                return _open_browser(url), False

        # The panel exits when this pipe closes, so it cannot outlive us.
        return (
            subprocess.Popen(
                [str(binary), url, str(WIDTH), str(INITIAL_HEIGHT)],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ),
            True,
        )

    return _open_browser(url), False


def _open_browser(url: str):
    for candidate in BROWSERS.get(sys.platform, []):
        path = candidate if Path(candidate).exists() else shutil.which(candidate)
        if not path:
            continue
        return subprocess.Popen(
            [
                path,
                f"--app={url}",
                f"--window-size={WIDTH},{INITIAL_HEIGHT + 40}",
                f"--user-data-dir={cache_dir() / 'browser-profile'}",
                "--no-first-run",
                "--no-default-browser-check",
                "--autoplay-policy=no-user-gesture-required",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    return None
