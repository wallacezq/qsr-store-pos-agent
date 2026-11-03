/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const os = require('os');
const fs = require('fs');
const http = require('http');
const router = express.Router();

// --- CPU Utilization ---
let prevCpuTimes = null;

function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times)) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }

  if (!prevCpuTimes) {
    prevCpuTimes = { idle: totalIdle, total: totalTick };
    return { user: 0, system: 0, idle: 100, total: 0 };
  }

  const idleDiff = totalIdle - prevCpuTimes.idle;
  const totalDiff = totalTick - prevCpuTimes.total;
  prevCpuTimes = { idle: totalIdle, total: totalTick };

  if (totalDiff === 0) return { user: 0, system: 0, idle: 100, total: 0 };

  const idlePercent = (idleDiff / totalDiff) * 100;
  const usedPercent = 100 - idlePercent;

  // Approximate user vs system split
  let userTick = 0, sysTick = 0;
  for (const cpu of cpus) {
    userTick += cpu.times.user + cpu.times.nice;
    sysTick += cpu.times.sys + cpu.times.irq;
  }

  return {
    user: Math.round(usedPercent * 0.7 * 10) / 10,
    system: Math.round(usedPercent * 0.3 * 10) / 10,
    idle: Math.round(idlePercent * 10) / 10,
    total: Math.round(usedPercent * 10) / 10,
  };
}

// --- GPU Utilization (system-wide via external qmmd service) ---
const QMMD_URL = process.env.QMMD_URL || 'http://qmmd:9101';

function round(val) {
  return Math.round(val * 10) / 10;
}

let gpuData = { render: 0, compute: 0, video: 0, copy: 0, videoEnhance: 0, frequency: 0, power: 0, total: 0, available: false };
let gpuPollInterval = null;

// Maps qmmd engine labels (i915 full names + xe command-streamer abbreviations) to gpuData fields.
const ENGINE_FIELD = {
  render: 'render', rcs: 'render',
  compute: 'compute', ccs: 'compute',
  video: 'video', vcs: 'video',
  copy: 'copy', bcs: 'copy',
  'video-enhance': 'videoEnhance', vecs: 'videoEnhance',
};

function parsePrometheusLine(line) {
  // Format: metric_name{label="val",...} value
  const match = line.match(/^(\w+)\{([^}]*)\}\s+([\d.eE+-]+)$/);
  if (!match) return null;
  const [, metric, labelsStr, valueStr] = match;
  const labels = {};
  for (const pair of labelsStr.split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) labels[k] = v.replace(/"/g, '');
  }
  return { metric, labels, value: parseFloat(valueStr) };
}

function scrapeQmmd() {
  return new Promise((resolve) => {
    const req = http.get(`${QMMD_URL}/metrics`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function pollGpuMetrics() {
  const body = await scrapeQmmd();
  if (!body) {
    gpuData.available = false;
    return;
  }

  for (const line of body.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const parsed = parsePrometheusLine(line);
    if (!parsed) continue;

    if (parsed.metric === 'qmmd_gpu_engine_utilization_ratio') {
      // i915 uses full engine names; xe uses command-streamer abbreviations.
      const field = ENGINE_FIELD[parsed.labels.engine];
      if (field) {
        gpuData[field] = round(parsed.value * 100); // ratio → percent
        gpuData.available = true;
      }
    } else if (parsed.metric === 'qmmd_gpu_actual_frequency_hertz') {
      if (parsed.labels.freq_id === 'gt0') {
        gpuData.frequency = round(parsed.value / 1e6); // Hz → MHz
      }
    } else if (parsed.metric === 'qmmd_gpu_power_watts') {
      if (parsed.labels.domain === 'gpu') {
        gpuData.power = round(parsed.value);
      }
    }
  }

  if (gpuData.available) {
    gpuData.total = round(Math.min(100, gpuData.render + gpuData.compute));
  }
}

function startGpuMonitor() {
  // Scrape the external qmmd service every second
  console.log(`[gpu] Polling qmmd at ${QMMD_URL}/metrics`);
  pollGpuMetrics();
  gpuPollInterval = setInterval(pollGpuMetrics, 1000);
}

// --- NPU Utilization (Intel via sysfs) ---
let npuData = { utilization: 0, available: false };

function readNpuUtilization() {
  // Intel NPU exposes busy time via sysfs
  const paths = [
    '/sys/class/accel/accel0/device/npu_busy_time_us',
    '/sys/devices/pci0000:00/0000:00:0b.0/npu_busy_time_us',
  ];

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        npuData.available = true;
        // Would need delta calculation over time for percentage
        // For now, mark as available
        return;
      }
    } catch (e) {
      // continue
    }
  }
  npuData.available = false;
}

// NPU busy time tracking for delta-based utilization
let prevNpuBusy = null;
let prevNpuTime = null;

function getNpuUtilization() {
  if (!npuData.available) return npuData;

  const paths = [
    '/sys/class/accel/accel0/device/npu_busy_time_us',
    '/sys/devices/pci0000:00/0000:00:0b.0/npu_busy_time_us',
  ];

  for (const p of paths) {
    try {
      const busyUs = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
      const now = Date.now() * 1000; // microseconds

      if (prevNpuBusy !== null && prevNpuTime !== null) {
        const busyDelta = busyUs - prevNpuBusy;
        const timeDelta = now - prevNpuTime;
        if (timeDelta > 0) {
          npuData.utilization = Math.round((busyDelta / timeDelta) * 100 * 10) / 10;
        }
      }
      prevNpuBusy = busyUs;
      prevNpuTime = now;
      return npuData;
    } catch (e) {
      // continue
    }
  }
  return npuData;
}

// --- Memory ---
function getMemoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    usedPercent: Math.round((used / total) * 100 * 10) / 10,
    totalGB: Math.round((total / 1073741824) * 10) / 10,
    usedGB: Math.round((used / 1073741824) * 10) / 10,
  };
}

// Initialize monitors
startGpuMonitor();
readNpuUtilization();

/**
 * GET /api/metrics/stream
 * SSE endpoint streaming system metrics every 1s.
 */
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(':\n\n'); // SSE comment for keep-alive

  const intervalId = setInterval(() => {
    const payload = {
      timestamp: Date.now(),
      cpu: getCpuUsage(),
      gpu: gpuData,
      npu: getNpuUtilization(),
      memory: getMemoryUsage(),
      system: {
        platform: os.platform(),
        cpuModel: os.cpus()[0]?.model || 'Unknown',
        cpuCores: os.cpus().length,
        uptime: os.uptime(),
      },
    };

    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }, 1000);

  req.on('close', () => {
    clearInterval(intervalId);
  });
});

/**
 * GET /api/metrics/snapshot
 * Single-shot metrics snapshot (for testing / non-SSE clients).
 */
router.get('/snapshot', (req, res) => {
  res.json({
    timestamp: Date.now(),
    cpu: getCpuUsage(),
    gpu: gpuData,
    npu: getNpuUtilization(),
    memory: getMemoryUsage(),
    system: {
      platform: os.platform(),
      cpuModel: os.cpus()[0]?.model || 'Unknown',
      cpuCores: os.cpus().length,
      uptime: os.uptime(),
    },
  });
});

module.exports = router;
