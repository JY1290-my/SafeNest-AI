"""One isolated detector process per registered local Camera, existing algorithm."""
import os
from pathlib import Path
import subprocess
import sys
import time
from device_settings import CaptureLease, SettingsStore, DeviceSetupError
from camera_catalog import CameraCatalog

ROOT = Path(__file__).resolve().parent


def worker_spec(root, key):
    catalog = CameraCatalog(root)
    for camera, binding in catalog.entries():
        if camera.key == key:
            return camera, binding
    raise DeviceSetupError('Camera setup belongs to another device or is no longer registered locally.')


def run_worker(root, key):
    from dotenv import load_dotenv
    load_dotenv(Path(root) / '.env')
    camera, binding = worker_spec(root, key)
    os.environ['SAFENEST_CAMERA_KEY'] = key
    os.environ['SAFENEST_CAMERA_ID'] = binding['camera_id']
    os.environ['SAFENEST_CAMERA_WORKER'] = '1'
    from monitor_bridge import MonitorBridge
    from fall_detection import run_detector
    logs = Path(root) / 'camera_logs' / camera.scope / binding['camera_id']
    logs.mkdir(parents=True, exist_ok=True)
    # Keep the original primary-camera files; additional cameras never append there.
    log = Path(root) / 'events.csv' if binding.get('is_default') else logs / 'events.csv'
    bridge = MonitorBridge(log)
    bridge.log_path = log
    bridge.context_log_path = Path(root) / 'context_events.jsonl' if binding.get('is_default') else logs / 'context_events.jsonl'
    bridge.start()
    try:
        run_detector(bridge)
    finally:
        bridge.close()


def run_all(root=ROOT, popen=subprocess.Popen, wait=time.sleep):
    catalog = CameraCatalog(root)
    cameras = catalog.entries()
    if not cameras: raise DeviceSetupError('Register at least one camera in Camera setup first.')
    sources = [camera.source for camera, _ in cameras]
    if len(sources) != len(set(sources)): raise DeviceSetupError('Each active camera needs a different local camera index.')
    processes = []
    with CaptureLease(root):
        try:
            for camera, _ in cameras:
                processes.append(popen([sys.executable, str(Path(root) / 'multi_camera_runner.py'), '--worker', camera.key],
                                       cwd=str(root), shell=False))
            while any(p.poll() is None for p in processes): wait(.3)
        finally:
            for p in processes:
                if p.poll() is None: p.terminate()
            for p in processes:
                try: p.wait(timeout=5)
                except subprocess.TimeoutExpired: p.kill(); p.wait(timeout=2)
    return 0


def main():
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--worker':
            run_worker(ROOT, sys.argv[2]); return 0
        if len(sys.argv) == 3 and sys.argv[1] == '--single':
            with CaptureLease(ROOT): run_worker(ROOT, sys.argv[2])
            return 0
        if len(sys.argv) != 1: return 2
        return run_all()
    except KeyboardInterrupt:
        return 0
    except DeviceSetupError as exc:
        print(str(exc)); return 1


if __name__ == '__main__':
    raise SystemExit(main())
