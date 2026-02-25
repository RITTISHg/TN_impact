/* ============================================================
   ESP32 POWER MONITOR DASHBOARD — JAVASCRIPT
   Simulated real-time data for UI demonstration
   Replace the simulation with your ESP32 WebSocket/HTTP data
   ============================================================ */

// ===== CONFIGURATION =====
const CONFIG = {
  costPerUnit: 6.50,       // ₹ per kWh
  currency: '₹',
  voltageMax: 300,          // Max gauge range
  currentMax: 20,
  powerMax: 4000,
  sampleInterval: 1000,     // ms
  maxDataPoints: 60,
  voltageNominal: 230,
  voltageHighThreshold: 250,
  voltageLowThreshold: 200,
  currentMaxThreshold: 15,
  powerMaxThreshold: 3000,
};

// ===== STATE =====
const state = {
  voltage: [],
  current: [],
  power: [],
  energy: 0,
  energyToday: 0,
  energyWeek: 0,
  energyMonth: 0,
  labels: [],
  peakVoltage: { value: 0, time: '--' },
  peakCurrent: { value: 0, time: '--' },
  peakPower: { value: 0, time: '--' },
  uptimeStart: Date.now(),
  logEntries: [],
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

// Voltage Chart
const voltageCtx = document.getElementById('voltageChart').getContext('2d');
const voltageChart = new Chart(voltageCtx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      label: 'Voltage (V)',
      data: [],
      borderColor: '#38bdf8',
      backgroundColor: createGradient(voltageCtx, 'rgba(56,189,248,0.15)', 'rgba(56,189,248,0)'),
      fill: true,
      tension: 0.4,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#38bdf8',
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(17,24,39,0.95)',
        borderColor: 'rgba(56,189,248,0.2)',
        borderWidth: 1,
        titleFont: { weight: '600' },
        bodyFont: { family: "'JetBrains Mono', monospace" },
        padding: 12,
        cornerRadius: 8,
      }
    },
    scales: {
      x: { display: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } },
      y: {
        display: true,
        grid: { color: 'rgba(255,255,255,0.03)' },
        suggestedMin: 200,
        suggestedMax: 260,
      },
    },
    interaction: { intersect: false, mode: 'index' },
    animation: { duration: 400 },
  }
});

// Current Chart
const currentCtx = document.getElementById('currentChart').getContext('2d');
const currentChart = new Chart(currentCtx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      label: 'Current (A)',
      data: [],
      borderColor: '#a78bfa',
      backgroundColor: createGradient(currentCtx, 'rgba(167,139,250,0.15)', 'rgba(167,139,250,0)'),
      fill: true,
      tension: 0.4,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#a78bfa',
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: {
      backgroundColor: 'rgba(17,24,39,0.95)',
      borderColor: 'rgba(167,139,250,0.2)',
      borderWidth: 1,
      padding: 12,
      cornerRadius: 8,
      bodyFont: { family: "'JetBrains Mono', monospace" },
    }},
    scales: {
      x: { display: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } },
      y: { display: true, grid: { color: 'rgba(255,255,255,0.03)' }, suggestedMin: 0, suggestedMax: 10 },
    },
    interaction: { intersect: false, mode: 'index' },
    animation: { duration: 400 },
  }
});

// Power Chart
const powerCtx = document.getElementById('powerChart').getContext('2d');
const powerChart = new Chart(powerCtx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      label: 'Power (W)',
      data: [],
      borderColor: '#fb923c',
      backgroundColor: createGradient(powerCtx, 'rgba(251,146,60,0.15)', 'rgba(251,146,60,0)'),
      fill: true,
      tension: 0.4,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#fb923c',
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: {
      backgroundColor: 'rgba(17,24,39,0.95)',
      borderColor: 'rgba(251,146,60,0.2)',
      borderWidth: 1,
      padding: 12,
      cornerRadius: 8,
      bodyFont: { family: "'JetBrains Mono', monospace" },
    }},
    scales: {
      x: { display: true, grid: { display: false }, ticks: { maxTicksLimit: 8 } },
      y: { display: true, grid: { color: 'rgba(255,255,255,0.03)' }, suggestedMin: 0 },
    },
    interaction: { intersect: false, mode: 'index' },
    animation: { duration: 400 },
  }
});

// ===== ANALYTICS CHARTS =====
// Power Distribution (Bar chart)
const powerDistCtx = document.getElementById('powerDistChart').getContext('2d');
const powerDistChart = new Chart(powerDistCtx, {
  type: 'bar',
  data: {
    labels: ['12AM', '2AM', '4AM', '6AM', '8AM', '10AM', '12PM', '2PM', '4PM', '6PM', '8PM', '10PM'],
    datasets: [{
      label: 'Power (W)',
      data: [120, 80, 60, 150, 450, 800, 1200, 900, 750, 1100, 680, 300],
      backgroundColor: createGradient(powerDistCtx, 'rgba(251,146,60,0.6)', 'rgba(251,146,60,0.1)'),
      borderColor: '#fb923c',
      borderWidth: 1,
      borderRadius: 6,
      barPercentage: 0.6,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false } },
      y: { grid: { color: 'rgba(255,255,255,0.03)' }, beginAtZero: true },
    },
  }
});

// Voltage Stability (scatter)
const voltStabCtx = document.getElementById('voltageStabilityChart').getContext('2d');
const voltStabData = [];
for (let i = 0; i < 50; i++) {
  voltStabData.push({ x: i, y: 220 + Math.random() * 20 - 5 });
}
const voltageStabilityChart = new Chart(voltStabCtx, {
  type: 'scatter',
  data: {
    datasets: [{
      label: 'Voltage (V)',
      data: voltStabData,
      backgroundColor: 'rgba(56,189,248,0.5)',
      borderColor: '#38bdf8',
      borderWidth: 1,
      pointRadius: 3,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, title: { display: true, text: 'Sample', color: '#64748b' } },
      y: { grid: { color: 'rgba(255,255,255,0.03)' }, suggestedMin: 210, suggestedMax: 250 }
    }
  }
});

// Load Profile (doughnut)
const loadProfCtx = document.getElementById('loadProfileChart').getContext('2d');
const loadProfileChart = new Chart(loadProfCtx, {
  type: 'doughnut',
  data: {
    labels: ['Light Load (<500W)', 'Medium Load (500-1500W)', 'Heavy Load (>1500W)', 'Idle'],
    datasets: [{
      data: [35, 40, 15, 10],
      backgroundColor: [
        'rgba(56,189,248,0.7)',
        'rgba(167,139,250,0.7)',
        'rgba(251,146,60,0.7)',
        'rgba(100,116,139,0.5)',
      ],
      borderColor: 'transparent',
      borderWidth: 0,
      hoverOffset: 8,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '65%',
    plugins: {
      legend: {
        position: 'bottom',
        labels: { padding: 14, usePointStyle: true, pointStyleWidth: 10, font: { size: 11 } }
      },
    }
  }
});

// Energy Trend (7 days bar)
const energyTrendCtx = document.getElementById('energyTrendChart').getContext('2d');
const days = [];
const now = new Date();
for (let i = 6; i >= 0; i--) {
  const d = new Date(now);
  d.setDate(d.getDate() - i);
  days.push(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
}
const energyTrendChart = new Chart(energyTrendCtx, {
  type: 'bar',
  data: {
    labels: days,
    datasets: [{
      label: 'Energy (kWh)',
      data: [12.4, 14.2, 9.8, 15.6, 11.3, 13.7, 0],
      backgroundColor: createGradient(energyTrendCtx, 'rgba(52,211,153,0.6)', 'rgba(52,211,153,0.1)'),
      borderColor: '#34d399',
      borderWidth: 1,
      borderRadius: 8,
      barPercentage: 0.5,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false } },
      y: { grid: { color: 'rgba(255,255,255,0.03)' }, beginAtZero: true, title: { display: true, text: 'kWh', color: '#64748b' } },
    }
  }
});


// ===== GAUGE UPDATE FUNCTIONS =====
function setGauge(fillEl, value, max) {
  const circumference = 2 * Math.PI * 85; // ~534
  const ratio = Math.min(value / max, 1);
  const offset = circumference - (ratio * circumference);
  fillEl.style.strokeDasharray = circumference;
  fillEl.style.strokeDashoffset = offset;
}

function updateGauges(v, c, p) {
  // Update gauge fills
  setGauge(document.getElementById('voltageFill'), v, CONFIG.voltageMax);
  setGauge(document.getElementById('currentFill'), c, CONFIG.currentMax);
  setGauge(document.getElementById('powerFill'), p, CONFIG.powerMax);

  // Update values
  document.getElementById('voltageValue').textContent = v.toFixed(1);
  document.getElementById('currentValue').textContent = c.toFixed(2);
  document.getElementById('powerValue').textContent = p.toFixed(1);
}

// ===== SIMULATED DATA GENERATOR =====
// TODO: Replace this function with real ESP32 data via WebSocket/HTTP
function generateSimData() {
  const baseV = 228 + Math.sin(Date.now() / 10000) * 5;
  const v = baseV + (Math.random() - 0.5) * 4;

  const baseC = 3.5 + Math.sin(Date.now() / 15000) * 1.5;
  const c = Math.max(0.1, baseC + (Math.random() - 0.5) * 0.8);

  const p = v * c * (0.85 + Math.random() * 0.1);

  return { v: +v.toFixed(2), c: +c.toFixed(3), p: +p.toFixed(1) };
}

// ===== MAIN UPDATE LOOP =====
function updateDashboard() {
  const { v, c, p } = generateSimData();
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

  // Push data
  state.voltage.push(v);
  state.current.push(c);
  state.power.push(p);
  state.labels.push(timeStr);

  // Trim to max
  if (state.voltage.length > CONFIG.maxDataPoints) {
    state.voltage.shift();
    state.current.shift();
    state.power.shift();
    state.labels.shift();
  }

  // Update gauges
  updateGauges(v, c, p);

  // Energy accumulation (kWh) = P(W) * t(h)
  const energyIncrement = p / 1000 / 3600; // per second
  state.energy += energyIncrement;
  state.energyToday += energyIncrement;
  state.energyWeek += energyIncrement;
  state.energyMonth += energyIncrement;

  document.getElementById('energyValue').textContent = state.energy.toFixed(3);
  document.getElementById('energyCost').textContent = CONFIG.currency + (state.energy * CONFIG.costPerUnit).toFixed(2);
  document.getElementById('energyToday').textContent = state.energyToday.toFixed(3);
  document.getElementById('energyWeek').textContent = state.energyWeek.toFixed(3);
  document.getElementById('energyMonth').textContent = state.energyMonth.toFixed(3);

  // Energy audit section
  document.getElementById('auditToday').textContent = state.energyToday.toFixed(3) + ' kWh';
  document.getElementById('auditTodayCost').textContent = CONFIG.currency + (state.energyToday * CONFIG.costPerUnit).toFixed(2);
  document.getElementById('auditWeek').textContent = state.energyWeek.toFixed(3) + ' kWh';
  document.getElementById('auditWeekCost').textContent = CONFIG.currency + (state.energyWeek * CONFIG.costPerUnit).toFixed(2);
  document.getElementById('auditMonth').textContent = state.energyMonth.toFixed(3) + ' kWh';
  document.getElementById('auditMonthCost').textContent = CONFIG.currency + (state.energyMonth * CONFIG.costPerUnit).toFixed(2);
  document.getElementById('auditTotal').textContent = state.energy.toFixed(3) + ' kWh';
  document.getElementById('auditTotalCost').textContent = CONFIG.currency + (state.energy * CONFIG.costPerUnit).toFixed(2);

  // Min / Avg / Max
  const vArr = state.voltage;
  const cArr = state.current;
  const pArr = state.power;

  document.getElementById('voltageMin').textContent = Math.min(...vArr).toFixed(1);
  document.getElementById('voltageAvg').textContent = (vArr.reduce((a, b) => a + b, 0) / vArr.length).toFixed(1);
  document.getElementById('voltageMax').textContent = Math.max(...vArr).toFixed(1);

  document.getElementById('currentMin').textContent = Math.min(...cArr).toFixed(2);
  document.getElementById('currentAvg').textContent = (cArr.reduce((a, b) => a + b, 0) / cArr.length).toFixed(2);
  document.getElementById('currentMax').textContent = Math.max(...cArr).toFixed(2);

  document.getElementById('powerMin').textContent = Math.min(...pArr).toFixed(0);
  document.getElementById('powerAvg').textContent = (pArr.reduce((a, b) => a + b, 0) / pArr.length).toFixed(0);

  // Peak tracking
  if (v > state.peakVoltage.value) {
    state.peakVoltage = { value: v, time: timeStr };
  }
  if (c > state.peakCurrent.value) {
    state.peakCurrent = { value: c, time: timeStr };
  }
  if (p > state.peakPower.value) {
    state.peakPower = { value: p, time: timeStr };
  }

  document.getElementById('powerPeak').textContent = state.peakPower.value.toFixed(0);
  document.getElementById('peakVoltage').textContent = state.peakVoltage.value.toFixed(1) + ' V';
  document.getElementById('peakVoltageTime').textContent = state.peakVoltage.time;
  document.getElementById('peakCurrent').textContent = state.peakCurrent.value.toFixed(2) + ' A';
  document.getElementById('peakCurrentTime').textContent = state.peakCurrent.time;
  document.getElementById('peakPower').textContent = state.peakPower.value.toFixed(0) + ' W';
  document.getElementById('peakPowerTime').textContent = state.peakPower.time;

  // Power Factor
  const pf = (p / (v * c)).toFixed(3);
  document.getElementById('powerFactor').textContent = pf;

  // Load status
  const loadChip = document.getElementById('loadStatusChip');
  const loadText = document.getElementById('loadStatusText');
  if (p > CONFIG.powerMaxThreshold) {
    loadChip.className = 'status-chip danger';
    loadText.textContent = 'OVERLOAD!';
  } else if (p > CONFIG.powerMaxThreshold * 0.7) {
    loadChip.className = 'status-chip warning';
    loadText.textContent = 'High Load';
  } else {
    loadChip.className = 'status-chip normal';
    loadText.textContent = 'Normal Load';
  }

  // Update Charts
  voltageChart.data.labels = [...state.labels];
  voltageChart.data.datasets[0].data = [...state.voltage];
  voltageChart.update('none');

  currentChart.data.labels = [...state.labels];
  currentChart.data.datasets[0].data = [...state.current];
  currentChart.update('none');

  powerChart.data.labels = [...state.labels];
  powerChart.data.datasets[0].data = [...state.power];
  powerChart.update('none');

  // Log entry
  const statusLabel = p > CONFIG.powerMaxThreshold ? 'danger' : p > CONFIG.powerMaxThreshold * 0.7 ? 'warning' : 'normal';
  const statusText = { danger: 'Overload', warning: 'High', normal: 'Normal' }[statusLabel];
  state.logEntries.unshift({ time: timeStr, v, c, p, energy: state.energy.toFixed(4), status: statusLabel, statusText });
  if (state.logEntries.length > 20) state.logEntries.pop();
  updateLogTable();

  // Uptime
  const uptimeMs = Date.now() - state.uptimeStart;
  const uptimeH = Math.floor(uptimeMs / 3600000);
  const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);
  document.getElementById('uptimeValue').textContent = `${uptimeH}h ${uptimeM}m`;
}

// ===== LOG TABLE =====
function updateLogTable() {
  const tbody = document.getElementById('logTableBody');
  tbody.innerHTML = state.logEntries.map(e => `
    <tr>
      <td>${e.time}</td>
      <td>${e.v.toFixed(1)}</td>
      <td>${e.c.toFixed(3)}</td>
      <td>${e.p.toFixed(1)}</td>
      <td>${e.energy}</td>
      <td><span class="status-badge ${e.status}">${e.statusText}</span></td>
    </tr>
  `).join('');
}

// ===== HEADER CLOCK =====
function updateClock() {
  document.getElementById('headerTime').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ===== NAVIGATION =====
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const section = item.dataset.section;

    // Update active nav
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');

    // Switch section
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById('section-' + section).classList.add('active');

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
  });
});

// ===== MOBILE MENU =====
document.getElementById('menuToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ===== REPORT DOWNLOAD =====
function downloadReport(type) {
  const headers = ['Timestamp', 'Voltage (V)', 'Current (A)', 'Power (W)', 'Energy (kWh)', 'Status'];
  let csvContent = headers.join(',') + '\n';

  state.logEntries.forEach(e => {
    csvContent += `${e.time},${e.v},${e.c},${e.p},${e.energy},${e.statusText}\n`;
  });

  // Add summary
  csvContent += '\n--- SUMMARY ---\n';
  csvContent += `Peak Voltage,${state.peakVoltage.value} V,at ${state.peakVoltage.time}\n`;
  csvContent += `Peak Current,${state.peakCurrent.value} A,at ${state.peakCurrent.time}\n`;
  csvContent += `Peak Power,${state.peakPower.value} W,at ${state.peakPower.time}\n`;
  csvContent += `Total Energy,${state.energy.toFixed(4)} kWh\n`;
  csvContent += `Estimated Cost,${CONFIG.currency}${(state.energy * CONFIG.costPerUnit).toFixed(2)}\n`;

  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `power_report_${type}_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} report downloaded!`, 'success');
}

// ===== SAVE SETTINGS =====
function saveSettings() {
  CONFIG.costPerUnit = parseFloat(document.getElementById('costPerUnit').value) || 6.50;
  CONFIG.currency = document.getElementById('currency').value || '₹';
  CONFIG.voltageHighThreshold = parseFloat(document.getElementById('voltageHigh').value) || 250;
  CONFIG.voltageLowThreshold = parseFloat(document.getElementById('voltageLow').value) || 200;
  CONFIG.currentMaxThreshold = parseFloat(document.getElementById('currentMax').value) || 15;
  CONFIG.powerMaxThreshold = parseFloat(document.getElementById('powerMax').value) || 3000;

  showToast('Settings saved successfully!', 'success');
}

// ===== TOAST NOTIFICATION =====
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: '✅',
    warning: '⚠️',
    error: '❌',
  };

  toast.innerHTML = `<span>${icons[type] || '💬'}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ===== INITIALIZATION =====
function init() {
  updateClock();
  setInterval(updateClock, 1000);

  // Start real-time updates
  updateDashboard();
  setInterval(updateDashboard, CONFIG.sampleInterval);

  // Initial startup toast
  setTimeout(() => {
    showToast('Dashboard initialized — Simulated data active', 'success');
  }, 800);
}

// Start when DOM is loaded
document.addEventListener('DOMContentLoaded', init);
