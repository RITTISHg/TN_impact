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
    showToast('Settings saved successfully!', 'success');
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


// ══════════════════════════════════════════════════════════════
// INITIALIZATION — Shows UI, waits for real ESP32 data
// ══════════════════════════════════════════════════════════════
function init() {
    updateClock();
    setInterval(updateClock, 1000);

    // Show waiting state
    document.getElementById('connectionStatus').querySelector('.status-dot').classList.add('offline');
    document.getElementById('connectionStatus').querySelector('.status-text').textContent = 'Waiting for ESP32...';

    showToast('Waiting for ESP32 data — connect your device', 'warning');
}

document.addEventListener('DOMContentLoaded', init);


// ══════════════════════════════════════════════════════════════
// INTEGRATION EXAMPLES (uncomment the one you need)
// ══════════════════════════════════════════════════════════════

/*
// ── Option 1: WebSocket ──
const ws = new WebSocket('ws://YOUR_ESP32_IP/ws');
ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    updateFromESP32(data.voltage, data.current, data.power);
};

// ── Option 2: HTTP Polling ──
setInterval(async () => {
    try {
        const res = await fetch('http://YOUR_ESP32_IP/data');
        const data = await res.json();
        updateFromESP32(data.voltage, data.current, data.power);
    } catch (e) {
        console.error('ESP32 fetch error:', e);
    }
}, 1000);

// ── Option 3: Web Serial API (Chrome only) ──
async function connectSerial() {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    const reader = port.readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const match = line.match(/Vrms:\s([\d.]+).*Current:\s([\d.]+).*Power:\s([\d.]+)/);
            if (match) {
                updateFromESP32(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
            }
        }
    }
}
*/
