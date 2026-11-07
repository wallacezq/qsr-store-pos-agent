/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-camera DL Streamer pipeline manager.
//
// Real mode: spawns `gst-launch-1.0` running
//   rtspsrc -> decode -> gvadetect -> gvatrack -> gvaclassify (zero-shot CLIP)
//   -> gvawatermark -> tee -> [gvametaconvert ! gvametapublish mqtt] + [jpeg snapshot]
// so detections (empty/occupied/dirty table) are published to the MQTT bus and a
// live annotated snapshot is written for the UI.
//
// Simulated mode (no DL Streamer binary / missing models / VISION_SIMULATE=1):
// periodically publishes DL-Streamer-shaped detection JSON to the same MQTT topic,
// so the whole downstream flow (bridge -> table-status -> dashboard) works in dev.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const mqttPublisher = require('../services/mqtt-publisher');

const GST_BIN = process.env.VISION_GST_BIN || 'gst-launch-1.0';
const FORCE_SIM = process.env.VISION_SIMULATE === '1';
const DEVICE_DEFAULT = process.env.VISION_DEVICE || 'CPU';
// OpenVINO IR model paths (see wallacezq/dlstreamer-example download_models.sh).
const DETECT_MODEL = process.env.VISION_DETECT_MODEL || './models/yolov8n/yolov8n.xml';
const CLIP_MODEL = process.env.VISION_CLIP_MODEL || './models/clip/clip-image-encoder.xml';
const ZEROSHOT_EMBEDDINGS = process.env.VISION_ZEROSHOT_EMBEDDINGS || './models/clip/table-states.safetensors';
// ROI class gvaclassify runs on (gvadetect label for a table/surface).
const TABLE_OBJECT_CLASS = process.env.VISION_TABLE_CLASS || 'dining table';

const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const TABLE_STATES = ['empty table', 'occupied table', 'dirty table'];

const running = new Map(); // cameraId -> { proc?, timer?, mode, status, lastEventAt }

function ensureSnapshotDir() {
  try { fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch { /* ignore */ }
}

function snapshotPath(cameraId) {
  return path.join(SNAPSHOT_DIR, `${cameraId}.jpg`);
}

function detectionTopic(cameraId) {
  return `vision/detections/${cameraId}`;
}

function mqttAddress() {
  // gvametapublish wants host:port; derive from the broker URL.
  const url = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
  const m = url.match(/^mqtt:\/\/([^:/]+)(?::(\d+))?/i);
  return m ? `${m[1]}:${m[2] || '1883'}` : 'localhost:1883';
}

// Build the gst-launch argument vector. Kept as an args array (no shell) so the
// user-supplied RTSP URL cannot inject shell tokens.
function buildGstArgs(camera) {
  const device = camera.device || DEVICE_DEFAULT;
  return [
    '-v',
    'rtspsrc', `location=${camera.url}`, 'latency=100', 'protocols=tcp', '!',
    'rtph264depay', '!', 'decodebin3', '!',
    'gvadetect', `model=${DETECT_MODEL}`, `device=${device}`, 'threshold=0.3', 'inference-interval=3', '!',
    'gvatrack', 'tracking-type=short-term-imageless', '!',
    'gvaclassify', `model=${CLIP_MODEL}`, `zeroshot-embeddings-file=${ZEROSHOT_EMBEDDINGS}`,
    `object-class=${TABLE_OBJECT_CLASS}`, `device=${device}`, '!',
    'gvawatermark', '!',
    'tee', 'name=t',
    't.', '!', 'queue', '!', 'gvametaconvert', 'format=json', '!',
    'gvametapublish', 'method=mqtt', `address=${mqttAddress()}`, `topic=${detectionTopic(camera.id)}`,
    `mqtt-client-id=vision-${camera.id}`, '!', 'fakesink',
    't.', '!', 'queue', 'max-size-buffers=1', 'leaky=downstream', '!',
    'jpegenc', '!', 'multifilesink', `location=${snapshotPath(camera.id)}`, 'max-files=1',
  ];
}

function modelsPresent() {
  // Treat relative sample paths as "not present" so dev defaults to simulation.
  return [DETECT_MODEL, CLIP_MODEL, ZEROSHOT_EMBEDDINGS].every(
    (p) => path.isAbsolute(p) && fs.existsSync(p)
  );
}

function startReal(camera) {
  ensureSnapshotDir();
  const args = buildGstArgs(camera);
  const proc = spawn(GST_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.on('error', (err) => {
    // Binary missing or failed to launch — degrade to simulation.
    console.warn(`[Vision] gst-launch failed for ${camera.id} (${err.message}); using simulation.`);
    const entry = running.get(camera.id);
    if (entry) entry.proc = null;
    startSimulated(camera);
  });

  proc.on('exit', (code) => {
    console.log(`[Vision] pipeline for ${camera.id} exited (code=${code})`);
    const entry = running.get(camera.id);
    if (entry && entry.proc === proc) entry.status = 'stopped';
  });

  running.set(camera.id, { proc, mode: 'live', status: 'detecting', lastEventAt: null });
  console.log(`[Vision] started DL Streamer pipeline for ${camera.id} (${camera.name})`);
}

// Emit a DL-Streamer-shaped detection message so the bridge handles sim and real
// output identically.
function emitSimDetection(camera) {
  const state = TABLE_STATES[Math.floor(Math.random() * TABLE_STATES.length)];
  const confidence = 0.55 + Math.random() * 0.4;
  const trackId = 1 + Math.floor(Math.random() * 6);
  const message = {
    timestamp: Date.now(),
    source: camera.url,
    resolution: { width: 1280, height: 720 },
    objects: [
      {
        id: trackId,
        detection: {
          label: 'dining table',
          confidence: 0.8 + Math.random() * 0.2,
          bounding_box: { x_min: 0.1, y_min: 0.1, x_max: 0.5, y_max: 0.6 },
        },
        // gvaclassify zero-shot attaches the winning label + confidence.
        label: state,
        confidence,
        zs_mode: true,
      },
    ],
  };
  mqttPublisher.publish(detectionTopic(camera.id), message);
  const entry = running.get(camera.id);
  if (entry) entry.lastEventAt = new Date().toISOString();
}

function startSimulated(camera) {
  const intervalMs = parseInt(process.env.VISION_SIM_INTERVAL_MS || '6000', 10);
  const timer = setInterval(() => emitSimDetection(camera), intervalMs);
  running.set(camera.id, { timer, mode: 'simulated', status: 'detecting', lastEventAt: null });
  console.log(`[Vision] started SIMULATED pipeline for ${camera.id} (${camera.name})`);
}

function start(camera) {
  if (running.has(camera.id)) stop(camera.id);
  if (FORCE_SIM || !modelsPresent()) {
    startSimulated(camera);
  } else {
    startReal(camera);
  }
  return status(camera.id);
}

function stop(cameraId) {
  const entry = running.get(cameraId);
  if (!entry) return false;
  if (entry.proc) { try { entry.proc.kill('SIGTERM'); } catch { /* ignore */ } }
  if (entry.timer) clearInterval(entry.timer);
  running.delete(cameraId);
  return true;
}

function status(cameraId) {
  const entry = running.get(cameraId);
  if (!entry) return { status: 'stopped', mode: null, lastEventAt: null };
  return { status: entry.status, mode: entry.mode, lastEventAt: entry.lastEventAt };
}

function markEvent(cameraId) {
  const entry = running.get(cameraId);
  if (entry) entry.lastEventAt = new Date().toISOString();
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

module.exports = { start, stop, status, markEvent, stopAll, snapshotPath, detectionTopic, TABLE_STATES };
