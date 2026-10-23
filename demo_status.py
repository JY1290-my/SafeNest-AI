"""Explicit UI simulation. No YOLO, webcam, CSV writes, or cloud publishing."""
import time
from monitor_bridge import MonitorBridge, utc_now

def main():
    bridge = MonitorBridge(demo=True)
    bridge.start()
    print('DEMO ONLY: cycles Normal / Checking / Suspected Fall / Camera Offline.')
    try:
        while True:
            for status, connected in [('Normal',True), ('Checking',True), ('Suspected Fall',True), ('Camera Offline',False)]:
                bridge.state.record_event(utc_now(), status)
                for _ in range(8):
                    bridge.state.update(status, connected)
                    time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        bridge.close()

if __name__ == '__main__':
    main()
