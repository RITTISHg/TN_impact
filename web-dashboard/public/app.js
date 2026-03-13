/* ============================================================
   ESP32 POWER MONITOR + ONNX ML DASHBOARD — JAVASCRIPT
   Awaits real ESP32 data via WebSocket / HTTP / Serial bridge
   Deployed on Vercel · Processed on AMD Ryzen™
   ============================================================ */
'use strict';

// ===== SECURITY: HTML sanitizer to prevent XSS =====
function escapeHTML(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
}

function sanitizeNumber(val, fallback = 0, min = -Infinity, max = Infinity) {
    const n = parseFloat(val);
    if (isNaN(n) || !isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

// ===== CONFIGURATION =====
const CONFIG = {
    costPerUnit: 6.50,
    currency: '₹',
    voltageMax: 300,
    currentMax: 20,
    powerMax: 4000,
    maxDataPoints: 80,
    voltageHighThreshold: 250,
    voltageLowThreshold: 200,
    currentMaxThreshold: 15,
    powerMaxThreshold: 3000,
    voltageNominal: 230,
    updateInterval: 100, // ms
};

// ===== STATE =====
const state = {
    voltage: [], current: [], power: [], labels: [],
    energy: 0, energyToday: 0, energyWeek: 0, energyMonth: 0,
    peakVoltage: { value: 0, time: '--' },
    peakCurrent: { value: 0, time: '--' },
    peakPower: { value: 0, time: '--' },
    uptimeStart: Date.now(),
    logEntries: [],
    lastUpdateTime: Date.now(),
    connected: false,
    sampleCount: 0,
};

// ===== ONNX PERFORMANCE STATE =====
const onnxState = {
    totalInferences: 0,
    totalTime: 0,
    sessionStart: Date.now(),
    latencies: [],
    modelLatencies: {},
    errors: 0,
    maxHistory: 200,
};

// ===== AI STATE =====
const aiState = {
    healthScore: 100.0,
    healthLabel: 'Excellent',
    healthColor: '#22c55e',
    isAnomaly: false,
    anomalyScore: 0,
    faultId: 0,
    faultName: 'Normal',
    faultConfidence: 1.0,
    recommendations: [],
};

// ===== CHART.JS SETUP =====
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(255,255,255,0.04)';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 11;

function createGradient(ctx, colorStart, colorEnd) {
    const g = ctx.createLinearGradient(0, 0, 0, 220);
    g.addColorStop(0, colorStart);
    g.addColorStop(1, colorEnd);
    return g;
}

const defaultChartOptions = (color, borderColor) => ({
    responsive: true, maintainAspectRatio: false,
    plugins: {
        legend: { display: false },
        tooltip: {
            backgroundColor: 'rgba(17,24,39,0.95)', borderColor, borderWidth: 1,
            titleFont: { weight: '600' }, bodyFont: { family: "'JetBrains Mono', monospace" },
            padding: 12, cornerRadius: 8,
        }
    },
    scales: {
        x: { display: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } },
        y: { display: true, grid: { color: 'rgba(255,255,255,0.03)' } },
    },
    interaction: { intersect: false, mode: 'index' },
    animation: { duration: 200 },
});

// ── Real-time charts ──
const voltageCtx = document.getElementById('voltageChart').getContext('2d');
const voltageChart = new Chart(voltageCtx, {
    type: 'line',
    data: {
        labels: [], datasets: [{
            label: 'Voltage (V)', data: [], borderColor: '#38bdf8',
            backgroundColor: createGradient(voltageCtx, 'rgba(56,189,248,0.15)', 'rgba(56,189,248,0)'),
            fill: true, tension: 0.4, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#38bdf8'
        }]
    },
    options: {
        ...defaultChartOptions('#38bdf8', 'rgba(56,189,248,0.2)'),
        scales: {
            x: { display: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } },
            y: { display: true, grid: { color: 'rgba(255,255,255,0.03)' }, suggestedMin: 200, suggestedMax: 260 }
        }
    }
});

const currentCtx = document.getElementById('currentChart').getContext('2d');
const currentChart = new Chart(currentCtx, {
    type: 'line',
    data: {
        labels: [], datasets: [{
            label: 'Current (A)', data: [], borderColor: '#a78bfa',
            backgroundColor: createGradient(currentCtx, 'rgba(167,139,250,0.15)', 'rgba(167,139,250,0)'),
            fill: true, tension: 0.4, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#a78bfa'
        }]
    },
    options: {
        ...defaultChartOptions('#a78bfa', 'rgba(167,139,250,0.2)'),
        scales: {
            x: { display: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } },
            y: { display: true, grid: { color: 'rgba(255,255,255,0.03)' }, suggestedMin: 0, suggestedMax: 10 }
        }
    }
});

const powerCtx = document.getElementById('powerChart').getContext('2d');
const powerChart = new Chart(powerCtx, {
    type: 'line',
    data: {
        labels: [], datasets: [{
            label: 'Power (W)', data: [], borderColor: '#fb923c',
            backgroundColor: createGradient(powerCtx, 'rgba(251,146,60,0.15)', 'rgba(251,146,60,0)'),
            fill: true, tension: 0.4, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#fb923c'
        }]
    },
    options: {
        ...defaultChartOptions('#fb923c', 'rgba(251,146,60,0.2)'),
        scales: {
            x: { display: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } },
            y: { display: true, grid: { color: 'rgba(255,255,255,0.03)' }, suggestedMin: 0 }
        }
    }
});

// ── Analytics charts ──
const powerDistCtx = document.getElementById('powerDistChart').getContext('2d');
const powerDistChart = new Chart(powerDistCtx, {
    type: 'bar',
    data: {
        labels: ['12AM', '2AM', '4AM', '6AM', '8AM', '10AM', '12PM', '2PM', '4PM', '6PM', '8PM', '10PM'],
        datasets: [{
            label: 'Power (W)', data: new Array(12).fill(0),
            backgroundColor: createGradient(powerDistCtx, 'rgba(251,146,60,0.6)', 'rgba(251,146,60,0.1)'),
            borderColor: '#fb923c', borderWidth: 1, borderRadius: 6, barPercentage: 0.6
        }]
    },
    options: {
        responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, beginAtZero: true } }
    }
});

const voltStabCtx = document.getElementById('voltageStabilityChart').getContext('2d');
const voltageStabilityChart = new Chart(voltStabCtx, {
    type: 'scatter',
    data: { datasets: [{ label: 'Voltage (V)', data: [], backgroundColor: 'rgba(56,189,248,0.5)', borderColor: '#38bdf8', borderWidth: 1, pointRadius: 3 }] },
    options: {
        responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: {
            x: { grid: { display: false }, title: { display: true, text: 'Sample', color: '#64748b' } },
            y: { grid: { color: 'rgba(255,255,255,0.03)' }, suggestedMin: 210, suggestedMax: 250 }
        }
    }
});

const loadProfCtx = document.getElementById('loadProfileChart').getContext('2d');
const loadProfileChart = new Chart(loadProfCtx, {
    type: 'doughnut',
    data: {
        labels: ['Light (<500W)', 'Medium (500-1500W)', 'Heavy (>1500W)', 'Idle'],
        datasets: [{
            data: [0, 0, 0, 100], backgroundColor: ['rgba(56,189,248,0.7)', 'rgba(167,139,250,0.7)', 'rgba(251,146,60,0.7)', 'rgba(100,116,139,0.5)'],
            borderColor: 'transparent', borderWidth: 0, hoverOffset: 8
        }]
    },
    options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: { legend: { position: 'bottom', labels: { padding: 14, usePointStyle: true, pointStyleWidth: 10, font: { size: 11 } } } }
    }
});

const days = [];
const now = new Date();
for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); days.push(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })); }
const energyTrendCtx = document.getElementById('energyTrendChart').getContext('2d');
const energyTrendChart = new Chart(energyTrendCtx, {
    type: 'bar',
    data: {
        labels: days, datasets: [{
            label: 'Energy (kWh)', data: [0, 0, 0, 0, 0, 0, 0],
            backgroundColor: createGradient(energyTrendCtx, 'rgba(52,211,153,0.6)', 'rgba(52,211,153,0.1)'),
            borderColor: '#34d399', borderWidth: 1, borderRadius: 8, barPercentage: 0.5
        }]
    },
    options: {
        responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, beginAtZero: true, title: { display: true, text: 'kWh', color: '#64748b' } } }
    }
});

// ── ONNX Sparkline chart ──
const sparkCtx = document.getElementById('onnxSparkline').getContext('2d');
const onnxSparklineChart = new Chart(sparkCtx, {
    type: 'line',
    data: {
        labels: [], datasets: [{
            data: [], borderColor: '#06b6d4',
            backgroundColor: createGradient(sparkCtx, 'rgba(6,182,212,0.2)', 'rgba(6,182,212,0)'),
            fill: true, tension: 0.3, borderWidth: 1.5, pointRadius: 0
        }]
    },
    options: {
        responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } }, animation: { duration: 0 }
    }
});





// ══════════════════════════════════════════════════════════════
// GAUGE & UI UPDATES
// ══════════════════════════════════════════════════════════════
function setGauge(fillEl, value, max) {
    const circ = 2 * Math.PI * 85; const ratio = Math.min(value / max, 1);
    fillEl.style.strokeDasharray = circ; fillEl.style.strokeDashoffset = circ - (ratio * circ);
}

function updateGauges(v, c, p) {
    setGauge(document.getElementById('voltageFill'), v, CONFIG.voltageMax);
    setGauge(document.getElementById('currentFill'), c, CONFIG.currentMax);
    setGauge(document.getElementById('powerFill'), p, CONFIG.powerMax);
    document.getElementById('voltageValue').textContent = v.toFixed(1);
    document.getElementById('currentValue').textContent = c.toFixed(2);
    document.getElementById('powerValue').textContent = p.toFixed(1);
}

function updateONNXPanel() {
    const elapsedS = (Date.now() - onnxState.sessionStart) / 1000;
    const throughput = onnxState.totalInferences / Math.max(elapsedS, 1);
    const lats = onnxState.latencies;

    document.getElementById('onnxInferences').textContent = onnxState.totalInferences.toLocaleString();
    document.getElementById('onnxThroughput').textContent = throughput.toFixed(1);

    if (lats.length > 0) {
        const sorted = [...lats].sort((a, b) => a - b);
        const avg = lats.reduce((a, b) => a + b, 0) / lats.length;
        const p50 = sorted[Math.floor(sorted.length * 0.5)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const p99 = sorted[Math.floor(sorted.length * 0.99)];
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const std = Math.sqrt(lats.reduce((sum, l) => sum + (l - avg) ** 2, 0) / lats.length);

        document.getElementById('onnxAvgLatency').textContent = avg.toFixed(2);
        document.getElementById('onnxP50').textContent = p50.toFixed(3);
        document.getElementById('onnxP95').textContent = p95.toFixed(3);
        document.getElementById('onnxP99').textContent = p99.toFixed(3);
        document.getElementById('onnxMin').textContent = min.toFixed(3);
        document.getElementById('onnxMax').textContent = max.toFixed(3);
        document.getElementById('onnxStd').textContent = std.toFixed(3);

        // Sparkline
        const recent = lats.slice(-60);
        onnxSparklineChart.data.labels = recent.map((_, i) => i);
        onnxSparklineChart.data.datasets[0].data = recent;
        onnxSparklineChart.update('none');
    }

    // Model breakdown
    const breakdown = document.getElementById('onnxModelBreakdown');
    breakdown.innerHTML = '';
    for (const [name, ms] of Object.entries(onnxState.modelLatencies)) {
        const avg = ms.latencies.reduce((a, b) => a + b, 0) / ms.latencies.length;
        const shortName = escapeHTML(name.replace('anomaly_detector', 'AnomalyDet').replace('fault_', 'Fault-'));
        const row = document.createElement('div');
        row.className = 'onnx-model-row';
        const nameSpan = document.createElement('span'); nameSpan.className = 'model-name'; nameSpan.textContent = shortName;
        const statsSpan = document.createElement('span'); statsSpan.className = 'model-stats'; statsSpan.textContent = `${avg.toFixed(2)}ms avg · ${ms.count} calls`;
        row.appendChild(nameSpan); row.appendChild(statsSpan);
        breakdown.appendChild(row);
    }

    // Errors
    const errEl = document.getElementById('onnxErrorStatus');
    if (onnxState.errors > 0) { errEl.textContent = `⚠ ${onnxState.errors} Errors`; errEl.className = 'onnx-footer err'; }
    else { errEl.textContent = '✓ Zero Errors'; errEl.className = 'onnx-footer ok'; }
}

function updateAIPanel() {
    const scoreEl = document.getElementById('healthScore');
    scoreEl.textContent = aiState.healthScore.toFixed(1);
    scoreEl.style.color = aiState.healthColor;
    document.getElementById('healthLabel').textContent = `System Health: ${aiState.healthLabel}`;

    const alertsEl = document.getElementById('aiAlerts');
    alertsEl.innerHTML = '';
    if (aiState.faultId !== 0) {
        const d = document.createElement('div'); d.className = 'ai-alert-item fault';
        d.textContent = `FAULT: ${aiState.faultName} (${(aiState.faultConfidence * 100).toFixed(0)}%)`;
        alertsEl.appendChild(d);
    }
    if (aiState.isAnomaly) {
        const d = document.createElement('div'); d.className = 'ai-alert-item anomaly';
        d.textContent = `ANOMALY (score=${aiState.anomalyScore.toFixed(2)})`;
        alertsEl.appendChild(d);
    }
    if (!aiState.isAnomaly && aiState.faultId === 0) {
        const d = document.createElement('div'); d.className = 'ai-alert-item normal';
        d.textContent = 'All systems operating normally';
        alertsEl.appendChild(d);
    }

    const recEl = document.getElementById('aiRecommendations');
    recEl.innerHTML = '';
    aiState.recommendations.forEach(r => {
        const item = document.createElement('div'); item.className = 'ai-rec-item';
        const title = document.createElement('div'); title.className = 'rec-title'; title.textContent = `• ${r.title}`;
        const action = document.createElement('div'); action.className = 'rec-action'; action.textContent = r.action;
        item.appendChild(title); item.appendChild(action); recEl.appendChild(item);
    });
}


// ══════════════════════════════════════════════════════════════
// MAIN UPDATE FUNCTION
// ══════════════════════════════════════════════════════════════
function updateFromESP32(v, c, p) {
    // Input validation — reject non-numeric or wildly out-of-range values
    v = sanitizeNumber(v, 0, 0, 500);
    c = sanitizeNumber(c, 0, 0, 100);
    p = sanitizeNumber(p, 0, 0, 50000);
    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
    state.sampleCount++;

    if (!state.connected) {
        state.connected = true;
        document.getElementById('connectionStatus').querySelector('.status-dot').classList.remove('offline');
        document.getElementById('connectionStatus').querySelector('.status-text').textContent = 'ESP32 Connected';
        showToast('Sensor data stream active!', 'success');
    }

    state.voltage.push(v); state.current.push(c); state.power.push(p); state.labels.push(timeStr);
    if (state.voltage.length > CONFIG.maxDataPoints) { state.voltage.shift(); state.current.shift(); state.power.shift(); state.labels.shift(); }

    updateGauges(v, c, p);

    // Energy
    const nowMs = Date.now(); const dtH = (nowMs - state.lastUpdateTime) / 3600000;
    const eInc = (p / 1000) * dtH;
    state.energy += eInc; state.energyToday += eInc; state.energyWeek += eInc; state.energyMonth += eInc;
    state.lastUpdateTime = nowMs;

    document.getElementById('energyValue').textContent = state.energy.toFixed(3);
    document.getElementById('energyCost').textContent = CONFIG.currency + (state.energy * CONFIG.costPerUnit).toFixed(2);
    document.getElementById('energyToday').textContent = state.energyToday.toFixed(3);
    document.getElementById('energyWeek').textContent = state.energyWeek.toFixed(3);
    document.getElementById('energyMonth').textContent = state.energyMonth.toFixed(3);

    // Audit section
    document.getElementById('auditToday').textContent = state.energyToday.toFixed(3) + ' kWh';
    document.getElementById('auditTodayCost').textContent = CONFIG.currency + (state.energyToday * CONFIG.costPerUnit).toFixed(2);
    document.getElementById('auditWeek').textContent = state.energyWeek.toFixed(3) + ' kWh';
    document.getElementById('auditWeekCost').textContent = CONFIG.currency + (state.energyWeek * CONFIG.costPerUnit).toFixed(2);
    document.getElementById('auditMonth').textContent = state.energyMonth.toFixed(3) + ' kWh';
    document.getElementById('auditMonthCost').textContent = CONFIG.currency + (state.energyMonth * CONFIG.costPerUnit).toFixed(2);
    document.getElementById('auditTotal').textContent = state.energy.toFixed(3) + ' kWh';
    document.getElementById('auditTotalCost').textContent = CONFIG.currency + (state.energy * CONFIG.costPerUnit).toFixed(2);

    // Min / Avg / Max
    const vArr = state.voltage, cArr = state.current, pArr = state.power;
    document.getElementById('voltageMin').textContent = Math.min(...vArr).toFixed(1);
    document.getElementById('voltageAvg').textContent = (vArr.reduce((a, b) => a + b, 0) / vArr.length).toFixed(1);
    document.getElementById('voltageMax').textContent = Math.max(...vArr).toFixed(1);
    document.getElementById('currentMin').textContent = Math.min(...cArr).toFixed(2);
    document.getElementById('currentAvg').textContent = (cArr.reduce((a, b) => a + b, 0) / cArr.length).toFixed(2);
    document.getElementById('currentMax').textContent = Math.max(...cArr).toFixed(2);
    document.getElementById('powerMin').textContent = Math.min(...pArr).toFixed(0);
    document.getElementById('powerAvg').textContent = (pArr.reduce((a, b) => a + b, 0) / pArr.length).toFixed(0);

    // Peaks
    if (v > state.peakVoltage.value) state.peakVoltage = { value: v, time: timeStr };
    if (c > state.peakCurrent.value) state.peakCurrent = { value: c, time: timeStr };
    if (p > state.peakPower.value) state.peakPower = { value: p, time: timeStr };
    document.getElementById('powerPeak').textContent = state.peakPower.value.toFixed(0);
    document.getElementById('peakVoltage').textContent = state.peakVoltage.value.toFixed(1) + ' V';
    document.getElementById('peakVoltageTime').textContent = state.peakVoltage.time;
    document.getElementById('peakCurrent').textContent = state.peakCurrent.value.toFixed(2) + ' A';
    document.getElementById('peakCurrentTime').textContent = state.peakCurrent.time;
    document.getElementById('peakPower').textContent = state.peakPower.value.toFixed(0) + ' W';
    document.getElementById('peakPowerTime').textContent = state.peakPower.time;

    // PF
    const pf = (v * c) > 0 ? (p / (v * c)).toFixed(3) : '0.000';
    document.getElementById('powerFactor').textContent = pf;

    // Load status
    const loadChip = document.getElementById('loadStatusChip');
    const loadText = document.getElementById('loadStatusText');
    if (p > CONFIG.powerMaxThreshold) { loadChip.className = 'status-chip danger'; loadText.textContent = 'OVERLOAD!'; }
    else if (p > CONFIG.powerMaxThreshold * 0.7) { loadChip.className = 'status-chip warning'; loadText.textContent = 'High Load'; }
    else { loadChip.className = 'status-chip normal'; loadText.textContent = 'Normal Load'; }

    // Charts (update less frequently for performance)
    if (state.sampleCount % 3 === 0) {
        voltageChart.data.labels = [...state.labels]; voltageChart.data.datasets[0].data = [...state.voltage]; voltageChart.update('none');
        currentChart.data.labels = [...state.labels]; currentChart.data.datasets[0].data = [...state.current]; currentChart.update('none');
        powerChart.data.labels = [...state.labels]; powerChart.data.datasets[0].data = [...state.power]; powerChart.update('none');
        voltageStabilityChart.data.datasets[0].data = state.voltage.map((val, idx) => ({ x: idx, y: val })); voltageStabilityChart.update('none');
    }

    // Update ML panels every 5 samples (populated when connected to backend)
    if (state.sampleCount % 5 === 0) { updateONNXPanel(); updateAIPanel(); }

    // Log
    const statusLabel = p > CONFIG.powerMaxThreshold ? 'danger' : p > CONFIG.powerMaxThreshold * 0.7 ? 'warning' : 'normal';
    const statusText = { danger: 'Overload', warning: 'High', normal: 'Normal' }[statusLabel];
    state.logEntries.unshift({ time: timeStr, v, c, p, energy: state.energy.toFixed(4), status: statusLabel, statusText });
    if (state.logEntries.length > 20) state.logEntries.pop();
    if (state.sampleCount % 5 === 0) updateLogTable();

    // Uptime
    const uptimeMs = Date.now() - state.uptimeStart;
    document.getElementById('uptimeValue').textContent = `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;
}


// ══════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════
function updateLogTable() {
    const tbody = document.getElementById('logTableBody');
    tbody.innerHTML = '';
    state.logEntries.forEach(e => {
        const tr = document.createElement('tr');
        const cells = [e.time, e.v.toFixed(1), e.c.toFixed(3), e.p.toFixed(1), e.energy];
        cells.forEach(val => { const td = document.createElement('td'); td.textContent = val; tr.appendChild(td); });
        const statusTd = document.createElement('td');
        const badge = document.createElement('span');
        const safeStatus = ['normal', 'warning', 'danger'].includes(e.status) ? e.status : 'normal';
        badge.className = `status-badge ${safeStatus}`;
        badge.textContent = escapeHTML(e.statusText);
        statusTd.appendChild(badge); tr.appendChild(statusTd);
        tbody.appendChild(tr);
    });
}

function updateClock() { document.getElementById('headerTime').textContent = new Date().toLocaleTimeString('en-US', { hour12: false }); }

// Navigation
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault(); const section = item.dataset.section;
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active')); item.classList.add('active');
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        document.getElementById('section-' + section).classList.add('active');
        document.getElementById('sidebar').classList.remove('open');
    });
});

document.getElementById('menuToggle').addEventListener('click', () => { document.getElementById('sidebar').classList.toggle('open'); });

function downloadReport(type) {
    // Sanitize report type to prevent path traversal
    const allowedTypes = ['daily', 'monthly', 'full'];
    if (!allowedTypes.includes(type)) { showToast('Invalid report type.', 'error'); return; }
    if (state.logEntries.length === 0) { showToast('No data available yet.', 'warning'); return; }
    const headers = ['Timestamp', 'Voltage (V)', 'Current (A)', 'Power (W)', 'Energy (kWh)', 'Status'];
    let csv = headers.join(',') + '\n';
    state.logEntries.forEach(e => { csv += `${e.time},${e.v},${e.c},${e.p},${e.energy},${e.statusText}\n`; });
    csv += '\n--- SUMMARY ---\n';
    csv += `Peak Voltage,${state.peakVoltage.value} V,at ${state.peakVoltage.time}\n`;
    csv += `Peak Current,${state.peakCurrent.value} A,at ${state.peakCurrent.time}\n`;
    csv += `Peak Power,${state.peakPower.value} W,at ${state.peakPower.time}\n`;
    csv += `Total Energy,${state.energy.toFixed(4)} kWh\nEstimated Cost,${CONFIG.currency}${(state.energy * CONFIG.costPerUnit).toFixed(2)}\n`;
    const blob = new Blob([csv], { type: 'text/csv' }); const url = URL.createObjectURL(blob);
    const safeDate = new Date().toISOString().split('T')[0].replace(/[^0-9-]/g, '');
    const a = document.createElement('a'); a.href = url; a.download = `power_report_${type}_${safeDate}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} report downloaded!`, 'success');
}

function saveSettings() {
    // Validate and clamp all user inputs to safe ranges
    CONFIG.costPerUnit = sanitizeNumber(document.getElementById('costPerUnit').value, 6.50, 0.01, 100);
    const rawCurrency = document.getElementById('currency').value || '₹';
    CONFIG.currency = escapeHTML(rawCurrency.substring(0, 3)); // Max 3 chars, sanitized
    CONFIG.voltageHighThreshold = sanitizeNumber(document.getElementById('voltageHigh').value, 250, 100, 500);
    CONFIG.voltageLowThreshold = sanitizeNumber(document.getElementById('voltageLow').value, 200, 50, 400);
    CONFIG.currentMaxThreshold = sanitizeNumber(document.getElementById('currentMax').value, 15, 1, 100);
    CONFIG.powerMaxThreshold = sanitizeNumber(document.getElementById('powerMax').value, 3000, 100, 50000);

    // Persist to localStorage
    localStorage.setItem('powerMonitor_generalSettings', JSON.stringify({
        costPerUnit: CONFIG.costPerUnit,
        currency: CONFIG.currency,
        voltageHighThreshold: CONFIG.voltageHighThreshold,
        voltageLowThreshold: CONFIG.voltageLowThreshold,
        currentMaxThreshold: CONFIG.currentMaxThreshold,
        powerMaxThreshold: CONFIG.powerMaxThreshold,
    }));

    showSavePopup('⚙️ Settings Saved!', [
        `Voltage Alert: ${CONFIG.voltageLowThreshold}V – ${CONFIG.voltageHighThreshold}V`,
        `Current Max: ${CONFIG.currentMaxThreshold}A`,
        `Power Max: ${CONFIG.powerMaxThreshold}W`,
        `Cost: ${CONFIG.currency}${CONFIG.costPerUnit}/kWh`,
    ]);
    showToast('Settings saved successfully!', 'success');
}

// Load general settings from localStorage on startup
function loadGeneralSettings() {
    try {
        const saved = localStorage.getItem('powerMonitor_generalSettings');
        if (saved) {
            const s = JSON.parse(saved);
            CONFIG.costPerUnit = s.costPerUnit ?? 6.50;
            CONFIG.currency = s.currency ?? '₹';
            CONFIG.voltageHighThreshold = s.voltageHighThreshold ?? 250;
            CONFIG.voltageLowThreshold = s.voltageLowThreshold ?? 200;
            CONFIG.currentMaxThreshold = s.currentMaxThreshold ?? 15;
            CONFIG.powerMaxThreshold = s.powerMaxThreshold ?? 3000;

            document.getElementById('costPerUnit').value = CONFIG.costPerUnit;
            document.getElementById('currency').value = CONFIG.currency;
            document.getElementById('voltageHigh').value = CONFIG.voltageHighThreshold;
            document.getElementById('voltageLow').value = CONFIG.voltageLowThreshold;
            document.getElementById('currentMax').value = CONFIG.currentMaxThreshold;
            document.getElementById('powerMax').value = CONFIG.powerMaxThreshold;
        }
    } catch (e) {
        console.warn('[Settings] Failed to load:', e);
    }
}

function showToast(message, type = 'success') {
    const allowedTypes = ['success', 'warning', 'error'];
    if (!allowedTypes.includes(type)) type = 'success';
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div'); toast.className = `toast ${type}`;
    const icons = { success: '✅', warning: '⚠️', error: '❌' };
    const iconSpan = document.createElement('span'); iconSpan.textContent = icons[type] || '💬';
    const msgSpan = document.createElement('span'); msgSpan.textContent = message;
    toast.appendChild(iconSpan); toast.appendChild(msgSpan);
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('fade-out'); setTimeout(() => toast.remove(), 300); }, 3000);
}

// ── Big centered popup for settings saves (visible from hackathon stage) ──
function showSavePopup(title, details) {
    // Remove existing popup if any
    const existing = document.getElementById('savePopupOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'savePopupOverlay';
    overlay.style.cssText = `
        position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;
        background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);
        display:flex;align-items:center;justify-content:center;
        animation:fadeIn 0.3s ease;
    `;

    const popup = document.createElement('div');
    popup.style.cssText = `
        background:linear-gradient(135deg,#111827 0%,#1e293b 100%);
        border:1px solid rgba(34,197,94,0.3);border-radius:20px;
        padding:32px 40px;text-align:center;max-width:420px;width:90%;
        box-shadow:0 25px 60px rgba(0,0,0,0.5),0 0 40px rgba(34,197,94,0.15);
        animation:popIn 0.4s cubic-bezier(0.34,1.56,0.64,1);
    `;

    const checkmark = document.createElement('div');
    checkmark.style.cssText = `
        font-size:56px;margin-bottom:12px;
        animation:bounceIn 0.5s ease 0.2s both;
    `;
    checkmark.textContent = '✅';

    const titleEl = document.createElement('div');
    titleEl.style.cssText = `
        font-size:22px;font-weight:800;color:#f1f5f9;margin-bottom:16px;
        font-family:'Inter',sans-serif;
    `;
    titleEl.textContent = title;

    const detailsEl = document.createElement('div');
    detailsEl.style.cssText = `
        text-align:left;background:rgba(0,0,0,0.3);border-radius:12px;
        padding:14px 18px;margin-bottom:18px;
    `;
    details.forEach(d => {
        const line = document.createElement('div');
        line.style.cssText = `
            font-size:13px;color:#94a3b8;padding:4px 0;
            font-family:'JetBrains Mono',monospace;
            border-bottom:1px solid rgba(255,255,255,0.05);
        `;
        line.textContent = d;
        detailsEl.appendChild(line);
    });

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:#64748b;';
    hint.textContent = 'Settings saved to browser — click to close';

    popup.appendChild(checkmark);
    popup.appendChild(titleEl);
    popup.appendChild(detailsEl);
    popup.appendChild(hint);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    // Add keyframe styles if not already added
    if (!document.getElementById('popupAnimStyles')) {
        const style = document.createElement('style');
        style.id = 'popupAnimStyles';
        style.textContent = `
            @keyframes fadeIn { from{opacity:0} to{opacity:1} }
            @keyframes popIn { from{opacity:0;transform:scale(0.7)} to{opacity:1;transform:scale(1)} }
            @keyframes bounceIn { from{opacity:0;transform:scale(0.3)} 50%{transform:scale(1.1)} to{opacity:1;transform:scale(1)} }
        `;
        document.head.appendChild(style);
    }

    // Click to close
    overlay.addEventListener('click', () => {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s ease';
        setTimeout(() => overlay.remove(), 300);
    });

    // Auto-close after 3 seconds
    setTimeout(() => {
        if (document.body.contains(overlay)) {
            overlay.style.opacity = '0';
            overlay.style.transition = 'opacity 0.3s ease';
            setTimeout(() => overlay.remove(), 300);
        }
    }, 3000);
}


// ══════════════════════════════════════════════════════════════
// FIREBASE REALTIME DATABASE — Configuration
// ══════════════════════════════════════════════════════════════
const FIREBASE_URL = 'https://energy-ml-default-rtdb.firebaseio.com';
const FB_LIVE_URL      = `${FIREBASE_URL}/power_monitor/live.json`;
const FB_ONNX_URL      = `${FIREBASE_URL}/power_monitor/onnx_perf.json`;
const FB_SESSION_URL   = `${FIREBASE_URL}/power_monitor/session.json`;
const FB_READINGS_URL  = `${FIREBASE_URL}/power_monitor/readings.json?orderBy="$key"&limitToLast=80`;
const FB_ALERTS_URL    = `${FIREBASE_URL}/power_monitor/alerts.json?orderBy="$key"&limitToLast=10`;

// ── Firebase connection state ──
const fbState = {
    lastTimestamp: null,      // detect stale data
    consecutiveErrors: 0,
    connected: false,
    lastOnnxUpdate: 0,
    lastHistoryUpdate: 0,
    onnxSessionStart: Date.now(),
};

// ══════════════════════════════════════════════════════════════
// FIREBASE LIVE POLLER  (every 500ms for low-latency updates)
// ══════════════════════════════════════════════════════════════
async function pollFirebaseLive() {
    try {
        const res = await fetch(FB_LIVE_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (!d || d.test_mode) return;   // skip test data

        // ── Detect stale / duplicate reading ──
        if (d.timestamp === fbState.lastTimestamp) return;
        fbState.lastTimestamp = d.timestamp;
        fbState.consecutiveErrors = 0;

        // ── Connection status ──
        if (!fbState.connected) {
            fbState.connected = true;
            state.connected = true;
            document.getElementById('connectionStatus').querySelector('.status-dot').classList.remove('offline');
            document.getElementById('connectionStatus').querySelector('.status-text').textContent = 'Firebase Live';
            showToast('Connected to Firebase — live data streaming!', 'success');
        }

        // ── Core sensor values ──
        const v = sanitizeNumber(d.voltage,  0, 0, 500);
        const c = sanitizeNumber(d.current,  0, 0, 100);
        const p = sanitizeNumber(d.power,    0, 0, 50000);
        updateFromESP32(v, c, p);

        // ── Override energy with server-computed value (more accurate) ──
        if (d.energy_kwh != null) {
            const ekwh = sanitizeNumber(d.energy_kwh, 0, 0, 1e6);
            state.energy = ekwh;
            state.energyToday  = ekwh;   // session-scoped
            state.energyWeek   = ekwh;
            state.energyMonth  = ekwh;
            document.getElementById('energyValue').textContent  = ekwh.toFixed(4);
            document.getElementById('energyCost').textContent   = CONFIG.currency + (ekwh * CONFIG.costPerUnit).toFixed(2);
            document.getElementById('energyToday').textContent  = ekwh.toFixed(4);
            document.getElementById('energyWeek').textContent   = ekwh.toFixed(4);
            document.getElementById('energyMonth').textContent  = ekwh.toFixed(4);
            document.getElementById('auditToday').textContent   = ekwh.toFixed(4) + ' kWh';
            document.getElementById('auditTodayCost').textContent = CONFIG.currency + (ekwh * CONFIG.costPerUnit).toFixed(2);
            document.getElementById('auditWeek').textContent    = ekwh.toFixed(4) + ' kWh';
            document.getElementById('auditWeekCost').textContent  = CONFIG.currency + (ekwh * CONFIG.costPerUnit).toFixed(2);
            document.getElementById('auditMonth').textContent   = ekwh.toFixed(4) + ' kWh';
            document.getElementById('auditMonthCost').textContent = CONFIG.currency + (ekwh * CONFIG.costPerUnit).toFixed(2);
            document.getElementById('auditTotal').textContent   = ekwh.toFixed(4) + ' kWh';
            document.getElementById('auditTotalCost').textContent = CONFIG.currency + (ekwh * CONFIG.costPerUnit).toFixed(2);
        }

        // ── AI — Anomaly ──
        if (d.anomaly) {
            aiState.isAnomaly    = !!d.anomaly.is_anomaly;
            aiState.anomalyScore = sanitizeNumber(d.anomaly.score, 0, 0, 1);
        }

        // ── AI — Fault ──
        if (d.fault) {
            aiState.faultId         = sanitizeNumber(d.fault.fault_id, 0, 0, 9);
            aiState.faultName       = escapeHTML(String(d.fault.fault_name || 'Normal'));
            aiState.faultConfidence = sanitizeNumber(d.fault.confidence, 1, 0, 1);
        }

        // ── AI — Health ──
        if (d.health) {
            const hs = sanitizeNumber(d.health.score, 100, 0, 100);
            aiState.healthScore = hs;
            aiState.healthLabel = escapeHTML(String(d.health.label || 'Unknown'));
            // Color by score
            if (hs >= 85)      aiState.healthColor = '#22c55e';
            else if (hs >= 60) aiState.healthColor = '#eab308';
            else               aiState.healthColor = '#ef4444';
        }

        updateAIPanel();

        // ── Email alerts — check thresholds ──
        checkEmailThresholds(v, c, p);

    } catch (err) {
        fbState.consecutiveErrors++;
        if (fbState.consecutiveErrors >= 5 && fbState.connected) {
            fbState.connected = false;
            state.connected   = false;
            document.getElementById('connectionStatus').querySelector('.status-dot').classList.add('offline');
            document.getElementById('connectionStatus').querySelector('.status-text').textContent = 'Firebase Disconnected';
            showToast('Firebase connection lost — retrying…', 'error');
        }
    }
}

// ══════════════════════════════════════════════════════════════
// FIREBASE ONNX PERF POLLER  (every 3 seconds)
// ══════════════════════════════════════════════════════════════
async function pollFirebaseOnnx() {
    try {
        const res = await fetch(FB_ONNX_URL, { cache: 'no-store' });
        if (!res.ok) return;
        const d = await res.json();
        if (!d || d.test) return;

        const inferences = sanitizeNumber(d.total_inferences, 0, 0, 1e9);
        if (inferences === 0) return;

        const avgMs  = sanitizeNumber(d.avg_latency_ms,  0, 0, 5000);
        const p95Ms  = sanitizeNumber(d.p95_latency_ms,  0, 0, 5000);
        const tput   = sanitizeNumber(d.throughput_ips,  0, 0, 1e6);
        const errors = sanitizeNumber(d.error_count,     0, 0, 1e6);

        // Sync ONNX state for the panel
        onnxState.totalInferences = inferences;
        onnxState.errors = errors;

        // Synthesize a latency history entry so the sparkline stays live
        if (avgMs > 0) {
            onnxState.latencies.push(avgMs);
            if (onnxState.latencies.length > onnxState.maxHistory)
                onnxState.latencies.shift();
        }

        // Direct DOM updates for exact server values
        document.getElementById('onnxInferences').textContent  = inferences.toLocaleString();
        document.getElementById('onnxThroughput').textContent  = tput.toFixed(1);
        document.getElementById('onnxAvgLatency').textContent  = avgMs.toFixed(2);
        document.getElementById('onnxP95').textContent         = p95Ms.toFixed(3);

        // Update sparkline
        const recent = onnxState.latencies.slice(-60);
        onnxSparklineChart.data.labels = recent.map((_, i) => i);
        onnxSparklineChart.data.datasets[0].data = recent;
        onnxSparklineChart.update('none');

        const errEl = document.getElementById('onnxErrorStatus');
        if (errors > 0) { errEl.textContent = `⚠ ${errors} Errors`; errEl.className = 'onnx-footer err'; }
        else            { errEl.textContent = '✓ Zero Errors';       errEl.className = 'onnx-footer ok'; }

    } catch (_) { /* silent — non-critical */ }
}

// ══════════════════════════════════════════════════════════════
// FIREBASE HISTORY POLLER  (every 10 seconds)
// Power Distribution chart + Voltage Stability + Energy Trend
// ══════════════════════════════════════════════════════════════
async function pollFirebaseHistory() {
    try {
        const res = await fetch(FB_READINGS_URL, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!data) return;

        const rows = Object.values(data).filter(r => r && !r.test_mode);
        if (rows.length === 0) return;

        // ── Voltage Stability scatter ──
        voltageStabilityChart.data.datasets[0].data = rows.map((r, i) => ({
            x: i, y: sanitizeNumber(r.voltage, 230, 0, 500)
        }));
        voltageStabilityChart.update('none');

        // ── Load Profile doughnut ──
        let light = 0, medium = 0, heavy = 0, idle = 0;
        rows.forEach(r => {
            const pw = sanitizeNumber(r.power, 0, 0, 50000);
            if      (pw < 50)   idle++;
            else if (pw < 500)  light++;
            else if (pw < 1500) medium++;
            else                heavy++;
        });
        const total = rows.length;
        loadProfileChart.data.datasets[0].data = [
            Math.round(light/total*100), Math.round(medium/total*100),
            Math.round(heavy/total*100), Math.round(idle/total*100)
        ];
        loadProfileChart.update('none');

        // ── Power Distribution bar (bin into 12 x 2h slots by timestamp hour) ──
        const hourBins = new Array(12).fill(0);
        const hourCounts = new Array(12).fill(0);
        rows.forEach(r => {
            if (!r.timestamp) return;
            const h = new Date(r.timestamp).getHours();
            const slot = Math.floor(h / 2);
            hourBins[slot] += sanitizeNumber(r.power, 0, 0, 50000);
            hourCounts[slot]++;
        });
        powerDistChart.data.datasets[0].data = hourBins.map((sum, i) =>
            hourCounts[i] > 0 ? Math.round(sum / hourCounts[i]) : 0
        );
        powerDistChart.update('none');

        // ── Energy Trend — last reading per day ──
        const byDay = {};
        rows.forEach(r => {
            if (!r.timestamp || !r.energy_kwh) return;
            const day = r.timestamp.slice(0, 10);
            byDay[day] = Math.max(byDay[day] || 0, sanitizeNumber(r.energy_kwh, 0, 0, 1e6));
        });
        const sortedDays = Object.keys(byDay).sort().slice(-7);
        if (sortedDays.length > 0) {
            energyTrendChart.data.labels   = sortedDays.map(d => {
                const dt = new Date(d);
                return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            });
            energyTrendChart.data.datasets[0].data = sortedDays.map(d => +(byDay[d] || 0).toFixed(4));
            energyTrendChart.update('none');
        }

    } catch (_) { /* silent */ }
}

// ══════════════════════════════════════════════════════════════
// FIREBASE ALERTS LOG  (every 5 seconds)
// Shows last 10 alerts in the Reports → Log table
// ══════════════════════════════════════════════════════════════
async function pollFirebaseAlerts() {
    try {
        const res = await fetch(FB_ALERTS_URL, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!data) return;

        const alerts = Object.values(data).reverse().slice(0, 10);
        // Merge into logEntries for the CSV download & table display
        alerts.forEach(a => {
            if (!a || !a.timestamp) return;
            const ts = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
            const exists = state.logEntries.some(e => e.time === ts && e._alert);
            if (!exists) {
                state.logEntries.unshift({
                    time: ts, v: a.voltage || 0, c: a.current || 0, p: a.power || 0,
                    energy: state.energy.toFixed(4),
                    status: a.severity === 'critical' ? 'danger' : 'warning',
                    statusText: escapeHTML(a.type + ': ' + (a.detail || '')).slice(0, 40),
                    _alert: true
                });
            }
        });
        if (state.logEntries.length > 200) state.logEntries.length = 200;
        updateLogTable();
    } catch (_) { /* silent */ }
}

// ══════════════════════════════════════════════════════════════
// FIREBASE SESSION SUMMARY  (on load, then every 30 seconds)
// Populates peak cards from the server session data
// ══════════════════════════════════════════════════════════════
async function pollFirebaseSession() {
    try {
        const res = await fetch(FB_SESSION_URL, { cache: 'no-store' });
        if (!res.ok) return;
        const d = await res.json();
        if (!d || !d.peak_power_w) return;

        const pk = sanitizeNumber(d.peak_power_w, 0, 0, 50000);
        if (pk > state.peakPower.value) {
            state.peakPower = { value: pk, time: d.peak_power_time || '--' };
            document.getElementById('peakPower').textContent     = pk.toFixed(0) + ' W';
            document.getElementById('peakPowerTime').textContent = d.peak_power_time || '--';
            document.getElementById('powerPeak').textContent     = pk.toFixed(0);
        }
    } catch (_) { /* silent */ }
}

// ══════════════════════════════════════════════════════════════
// EMAIL ALERT ENGINE (EmailJS)
// ══════════════════════════════════════════════════════════════
const emailAlert = {
    enabled: false,
    serviceId: 'service_02p01dl',
    templateId: 'template_3zh2atr',
    publicKey: 'zthpelV1k5lIP5d_Z',
    recipientEmail: '',
    // Demo-friendly thresholds (easy to trigger)
    thresholds: {
        voltageHigh: 240,
        voltageLow: 210,
        currentMax: 5,
        powerMax: 1000,
    },
    cooldownSec: 30,
    lastEmailTime: 0,
    emailsSent: 0,
};

// ── Load saved settings from localStorage ──
function loadEmailSettings() {
    try {
        const saved = localStorage.getItem('powerMonitor_emailAlert');
        if (saved) {
            const s = JSON.parse(saved);
            emailAlert.serviceId = s.serviceId || '';
            emailAlert.templateId = s.templateId || '';
            emailAlert.publicKey = s.publicKey || '';
            emailAlert.recipientEmail = s.recipientEmail || '';
            emailAlert.thresholds.voltageHigh = s.voltageHigh ?? 240;
            emailAlert.thresholds.voltageLow = s.voltageLow ?? 210;
            emailAlert.thresholds.currentMax = s.currentMax ?? 5;
            emailAlert.thresholds.powerMax = s.powerMax ?? 1000;
            emailAlert.cooldownSec = s.cooldownSec ?? 30;

            // Populate fields
            document.getElementById('emailjsServiceId').value = emailAlert.serviceId;
            document.getElementById('emailjsTemplateId').value = emailAlert.templateId;
            document.getElementById('emailjsPublicKey').value = emailAlert.publicKey;
            document.getElementById('alertEmail').value = emailAlert.recipientEmail;
            document.getElementById('emailVoltageHigh').value = emailAlert.thresholds.voltageHigh;
            document.getElementById('emailVoltageLow').value = emailAlert.thresholds.voltageLow;
            document.getElementById('emailCurrentMax').value = emailAlert.thresholds.currentMax;
            document.getElementById('emailPowerMax').value = emailAlert.thresholds.powerMax;
            document.getElementById('emailCooldown').value = emailAlert.cooldownSec;

            // Enable if all required fields are set
            if (emailAlert.serviceId && emailAlert.templateId && emailAlert.publicKey && emailAlert.recipientEmail) {
                emailAlert.enabled = true;
                emailjs.init(emailAlert.publicKey);
                document.getElementById('emailAlertStatus').textContent = `✅ Enabled — alerts sent to ${emailAlert.recipientEmail}`;
                document.getElementById('emailAlertStatus').style.color = '#22c55e';
            }
        }
    } catch (e) {
        console.warn('[EmailAlert] Failed to load settings:', e);
    }
}

// ── Save settings ──
function saveEmailSettings() {
    emailAlert.serviceId = document.getElementById('emailjsServiceId').value.trim();
    emailAlert.templateId = document.getElementById('emailjsTemplateId').value.trim();
    emailAlert.publicKey = document.getElementById('emailjsPublicKey').value.trim();
    emailAlert.recipientEmail = document.getElementById('alertEmail').value.trim();
    emailAlert.thresholds.voltageHigh = sanitizeNumber(document.getElementById('emailVoltageHigh').value, 240, 100, 500);
    emailAlert.thresholds.voltageLow = sanitizeNumber(document.getElementById('emailVoltageLow').value, 210, 50, 400);
    emailAlert.thresholds.currentMax = sanitizeNumber(document.getElementById('emailCurrentMax').value, 5, 0.1, 100);
    emailAlert.thresholds.powerMax = sanitizeNumber(document.getElementById('emailPowerMax').value, 1000, 10, 50000);
    emailAlert.cooldownSec = sanitizeNumber(document.getElementById('emailCooldown').value, 30, 10, 600);

    // Validate
    if (!emailAlert.serviceId || !emailAlert.templateId || !emailAlert.publicKey || !emailAlert.recipientEmail) {
        showToast('Please fill in all EmailJS fields!', 'error');
        return;
    }

    // Save to localStorage
    localStorage.setItem('powerMonitor_emailAlert', JSON.stringify({
        serviceId: emailAlert.serviceId,
        templateId: emailAlert.templateId,
        publicKey: emailAlert.publicKey,
        recipientEmail: emailAlert.recipientEmail,
        voltageHigh: emailAlert.thresholds.voltageHigh,
        voltageLow: emailAlert.thresholds.voltageLow,
        currentMax: emailAlert.thresholds.currentMax,
        powerMax: emailAlert.thresholds.powerMax,
        cooldownSec: emailAlert.cooldownSec,
    }));

    // Initialize EmailJS
    emailjs.init(emailAlert.publicKey);
    emailAlert.enabled = true;

    document.getElementById('emailAlertStatus').textContent = `✅ Enabled — alerts sent to ${emailAlert.recipientEmail}`;
    document.getElementById('emailAlertStatus').style.color = '#22c55e';

    showSavePopup('📧 Email Alerts Enabled!', [
        `Recipient: ${emailAlert.recipientEmail}`,
        `High Voltage Alert: > ${emailAlert.thresholds.voltageHigh}V`,
        `Low Voltage Alert: < ${emailAlert.thresholds.voltageLow}V`,
        `Max Current Alert: > ${emailAlert.thresholds.currentMax}A`,
        `Max Power Alert: > ${emailAlert.thresholds.powerMax}W`,
        `Cooldown: ${emailAlert.cooldownSec}s between emails`,
    ]);
    showToast('Email alerts enabled! Alerts will fire when thresholds are breached.', 'success');
}

// ── Send alert email ──
function sendEmailAlert(alertType, details) {
    if (!emailAlert.enabled) return;

    // Cooldown check — prevent email spam
    const now = Date.now();
    if ((now - emailAlert.lastEmailTime) < emailAlert.cooldownSec * 1000) {
        console.log(`[EmailAlert] Cooldown active — skipping (${Math.round((emailAlert.cooldownSec * 1000 - (now - emailAlert.lastEmailTime)) / 1000)}s remaining)`);
        return;
    }
    emailAlert.lastEmailTime = now;
    emailAlert.emailsSent++;

    const timeStr = new Date().toLocaleString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' });

    const templateParams = {
        to_email: emailAlert.recipientEmail,
        alert_type: alertType,
        alert_details: details,
        voltage: state.voltage.length > 0 ? state.voltage[state.voltage.length - 1].toFixed(1) : '0',
        current: state.current.length > 0 ? state.current[state.current.length - 1].toFixed(3) : '0',
        power: state.power.length > 0 ? state.power[state.power.length - 1].toFixed(1) : '0',
        energy: state.energy.toFixed(4),
        timestamp: timeStr,
        health_score: aiState.healthScore.toFixed(1),
        fault_status: aiState.faultId !== 0 ? aiState.faultName : 'Normal',
        threshold_voltage_high: emailAlert.thresholds.voltageHigh,
        threshold_voltage_low: emailAlert.thresholds.voltageLow,
        threshold_current_max: emailAlert.thresholds.currentMax,
        threshold_power_max: emailAlert.thresholds.powerMax,
    };

    emailjs.send(emailAlert.serviceId, emailAlert.templateId, templateParams)
        .then(() => {
            console.log(`[EmailAlert] ✅ Alert sent: ${alertType}`);
            showToast(`📧 Email alert sent: ${alertType}`, 'success');
            document.getElementById('emailAlertStatus').textContent =
                `✅ Last alert: ${alertType} at ${timeStr} (${emailAlert.emailsSent} total)`;
            document.getElementById('emailAlertStatus').style.color = '#22c55e';
        })
        .catch((err) => {
            console.error('[EmailAlert] ❌ Failed:', err);
            showToast(`Email alert failed: ${err.text || err}`, 'error');
            document.getElementById('emailAlertStatus').textContent = `❌ Send failed: ${err.text || err}`;
            document.getElementById('emailAlertStatus').style.color = '#ef4444';
        });
}

// ── Test alert button ──
function sendTestEmailAlert() {
    if (!emailAlert.serviceId || !emailAlert.templateId || !emailAlert.publicKey || !emailAlert.recipientEmail) {
        // Try saving first
        saveEmailSettings();
        if (!emailAlert.enabled) return;
    }

    // Force bypass cooldown for test
    emailAlert.lastEmailTime = 0;
    sendEmailAlert(
        '🧪 TEST ALERT',
        'This is a test alert from the ESP32 Power Monitor Dashboard. If you received this email, your alert system is working correctly!'
    );
}

// ── Check thresholds on every live reading ──
function checkEmailThresholds(v, c, p) {
    if (!emailAlert.enabled) return;

    const alerts = [];

    if (v > emailAlert.thresholds.voltageHigh) {
        alerts.push(`⚠️ HIGH VOLTAGE: ${v.toFixed(1)}V exceeds ${emailAlert.thresholds.voltageHigh}V threshold`);
    }
    if (v > 0 && v < emailAlert.thresholds.voltageLow) {
        alerts.push(`⚠️ LOW VOLTAGE: ${v.toFixed(1)}V below ${emailAlert.thresholds.voltageLow}V threshold`);
    }
    if (c > emailAlert.thresholds.currentMax) {
        alerts.push(`⚠️ OVERCURRENT: ${c.toFixed(2)}A exceeds ${emailAlert.thresholds.currentMax}A threshold`);
    }
    if (p > emailAlert.thresholds.powerMax) {
        alerts.push(`⚠️ OVERLOAD: ${p.toFixed(0)}W exceeds ${emailAlert.thresholds.powerMax}W threshold`);
    }

    // Also check AI fault
    if (aiState.faultId !== 0) {
        alerts.push(`🤖 AI FAULT DETECTED: ${aiState.faultName} (${(aiState.faultConfidence * 100).toFixed(0)}% confidence)`);
    }

    if (alerts.length > 0) {
        sendEmailAlert(
            `⚡ POWER ALERT (${alerts.length} issue${alerts.length > 1 ? 's' : ''})`,
            alerts.join('\n')
        );
    }
}


// ══════════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════════
function init() {
    updateClock();
    setInterval(updateClock, 1000);

    // Show connecting state
    document.getElementById('connectionStatus').querySelector('.status-dot').classList.add('offline');
    document.getElementById('connectionStatus').querySelector('.status-text').textContent = 'Connecting to Firebase…';

    showToast('Connecting to Firebase Realtime Database…', 'warning');

    // Load saved settings from previous session
    loadGeneralSettings();
    loadEmailSettings();

    // ── Start pollers ──
    pollFirebaseLive();                                  // immediate first fetch
    setInterval(pollFirebaseLive,   500);                // live:    every 500ms (low-latency)

    setTimeout(() => {
        pollFirebaseOnnx();
        setInterval(pollFirebaseOnnx,   3000);           // ONNX:    every 3s
    }, 1500);

    setTimeout(() => {
        pollFirebaseHistory();
        setInterval(pollFirebaseHistory, 10000);         // history: every 10s
    }, 3000);

    setTimeout(() => {
        pollFirebaseAlerts();
        setInterval(pollFirebaseAlerts,  5000);          // alerts:  every 5s
    }, 2000);

    setTimeout(() => {
        pollFirebaseSession();
        setInterval(pollFirebaseSession, 30000);         // session: every 30s
    }, 4000);
}

document.addEventListener('DOMContentLoaded', init);

