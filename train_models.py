"""
Train all ML models (anomaly detector, fault classifier, power forecaster)
using synthetic data and convert them to ONNX.
Run once before starting the dashboard.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

print("=" * 60)
print("  AMD Power Monitor — ML Model Training")
print("=" * 60)

import numpy as np
from ml_models.data_generator import SyntheticDataGenerator
from ml_models.model_manager import ModelManager
from ml_models.onnx_converter import ONNXModelConverter
from ml_models.feature_engineer import FeatureEngineer
from ml_models.config import ANOMALY_WINDOW_SIZE

# ── 1. Generate training data ─────────────────────────────────
print("\n[1/4] Generating synthetic training data...")
gen = SyntheticDataGenerator(seed=42)
df = gen.generate_dataset(total_samples=12_000, fault_ratio=0.30, window_size=30)
print(f"  Dataset: {len(df):,} samples")
counts = df['fault_label'].value_counts().sort_index()
for lbl, cnt in counts.items():
    print(f"    [{lbl}] {cnt:,} ({cnt/len(df)*100:.1f}%)")

# Sort by timestamp so train() gets continuous time-series
df = df.sort_values('timestamp').reset_index(drop=True)
voltage_arr = df['voltage'].values.astype(float)
current_arr = df['current'].values.astype(float)
power_arr   = df['power'].values.astype(float)

# ── 2. Extract windowed features for fault classifier ─────────
print("\n[2/4] Extracting windowed features for fault classifier...")
WINDOW = ANOMALY_WINDOW_SIZE
fe = FeatureEngineer(window_size=WINDOW)

feat_rows, label_rows = [], []
# Use non-shuffled df (sorted) so each window is coherent
df_sorted = df.sort_values('timestamp').reset_index(drop=True)
n_windows = len(df_sorted) // WINDOW

for w in range(n_windows):
    chunk = df_sorted.iloc[w * WINDOW:(w + 1) * WINDOW]
    v = chunk['voltage'].values.astype(float)
    i = chunk['current'].values.astype(float)
    p = chunk['power'].values.astype(float)
    feats = fe.extract_all_features(v, i, p)
    feat_rows.append(feats)
    label_rows.append(int(chunk['fault_label'].mode()[0]))

X = np.array(feat_rows)
y = np.array(label_rows)
print(f"  Feature matrix: {X.shape[0]} windows × {X.shape[1]} features")
print(f"  Label classes present: {sorted(np.unique(y).tolist())}")

# ── 3. Train models ───────────────────────────────────────────
print("\n[3/4] Training models...")
mm = ModelManager()

# AnomalyDetector.train() takes raw voltage/current/power arrays
print("  Training anomaly detector (IsolationForest)...")
mm.anomaly_detector.train(voltage_arr, current_arr, power_arr)
mm.anomaly_detector.save()
print(f"  ✅ Anomaly detector trained")

# FaultClassifier.train() takes X (features matrix) and y (labels)
if len(np.unique(y)) > 1:
    print("  Training fault classifier (RF + GradientBoosting)...")
    try:
        mm.fault_classifier.train(X, y, verbose=True)
        mm.fault_classifier.save()
        print("  ✅ Fault classifier trained")
    except Exception as e:
        print(f"  ⚠️  Fault classifier error: {e}")
else:
    print("  ⚠️  Skipping fault classifier — insufficient label diversity")

# PowerForecaster.train() takes raw power array (+ optional V, I)
print("  Training power forecaster...")
try:
    mm.power_forecaster.train(power_arr, voltage_arr, current_arr, verbose=False)
    mm.power_forecaster.save()
    print("  ✅ Power forecaster trained")
except Exception as e:
    print(f"  ⚠️  Forecaster error: {e}")

# ── 4. Convert to ONNX ────────────────────────────────────────
print("\n[4/4] Converting to ONNX (target_opset={'': 12, 'ai.onnx.ml': 3})...")
conv = ONNXModelConverter()
n_features = X.shape[1]

if mm.anomaly_detector.is_trained:
    ok = conv.convert_isolation_forest(
        mm.anomaly_detector.isolation_forest,
        mm.anomaly_detector.scaler,
        n_features, 'anomaly_detector'
    )
    print(f"  anomaly_detector ONNX: {'✅' if ok else '❌ FAILED'}")

if mm.fault_classifier.is_trained:
    ok = conv.convert_classifier(
        mm.fault_classifier.rf_model,
        mm.fault_classifier.gb_model,
        mm.fault_classifier.scaler,
        n_features, 'fault'
    )
    print(f"  fault ONNX:            {'✅' if ok else '❌ FAILED'}")

# Load and test
loaded = conv.load_all_sessions()
print(f"\n  ONNX sessions loaded:  {loaded}")

if loaded > 0:
    print("\n  Smoke-test inference...")
    v_t = np.full(WINDOW, 230.0) + np.random.normal(0, 1, WINDOW)
    i_t = np.full(WINDOW, 2.0)  + np.random.normal(0, 0.05, WINDOW)
    p_t = v_t * i_t * 0.92
    feats_t = fe.extract_all_features(v_t, i_t, p_t)

    is_anom, score   = conv.infer_anomaly(feats_t)
    fault_id, conf, _ = conv.infer_fault(feats_t)
    perf = conv.monitor.get_stats()

    print(f"    Anomaly  : {is_anom}  score={score:.4f}")
    print(f"    Fault    : {fault_id}  conf={conf:.4f}")
    print(f"    Latency  : {perf['avg_latency_ms']:.3f} ms avg")

print("\n" + "=" * 60)
print("  Training complete! Run:  python power_dashboard.py")
print("=" * 60)
