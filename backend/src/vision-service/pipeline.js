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

const GST_BIN = process.env.VISION_GST_BIN || 'gst-launch-1.0'; // native mode only
const DOCKER_BIN = process.env.VISION_DOCKER_BIN || 'docker';
const DOCKER_IMAGE = process.env.VISION_DOCKER_IMAGE || 'intel/dlstreamer:2026.3.0-ubuntu24-rc1';
const DOCKER_NETWORK = process.env.VISION_DOCKER_NETWORK || '';
// How to run DL Streamer: 'docker' (sibling container, default) or 'native' (gst on PATH).
const INVOKE = (process.env.VISION_INVOKE || 'docker').toLowerCase();
const FORCE_SIM = process.env.VISION_SIMULATE === '1';
const DEVICE_DEFAULT = process.env.VISION_DEVICE || 'CPU';
// OpenVINO IR model paths. In docker mode these resolve INSIDE the container,
// where VISION_MODELS_DIR is bind-mounted to /models.
const DETECT_MODEL = process.env.VISION_DETECT_MODEL || '/models/yolov8n/yolov8n.xml';
const CLIP_MODEL = process.env.VISION_CLIP_MODEL || '/models/clip/clip-image-encoder.xml';
const ZEROSHOT_EMBEDDINGS = process.env.VISION_ZEROSHOT_EMBEDDINGS || '/models/clip/table-states.safetensors';
// ROI class gvaclassify runs on (gvadetect label for a table/surface).
const TABLE_OBJECT_CLASS = process.env.VISION_TABLE_CLASS || 'dining table';

// Host dir with the OpenVINO models (bind-mounted to /models). Required to run a
// real pipeline in docker mode; unset -> dev falls back to simulation.
const MODELS_HOST_DIR = process.env.VISION_MODELS_DIR || '';
// Optional host dir for annotated snapshots (bind-mounted to /snapshots).
const SNAPSHOT_HOST_DIR = process.env.VISION_SNAPSHOT_HOST_DIR || '';
// Path where the backend READS snapshots (same host dir mounted into the backend).
const SNAPSHOT_DIR = process.env.VISION_SNAPSHOT_DIR || path.join(__dirname, 'snapshots');
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

// Resolve the models to use: prefer the active entries from the model store,
// fall back to env defaults. Paths are as the DL Streamer runtime sees them.
function resolveModels(camera) {
  let modelStore = null;
  try { modelStore = require('./modelStore'); } catch { /* optional */ }
  const det = modelStore && modelStore.getActive('detection');
  const clip = modelStore && modelStore.getActive('clip');
  const cls = modelStore && modelStore.getActive('classification');
  return {
    detect: det?.modelPath || DETECT_MODEL,
    clip: clip?.modelPath || CLIP_MODEL,
    embeddings: clip?.embeddingsPath || ZEROSHOT_EMBEDDINGS,
    classify: cls?.modelPath || null,
    classifyLabels: cls?.labelsFile || null,
    device: camera.device || DEVICE_DEFAULT,
  };
}

// GStreamer pipeline tokens (one arg per token). Model/snapshot paths here are
// whatever the runtime sees: container paths in docker mode, host paths native.
function buildGstTokens(camera, snapshotTarget) {
  const m = resolveModels(camera);
  const tokens = [
    'rtspsrc', `location=${camera.url}`, 'latency=100', 'protocols=tcp', '!',
    'rtph264depay', '!', 'decodebin3', '!',
    'gvadetect', `model=${m.detect}`, `device=${m.device}`, 'threshold=0.3', 'inference-interval=3', '!',
    'gvatrack', 'tracking-type=short-term-imageless', '!',
    'gvaclassify', `model=${m.clip}`, `zeroshot-embeddings-file=${m.embeddings}`,
    `object-class=${TABLE_OBJECT_CLASS}`, `device=${m.device}`, '!',
  ];
  // Optional extra classification stage when an active classification model is set.
  if (m.classify) {
    tokens.push('gvaclassify', `model=${m.classify}`, `device=${m.device}`);
    if (m.classifyLabels) tokens.push(`labels-file=${m.classifyLabels}`);
    tokens.push('!');
  }
  tokens.push('gvawatermark', '!');
  const publish = [
    'gvametaconvert', 'format=json', '!',
    'gvametapublish', 'method=mqtt', `address=${mqttAddress()}`, `topic=${detectionTopic(camera.id)}`,
    `mqtt-client-id=vision-${camera.id}`, '!', 'fakesink',
  ];
  if (snapshotTarget) {
    tokens.push(
      'tee', 'name=t',
      't.', '!', 'queue', '!', ...publish,
      't.', '!', 'queue', 'max-size-buffers=1', 'leaky=downstream', '!',
      'jpegenc', '!', 'multifilesink', `location=${snapshotTarget}`, 'max-files=1',
    );
  } else {
    tokens.push(...publish);
  }
  return tokens;
}

// Wrap the pipeline in `docker run <dlstreamer-image> gst-launch-1.0 ...`. The
// gst tokens are passed positionally ("$@") so the user-supplied RTSP URL cannot
// be re-parsed or injected by the shell.
function buildDockerArgs(camera) {
  const device = camera.device || DEVICE_DEFAULT;
  const snapshotTarget = SNAPSHOT_HOST_DIR ? `/snapshots/${camera.id}.jpg` : null;
  const gstTokens = buildGstTokens(camera, snapshotTarget);
  const args = ['run', '--rm', '--name', `vision-${camera.id}`];
  // Let the pipeline reach an RTSP server running on the Docker host.
  args.push('--add-host', 'host.docker.internal:host-gateway');
  if (DOCKER_NETWORK) args.push('--network', DOCKER_NETWORK);
  if (device !== 'CPU') args.push('--device', '/dev/dri'); // GPU/NPU passthrough
  if (MODELS_HOST_DIR) args.push('-v', `${MODELS_HOST_DIR}:/models:ro`);
  if (SNAPSHOT_HOST_DIR) args.push('-v', `${SNAPSHOT_HOST_DIR}:/snapshots`);
  args.push(DOCKER_IMAGE, 'bash', '-c',
    'source /opt/intel/dlstreamer/setupvars.sh 2>/dev/null; exec gst-launch-1.0 -v "$@"',
    'gst', ...gstTokens);
  return args;
}

// Real pipelines need models. In docker mode gate on a host models dir so dev
// (no models) defaults to simulation; native mode trusts gst on PATH.
function canRunReal() {
  if (FORCE_SIM) return false;
  if (INVOKE === 'native') return true;
  if (!MODELS_HOST_DIR) return false;
  return modelsAvailable();
}

// When the models mount is visible to this process (vision_models at /models),
// require the active detection + clip models to actually exist so an empty
// volume stays in simulation; otherwise trust the configuration.
function modelsAvailable() {
  const probe = process.env.VISION_MODELS_MOUNT || '/models';
  if (!fs.existsSync(probe)) return true;
  const m = resolveModels({});
  return fs.existsSync(m.detect) && fs.existsSync(m.clip);
}

function startReal(camera) {
  ensureSnapshotDir();
  let bin, args;
  if (INVOKE === 'native') {
    bin = GST_BIN;
    args = ['-v', ...buildGstTokens(camera, snapshotPath(camera.id))];
  } else {
    bin = DOCKER_BIN;
    // Clear any stale container with the same name (best effort).
    try { spawn(DOCKER_BIN, ['rm', '-f', `vision-${camera.id}`], { stdio: 'ignore' }); } catch { /* ignore */ }
    args = buildDockerArgs(camera);
  }
  console.log(`[Vision] launching ${camera.id}: ${bin} ${args.join(' ')}`);
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Capture pipeline output so a failed/exited pipeline reports why.
  let tail = '';
  const capture = (buf) => { tail = (tail + buf.toString()).slice(-4000); };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);

  proc.on('error', (err) => {
    // Binary missing or failed to launch — degrade to simulation.
    console.warn(`[Vision] ${INVOKE} launch failed for ${camera.id} (${err.message}); using simulation.`);
    const entry = running.get(camera.id);
    if (entry) entry.proc = null;
    startSimulated(camera);
  });

  proc.on('exit', (code) => {
    console.log(`[Vision] pipeline for ${camera.id} exited (code=${code})`);
    if (code && tail.trim()) console.warn(`[Vision] ${camera.id} output tail:\n${tail.trim()}`);
    const entry = running.get(camera.id);
    if (entry && entry.proc === proc) {
      entry.status = 'stopped';
      entry.lastError = tail.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(-400) || `exited with code ${code}`;
    }
  });

  running.set(camera.id, { proc, mode: 'live', status: 'detecting', lastEventAt: null, lastError: null });
  console.log(`[Vision] started DL Streamer pipeline for ${camera.id} via ${INVOKE} (${camera.name})`);
}

// Emit a DL-Streamer-shaped detection message so the bridge handles sim and real
// output identically.
function emitSimDetection(camera) {
  const state = TABLE_STATES[Math.floor(Math.random() * TABLE_STATES.length)];
  const confidence = 0.55 + Math.random() * 0.4;
  // Pin simulated detections to track/table 0 so they don't pollute the real
  // (e.g. café 15-table) set with extra per-track tables.
  const trackId = 0;
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
  if (canRunReal()) {
    startReal(camera);
  } else {
    startSimulated(camera);
  }
  return status(camera.id);
}

function stop(cameraId) {
  const entry = running.get(cameraId);
  if (!entry) return false;
  if (entry.proc) { try { entry.proc.kill('SIGTERM'); } catch { /* ignore */ } }
  // Ensure the sibling DL Streamer container is torn down too.
  if (entry.mode === 'live' && INVOKE === 'docker') {
    try { spawn(DOCKER_BIN, ['rm', '-f', `vision-${cameraId}`], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  if (entry.timer) clearInterval(entry.timer);
  running.delete(cameraId);
  return true;
}

function status(cameraId) {
  const entry = running.get(cameraId);
  if (!entry) return { status: 'stopped', mode: null, lastEventAt: null, lastError: null };
  return { status: entry.status, mode: entry.mode, lastEventAt: entry.lastEventAt, lastError: entry.lastError || null };
}

function markEvent(cameraId) {
  const entry = running.get(cameraId);
  if (entry) entry.lastEventAt = new Date().toISOString();
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

// Whether newly started cameras run a real DL Streamer pipeline vs simulation.
function realEnabled() {
  return canRunReal();
}

function config() {
  return {
    invoke: INVOKE,
    image: DOCKER_IMAGE,
    network: DOCKER_NETWORK || null,
    device: DEVICE_DEFAULT,
    modelsDirConfigured: !!MODELS_HOST_DIR,
    simulate: FORCE_SIM,
    realEnabled: canRunReal(),
  };
}

module.exports = { start, stop, status, markEvent, stopAll, snapshotPath, detectionTopic, TABLE_STATES, realEnabled, config };
