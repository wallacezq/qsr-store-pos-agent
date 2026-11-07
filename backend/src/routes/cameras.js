/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const fs = require('fs');
const router = express.Router();
const store = require('../vision-service/cameraStore');
const pipeline = require('../vision-service/pipeline');
const { getVisionBridge } = require('../vision-service/visionBridge');

const bridge = getVisionBridge();
bridge.setCameraLookup((id) => store.get(id));
bridge.connect();

// Auto-start any enabled cameras once at module load.
let bootstrapped = false;
function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  for (const cam of store.list()) {
    if (cam.enabled) {
      try { pipeline.start(cam); } catch (err) { console.error('[Cameras] auto-start failed:', err.message); }
    }
  }
}
bootstrap();

function withStatus(cam) {
  const st = pipeline.status(cam.id);
  return { ...cam, ...st, health: health(st) };
}

// Derive a coarse health signal so the UI can flag "launched but not detecting".
function health(st) {
  if (st.status === 'stopped') return 'stopped';
  if (st.mode === 'simulated') return 'simulated';
  if (st.lastEventAt && Date.now() - new Date(st.lastEventAt).getTime() < 30000) return 'detecting';
  return 'starting';
}

// GET /api/cameras - list cameras with live status
router.get('/', (req, res) => {
  res.json(store.list().map(withStatus));
});

// POST /api/cameras - add a camera (optionally auto-start)
router.post('/', (req, res) => {
  try {
    const camera = store.add(req.body);
    if (camera.enabled) pipeline.start(camera);
    res.status(201).json(withStatus(camera));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/cameras/:id - update camera config
router.put('/:id', (req, res) => {
  const camera = store.update(req.params.id, req.body);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  // Restart to apply new URL/device if it was running.
  if (pipeline.status(camera.id).status !== 'stopped') {
    pipeline.stop(camera.id);
    if (camera.enabled) pipeline.start(camera);
  }
  res.json(withStatus(camera));
});

// DELETE /api/cameras/:id
router.delete('/:id', (req, res) => {
  pipeline.stop(req.params.id);
  const removed = store.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Camera not found' });
  res.json({ success: true });
});

// POST /api/cameras/:id/start
router.post('/:id/start', (req, res) => {
  const camera = store.get(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  store.update(camera.id, { enabled: true });
  const s = pipeline.start(camera);
  res.json({ id: camera.id, ...s });
});

// POST /api/cameras/:id/stop
router.post('/:id/stop', (req, res) => {
  const camera = store.get(req.params.id);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  store.update(camera.id, { enabled: false });
  pipeline.stop(camera.id);
  res.json({ id: camera.id, status: 'stopped' });
});

// GET /api/cameras/:id/snapshot - latest annotated frame (real pipeline only)
router.get('/:id/snapshot', (req, res) => {
  const file = pipeline.snapshotPath(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No snapshot available' });
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

// GET /api/cameras/events/recent - backfill for the event stream
router.get('/events/recent', (req, res) => {
  res.json({ connected: true, events: bridge.getRecent(Number(req.query.limit) || 50) });
});

// GET /api/cameras/events/stream - SSE of normalized vision events
router.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': connected\n\n');

  const onEvent = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  bridge.on('event', onEvent);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bridge.off('event', onEvent);
  });
});

// POST /api/cameras/discover - ONVIF discovery stub (returns empty list unless
// an ONVIF discovery backend is configured).
router.post('/discover', (req, res) => {
  res.json({ devices: [], note: 'ONVIF auto-discovery not configured; add cameras manually by URL.' });
});

module.exports = router;
