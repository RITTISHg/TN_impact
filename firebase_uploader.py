"""
╔══════════════════════════════════════════════════════════════╗
║  Firebase Realtime Database Uploader — REST API Mode         ║
║  No credentials file needed — uses Firebase REST API         ║
║  Works with test-mode databases (public read/write)          ║
╚══════════════════════════════════════════════════════════════╝

Firebase Realtime Database schema written:
  /power_monitor/
    live/           ← Latest reading, overwritten every cycle
    readings/       ← Rolling history, appended every 5 readings
    alerts/         ← Written only on anomaly / non-normal fault
    session/        ← Written on dashboard shutdown
    onnx_perf/      ← ONNX perf snapshot every 30 readings
"""

from __future__ import annotations
import os
import queue
import threading
import time
from datetime import datetime
from typing import Any, Dict, Optional

try:
    import requests
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

# ══════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════
FIREBASE_DATABASE_URL: str = os.environ.get(
    "FIREBASE_DATABASE_URL",
    "https://energy-ml-default-rtdb.firebaseio.com"
).rstrip("/")

# Optional auth token (leave empty for test-mode public DB)
FIREBASE_AUTH_TOKEN: str = os.environ.get("FIREBASE_AUTH_TOKEN", "")

# Upload rate controls
LIVE_UPLOAD_EVERY_N    = 1      # push /live on every reading
HISTORY_UPLOAD_EVERY_N = 5      # append to /readings every N readings
ONNX_UPLOAD_EVERY_N    = 30     # push ONNX perf every N readings
MAX_QUEUE_SIZE         = 300    # drop oldest if queue overflows
RETRY_DELAY_S          = 3.0    # wait before retrying on error
MAX_HISTORY_NODES      = 500    # prune /readings when it exceeds this
REQUEST_TIMEOUT_S      = 3      # HTTP timeout per request (reduced from 8s)

FAULT_CLASS_NAMES: Dict[int, str] = {
    0: "Normal",
    1: "Overvoltage",
    2: "Undervoltage",
    3: "Overcurrent",
    4: "Overload",
    5: "Voltage Sag",
    6: "Voltage Swell",
    7: "Power Factor Issue",
    8: "Harmonic Distortion",
    9: "Phase Imbalance",
}


# ══════════════════════════════════════════════════════════════
# FIREBASE REST HELPERS
# ══════════════════════════════════════════════════════════════
def _auth_param() -> Dict[str, str]:
    """Return auth query param dict if token is set."""
    return {"auth": FIREBASE_AUTH_TOKEN} if FIREBASE_AUTH_TOKEN else {}


def _url(path: str) -> str:
    """Build full Firebase REST URL for a path."""
    return f"{FIREBASE_DATABASE_URL}/{path.lstrip('/')}.json"


def fb_put(path: str, data: Any) -> bool:
    """PUT (overwrite) a node. Returns True on success."""
    try:
        r = requests.put(
            _url(path), json=data,
            params=_auth_param(),
            timeout=REQUEST_TIMEOUT_S
        )
        return r.status_code == 200
    except Exception:
        return False


def fb_post(path: str, data: Any) -> Optional[str]:
    """POST (push/append) to a list node. Returns push key or None."""
    try:
        r = requests.post(
            _url(path), json=data,
            params=_auth_param(),
            timeout=REQUEST_TIMEOUT_S
        )
        if r.status_code == 200:
            return r.json().get("name")
    except Exception:
        pass
    return None


def fb_delete(path: str) -> bool:
    """DELETE a node."""
    try:
        r = requests.delete(
            _url(path),
            params=_auth_param(),
            timeout=REQUEST_TIMEOUT_S
        )
        return r.status_code == 200
    except Exception:
        return False


def fb_get_keys(path: str) -> list:
    """GET all child keys (shallow) for pruning."""
    try:
        r = requests.get(
            _url(path),
            params={**_auth_param(), "shallow": "true"},
            timeout=REQUEST_TIMEOUT_S
        )
        if r.status_code == 200 and r.json():
            return sorted(r.json().keys())
    except Exception:
        pass
    return []


# ══════════════════════════════════════════════════════════════
# UPLOADER CLASS
# ══════════════════════════════════════════════════════════════
class FirebaseUploader:
    """
    Background daemon thread that drains a queue and pushes data
    to Firebase Realtime Database via REST API — no credentials needed.
    """

    def __init__(self):
        self.is_ready: bool = _HAS_REQUESTS
        self._queue: queue.Queue = queue.Queue(maxsize=MAX_QUEUE_SIZE)
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._reading_count: int = 0
        self._error_count: int = 0
        self._success_count: int = 0
        self._last_error: Optional[str] = None
        self._session_start: str = datetime.now().isoformat(timespec='seconds')

        if not _HAS_REQUESTS:
            print("  [Firebase] 'requests' not installed. Run: pip install requests")
            return

        # Quick connectivity check
        try:
            r = requests.get(
                _url("power_monitor/live"),
                params=_auth_param(),
                timeout=5
            )
            if r.status_code == 200:
                print(f"  [Firebase] Connected  → {FIREBASE_DATABASE_URL}")
                print(f"  [Firebase] Root node  → /power_monitor/")
            else:
                print(f"  [Firebase] Warning: DB returned HTTP {r.status_code}")
        except Exception as e:
            print(f"  [Firebase] Warning: connectivity check failed: {e}")
            # Still try — might work when actual loop starts

    # ── public API ─────────────────────────────────────────────

    def start(self) -> None:
        if not self.is_ready:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._worker, name="FirebaseREST", daemon=True
        )
        self._thread.start()
        print("  [Firebase] Upload thread started (REST API mode).")

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)

    def enqueue_reading(
        self,
        v: float, i: float, p: float,
        ai_anomaly: Dict[str, Any],
        ai_fault:   Dict[str, Any],
        ai_health:  Dict[str, Any],
        energy_kwh: float = 0.0,
    ) -> None:
        self._reading_count += 1
        ts = datetime.now().isoformat(timespec='seconds')

        fault_id   = int(ai_fault.get('fault_id', 0))
        fault_name = FAULT_CLASS_NAMES.get(fault_id, "Unknown")
        is_anomaly = bool(ai_anomaly.get('is_anomaly', False))
        score      = float(ai_anomaly.get('score', 0.0))
        conf       = float(ai_fault.get('confidence', 1.0))
        health_score = float(ai_health.get('overall_score', 100.0))

        reading: Dict[str, Any] = {
            "timestamp":  ts,
            "voltage":    round(v, 2),
            "current":    round(i, 3),
            "power":      round(p, 2),
            "energy_kwh": round(energy_kwh, 6),
            "anomaly": {
                "is_anomaly": is_anomaly,
                "score":      round(score, 4),
            },
            "fault": {
                "fault_id":   fault_id,
                "fault_name": fault_name,
                "confidence": round(conf, 4),
            },
            "health": {
                "score": round(health_score, 1),
                "label": str(ai_health.get('label', 'Unknown')),
            },
        }

        # Always update /live
        self._safe_enqueue({'op': 'put', 'path': 'power_monitor/live', 'data': reading, 'n': self._reading_count})

        # Append to /readings every N samples
        if self._reading_count % HISTORY_UPLOAD_EVERY_N == 0:
            self._safe_enqueue({'op': 'post', 'path': 'power_monitor/readings', 'data': reading, 'n': self._reading_count})

        # Alert on anomaly or fault
        if is_anomaly or fault_id != 0:
            alert = {
                "timestamp": ts,
                "type":      "fault" if fault_id != 0 else "anomaly",
                "detail":    f"{fault_name} ({conf:.0%})" if fault_id != 0 else f"Anomaly score={score:.3f}",
                "severity":  "critical" if fault_id in (3, 4) else "warning",
                "voltage":   round(v, 2),
                "current":   round(i, 3),
                "power":     round(p, 2),
            }
            self._safe_enqueue({'op': 'post', 'path': 'power_monitor/alerts', 'data': alert, 'n': self._reading_count})

    def enqueue_onnx_perf(self, perf: Dict[str, Any]) -> None:
        data = {
            "timestamp":         datetime.now().isoformat(timespec='seconds'),
            "total_inferences":  int(perf.get('total_inferences', 0)),
            "avg_latency_ms":    round(float(perf.get('avg_latency_ms', 0)), 3),
            "p95_latency_ms":    round(float(perf.get('p95_latency_ms', 0)), 3),
            "throughput_ips":    round(float(perf.get('throughput_ips', 0)), 2),
            "error_count":       int(perf.get('error_count', 0)),
        }
        self._safe_enqueue({'op': 'put', 'path': 'power_monitor/onnx_perf', 'data': data})

    def enqueue_session_summary(
        self,
        sample_count: int,
        energy_kwh: float,
        peak_power: float,
        peak_power_time: str,
    ) -> None:
        data = {
            "start_time":      self._session_start,
            "end_time":        datetime.now().isoformat(timespec='seconds'),
            "sample_count":    sample_count,
            "energy_kwh":      round(energy_kwh, 6),
            "peak_power_w":    round(peak_power, 2),
            "peak_power_time": peak_power_time,
        }
        self._safe_enqueue({'op': 'put', 'path': 'power_monitor/session', 'data': data})

    def get_status(self) -> Dict[str, Any]:
        return {
            'ready':          self.is_ready,
            'queue_depth':    self._queue.qsize(),
            'readings_sent':  self._success_count,
            'errors':         self._error_count,
            'last_error':     self._last_error,
        }

    # ── internal ───────────────────────────────────────────────

    def _safe_enqueue(self, item: Dict[str, Any]) -> None:
        if not self.is_ready:
            return
        if self._queue.full():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
        try:
            self._queue.put_nowait(item)
        except queue.Full:
            pass

    def _worker(self) -> None:
        history_push_count = 0

        while not self._stop_event.is_set():
            try:
                item = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue

            op   = item.get('op', 'put')
            path = item.get('path', '')
            data = item.get('data', {})
            ok   = False

            try:
                if op == 'put':
                    ok = fb_put(path, data)
                elif op == 'post':
                    key = fb_post(path, data)
                    ok = key is not None
                    if ok and 'readings' in path:
                        history_push_count += 1
                        # Prune every 100 history pushes
                        if history_push_count % 100 == 0:
                            self._prune_readings()

                if ok:
                    self._success_count += 1
                else:
                    raise RuntimeError(f"Firebase REST returned failure for {op} {path}")

                self._queue.task_done()

            except Exception as e:
                self._error_count += 1
                self._last_error = str(e)
                self._safe_enqueue(item)   # re-queue for retry
                time.sleep(RETRY_DELAY_S)

    def _prune_readings(self) -> None:
        """Delete oldest entries in /readings if over MAX_HISTORY_NODES."""
        try:
            keys = fb_get_keys("power_monitor/readings")
            if len(keys) > MAX_HISTORY_NODES:
                to_delete = keys[:len(keys) - MAX_HISTORY_NODES]
                for k in to_delete:
                    fb_delete(f"power_monitor/readings/{k}")
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════
# SINGLETON
# ══════════════════════════════════════════════════════════════
_uploader: Optional[FirebaseUploader] = None

def get_uploader() -> FirebaseUploader:
    global _uploader
    if _uploader is None:
        _uploader = FirebaseUploader()
    return _uploader
