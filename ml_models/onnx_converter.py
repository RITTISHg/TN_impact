"""
╔══════════════════════════════════════════════════════════════╗
║  ONNX Model Converter & Inference Runtime                   ║
║  Converts sklearn models → ONNX for accelerated inference   ║
║  Optimized for AMD Ryzen™ High-Performance Processors       ║
╚══════════════════════════════════════════════════════════════╝
"""

import os
import time
import numpy as np
from typing import Dict, Optional, Tuple, List
from collections import deque
from sklearn.ensemble import IsolationForest, RandomForestClassifier, GradientBoostingClassifier
from sklearn.preprocessing import StandardScaler

try:
    import onnxruntime as ort
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
    _HAS_ONNX = True
except ImportError:
    _HAS_ONNX = False

from .config import MODELS_DIR


class ONNXPerformanceMonitor:
    """
    Tracks ONNX inference performance metrics in real-time.
    
    Monitors:
        - Inference latency (per-call, rolling average, p95, p99)
        - Throughput (inferences per second)
        - Memory efficiency
        - Model load times
        - Session statistics
    """

    def __init__(self, history_size: int = 2000):
        self.latency_history = deque(maxlen=history_size)
        self.throughput_history = deque(maxlen=history_size)
        self.model_latencies = {}  # Per-model latency tracking
        
        self.total_inferences = 0
        self.total_inference_time = 0.0
        self.session_start = time.time()
        
        # Model load times
        self.model_load_times = {}
        
        # Error tracking
        self.error_count = 0
        self.last_error = None
        
        # Batch stats
        self._batch_start = None
        self._batch_count = 0

    def record_inference(self, model_name: str, latency_ms: float):
        """Record a single inference event."""
        self.latency_history.append({
            'model': model_name,
            'latency_ms': latency_ms,
            'timestamp': time.time(),
        })
        
        if model_name not in self.model_latencies:
            self.model_latencies[model_name] = deque(maxlen=500)
        self.model_latencies[model_name].append(latency_ms)
        
        self.total_inferences += 1
        self.total_inference_time += latency_ms

    def record_model_load(self, model_name: str, load_time_ms: float):
        """Record model load time."""
        self.model_load_times[model_name] = load_time_ms

    def record_error(self, error_msg: str):
        """Record an inference error."""
        self.error_count += 1
        self.last_error = error_msg

    def get_stats(self) -> Dict:
        """Get comprehensive performance statistics."""
        stats = {
            'total_inferences': self.total_inferences,
            'total_time_ms': self.total_inference_time,
            'session_uptime_s': time.time() - self.session_start,
            'error_count': self.error_count,
            'models_loaded': len(self.model_load_times),
        }
        
        if self.latency_history:
            latencies = [x['latency_ms'] for x in self.latency_history]
            stats['avg_latency_ms'] = np.mean(latencies)
            stats['min_latency_ms'] = np.min(latencies)
            stats['max_latency_ms'] = np.max(latencies)
            stats['p50_latency_ms'] = np.percentile(latencies, 50)
            stats['p95_latency_ms'] = np.percentile(latencies, 95)
            stats['p99_latency_ms'] = np.percentile(latencies, 99)
            stats['std_latency_ms'] = np.std(latencies)
            
            # Throughput
            elapsed = stats['session_uptime_s']
            if elapsed > 0:
                stats['throughput_ips'] = self.total_inferences / elapsed
            else:
                stats['throughput_ips'] = 0.0
        else:
            stats['avg_latency_ms'] = 0.0
            stats['min_latency_ms'] = 0.0
            stats['max_latency_ms'] = 0.0
            stats['p50_latency_ms'] = 0.0
            stats['p95_latency_ms'] = 0.0
            stats['p99_latency_ms'] = 0.0
            stats['std_latency_ms'] = 0.0
            stats['throughput_ips'] = 0.0
        
        # Per-model stats
        stats['per_model'] = {}
        for model_name, latencies in self.model_latencies.items():
            lats = list(latencies)
            stats['per_model'][model_name] = {
                'avg_ms': np.mean(lats),
                'p95_ms': np.percentile(lats, 95) if len(lats) >= 20 else np.max(lats),
                'count': len(lats),
                'load_time_ms': self.model_load_times.get(model_name, 0),
            }
        
        return stats

    def get_recent_latencies(self, n: int = 50) -> List[float]:
        """Get recent latency values for plotting."""
        return [x['latency_ms'] for x in list(self.latency_history)[-n:]]


class ONNXModelConverter:
    """
    Converts sklearn models to ONNX format and provides
    high-performance inference sessions.
    """

    ONNX_DIR = os.path.join(MODELS_DIR, "onnx")

    def __init__(self):
        os.makedirs(self.ONNX_DIR, exist_ok=True)
        self.sessions = {}  # model_name -> ort.InferenceSession
        self.monitor = ONNXPerformanceMonitor()

    @staticmethod
    def _get_onnx_providers():
        """Get available ONNX Runtime execution providers."""
        available = ort.get_available_providers() if _HAS_ONNX else []
        # Prefer AMD-friendly providers
        preferred = []
        for prov in ['DmlExecutionProvider', 'CPUExecutionProvider']:
            if prov in available:
                preferred.append(prov)
        return preferred if preferred else ['CPUExecutionProvider']

    def convert_isolation_forest(self, model: IsolationForest,
                                  scaler: StandardScaler,
                                  n_features: int,
                                  model_name: str = "anomaly_detector") -> bool:
        """Convert IsolationForest + Scaler pipeline to ONNX."""
        if not _HAS_ONNX:
            print("  ⚠️ ONNX libraries not available")
            return False

        try:
            from sklearn.pipeline import Pipeline
            pipeline = Pipeline([
                ('scaler', scaler),
                ('model', model),
            ])

            initial_type = [('float_input', FloatTensorType([None, n_features]))]
            # Use dict to pin ai.onnx.ml domain to v3 (skl2onnx max supported)
            # newer sklearn/onnx generates ai.onnx.ml v4 which skl2onnx can't handle
            onnx_model = convert_sklearn(
                pipeline, initial_types=initial_type,
                target_opset={'': 12, 'ai.onnx.ml': 3},
                options={id(model): {'score_samples': True}},
            )

            path = os.path.join(self.ONNX_DIR, f"{model_name}.onnx")
            with open(path, "wb") as f:
                f.write(onnx_model.SerializeToString())

            print(f"  ✅ ONNX model exported: {model_name} → {path}")
            return True

        except Exception as e:
            print(f"  ⚠️ ONNX conversion failed for {model_name}: {e}")
            return False

    def convert_classifier(self, rf_model: RandomForestClassifier,
                            gb_model: GradientBoostingClassifier,
                            scaler: StandardScaler,
                            n_features: int,
                            model_name_prefix: str = "fault") -> bool:
        """Convert RF + GB classifiers to individual ONNX models."""
        if not _HAS_ONNX:
            return False

        success = True
        for name, model in [("rf", rf_model), ("gb", gb_model)]:
            try:
                from sklearn.pipeline import Pipeline
                pipeline = Pipeline([
                    ('scaler', scaler),
                    ('model', model),
                ])

                initial_type = [('float_input', FloatTensorType([None, n_features]))]
                # Pin ai.onnx.ml domain to v3 to avoid opset version mismatch
                onnx_model = convert_sklearn(
                    pipeline, initial_types=initial_type,
                    target_opset={'': 12, 'ai.onnx.ml': 3},
                    options={id(model): {'zipmap': False}},
                )

                path = os.path.join(self.ONNX_DIR, f"{model_name_prefix}_{name}.onnx")
                with open(path, "wb") as f:
                    f.write(onnx_model.SerializeToString())

                print(f"  ✅ ONNX model exported: {model_name_prefix}_{name} → {path}")

            except Exception as e:
                print(f"  ⚠️ ONNX conversion failed for {model_name_prefix}_{name}: {e}")
                success = False

        return success

    def load_session(self, model_name: str) -> bool:
        """Load an ONNX model into an inference session."""
        path = os.path.join(self.ONNX_DIR, f"{model_name}.onnx")
        if not os.path.exists(path):
            return False

        try:
            t0 = time.perf_counter()
            providers = self._get_onnx_providers()
            sess_options = ort.SessionOptions()
            sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            sess_options.intra_op_num_threads = 4
            sess_options.inter_op_num_threads = 2

            session = ort.InferenceSession(path, sess_options, providers=providers)
            load_time = (time.perf_counter() - t0) * 1000

            self.sessions[model_name] = session
            self.monitor.record_model_load(model_name, load_time)

            active_provider = session.get_providers()[0] if session.get_providers() else "Unknown"
            print(f"  📦 ONNX session loaded: {model_name} "
                  f"[{active_provider}] ({load_time:.1f}ms)")
            return True

        except Exception as e:
            print(f"  ⚠️ Failed to load ONNX session {model_name}: {e}")
            self.monitor.record_error(str(e))
            return False

    def load_all_sessions(self) -> int:
        """Load all available ONNX models. Returns count of loaded models."""
        loaded = 0
        if not os.path.exists(self.ONNX_DIR):
            return 0

        for fname in os.listdir(self.ONNX_DIR):
            if fname.endswith('.onnx'):
                model_name = fname.replace('.onnx', '')
                if self.load_session(model_name):
                    loaded += 1
        return loaded

    def infer_anomaly(self, features: np.ndarray) -> Tuple[bool, float]:
        """
        Run anomaly detection inference via ONNX.
        
        Returns:
            (is_anomaly, anomaly_score)
        """
        session = self.sessions.get('anomaly_detector')
        if session is None:
            return False, 0.0

        try:
            input_name = session.get_inputs()[0].name
            x = features.reshape(1, -1).astype(np.float32)

            t0 = time.perf_counter()
            outputs = session.run(None, {input_name: x})
            latency = (time.perf_counter() - t0) * 1000

            self.monitor.record_inference('anomaly_detector', latency)

            # IsolationForest: label = -1 (anomaly), 1 (normal)
            prediction = int(outputs[0][0])
            # Decision function score (if available)
            score = 0.0
            if len(outputs) > 1:
                score = float(-outputs[1][0])  # Negate: higher = more anomalous
                score = max(0.0, min(score, 1.0))

            is_anomaly = prediction == -1
            return is_anomaly, score

        except Exception as e:
            self.monitor.record_error(str(e))
            return False, 0.0

    def infer_fault(self, features: np.ndarray) -> Tuple[int, float, List]:
        """
        Run fault classification via ONNX (ensemble of RF + GB).
        
        Returns:
            (fault_id, confidence, top3_predictions)
        """
        rf_session = self.sessions.get('fault_rf')
        gb_session = self.sessions.get('fault_gb')

        if rf_session is None and gb_session is None:
            return 0, 1.0, []

        x = features.reshape(1, -1).astype(np.float32)
        rf_proba = None
        gb_proba = None

        # Random Forest inference
        if rf_session:
            try:
                input_name = rf_session.get_inputs()[0].name
                t0 = time.perf_counter()
                outputs = rf_session.run(None, {input_name: x})
                latency = (time.perf_counter() - t0) * 1000
                self.monitor.record_inference('fault_rf', latency)

                # output[1] = probabilities
                if len(outputs) > 1:
                    rf_proba = outputs[1][0].astype(np.float64)
                else:
                    rf_proba = None
            except Exception as e:
                self.monitor.record_error(f"RF: {e}")

        # Gradient Boosting inference
        if gb_session:
            try:
                input_name = gb_session.get_inputs()[0].name
                t0 = time.perf_counter()
                outputs = gb_session.run(None, {input_name: x})
                latency = (time.perf_counter() - t0) * 1000
                self.monitor.record_inference('fault_gb', latency)

                if len(outputs) > 1:
                    gb_proba = outputs[1][0].astype(np.float64)
                else:
                    gb_proba = None
            except Exception as e:
                self.monitor.record_error(f"GB: {e}")

        # Ensemble
        if rf_proba is not None and gb_proba is not None:
            # Ensure same shape
            min_classes = min(len(rf_proba), len(gb_proba))
            ensemble_proba = rf_proba[:min_classes] * 0.55 + gb_proba[:min_classes] * 0.45
        elif rf_proba is not None:
            ensemble_proba = rf_proba
        elif gb_proba is not None:
            ensemble_proba = gb_proba
        else:
            return 0, 1.0, []

        fault_id = int(np.argmax(ensemble_proba))
        confidence = float(ensemble_proba[fault_id])

        from .config import FAULT_CLASSES
        top3_idx = np.argsort(ensemble_proba)[::-1][:3]
        top3 = [
            (int(idx), FAULT_CLASSES.get(int(idx), f"Unknown_{idx}"),
             float(ensemble_proba[idx]))
            for idx in top3_idx
        ]

        return fault_id, confidence, top3

    def get_runtime_info(self) -> Dict:
        """Get ONNX Runtime environment info."""
        info = {
            'onnx_available': _HAS_ONNX,
            'runtime_version': ort.__version__ if _HAS_ONNX else 'N/A',
            'providers': ort.get_available_providers() if _HAS_ONNX else [],
            'active_sessions': list(self.sessions.keys()),
            'models_dir': self.ONNX_DIR,
        }

        # Session details
        info['session_details'] = {}
        for name, sess in self.sessions.items():
            info['session_details'][name] = {
                'provider': sess.get_providers()[0] if sess.get_providers() else 'Unknown',
                'inputs': [inp.name for inp in sess.get_inputs()],
                'outputs': [out.name for out in sess.get_outputs()],
            }

        return info
