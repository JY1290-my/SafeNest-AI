"""Metadata bridge and authenticated local view; never opens a camera."""
import csv
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse

STALE_SECONDS = 15
BASE = Path(__file__).resolve().parent


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class MonitorState:
    def __init__(self, log_path=None, demo=False):
        self.lock = threading.RLock()
        self.status = "Starting"
        self.camera_connected = False
        self.updated_at = utc_now()
        self.updated_mono = time.monotonic()
        self.features = None
        self.context = None
        self.frame = None
        self.frame_at = 0
        self.jpeg = None
        self.jpeg_at = 0
        self.frame_requested_until = 0
        self.remote_requested_until = 0
        self.video_state = "Disabled"
        self.events = deque(maxlen=30)
        self.row_index = 0
        self.demo = demo
        self.cloud_state = "Disabled"
        self.room = os.getenv("SAFENEST_ROOM", "Living room")[:80]
        self.camera_name = os.getenv("SAFENEST_CAMERA_NAME", "Laptop camera")[:80]
        if log_path and Path(log_path).exists():
            try:
                with Path(log_path).open(encoding="utf-8-sig", newline="") as f:
                    for row in csv.DictReader(f):
                        self.record_event(row.get("time", ""), row.get("status", ""),
                                          row.get("angle_deg", ""), row.get("width_height_ratio", ""))
            except (OSError, csv.Error, UnicodeError):
                print("Dashboard: existing event history could not be read.")

    def record_event(self, timestamp, status, angle="", ratio="", reason=""):
        with self.lock:
            self.row_index += 1
            identity = json.dumps([self.row_index, timestamp, status, str(angle), str(ratio)])
            self.events.appendleft({"id": hashlib.sha256(identity.encode()).hexdigest(),
                                    "time": str(timestamp)[:50], "status": str(status)[:40],
                                    "angle_deg": str(angle)[:20], "width_height_ratio": str(ratio)[:20]})
            if reason:
                self.events[0]["reason"] = str(reason)[:160]

    def update(self, status, camera_connected, features=None, frame=None, context=None):
        with self.lock:
            self.status, self.camera_connected = status, camera_connected
            self.features = [float(v) if v is not None else None for v in features] if features is not None else None
            # Only bounded, text/number metadata; calibration geometry, tracks'
            # keypoints, scene descriptors and images never enter a snapshot.
            self.context = None
            if camera_connected and isinstance(context,dict):
                people = []
                for p in context.get("people",[])[:16]:
                    people.append({"person_number":int(p["person_number"]),"visible":p.get("visible") is True,
                                   **{k:str(p.get(k,""))[:160 if k=="reason" else 32]
                                      for k in ("state","baseline_status","zone","reason")}})
                self.context = {"calibration":str(context.get("calibration",""))[:160],
                                "visible_count":int(context.get("visible_count",0)),
                                "missing_count":int(context.get("missing_count",0)),"people":people}
            self.updated_at, self.updated_mono = utc_now(), time.monotonic()
            # Only retain a frame while a signed-in viewer has an active viewing lease.
            self.frame = frame if max(self.frame_requested_until, self.remote_requested_until) > self.updated_mono else None
            self.frame_at = self.updated_mono if self.frame is not None else 0
            if not camera_connected:
                self.frame = self.jpeg = None

    def snapshot(self):
        with self.lock:
            stale = time.monotonic() - self.updated_mono > STALE_SECONDS
            result = {"schema_version": 1, "status": "Connection Lost" if stale else self.status,
                    "observed_at": self.updated_at, "room": self.room, "camera_name": self.camera_name,
                    "camera_connected": self.camera_connected and not stale,
                    "stale": stale, "demo": self.demo, "features": self.features,
                    "events": list(self.events)}
            if self.context is not None and not stale:
                result["context"] = self.context
            return result

    def clear_remote_lease(self):
        with self.lock:
            self.remote_requested_until = 0
            if self.frame_requested_until <= time.monotonic():
                self.frame = self.jpeg = None
                self.frame_at = 0

    def remote_frame(self):
        """Latest frame only; a remote worker must reauthorize before calling this."""
        with self.lock:
            now = time.monotonic()
            self.remote_requested_until = now + .5
            if not self.camera_connected or self.frame is None or now - self.frame_at >= 2:
                return None
            return self.frame, self.frame_at

    def frame_jpeg(self):
        with self.lock:
            now = time.monotonic()
            self.frame_requested_until = now + 3
            if not self.camera_connected or self.frame is None or now - self.frame_at > 2:
                return None
            if self.jpeg is not None and now - self.jpeg_at < 0.2:
                return self.jpeg
            frame = self.frame
        import cv2  # No model/camera imports needed for status-only testing.
        h, w = frame.shape[:2]
        if w > 640:
            frame = cv2.resize(frame, (640, max(1, round(h * 640 / w))))
        ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 65])
        if not ok:
            return None
        with self.lock:
            self.jpeg, self.jpeg_at = encoded.tobytes(), now
            return self.jpeg


class CloudPublisher:
    """One bounded background worker: internet failures never block inference."""
    def __init__(self, state):
        self.state = state
        self.stop_event = threading.Event()
        self.thread = None
        self.url = os.getenv("SUPABASE_URL", "").rstrip("/")
        self.key = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
        self.device = os.getenv("SAFENEST_DEVICE_ID", "")
        self.token = os.getenv("SAFENEST_DEVICE_TOKEN", "")
        self.camera = os.getenv("SAFENEST_CAMERA_ID", "")
        configured = all((self.url, self.key, self.device, self.token))
        self.enabled = configured and not state.demo
        if self.enabled and (urlparse(self.url).scheme != "https" or len(self.token) < 32):
            print("Cloud disabled: HTTPS URL and a device token of at least 32 characters are required.")
            self.enabled = False

    def start(self):
        if self.enabled:
            self.state.cloud_state = "Connecting"
            self.thread = threading.Thread(target=self._run, daemon=True, name="status-publisher")
            self.thread.start()

    def _send(self, session):
        # Explicit JSON metadata only. Frames are never part of snapshot().
        response = session.post(self.url + ("/rest/v1/rpc/publish_camera_monitor" if self.camera else "/rest/v1/rpc/publish_monitor"),
                                headers={"apikey": self.key, "Content-Type": "application/json"},
                                json={"p_device": self.device, "p_token": self.token,
                                      "p_payload": self.state.snapshot(), **({"p_camera":self.camera} if self.camera else {})},
                                timeout=(2, 3), allow_redirects=False)
        if not 200 <= response.status_code < 300:
            raise RuntimeError("Cloud publication rejected")

    def _run(self):
        import requests
        delay = 2
        with requests.Session() as session:
            while not self.stop_event.is_set():
                try:
                    self._send(session)
                    self.state.cloud_state, delay = "Connected", 2
                except (requests.RequestException, RuntimeError, ValueError):
                    self.state.cloud_state = "Disconnected"
                    delay = min(delay * 2, 30)
                self.stop_event.wait(delay)
            try:
                self._send(session)  # Best-effort final offline state.
            except (requests.RequestException, RuntimeError, ValueError):
                pass

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=6)


def create_local_app(state, password):
    from flask import Flask, request, session, jsonify, send_from_directory, Response
    from functools import wraps
    if len(password) < 12:
        raise ValueError("Local password must have at least 12 characters.")
    app = Flask(__name__, static_folder=None)
    app.secret_key = secrets.token_bytes(32)
    app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Strict",
                      PERMANENT_SESSION_LIFETIME=timedelta(hours=8), MAX_CONTENT_LENGTH=2048,
                      SESSION_COOKIE_SECURE=os.getenv("SAFENEST_COOKIE_SECURE") == "1")
    attempts = deque(maxlen=100)
    attempt_lock = threading.Lock()

    def protected(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if not session.get("signed_in"):
                return jsonify(error="Sign in required"), 401
            return fn(*args, **kwargs)
        return wrapped

    @app.before_request
    def check_origin():
        if request.method == "POST" and request.headers.get("Origin"):
            if request.headers["Origin"].rstrip("/") != request.host_url.rstrip("/"):
                return jsonify(error="Origin not allowed"), 403

    @app.after_request
    def secure_headers(response):
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                 "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
                                 "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
                                 "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"})
        return response

    @app.post("/api/login")
    def login():
        with attempt_lock:
            now = time.monotonic()
            while attempts and now - attempts[0] > 60:
                attempts.popleft()
            if len(attempts) >= 10:
                return jsonify(error="Too many attempts. Wait one minute."), 429
            body = request.get_json(silent=True)
            if not isinstance(body, dict):
                return jsonify(error="Expected a JSON object"), 400
            given = body.get("password", "")
            if not isinstance(given, str) or not hmac.compare_digest(given.encode(), password.encode()):
                attempts.append(now)
                return jsonify(error="Incorrect password"), 401
        session.clear()
        session["signed_in"] = True
        session.permanent = True
        return jsonify(ok=True)

    @app.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    @app.get("/api/status")
    @protected
    def status():
        return jsonify(server_now=utc_now(), received_at=utc_now(), payload=state.snapshot(),
                       cloud_state=state.cloud_state, video_state=state.video_state, camera_transport="local-jpeg" if not state.demo else "none")

    @app.get("/api/frame")
    @protected
    def frame():
        image = state.frame_jpeg()
        if image is None:
            return jsonify(error="Camera stream not connected"), 503
        return Response(image, mimetype="image/jpeg")

    @app.get("/config.js")
    def config():
        return Response('window.SAFENEST_CONFIG = {mode: "local"};', mimetype="application/javascript")

    @app.get("/")
    def index():
        return send_from_directory(BASE / "web", "index.html")

    @app.get("/<path:filename>")
    def assets(filename):
        if filename not in {"styles.css", "app.js", "dashboard.js", "cloud-client.js", "logic.js", "camera-window.js", "camera-tools.js", "fall-alert.js", "family-alerts.js", "push-notifications.js", "family-view.js", "family-management.js", "ui-overlays.js", "password-recovery.js", "home-cameras.js", "presence-client.js", "icon.svg", "manifest.webmanifest", "video-client.js", "THIRD_PARTY_NOTICES.txt"}:
            return jsonify(error="Not found"), 404
        return send_from_directory(BASE / "web", filename)
    return app


class MonitorBridge:
    def __init__(self, log_path=None, demo=False):
        from dotenv import load_dotenv
        load_dotenv(BASE / ".env")
        from device_settings import SettingsStore
        self.device_setup = SettingsStore(BASE).ensure().current()
        from camera_catalog import CameraCatalog
        binding = next((item for camera,item in CameraCatalog(BASE).entries() if camera.key==self.device_setup.key), None)
        if binding:
            os.environ['SAFENEST_CAMERA_ID'] = binding['camera_id']
            if not binding.get('is_default'):
                logs=BASE / 'camera_logs' / self.device_setup.scope / binding['camera_id']
                logs.mkdir(parents=True,exist_ok=True);log_path=logs / 'events.csv'
                self.context_log_path=logs / 'context_events.jsonl'
        else:
            os.environ.pop('SAFENEST_CAMERA_ID', None)
        self.log_path = log_path or BASE / 'events.csv'
        self.state = MonitorState(log_path, demo)
        self.state.room = self.device_setup.room
        self.state.camera_name = self.device_setup.camera_name
        self.publisher = CloudPublisher(self.state)
        from video_publisher import VideoPublisher
        self.video = VideoPublisher(self.state)
        self.server = None

    def start(self):
        self.publisher.start()
        self.video.start()
        if os.getenv("SAFENEST_CAMERA_WORKER") == "1":
            return  # Independent worker streams use the family site; no shared local port.
        password = os.getenv("SAFENEST_LOCAL_PASSWORD", "")
        if not password:
            print("Local dashboard disabled. Set SAFENEST_LOCAL_PASSWORD in .env to enable it.")
            return
        try:
            from waitress import create_server
            host = os.getenv("SAFENEST_LOCAL_HOST", "127.0.0.1")
            port = int(os.getenv("SAFENEST_LOCAL_PORT", "8765"))
            self.server = create_server(create_local_app(self.state, password), host=host, port=port, threads=4)
            threading.Thread(target=self.server.run, daemon=True, name="local-dashboard").start()
            print(f"SafeNest dashboard: http://{host}:{port}")
        except (OSError, ValueError) as exc:
            print(f"Local dashboard not started: {type(exc).__name__}. Detection remains available.")

    def close(self):
        if self.state.status not in {"Camera Offline", "AI Offline"}:
            self.state.update("AI Offline", False)
        self.video.close()
        self.publisher.close()
        if self.server:
            self.server.close()
