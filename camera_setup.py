"""Local desktop entry to camera settings, setup preview and the detector.

No HTTP endpoints, camera capture, cloud login or device management authority.
Setup preview and monitoring use exclusive capture in separate local processes.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import time
from device_settings import CaptureLease, DeviceSetupError


ROOT = Path(__file__).resolve().parent


class SetupError(Exception):
    """Safe, user-facing startup error (never include environment contents)."""


def public_settings(root=ROOT, environ=None):
    """Read labels only; never return credentials, URLs or the full environment."""
    from dotenv import dotenv_values
    env = os.environ if environ is None else environ
    try:
        values = dotenv_values(Path(root) / '.env', interpolate=False)
    except (OSError, UnicodeError):
        values = {}
    result = {}
    for key, fallback in [('SAFENEST_ROOM', 'Living room'),
                          ('SAFENEST_CAMERA_NAME', 'Laptop camera'),
                          ('SAFENEST_CAMERA_PROFILE', 'default')]:
        value = env.get(key, values.get(key))
        value = fallback if value is None else str(value)
        result[key] = ''.join(c for c in value if c.isprintable())[:80]
    return result


def check_runtime():
    missing = [name for name in ('cv2', 'ultralytics', 'dotenv')
               if importlib.util.find_spec(name) is None]
    if missing:
        raise SetupError('Monitoring dependencies are missing. Open this launcher using '
                         'your existing SafeNest virtual environment; see README.')


class DetectorLauncher:
    def __init__(self, root=ROOT, executable=None, popen=None, check=None):
        self.root = Path(root).resolve()
        self.executable = executable or sys.executable
        self.popen = popen or subprocess.Popen
        self.check = check or check_runtime
        self.process = None
        self.mode = None
        self.scan_deadline = None

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    def start(self):
        if self.running:
            return False
        script = self.root / 'fall_detection.py'
        if not script.is_file():
            raise SetupError('fall_detection.py is missing. Keep the launcher in the project folder.')
        if not (self.root / 'yolo11n-pose.pt').is_file():
            raise SetupError('The existing yolo11n-pose.pt model is missing. Keep your working model '
                             'in this project folder. No model is downloaded by this launcher.')
        self.check()
        from camera_catalog import CameraCatalog
        catalog = CameraCatalog(self.root)
        selected = catalog.store.current()
        if any(camera.key == selected.key for camera, _ in catalog.entries()):
            return self._spawn(self.root / 'multi_camera_runner.py', 'monitor', ['--single', selected.key])
        if catalog.entries():
            raise SetupError('Register this selected camera before monitoring it, or select a registered camera.')
        return self._spawn(script, 'monitor')

    def start_all(self):
        if self.running: return False
        self.check()
        if not (self.root / "yolo11n-pose.pt").is_file():
            raise SetupError("Keep your existing yolo11n-pose.pt in the project folder.")
        return self._spawn(self.root / "multi_camera_runner.py", "monitor")

    def preview(self):
        if self.running: return False
        script = self.root / 'camera_preview.py'
        if not script.is_file(): raise SetupError('camera_preview.py is missing from the project folder.')
        return self._spawn(script, 'preview')

    def scan(self):
        if self.running: return False
        script = self.root / 'camera_preview.py'
        if not script.is_file(): raise SetupError('camera_preview.py is missing from the project folder.')
        result = self._spawn(script, 'scan', ['--scan'])
        self.scan_deadline = time.monotonic() + 25
        return result

    def stop_setup(self):
        # Never terminate monitoring or its local alarm through a setup cleanup.
        if self.mode in ('scan', 'preview') and self.running:
            self.process.terminate()
            try: self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=2)

    def _spawn(self, script, mode, args=()):
        try:
            with CaptureLease(self.root): pass
        except DeviceSetupError as exc:
            raise SetupError(str(exc)) from None
        options = {'cwd': str(self.root), 'shell': False}
        if mode == 'scan':
            options.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if os.name == 'nt': options['creationflags'] = subprocess.CREATE_NO_WINDOW
        elif os.name == 'nt':
            options['creationflags'] = subprocess.CREATE_NEW_CONSOLE
        try:
            self.process = self.popen([self.executable, str(script), *args], **options)
            self.mode = mode
        except OSError:
            raise SetupError('Could not start monitoring. Check your Python environment and project folder.') from None
        return True


def main():
    from device_setup_ui import run_ui
    return run_ui(ROOT, DetectorLauncher)


if __name__ == '__main__':
    raise SystemExit(main())
