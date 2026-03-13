"""
╔══════════════════════════════════════════════════════════════╗
║     ⚡ ESP32 POWER MONITOR — PREMIUM DASHBOARD ⚡            ║
║     Real-Time Voltage, Current, Power & Energy Analytics     ║
║     ML Inference via ONNX Runtime on AMD Ryzen™ Processor    ║
╚══════════════════════════════════════════════════════════════╝
"""
from __future__ import annotations
from typing import Any, Dict, List, Optional

import serial  # type: ignore[import-untyped]
import matplotlib  # type: ignore[import-untyped]
matplotlib.use('TkAgg')
import matplotlib.pyplot as plt  # type: ignore[import-untyped]
import matplotlib.gridspec as gridspec  # type: ignore[import-untyped]
import numpy as np  # type: ignore[import-untyped]
from collections import deque
from datetime import datetime
import re
import time
import os

# ══════════════════════════════════════════════════════════════
# AI INTELLIGENCE IMPORTS
# ══════════════════════════════════════════════════════════════
from ml_models.model_manager import ModelManager  # type: ignore[import-untyped]
from ml_models.insights_engine import InsightsEngine  # type: ignore[import-untyped]
from ml_models.onnx_converter import ONNXModelConverter, ONNXPerformanceMonitor  # type: ignore[import-untyped]
from ml_models.feature_engineer import FeatureEngineer  # type: ignore[import-untyped]
from ml_models.config import ANOMALY_WINDOW_SIZE, FAULT_CLASSES  # type: ignore[import-untyped]

# ══════════════════════════════════════════════════════════════
# FIREBASE CLOUD UPLOADER
# ══════════════════════════════════════════════════════════════
from firebase_uploader import get_uploader  # type: ignore[import-untyped]

# ══════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════
PORT = "COM3"
BAUD = 115200
TIME_WINDOW = 80
COST_PER_KWH = 6.50
CURRENCY = "₹"

# Alert Thresholds
VOLTAGE_HIGH = 250
VOLTAGE_LOW = 200
CURRENT_MAX = 15
POWER_MAX = 3000
VOLTAGE_NOMINAL = 230

# Firebase upload intervals (in samples)
ONNX_UPLOAD_EVERY_N: int = 30   # push ONNX perf snapshot every 30 readings

# ══════════════════════════════════════════════════════════════
# DARK THEME COLORS
# ══════════════════════════════════════════════════════════════
COLORS: Dict[str, str] = {
    'bg_primary':    '#0a0e1a',
    'bg_card':       '#111827',
    'bg_card_alt':   '#151d2e',
    'text_primary':  '#f1f5f9',
    'text_secondary':'#94a3b8',
    'text_muted':    '#64748b',
    'grid':          '#1e293b',
    'voltage':       '#38bdf8',
    'voltage_glow':  '#38bdf850',
    'current':       '#a78bfa',
    'current_glow':  '#a78bfa50',
    'power':         '#fb923c',
    'power_glow':    '#fb923c50',
    'energy':        '#34d399',
    'success':       '#22c55e',
    'warning':       '#eab308',
    'danger':        '#ef4444',
    'amd_red':       '#ed1c24',
    'accent_blue':   '#3b82f6',
    'border':        '#1e293b',
    'onnx_cyan':     '#06b6d4',
    'onnx_teal':     '#14b8a6',
    'onnx_purple':   '#8b5cf6',
}

# ══════════════════════════════════════════════════════════════
# DATA STORAGE
# ══════════════════════════════════════════════════════════════
voltage_data: deque[float] = deque(maxlen=TIME_WINDOW)
current_data: deque[float] = deque(maxlen=TIME_WINDOW)
power_data: deque[float] = deque(maxlen=TIME_WINDOW)

# Statistics tracking — separate typed dicts to avoid union-type confusion
stats_float: Dict[str, float] = {
    'voltage_min': float('inf'), 'voltage_max': 0.0, 'voltage_sum': 0.0,
    'current_min': float('inf'), 'current_max': 0.0, 'current_sum': 0.0,
    'power_min': float('inf'), 'power_max': 0.0, 'power_sum': 0.0,
    'energy_kwh': 0.0,
    'last_update': time.time(),
}
stats_str: Dict[str, str] = {
    'peak_voltage_time': '', 'peak_current_time': '', 'peak_power_time': '',
}
stats_int: Dict[str, int] = {
    'sample_count': 0,
}
stats_start_time: datetime = datetime.now()

# ══════════════════════════════════════════════════════════════
# REALISTIC SENSOR DATA ENGINE (REMOVED)
# ══════════════════════════════════════════════════════════════
# The simulator has been completely removed to ensure only real hardware
# sensor data from the ESP32 is used.



# ══════════════════════════════════════════════════════════════
# ML + ONNX INITIALIZATION
# ══════════════════════════════════════════════════════════════
print("\n" + "═" * 60)
print("  ⚡ AMD Power Monitor — ONNX ML Intelligence Suite")
print("═" * 60)

print("  Initializing ML Framework...")
ml_manager: Optional[ModelManager] = None
ai_engine: Optional[InsightsEngine] = None
try:
    ml_manager = ModelManager()
    ml_manager.load_all_models()
    ai_engine = InsightsEngine()
except Exception as e:
    print(f"  [!] ML Init Warning: {e}")
    ml_manager = None
    ai_engine = None

# Initialize ONNX converter and convert models
print("\n  Initializing ONNX Runtime Engine...")
onnx_converter = ONNXModelConverter()
onnx_monitor = onnx_converter.monitor
feature_engineer = FeatureEngineer(window_size=ANOMALY_WINDOW_SIZE)

# Convert sklearn models to ONNX (if not already converted)
onnx_models_ready = False
if ml_manager:
    onnx_dir = onnx_converter.ONNX_DIR
    needs_conversion = not all(
        os.path.exists(os.path.join(onnx_dir, f))
        for f in ['anomaly_detector.onnx', 'fault_rf.onnx', 'fault_gb.onnx']
    )

    if needs_conversion:
        print("  Converting ML models to ONNX format...")
        n_features = feature_engineer.get_num_features()

        if ml_manager.anomaly_detector.is_trained:
            onnx_converter.convert_isolation_forest(
                ml_manager.anomaly_detector.isolation_forest,
                ml_manager.anomaly_detector.scaler,
                n_features, "anomaly_detector"
            )
        if ml_manager.fault_classifier.is_trained:
            onnx_converter.convert_classifier(
                ml_manager.fault_classifier.rf_model,
                ml_manager.fault_classifier.gb_model,
                ml_manager.fault_classifier.scaler,
                n_features, "fault"
            )
    else:
        print("  ONNX models already cached.")

    loaded = onnx_converter.load_all_sessions()
    onnx_models_ready = loaded > 0
    print(f"  ONNX sessions active: {loaded}")

# Runtime info
rt_info = onnx_converter.get_runtime_info()
print(f"  ONNX Runtime: v{rt_info['runtime_version']}")
print(f"  Providers: {rt_info['providers']}")

# ══════════════════════════════════════════════════════════════
# FIREBASE CLOUD UPLOADER — START BACKGROUND THREAD
# ══════════════════════════════════════════════════════════════
print("\n  Initializing Firebase Cloud Uploader...")
fb_uploader = get_uploader()
if fb_uploader.is_ready:
    fb_uploader.start()
else:
    print("  [Firebase] Running without cloud sync (credentials not configured).")

# ONNX inference buffers
onnx_voltage_buf = deque(maxlen=ANOMALY_WINDOW_SIZE)
onnx_current_buf = deque(maxlen=ANOMALY_WINDOW_SIZE)
onnx_power_buf = deque(maxlen=ANOMALY_WINDOW_SIZE)

# AI state — typed dicts for type-checker clarity
ai_anomaly: Dict[str, Any] = {'is_anomaly': False, 'score': 0.0}
ai_fault: Dict[str, Any] = {'fault_id': 0, 'confidence': 1.0}
ai_health: Dict[str, Any] = {'overall_score': 100.0, 'color': COLORS['success'], 'label': 'Healthy'}
ai_insights: List[Dict[str, Any]] = []

# ══════════════════════════════════════════════════════════════
# SENSOR CONNECTION
# ══════════════════════════════════════════════════════════════
print(f"\n  Connecting to ESP32 on {PORT} @ {BAUD} baud...")
try:
    ser = serial.Serial(PORT, BAUD, timeout=0.2)
    print(f"  ✅ ESP32 connected successfully!\n")
except Exception as e:
    print(f"  [!] Failed to connect to ESP32 on {PORT}: {e}")
    print("  Exiting... Please check your hardware connections and COM port.")
    import sys
    sys.exit(1)


def extract_values(line):
    """Parse sensor data: voltage,current"""
    try:
        parts = line.split(',')
        if len(parts) >= 2:
            v = float(parts[0])
            i = float(parts[1])
            p = v * i * 0.92  # Estimate real power with assumed 0.92 PF
            return v, i, p
    except ValueError:
        pass
    return None


def update_stats(v: float, i: float, p: float) -> None:
    """Update running statistics"""
    now_str = datetime.now().strftime('%H:%M:%S')
    stats_int['sample_count'] += 1

    if v < stats_float['voltage_min']: stats_float['voltage_min'] = v
    if v > stats_float['voltage_max']:
        stats_float['voltage_max'] = v
        stats_str['peak_voltage_time'] = now_str

    if i < stats_float['current_min']: stats_float['current_min'] = i
    if i > stats_float['current_max']:
        stats_float['current_max'] = i
        stats_str['peak_current_time'] = now_str

    if p < stats_float['power_min']: stats_float['power_min'] = p
    if p > stats_float['power_max']:
        stats_float['power_max'] = p
        stats_str['peak_power_time'] = now_str

    stats_float['voltage_sum'] += v
    stats_float['current_sum'] += i
    stats_float['power_sum'] += p

    now = time.time()
    dt_hours = (now - stats_float['last_update']) / 3600.0
    stats_float['energy_kwh'] += (p / 1000.0) * dt_hours
    stats_float['last_update'] = now


def get_load_status(p):
    """Return load condition label and color"""
    if p > POWER_MAX:
        return "OVERLOAD!", COLORS['danger']
    elif p > POWER_MAX * 0.7:
        return "HIGH LOAD", COLORS['warning']
    elif p > POWER_MAX * 0.3:
        return "NORMAL", COLORS['success']
    else:
        return "LIGHT", COLORS['accent_blue']


def draw_gauge_arc(ax, value, max_val, color, glow_color, label, unit):
    """Draw a semi-circular gauge with glowing arc"""
    ax.clear()
    ax.set_facecolor(COLORS['bg_card'])
    ax.set_xlim(-1.4, 1.4)
    ax.set_ylim(-0.4, 1.5)
    ax.set_aspect('equal')
    ax.axis('off')

    theta_bg = np.linspace(np.pi, 0, 100)
    x_bg = np.cos(theta_bg)
    y_bg = np.sin(theta_bg)
    ax.plot(x_bg, y_bg, color=COLORS['grid'], linewidth=14, solid_capstyle='round', alpha=0.5)

    ratio = min(value / max_val, 1.0) if max_val > 0 else 0
    theta_val = np.linspace(np.pi, np.pi - (ratio * np.pi), max(2, int(100 * ratio)))
    x_val = np.cos(theta_val)
    y_val = np.sin(theta_val)

    ax.plot(x_val, y_val, color=glow_color, linewidth=22, solid_capstyle='round', alpha=0.25)
    ax.plot(x_val, y_val, color=color, linewidth=12, solid_capstyle='round', alpha=0.9)
    if len(x_val) > 0:
        ax.plot(x_val[-1], y_val[-1], 'o', color=color, markersize=8, alpha=1, zorder=5)
        ax.plot(x_val[-1], y_val[-1], 'o', color='white', markersize=3, alpha=0.8, zorder=6)

    ax.text(0, 0.45, f"{value:.1f}" if value >= 10 else f"{value:.2f}",
            fontsize=28, fontweight='bold', color=color,
            ha='center', va='center', fontfamily='monospace')
    ax.text(0, 0.12, unit, fontsize=11, color=COLORS['text_muted'],
            ha='center', va='center', fontweight='500')

    ax.text(0, -0.22, label, fontsize=9, color=COLORS['text_secondary'],
            ha='center', va='center', fontweight='600',
            bbox={'boxstyle': 'round,pad=0.3', 'facecolor': COLORS['bg_card_alt'],
                  'edgecolor': COLORS['border'], 'alpha': 0.8})

    for angle_deg in [0, 45, 90, 135, 180]:
        angle = np.radians(angle_deg)
        x_m = 1.18 * np.cos(angle)
        y_m = 1.18 * np.sin(angle)
        tick_val = max_val * (180 - angle_deg) / 180
        ax.text(x_m, y_m, f"{tick_val:.0f}", fontsize=6, color=COLORS['text_muted'],
                ha='center', va='center', alpha=0.7)


def draw_waveform(ax, data, color, title, unit, y_min=None, y_max=None):
    """Draw a styled waveform chart with gradient fill"""
    ax.clear()
    ax.set_facecolor(COLORS['bg_card'])

    if len(data) < 2:
        ax.text(0.5, 0.5, 'Acquiring sensor data...', transform=ax.transAxes,
                fontsize=10, color=COLORS['text_muted'], ha='center', va='center')
        ax.set_title(f'  {title}', fontsize=10, fontweight='600',
                     color=COLORS['text_primary'], loc='left', pad=10)
        return

    x = np.arange(len(data))
    y = np.array(data)

    ax.fill_between(x, y, alpha=0.12, color=color)
    ax.plot(x, y, color=color, linewidth=3, alpha=0.15)
    ax.plot(x, y, color=color, linewidth=1.8, alpha=0.9, zorder=3)

    ax.plot(len(data) - 1, data[-1], 'o', color=color, markersize=6, zorder=5)
    ax.plot(len(data) - 1, data[-1], 'o', color='white', markersize=2.5, zorder=6, alpha=0.8)

    ax.annotate(f'{data[-1]:.1f}{unit}',
                xy=(len(data) - 1, data[-1]),
                xytext=(len(data) - 1 - 5, (data[-1] + (max(data) - min(data)) * 0.15) if len(data) > 1 else (data[-1] + 1)),
                fontsize=8, fontweight='bold', color=color,
                fontfamily='monospace',
                bbox={'boxstyle': 'round,pad=0.25', 'facecolor': COLORS['bg_card_alt'],
                      'edgecolor': color, 'alpha': 0.85, 'linewidth': 0.8},
                arrowprops={'arrowstyle': '->', 'color': color, 'lw': 0.8, 'alpha': 0.6})

    ax.set_title(f'  {title}', fontsize=10, fontweight='600',
                 color=COLORS['text_primary'], loc='left', pad=10)

    ax.set_xlim(0, max(len(data) - 1, 1))
    if y_min is not None and y_max is not None:
        ax.set_ylim(y_min, y_max)
    elif len(data) > 1:
        margin = (max(data) - min(data)) * 0.2 + 0.5
        ax.set_ylim(min(data) - margin, max(data) + margin)

    ax.tick_params(axis='both', colors=COLORS['text_muted'], labelsize=7)
    ax.grid(True, alpha=0.08, color=COLORS['text_muted'], linestyle='-', linewidth=0.5)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.spines['bottom'].set_color(COLORS['border'])
    ax.spines['left'].set_color(COLORS['border'])

    if len(data) > 5:
        ax.axhline(y=max(data), color=COLORS['danger'], linewidth=0.6, alpha=0.4, linestyle='--')
        ax.axhline(y=min(data), color=COLORS['accent_blue'], linewidth=0.6, alpha=0.4, linestyle='--')


def draw_stats_panel(ax: Any, v: float, i: float, p: float) -> None:
    """Draw the live statistics panel"""
    ax.clear()
    ax.set_facecolor(COLORS['bg_card'])
    ax.axis('off')
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 10)

    n = max(stats_int['sample_count'], 1)
    LX = 0.6   # Label column X
    VX = 4.8   # Value column X (right-aligned)
    SP = 0.58  # Row spacing

    # ── Header ──
    ax.text(5, 9.5, 'LIVE STATISTICS', fontsize=10, fontweight='bold',
            color=COLORS['text_primary'], ha='center', va='center')
    ax.text(9.3, 9.5, f'n={stats_int["sample_count"]}', fontsize=6,
            color=COLORS['text_muted'], ha='right', va='center', fontfamily='monospace')
    ax.plot([0.5, 9.5], [9.05, 9.05], color=COLORS['border'], linewidth=0.8, alpha=0.5)

    # ── Voltage ──
    y = 8.4
    ax.text(LX, y, '⚡ VOLTAGE', fontsize=7.5, fontweight='bold', color=COLORS['voltage'])
    y -= SP
    v_min_s = f'{stats_float["voltage_min"]:.1f}' if stats_float['voltage_min'] < float('inf') else '--'
    v_avg_s = f'{stats_float["voltage_sum"]/n:.1f}'
    v_max_s = f'{stats_float["voltage_max"]:.1f}' if stats_float['voltage_max'] > 0 else '--'
    for lbl, val in [('Min', v_min_s), ('Avg', v_avg_s), ('Max', v_max_s)]:
        ax.text(LX + 0.3, y, f'{lbl}:', fontsize=7, color=COLORS['text_muted'], fontfamily='monospace')
        ax.text(VX, y, f'{val} V', fontsize=7, color=COLORS['text_secondary'],
                fontfamily='monospace', ha='right')
        y -= SP

    # ── Current ──
    y -= 0.15
    ax.text(LX, y, '⏛ CURRENT', fontsize=7.5, fontweight='bold', color=COLORS['current'])
    y -= SP
    i_min_s = f'{stats_float["current_min"]:.3f}' if stats_float['current_min'] < float('inf') else '--'
    i_avg_s = f'{stats_float["current_sum"]/n:.3f}'
    i_max_s = f'{stats_float["current_max"]:.3f}' if stats_float['current_max'] > 0 else '--'
    for lbl, val in [('Min', i_min_s), ('Avg', i_avg_s), ('Max', i_max_s)]:
        ax.text(LX + 0.3, y, f'{lbl}:', fontsize=7, color=COLORS['text_muted'], fontfamily='monospace')
        ax.text(VX, y, f'{val} A', fontsize=7, color=COLORS['text_secondary'],
                fontfamily='monospace', ha='right')
        y -= SP

    # ── Power ──
    y -= 0.15
    ax.text(LX, y, '⚡ POWER', fontsize=7.5, fontweight='bold', color=COLORS['power'])
    y -= SP
    p_min_s = f'{stats_float["power_min"]:.0f}' if stats_float['power_min'] < float('inf') else '--'
    p_avg_s = f'{stats_float["power_sum"]/n:.0f}'
    p_max_s = f'{stats_float["power_max"]:.0f}' if stats_float['power_max'] > 0 else '--'
    for lbl, val, clr in [('Min', p_min_s, COLORS['text_secondary']),
                           ('Avg', p_avg_s, COLORS['text_secondary']),
                           ('Peak', p_max_s, COLORS['danger'])]:
        ax.text(LX + 0.3, y, f'{lbl}:', fontsize=7, color=COLORS['text_muted'], fontfamily='monospace')
        ax.text(VX, y, f'{val} W', fontsize=7, color=clr,
                fontfamily='monospace', ha='right', fontweight='bold' if lbl == 'Peak' else 'normal')
        y -= SP

    # ── Footer: PF + Load Status ──
    ax.plot([0.5, 9.5], [0.95, 0.95], color=COLORS['border'], linewidth=0.5, alpha=0.3)
    pf = p / (v * i) if (v * i) > 0 else 0
    ax.text(LX, 0.45, f'PF: {pf:.3f}', fontsize=7.5, color=COLORS['energy'], fontfamily='monospace')

    load_label, load_color = get_load_status(p)
    ax.text(9.3, 0.45, load_label, fontsize=7.5, fontweight='bold',
            color=load_color, ha='right',
            bbox={'boxstyle': 'round,pad=0.25', 'facecolor': load_color + '15',
                  'edgecolor': load_color, 'alpha': 0.9, 'linewidth': 0.8})


def draw_energy_panel(ax):
    """Draw the energy tracking / cost panel"""
    ax.clear()
    ax.set_facecolor(COLORS['bg_card'])
    ax.axis('off')
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 10)

    # ── Header ──
    ax.text(5, 9.5, 'ENERGY METER', fontsize=10, fontweight='bold',
            color=COLORS['energy'], ha='center', va='center')
    ax.plot([0.5, 9.5], [9.05, 9.05], color=COLORS['border'], linewidth=0.8, alpha=0.5)

    # ── Big energy value ──
    energy: float = stats_float['energy_kwh']
    ax.text(5, 7.4, f'{energy:.4f}', fontsize=28, fontweight='bold',
            color=COLORS['energy'], ha='center', va='center', fontfamily='monospace')
    ax.text(5, 6.3, 'kWh', fontsize=11, color=COLORS['text_muted'],
            ha='center', va='center')

    # ── Cost ──
    cost: float = energy * COST_PER_KWH
    ax.text(5, 5.3, f'Cost: {CURRENCY}{cost:.2f}', fontsize=10,
            fontweight='600', color=COLORS['text_secondary'],
            ha='center', va='center', fontfamily='monospace')

    ax.plot([1, 9], [4.7, 4.7], color=COLORS['border'], linewidth=0.5, alpha=0.4)

    # ── Uptime + Timestamp ──
    uptime = datetime.now() - stats_start_time
    hours = int(uptime.total_seconds() // 3600)
    minutes = int((uptime.total_seconds() % 3600) // 60)
    secs = int(uptime.total_seconds() % 60)
    ax.text(5, 4.1, f'Uptime  {hours:02d}h {minutes:02d}m {secs:02d}s',
            fontsize=8, color=COLORS['text_secondary'],
            ha='center', va='center', fontfamily='monospace')
    ax.text(5, 3.3, datetime.now().strftime('%Y-%m-%d  %H:%M:%S'),
            fontsize=8, color=COLORS['text_muted'],
            ha='center', va='center', fontfamily='monospace')

    # ── Peak Load ──
    ax.plot([1, 9], [2.6, 2.6], color=COLORS['border'], linewidth=0.5, alpha=0.4)
    ax.text(5, 2.1, 'PEAK LOAD CONDITIONS', fontsize=6.5, fontweight='bold',
            color=COLORS['danger'], ha='center', va='center')

    peak_items = [
        ('V', stats_str['peak_voltage_time'] or '--', COLORS['voltage']),
        ('I', stats_str['peak_current_time'] or '--', COLORS['current']),
        ('P', stats_str['peak_power_time'] or '--', COLORS['power']),
    ]
    for idx, (lbl, t, clr) in enumerate(peak_items):
        cx = 1.8 + idx * 2.8
        ax.text(cx, 1.4, f'{lbl}:', fontsize=6.5, color=clr,
                ha='center', va='center', fontfamily='monospace', fontweight='bold')
        ax.text(cx + 0.8, 1.4, t, fontsize=6.5, color=COLORS['text_muted'],
                ha='center', va='center', fontfamily='monospace')

    # ── AMD Badge ──
    ax.text(5, 0.3, 'Processed on AMD Ryzen™', fontsize=6, fontweight='bold',
            color=COLORS['amd_red'], ha='center', va='center', alpha=0.7,
            bbox={'boxstyle': 'round,pad=0.2', 'facecolor': COLORS['amd_red'] + '10',
                  'edgecolor': COLORS['amd_red'] + '30', 'linewidth': 0.5})


def draw_ai_insights_panel(ax):
    """Draw the AI insights and recommendations panel"""
    ax.clear()
    ax.set_facecolor(COLORS['bg_card'])
    ax.axis('off')
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 10)

    # ── Header ──
    ax.text(5, 9.5, '✨ AI ENGINE INSIGHTS', fontsize=10, fontweight='bold',
            color=COLORS['current'], ha='center', va='center')
    ax.plot([0.5, 9.5], [9.05, 9.05], color=COLORS['border'], linewidth=0.8, alpha=0.5)

    # ── Health Score ──
    if ai_health:
        health = ai_health['overall_score']
        h_color = ai_health['color']
        h_label = ai_health['label']

        ax.text(5, 7.5, f'{health:.1f}', fontsize=30, fontweight='bold',
                color=h_color, ha='center', va='center', fontfamily='monospace')
        ax.text(5, 6.2, f'System Health: {h_label}', fontsize=8.5, color=COLORS['text_muted'],
                ha='center', va='center', fontweight='bold')
    else:
        ax.text(5, 7.5, 'Analyzing...', fontsize=12, color=COLORS['text_muted'],
                ha='center', va='center')

    ax.plot([0.8, 9.2], [5.4, 5.4], color=COLORS['border'], linewidth=0.5, alpha=0.4)

    # ── Alerts Section ──
    y_pos = 4.7
    LX = 0.6

    if ai_fault.get('fault_id', 0) != 0:
        fault_name = FAULT_CLASSES.get(ai_fault['fault_id'], 'Unknown')
        conf = float(ai_fault['confidence']) * 100
        ax.text(LX, y_pos, f'FAULT: {fault_name} ({conf:.0f}%)',
                fontsize=7.5, fontweight='bold', color=COLORS['danger'])
        y_pos -= 0.75

    if ai_anomaly.get('is_anomaly', False):
        score = ai_anomaly['score']
        ax.text(LX, y_pos, f'ANOMALY (score={score:.2f})',
                fontsize=7.5, fontweight='bold', color=COLORS['warning'])
        y_pos -= 0.75

    # ── Recommendations ──
    if ai_insights:
        ax.text(LX, y_pos, 'RECOMMENDATIONS', fontsize=6.5,
                color=COLORS['text_secondary'], fontweight='bold')
        y_pos -= 0.65
        shown_insights = ai_insights[:2] if len(ai_insights) >= 2 else ai_insights
        for rec in shown_insights:
            title = rec['title'][:42] + '...' if len(rec['title']) > 42 else rec['title']
            ax.text(LX + 0.2, y_pos, f'• {title}',
                    fontsize=7, color=COLORS['text_primary'], fontweight='600')
            y_pos -= 0.55
            action = rec['action'][:48] + '...' if len(rec['action']) > 48 else rec['action']
            ax.text(LX + 0.4, y_pos, action,
                    fontsize=6, color=COLORS['text_muted'])
            y_pos -= 0.7


def draw_onnx_performance_panel(ax):
    """Draw the ONNX Runtime Performance Monitoring panel"""
    ax.clear()
    ax.set_facecolor(COLORS['bg_card'])
    ax.axis('off')
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 10)

    LX = 0.5
    RX = 9.5
    MID = 5.0

    # ── Header ──
    ax.text(MID, 9.5, 'ONNX RUNTIME MONITOR', fontsize=9, fontweight='bold',
            color=COLORS['onnx_cyan'], ha='center', va='center')
    ax.plot([LX, RX], [9.05, 9.05], color=COLORS['border'], linewidth=0.8, alpha=0.5)

    perf = onnx_monitor.get_stats()

    # ── Runtime info row ──
    providers = rt_info.get('providers', [])
    provider_str = providers[0].replace('ExecutionProvider', '') if providers else 'CPU'
    ax.text(LX, 8.55, f'v{rt_info["runtime_version"]}', fontsize=6.5,
            color=COLORS['text_muted'], fontfamily='monospace')
    ax.text(RX, 8.55, provider_str, fontsize=6.5,
            color=COLORS['onnx_teal'], fontfamily='monospace', fontweight='bold', ha='right')

    ax.plot([LX, RX], [8.15, 8.15], color=COLORS['border'], linewidth=0.4, alpha=0.3)

    # ── Two big KPIs side by side ──
    ax.text(2.5, 7.65, f'{perf["total_inferences"]:,}', fontsize=16, fontweight='bold',
            color=COLORS['onnx_cyan'], ha='center', va='center', fontfamily='monospace')
    ax.text(2.5, 7.0, 'Inferences', fontsize=6, color=COLORS['text_muted'],
            ha='center', va='center')

    ax.text(7.5, 7.65, f'{perf["throughput_ips"]:.1f}', fontsize=16, fontweight='bold',
            color=COLORS['onnx_teal'], ha='center', va='center', fontfamily='monospace')
    ax.text(7.5, 7.0, 'inf/sec', fontsize=6, color=COLORS['text_muted'],
            ha='center', va='center')

    ax.plot([LX, RX], [6.55, 6.55], color=COLORS['border'], linewidth=0.5, alpha=0.4)

    # ── Latency: 2-column layout ──
    ax.text(MID, 6.2, 'LATENCY (ms)', fontsize=6.5, fontweight='bold',
            color=COLORS['onnx_purple'], ha='center')

    # Left column
    left_items = [
        ('Avg', perf['avg_latency_ms'], COLORS['text_secondary']),
        ('P50', perf['p50_latency_ms'], COLORS['text_secondary']),
        ('P95', perf['p95_latency_ms'], COLORS['warning']),
    ]
    # Right column
    right_items = [
        ('P99', perf['p99_latency_ms'], COLORS['danger']),
        ('Min', perf['min_latency_ms'], COLORS['success']),
        ('Max', perf['max_latency_ms'], COLORS['danger']),
    ]

    y_lat = 5.6
    for (ll, lv, lc), (rl, rv, rc) in zip(left_items, right_items):
        # Left
        ax.text(LX + 0.2, y_lat, f'{ll}:', fontsize=6.5,
                color=COLORS['text_muted'], fontfamily='monospace')
        ax.text(4.2, y_lat, f'{lv:.3f}', fontsize=6.5,
                color=lc, fontfamily='monospace', fontweight='bold', ha='right')
        # Right
        ax.text(MID + 0.5, y_lat, f'{rl}:', fontsize=6.5,
                color=COLORS['text_muted'], fontfamily='monospace')
        ax.text(RX - 0.2, y_lat, f'{rv:.3f}', fontsize=6.5,
                color=rc, fontfamily='monospace', fontweight='bold', ha='right')
        y_lat -= 0.55

    # ── Sparkline ──
    recent_lats = onnx_monitor.get_recent_latencies(50)
    if len(recent_lats) > 3:
        ax.plot([LX, RX], [3.95, 3.95], color=COLORS['border'], linewidth=0.4, alpha=0.3)
        ax.text(MID, 3.6, 'LATENCY TREND', fontsize=5.5, color=COLORS['text_muted'],
                ha='center', fontfamily='monospace')

        spark_x = np.linspace(LX + 0.3, RX - 0.3, len(recent_lats))
        lat_arr = np.array(recent_lats)
        lat_min, lat_max = lat_arr.min(), lat_arr.max()
        lat_range = max(lat_max - lat_min, 0.001)
        spark_y = 1.6 + (lat_arr - lat_min) / lat_range * 1.8
        ax.fill_between(spark_x, 1.6, spark_y, alpha=0.12, color=COLORS['onnx_cyan'])
        ax.plot(spark_x, spark_y, color=COLORS['onnx_cyan'], linewidth=1.3, alpha=0.85)
        ax.plot(spark_x[-1:], spark_y[-1:], 'o', color=COLORS['onnx_cyan'], markersize=4, zorder=5)
        ax.plot(spark_x[-1:], spark_y[-1:], 'o', color='white', markersize=1.5, zorder=6, alpha=0.8)

    # ── Per-Model (compact footer) ──
    ax.plot([LX, RX], [1.2, 1.2], color=COLORS['border'], linewidth=0.4, alpha=0.3)
    y_m = 0.7
    for model_name, ms in perf.get('per_model', {}).items():
        sn = model_name.replace('anomaly_detector', 'Anomaly').replace('fault_', 'F-')
        ax.text(LX, y_m, f'{sn}', fontsize=5.5, color=COLORS['onnx_teal'],
                fontfamily='monospace', fontweight='bold')
        ax.text(RX, y_m, f'{ms["avg_ms"]:.2f}ms  ({ms["count"]})',
                fontsize=5.5, color=COLORS['text_muted'], fontfamily='monospace', ha='right')
        y_m -= 0.45

    # Error badge
    if perf['error_count'] > 0:
        ax.text(MID, 0.1, f'Errors: {perf["error_count"]}', fontsize=6,
                color=COLORS['danger'], ha='center', fontweight='bold')
    else:
        ax.text(MID, 0.1, 'Zero Errors', fontsize=6,
                color=COLORS['success'], ha='center', fontfamily='monospace')


# ══════════════════════════════════════════════════════════════
# MAIN FIGURE SETUP
# ══════════════════════════════════════════════════════════════
plt.style.use('dark_background')
plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.sans-serif': ['Segoe UI', 'Helvetica Neue', 'Arial', 'DejaVu Sans'],
    'font.size': 9,
    'axes.facecolor': COLORS['bg_card'],
    'figure.facecolor': COLORS['bg_primary'],
    'text.color': COLORS['text_primary'],
    'axes.labelcolor': COLORS['text_secondary'],
    'xtick.color': COLORS['text_muted'],
    'ytick.color': COLORS['text_muted'],
})

fig = plt.figure(figsize=(18, 10))
fig.canvas.manager.set_window_title('ESP32 Power Monitor — AMD ONNX Dashboard')

# GridSpec layout:
# Row 0: [Gauge] [Stats] [Energy] [AI Insights] [ONNX Perf]
# Row 1: [Voltage Waveform ——————————————————————————————————]
# Row 2: [Current Waveform ————————] [Power Waveform ————————]
gs = gridspec.GridSpec(3, 5, figure=fig,
                       height_ratios=[1.4, 0.9, 0.9],
                       width_ratios=[1, 1, 1, 1.1, 1.2],
                       hspace=0.35, wspace=0.25,
                       left=0.03, right=0.98, top=0.92, bottom=0.04)

ax_gauge = fig.add_subplot(gs[0, 0])
ax_stats = fig.add_subplot(gs[0, 1])
ax_energy = fig.add_subplot(gs[0, 2])
ax_ai = fig.add_subplot(gs[0, 3])
ax_onnx = fig.add_subplot(gs[0, 4])
ax_voltage = fig.add_subplot(gs[1, :])
ax_current = fig.add_subplot(gs[2, 0:3])
ax_power = fig.add_subplot(gs[2, 3:])

all_axes = [ax_gauge, ax_stats, ax_energy, ax_ai, ax_onnx, ax_voltage, ax_current, ax_power]
for ax in all_axes:
    ax.set_facecolor(COLORS['bg_card'])
    for spine in ax.spines.values():
        spine.set_color(COLORS['border'])
        spine.set_linewidth(0.5)

# Title
fig.suptitle('⚡ ESP32 POWER MONITOR + ONNX ML RUNTIME ⚡',
             fontsize=14, fontweight='bold', color=COLORS['text_primary'], y=0.97)

# Status badge
fig.text(0.98, 0.97, '● LIVE', fontsize=9, color=COLORS['success'],
         ha='right', va='top', fontfamily='monospace', fontweight='bold',
         bbox={'boxstyle': 'round,pad=0.3', 'facecolor': COLORS['success'] + '15',
               'edgecolor': COLORS['success'] + '40', 'linewidth': 0.6})

# ONNX badge
fig.text(0.88, 0.97, f'ONNX v{rt_info["runtime_version"]}', fontsize=7,
         color=COLORS['onnx_cyan'],
         ha='right', va='top', fontfamily='monospace',
         bbox={'boxstyle': 'round,pad=0.2', 'facecolor': COLORS['onnx_cyan'] + '12',
               'edgecolor': COLORS['onnx_cyan'] + '30', 'linewidth': 0.5})

plt.ion()
plt.show(block=False)


# ══════════════════════════════════════════════════════════════
# MAIN LOOP
# ══════════════════════════════════════════════════════════════
LOG_FILE = "power_log.csv"
if not os.path.exists(LOG_FILE):
    with open(LOG_FILE, "w") as f:
        f.write("timestamp,voltage,current,power\n")

# Open CSV file handle once (persistent) instead of open/close every reading
_csv_fh = open(LOG_FILE, "a", buffering=1)   # line-buffered

print("\n" + "═" * 60)
print("  ESP32 Power Monitor + ONNX ML Dashboard — Running")
print("  Press Ctrl+C to stop")
print("═" * 60 + "\n")

_frame_counter: int = 0   # tracks frames for throttled rendering

try:
    while True:
        raw = ser.readline().decode(errors="ignore").strip()
        if not raw:
            continue
        values = extract_values(raw)
        if not values:
            continue
        v, i, p = values
        _frame_counter += 1

        # Debug: log every 10th reading to console so we can verify sensor data
        if stats_int['sample_count'] % 10 == 0:
            print(f"  [RAW] '{raw}' → V={v:.2f}  I={i:.3f}  P={p:.1f} W")

        # Store data
        voltage_data.append(v)
        current_data.append(i)
        power_data.append(p)

        # Log to CSV (persistent handle, no open/close overhead)
        _csv_fh.write(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')},{v:.2f},{i:.3f},{p:.2f}\n")

        # Update statistics
        update_stats(v, i, p)

        # ─── ONNX INFERENCE PIPELINE ───
        onnx_voltage_buf.append(v)
        onnx_current_buf.append(i)
        onnx_power_buf.append(p)

        if onnx_models_ready and len(onnx_voltage_buf) >= ANOMALY_WINDOW_SIZE:
            v_arr = np.array(onnx_voltage_buf)
            i_arr = np.array(onnx_current_buf)
            p_arr = np.array(onnx_power_buf)

            features = feature_engineer.extract_all_features(v_arr, i_arr, p_arr)

            # ONNX Anomaly Detection
            is_anomaly, score = onnx_converter.infer_anomaly(features)
            ai_anomaly.update({'is_anomaly': is_anomaly, 'score': score})

            # ONNX Fault Classification
            fault_id, fconf, top3 = onnx_converter.infer_fault(features)
            ai_fault.update({'fault_id': fault_id, 'confidence': fconf})

        # ─── FALLBACK: sklearn inference if ONNX not ready ───
        elif ml_manager is not None and ai_engine is not None and not onnx_models_ready:
            _mm = ml_manager  # local rebind for type narrowing
            is_anomaly, score, details = _mm.anomaly_detector.detect(v, i, p)
            ai_anomaly.update({'is_anomaly': is_anomaly, 'score': score})

            if _mm.fault_classifier.is_trained:
                try:
                    fault_pred = _mm.fault_classifier.predict_realtime(v, i, p)
                    if fault_pred:
                        fid, fconf, _ = fault_pred
                        ai_fault.update({'fault_id': fid, 'confidence': fconf})
                except RuntimeError:
                    pass

        # Update Insights Engine
        if ai_engine is not None:
            _ae = ai_engine  # local rebind for type narrowing
            f_dict: Dict[str, Any] = {'fault_id': ai_fault['fault_id'], 'confidence': ai_fault['confidence']}
            _ae.update(v, i, p, anomaly_result=ai_anomaly, fault_result=f_dict)

            if stats_int['sample_count'] % 10 == 0:
                ai_health.update(_ae.get_health_score())
                new_recs = _ae.get_recommendations()
                ai_insights.clear()
                ai_insights.extend(new_recs)

        # Add to forecaster buffer
        if ml_manager is not None:
            _mm2 = ml_manager  # local rebind for type narrowing
            if _mm2.power_forecaster:
                _mm2.power_forecaster.add_point(p, v, i)

        # ─── FIREBASE UPLOAD ───────────────────────────────────
        fb_uploader.enqueue_reading(
            v, i, p,
            ai_anomaly=ai_anomaly,
            ai_fault=ai_fault,
            ai_health=ai_health,
            energy_kwh=stats_float['energy_kwh'],
        )
        # Push ONNX perf snapshot every 30 samples
        if stats_int['sample_count'] % ONNX_UPLOAD_EVERY_N == 0:
            fb_uploader.enqueue_onnx_perf(onnx_monitor.get_stats())

        # === RENDER PANELS (throttled for performance) ===

        # Gauge updates every frame (cheap)
        draw_gauge_arc(ax_gauge, v, 300, COLORS['voltage'], COLORS['voltage_glow'],
                       'VOLTAGE', 'Vrms')

        # Heavy text panels only every 3rd frame (~saves 200ms/frame)
        if _frame_counter % 3 == 0:
            draw_stats_panel(ax_stats, v, i, p)
            draw_energy_panel(ax_energy)
            draw_ai_insights_panel(ax_ai)
            draw_onnx_performance_panel(ax_onnx)

        # Waveforms every frame (visual continuity matters)
        draw_waveform(ax_voltage, voltage_data, COLORS['voltage'],
                      'Voltage (Vrms)', 'V', y_min=195, y_max=260)
        if len(voltage_data) > 2:
            ax_voltage.axhline(y=VOLTAGE_NOMINAL, color=COLORS['success'],
                              linewidth=0.7, alpha=0.3, linestyle='-.')
            ax_voltage.axhline(y=VOLTAGE_HIGH, color=COLORS['danger'],
                              linewidth=0.7, alpha=0.3, linestyle='--')
            ax_voltage.axhline(y=VOLTAGE_LOW, color=COLORS['warning'],
                              linewidth=0.7, alpha=0.3, linestyle='--')

        draw_waveform(ax_current, current_data, COLORS['current'],
                      'Current (A)', 'A')

        draw_waveform(ax_power, power_data, COLORS['power'],
                      'Power (W)', 'W')

        # Refresh
        fig.canvas.draw()
        fig.canvas.flush_events()
        plt.pause(0.02)

except KeyboardInterrupt:
    print("\n\n" + "═" * 60)
    print("  Dashboard stopped by user")
    print(f"  Total samples: {stats_int['sample_count']}")
    print(f"  Total energy: {stats_float['energy_kwh']:.4f} kWh")
    print(f"  Estimated cost: {CURRENCY}{stats_float['energy_kwh'] * COST_PER_KWH:.2f}")
    if stats_float['power_max'] > 0:
        print(f"  Peak: {stats_float['power_max']:.0f} W @ {stats_str['peak_power_time']}")
    print(f"\n  ONNX Runtime Performance Summary:")
    perf_final = onnx_monitor.get_stats()
    print(f"    Total inferences: {perf_final['total_inferences']:,}")
    print(f"    Avg latency:      {perf_final['avg_latency_ms']:.3f} ms")
    print(f"    P95 latency:      {perf_final['p95_latency_ms']:.3f} ms")
    print(f"    Throughput:       {perf_final['throughput_ips']:.1f} inf/s")
    print(f"    Errors:           {perf_final['error_count']}")
    print("═" * 60 + "\n")
    # Push final session summary to Firebase
    fb_uploader.enqueue_session_summary(
        sample_count    = stats_int['sample_count'],
        energy_kwh      = stats_float['energy_kwh'],
        peak_power      = stats_float['power_max'],
        peak_power_time = stats_str['peak_power_time'],
    )

except Exception as e:
    print(f"\n  Error: {e}")
    import traceback
    traceback.print_exc()

finally:
    # Close CSV file handle
    try:
        _csv_fh.close()
    except Exception:
        pass
    # Stop Firebase uploader gracefully
    fb_uploader.stop()
    if ser and hasattr(ser, 'is_open'):
        try:
            if ser.is_open:
                ser.close()
                print("  Serial port closed")
        except Exception:
            pass
    elif ser and hasattr(ser, 'close'):
        try:
            ser.close()
        except Exception:
            pass
    plt.close('all')
