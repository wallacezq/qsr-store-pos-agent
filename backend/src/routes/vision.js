/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const router = express.Router();
const modelStore = require('../vision-service/modelStore');
const pipeline = require('../vision-service/pipeline');
const exporter = require('../vision-service/exporter');

// GET /api/vision/models - models grouped by purpose
router.get('/models', (req, res) => {
  res.json(modelStore.grouped());
});

// POST /api/vision/models/export - pull + convert an open model to OpenVINO IR
router.post('/models/export', (req, res) => {
  try {
    res.status(202).json(exporter.startExport(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/vision/models/export/jobs - export job statuses
router.get('/models/export/jobs', (req, res) => {
  res.json(exporter.listJobs());
});

// POST /api/vision/models - register a model
router.post('/models', (req, res) => {
  try {
    res.status(201).json(modelStore.add(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/vision/models/:id/activate - make this the active model for its purpose
router.post('/models/:id/activate', (req, res) => {
  const model = modelStore.activate(req.params.id);
  if (!model) return res.status(404).json({ error: 'Model not found' });
  res.json(model);
});

// DELETE /api/vision/models/:id
router.delete('/models/:id', (req, res) => {
  const removed = modelStore.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Model not found' });
  res.json({ success: true });
});

// GET /api/vision/status - invocation mode + active models per purpose
router.get('/status', (req, res) => {
  const active = {
    detection: modelStore.getActive('detection'),
    classification: modelStore.getActive('classification'),
    clip: modelStore.getActive('clip'),
  };
  res.json({
    ...pipeline.config(),
    activeModels: {
      detection: active.detection?.name || null,
      classification: active.classification?.name || null,
      clip: active.clip?.name || null,
    },
  });
});

module.exports = router;
