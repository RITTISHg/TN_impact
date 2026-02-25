"""
╔══════════════════════════════════════════════════════════════╗
║     ⚡ ESP32 POWER MONITOR — PREMIUM DASHBOARD ⚡            ║
║     Real-Time Voltage, Current, Power & Energy Analytics     ║
║     Processed on AMD Ryzen™ High-Performance Processor       ║
╚══════════════════════════════════════════════════════════════╝
"""

import serial
import matplotlib
matplotlib.use('TkAgg')
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import numpy as np
from collections import deque
from datetime import datetime
import re
import time

# ══════════════════════════════════════════════════════════════
# CONFIGURATION — Edit these values for your setup
# ══════════════════════════════════════════════════════════════
PORT = "COM5"           # ⚠️ CHANGE THIS to your ESP32 COM port (e.g., /dev/ttyUSB0 on Linux)
BAUD = 115200
TIME_WINDOW = 80        # Number of data points to display on charts
COST_PER_KWH = 6.50     # ₹ per kWh (adjust to your local rate)
CURRENCY = "₹"

# Alert Thresholds
VOLTAGE_HIGH = 250      # V — overvoltage alert
VOLTAGE_LOW = 200       # V — undervoltage alert
CURRENT_MAX = 15        # A — overcurrent alert
POWER_MAX = 3000        # W — overload alert
VOLTAGE_NOMINAL = 230   # V — expected nominal voltage

# ══════════════════════════════════════════════════════════════
# DARK THEME COLORS
# ══════════════════════════════════════════════════════════════
COLORS = {
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
}

# ══════════════════════════════════════════════════════════════
# DATA STORAGE
# ══════════════════════════════════════════════════════════════
voltage_data = deque(maxlen=TIME_WINDOW)
current_data = deque(maxlen=TIME_WINDOW)
power_data = deque(maxlen=TIME_WINDOW)

# Statistics tracking
stats = {
    'voltage_min': float('inf'), 'voltage_max': 0, 'voltage_sum': 0,
    'current_min': float('inf'), 'current_max': 0, 'current_sum': 0,
    'power_min': float('inf'), 'power_max': 0, 'power_sum': 0,
    'peak_voltage_time': '', 'peak_current_time': '', 'peak_power_time': '',
    'sample_count': 0,
    'energy_kwh': 0.0,
    'start_time': datetime.now(),
    'last_update': time.time(),
}

# ══════════════════════════════════════════════════════════════
# SERIAL CONNECTION (ESP32 required)
# ══════════════════════════════════════════════════════════════
print(f"\n  Connecting to ESP32 on {PORT} @ {BAUD} baud...")
ser = serial.Serial(PORT, BAUD, timeout=1)
print(f"  Connected successfully!\n")


def extract_values(line):
    """Parse ESP32 serial data: Vrms, Current, Power"""
    match = re.search(r"Vrms:\s([\d.]+).*Current:\s([\d.]+).*Power:\s([\d.]+)", line)
    if match:
        return float(match.group(1)), float(match.group(2)), float(match.group(3))
    return None


def update_stats(v, i, p):
    """Update running statistics"""
    now_str = datetime.now().strftime('%H:%M:%S')
    stats['sample_count'] += 1

    if v < stats['voltage_min']: stats['voltage_min'] = v
    if v > stats['voltage_max']:
        stats['voltage_max'] = v
        stats['peak_voltage_time'] = now_str

    if i < stats['current_min']: stats['current_min'] = i
    if i > stats['current_max']:
        stats['current_max'] = i
        stats['peak_current_time'] = now_str

    if p < stats['power_min']: stats['power_min'] = p
    if p > stats['power_max']:
        stats['power_max'] = p
        stats['peak_power_time'] = now_str

    stats['voltage_sum'] += v
    stats['current_sum'] += i
    stats['power_sum'] += p

    # Energy calculation (kWh)
    now = time.time()
    dt_hours = (now - stats['last_update']) / 3600.0
    stats['energy_kwh'] += (p / 1000.0) * dt_hours
    stats['last_update'] = now


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

    # Background arc (track)
    theta_bg = np.linspace(np.pi, 0, 100)
    x_bg = np.cos(theta_bg)
    y_bg = np.sin(theta_bg)
    ax.plot(x_bg, y_bg, color=COLORS['grid'], linewidth=14, solid_capstyle='round', alpha=0.5)

    # Value arc
    ratio = min(value / max_val, 1.0) if max_val > 0 else 0
    theta_val = np.linspace(np.pi, np.pi - (ratio * np.pi), max(2, int(100 * ratio)))
    x_val = np.cos(theta_val)
    y_val = np.sin(theta_val)

    # Glow effect
    ax.plot(x_val, y_val, color=glow_color, linewidth=22, solid_capstyle='round', alpha=0.25)
    # Main arc
    ax.plot(x_val, y_val, color=color, linewidth=12, solid_capstyle='round', alpha=0.9)
    # Bright tip
    if len(x_val) > 0:
        ax.plot(x_val[-1], y_val[-1], 'o', color=color, markersize=8, alpha=1, zorder=5)
        ax.plot(x_val[-1], y_val[-1], 'o', color='white', markersize=3, alpha=0.8, zorder=6)

    # Center value text
    ax.text(0, 0.45, f"{value:.1f}" if value >= 10 else f"{value:.2f}",
            fontsize=28, fontweight='bold', color=color,
            ha='center', va='center', fontfamily='monospace')
    ax.text(0, 0.12, unit, fontsize=11, color=COLORS['text_muted'],
            ha='center', va='center', fontweight='500')

    # Label
    ax.text(0, -0.22, label, fontsize=9, color=COLORS['text_secondary'],
            ha='center', va='center', fontweight='600',
            bbox=dict(boxstyle='round,pad=0.3', facecolor=COLORS['bg_card_alt'],
                      edgecolor=COLORS['border'], alpha=0.8))

    # Scale markers
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
        ax.text(0.5, 0.5, 'Waiting for ESP32 data...', transform=ax.transAxes,
                fontsize=10, color=COLORS['text_muted'], ha='center', va='center')
        ax.set_title(f'  {title}', fontsize=10, fontweight='600',
                     color=COLORS['text_primary'], loc='left', pad=10)
        return

    x = np.arange(len(data))
    y = np.array(data)

    # Fill under curve
    ax.fill_between(x, y, alpha=0.12, color=color)
    # Glow line
    ax.plot(x, y, color=color, linewidth=3, alpha=0.15)
    # Main line
    ax.plot(x, y, color=color, linewidth=1.8, alpha=0.9, zorder=3)

    # Latest value dot
    ax.plot(len(data) - 1, data[-1], 'o', color=color, markersize=6, zorder=5)
    ax.plot(len(data) - 1, data[-1], 'o', color='white', markersize=2.5, zorder=6, alpha=0.8)

    # Value annotation
    ax.annotate(f'{data[-1]:.1f}{unit}',
                xy=(len(data) - 1, data[-1]),
                xytext=(len(data) - 1 - 5, data[-1] + (max(data) - min(data)) * 0.15 if len(data) > 1 else data[-1] + 1),
                fontsize=8, fontweight='bold', color=color,
                fontfamily='monospace',
                bbox=dict(boxstyle='round,pad=0.25', facecolor=COLORS['bg_card_alt'],
                          edgecolor=color, alpha=0.85, linewidth=0.8),
                arrowprops=dict(arrowstyle='->', color=color, lw=0.8, alpha=0.6))

    # Title
    ax.set_title(f'  {title}', fontsize=10, fontweight='600',
                 color=COLORS['text_primary'], loc='left', pad=10)

    # Styling
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

    # Min/Max reference lines
    if len(data) > 5:
        ax.axhline(y=max(data), color=COLORS['danger'], linewidth=0.6, alpha=0.4, linestyle='--')
        ax.axhline(y=min(data), color=COLORS['accent_blue'], linewidth=0.6, alpha=0.4, linestyle='--')


def draw_stats_panel(ax, v, i, p):
    """Draw the live statistics panel"""
    ax.clear()
    ax.set_facecolor(COLORS['bg_card'])
    ax.axis('off')
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 10)

    n = max(stats['sample_count'], 1)

    # Title
    ax.text(5, 9.5, 'LIVE STATISTICS', fontsize=10, fontweight='bold',
            color=COLORS['text_primary'], ha='center', va='center')
    ax.plot([0.5, 9.5], [9.0, 9.0], color=COLORS['border'], linewidth=0.8, alpha=0.5)

    # Voltage Stats
    ax.text(0.5, 8.4, 'VOLTAGE', fontsize=7.5, fontweight='bold', color=COLORS['voltage'])
    ax.text(0.8, 7.7, f'Min: {stats["voltage_min"]:.1f} V' if stats["voltage_min"] < float('inf') else 'Min: --', fontsize=7.5,
            color=COLORS['text_secondary'], fontfamily='monospace')
    ax.text(0.8, 7.1, f'Avg: {stats["voltage_sum"]/n:.1f} V', fontsize=7.5,
            color=COLORS['text_secondary'], fontfamily='monospace')
    ax.text(0.8, 6.5, f'Max: {stats["voltage_max"]:.1f} V' if stats["voltage_max"] > 0 else 'Max: --', fontsize=7.5,
            color=COLORS['text_secondary'], fontfamily='monospace')

    # Current Stats
    ax.text(0.5, 5.7, 'CURRENT', fontsize=7.5, fontweight='bold', color=COLORS['current'])
    ax.text(0.8, 5.0, f'Min: {stats["current_min"]:.3f} A' if stats["current_min"] < float('inf') else 'Min: --', fontsize=7.5,
            color=COLORS['text_secondary'], fontfamily='monospace')
    ax.text(0.8, 4.4, f'Avg: {stats["current_sum"]/n:.3f} A', fontsize=7.5,
            color=COLORS['text_secondary'], fontfamily='monospace')
    ax.text(0.8, 3.8, f'Max: {stats["current_max"]:.3f} A' if stats["current_max"] > 0 else 'Max: --', fontsize=7.5,
            color=COLORS['text_secondary'], fontfamily='monospace')

    # Power Stats
    ax.text(0.5, 3.0, 'POWER', fontsize=7.5, fontweight='bold', color=COLORS['power'])
    ax.text(0.8, 2.3, f'Min: {stats["power_min"]:.0f} W' if stats["power_min"] < float('inf') else 'Min: --', fontsize=7.5,
            color=COLORS['text_secondary'], fontfamily='monospace')
    ax.text(0.8, 1.7, f'Avg: {stats["power_sum"]/n:.0f} W', fontsize=7.5,
            color=COLORS['text_secondary'], fontfamily='monospace')
    ax.text(0.8, 1.1, f'Peak: {stats["power_max"]:.0f} W' if stats["power_max"] > 0 else 'Peak: --', fontsize=7.5,
            color=COLORS['danger'], fontfamily='monospace', fontweight='bold')

    # Power Factor
    pf = p / (v * i) if (v * i) > 0 else 0
    ax.text(5, 2.3, f'PF: {pf:.3f}', fontsize=7.5, color=COLORS['energy'], fontfamily='monospace')

    # Load Status
    load_label, load_color = get_load_status(p)
    ax.text(5, 1.1, load_label, fontsize=8, fontweight='bold',
            color=load_color,
            bbox=dict(boxstyle='round,pad=0.3', facecolor=load_color + '15',
                      edgecolor=load_color, alpha=0.9, linewidth=0.8))

    # Samples count
    ax.text(5, 8.4, f'Samples: {stats["sample_count"]}', fontsize=7,
            color=COLORS['text_muted'], fontfamily='monospace')


def draw_energy_panel(ax):
    """Draw the energy tracking / cost panel"""
    ax.clear()
    ax.set_facecolor(COLORS['bg_card'])
    ax.axis('off')
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 10)

    # Title
    ax.text(5, 9.5, 'ENERGY METER', fontsize=10, fontweight='bold',
            color=COLORS['energy'], ha='center', va='center')
    ax.plot([0.5, 9.5], [9.0, 9.0], color=COLORS['border'], linewidth=0.8, alpha=0.5)

    # Big energy value
    energy = stats['energy_kwh']
    ax.text(5, 7.5, f'{energy:.4f}', fontsize=30, fontweight='bold',
            color=COLORS['energy'], ha='center', va='center', fontfamily='monospace')
    ax.text(5, 6.3, 'kWh', fontsize=12, color=COLORS['text_muted'], ha='center', va='center')

    # Cost
    cost = energy * COST_PER_KWH
    ax.text(5, 5.2, f'Est. Cost: {CURRENCY}{cost:.2f}', fontsize=10,
            fontweight='600', color=COLORS['text_secondary'],
            ha='center', va='center', fontfamily='monospace')

    ax.plot([1, 9], [4.5, 4.5], color=COLORS['border'], linewidth=0.5, alpha=0.4)

    # Uptime
    uptime = datetime.now() - stats['start_time']
    hours = int(uptime.total_seconds() // 3600)
    minutes = int((uptime.total_seconds() % 3600) // 60)
    secs = int(uptime.total_seconds() % 60)
    ax.text(5, 3.7, f'Uptime: {hours:02d}h {minutes:02d}m {secs:02d}s',
            fontsize=8, color=COLORS['text_secondary'],
            ha='center', va='center', fontfamily='monospace')

    # Timestamp
    ax.text(5, 2.8, datetime.now().strftime('%Y-%m-%d  %H:%M:%S'),
            fontsize=8, color=COLORS['text_muted'],
            ha='center', va='center', fontfamily='monospace')

    # Peak times
    ax.plot([1, 9], [2.2, 2.2], color=COLORS['border'], linewidth=0.5, alpha=0.4)
    ax.text(5, 1.6, 'PEAK LOAD CONDITIONS', fontsize=7, fontweight='bold',
            color=COLORS['danger'], ha='center', va='center')
    ax.text(1, 0.9, f'V: {stats["peak_voltage_time"] or "--"}', fontsize=6.5,
            color=COLORS['text_muted'], fontfamily='monospace')
    ax.text(4.2, 0.9, f'I: {stats["peak_current_time"] or "--"}', fontsize=6.5,
            color=COLORS['text_muted'], fontfamily='monospace')
    ax.text(7.2, 0.9, f'P: {stats["peak_power_time"] or "--"}', fontsize=6.5,
            color=COLORS['text_muted'], fontfamily='monospace')

    # AMD badge
    ax.text(5, 0.15, 'Processed on AMD Ryzen', fontsize=6, fontweight='bold',
            color=COLORS['amd_red'], ha='center', va='center', alpha=0.7,
            bbox=dict(boxstyle='round,pad=0.2', facecolor=COLORS['amd_red'] + '10',
                      edgecolor=COLORS['amd_red'] + '30', linewidth=0.5))


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

fig = plt.figure(figsize=(16, 9))
fig.canvas.manager.set_window_title('ESP32 Power Monitor - AMD Dashboard')

# GridSpec layout:
# Row 0: [Voltage Gauge] [Stats Panel] [Energy Meter]
# Row 1: [Voltage Waveform ————————————————————————]
# Row 2: [Current Waveform ——————] [Power Waveform ——————]
gs = gridspec.GridSpec(3, 3, figure=fig,
                       height_ratios=[1.2, 0.9, 0.9],
                       width_ratios=[1, 1, 1],
                       hspace=0.35, wspace=0.25,
                       left=0.04, right=0.97, top=0.92, bottom=0.05)

ax_gauge = fig.add_subplot(gs[0, 0])
ax_stats = fig.add_subplot(gs[0, 1])
ax_energy = fig.add_subplot(gs[0, 2])
ax_voltage = fig.add_subplot(gs[1, :])
ax_current = fig.add_subplot(gs[2, 0:2])
ax_power = fig.add_subplot(gs[2, 2])

all_axes = [ax_gauge, ax_stats, ax_energy, ax_voltage, ax_current, ax_power]
for ax in all_axes:
    ax.set_facecolor(COLORS['bg_card'])
    for spine in ax.spines.values():
        spine.set_color(COLORS['border'])
        spine.set_linewidth(0.5)

# Title
fig.suptitle('ESP32 POWER MONITOR  -  REAL-TIME DASHBOARD',
             fontsize=14, fontweight='bold', color=COLORS['text_primary'], y=0.97)

# Connection status
fig.text(0.97, 0.97, 'ESP32 Connected', fontsize=8, color=COLORS['success'],
         ha='right', va='top', fontfamily='monospace',
         bbox=dict(boxstyle='round,pad=0.3', facecolor=COLORS['success'] + '15',
                   edgecolor=COLORS['success'] + '40', linewidth=0.6))

plt.ion()
plt.show(block=False)


# ══════════════════════════════════════════════════════════════
# MAIN LOOP — Reads ONLY from ESP32 serial
# ══════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("  ESP32 Power Monitor Dashboard - Running")
print("  Press Ctrl+C to stop")
print("=" * 60 + "\n")

try:
    while True:
        raw = ser.readline().decode(errors="ignore").strip()
        if not raw:
            continue
        values = extract_values(raw)
        if not values:
            continue
        v, i, p = values

        # Store data
        voltage_data.append(v)
        current_data.append(i)
        power_data.append(p)

        # Update statistics
        update_stats(v, i, p)

        # === RENDER ALL PANELS ===

        # Voltage Gauge
        draw_gauge_arc(ax_gauge, v, 300, COLORS['voltage'], COLORS['voltage_glow'],
                       'VOLTAGE', 'Vrms')

        # Stats Panel
        draw_stats_panel(ax_stats, v, i, p)

        # Energy Meter
        draw_energy_panel(ax_energy)

        # Voltage Waveform
        draw_waveform(ax_voltage, voltage_data, COLORS['voltage'],
                      'Voltage (Vrms)', 'V', y_min=195, y_max=260)
        if len(voltage_data) > 2:
            ax_voltage.axhline(y=VOLTAGE_NOMINAL, color=COLORS['success'],
                              linewidth=0.7, alpha=0.3, linestyle='-.')
            ax_voltage.axhline(y=VOLTAGE_HIGH, color=COLORS['danger'],
                              linewidth=0.7, alpha=0.3, linestyle='--')
            ax_voltage.axhline(y=VOLTAGE_LOW, color=COLORS['warning'],
                              linewidth=0.7, alpha=0.3, linestyle='--')

        # Current Waveform
        draw_waveform(ax_current, current_data, COLORS['current'],
                      'Current (A)', 'A')

        # Power Waveform
        draw_waveform(ax_power, power_data, COLORS['power'],
                      'Power (W)', 'W')

        # Refresh
        fig.canvas.draw_idle()
        fig.canvas.flush_events()
        plt.pause(0.01)

except KeyboardInterrupt:
    print("\n\n" + "=" * 60)
    print("  Dashboard stopped by user")
    print(f"  Total samples: {stats['sample_count']}")
    print(f"  Total energy: {stats['energy_kwh']:.4f} kWh")
    print(f"  Estimated cost: {CURRENCY}{stats['energy_kwh'] * COST_PER_KWH:.2f}")
    if stats['power_max'] > 0:
        print(f"  Peak: {stats['power_max']:.0f} W @ {stats['peak_power_time']}")
    print("=" * 60 + "\n")

except Exception as e:
    print(f"\n  Error: {e}")

finally:
    if ser and ser.is_open:
        ser.close()
        print("  Serial port closed")
    plt.close('all')
