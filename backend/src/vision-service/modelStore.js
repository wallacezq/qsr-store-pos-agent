/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Persistent registry of OpenVINO models used by the vision pipelines, grouped
// by purpose. One model per purpose can be "active"; the pipeline manager uses
// the active detection + clip models (and an optional classification stage).

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Registry persists under DATA_DIR (a named volume in docker); backend root in dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..');
const STORE_FILE = path.join(DATA_DIR, 'vision-models.json');
const PURPOSES = ['detection', 'classification', 'clip'];
const PRECISIONS = ['FP32', 'FP16', 'INT8'];

let models = load();

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('[ModelStore] Failed to load store, starting empty:', err.message);
  }
  return [];
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(models, null, 2), 'utf8');
  } catch (err) {
    console.error('[ModelStore] Failed to persist store:', err.message);
  }
}

function sanitize(input = {}) {
  const purpose = PURPOSES.includes(input.purpose) ? input.purpose : 'detection';
  const precision = PRECISIONS.includes(input.precision) ? input.precision : '';
  return {
    name: String(input.name || 'model').slice(0, 80),
    purpose,
    // Quantization/precision the IR was exported at (distinguishes same-source models).
    precision,
    // Paths are as seen by the DL Streamer runtime (container paths in docker mode).
    modelPath: String(input.modelPath || '').slice(0, 500),
    embeddingsPath: String(input.embeddingsPath || '').slice(0, 500), // clip zero-shot .safetensors
    labelsFile: String(input.labelsFile || '').slice(0, 500),         // optional classification labels
    device: String(input.device || '').slice(0, 10),
  };
}

function list() {
  return models.slice();
}

function grouped() {
  const out = { detection: [], classification: [], clip: [] };
  for (const m of models) (out[m.purpose] || (out[m.purpose] = [])).push(m);
  return out;
}

function getActive(purpose) {
  return models.find((m) => m.purpose === purpose && m.active) || null;
}

function getById(id) {
  return models.find((m) => m.id === id) || null;
}

function add(input) {
  const data = sanitize(input);
  if (!data.modelPath) throw new Error('modelPath is required');
  // First model of a purpose becomes active automatically.
  const active = !models.some((m) => m.purpose === data.purpose && m.active);
  const model = { id: randomUUID(), ...data, active, createdAt: new Date().toISOString() };
  models.push(model);
  persist();
  return model;
}

function activate(id) {
  const target = models.find((m) => m.id === id);
  if (!target) return null;
  for (const m of models) if (m.purpose === target.purpose) m.active = m.id === id;
  persist();
  return target;
}

function remove(id) {
  const idx = models.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  const [removed] = models.splice(idx, 1);
  // Promote another model of the same purpose if the active one was removed.
  if (removed.active) {
    const next = models.find((m) => m.purpose === removed.purpose);
    if (next) next.active = true;
  }
  persist();
  return true;
}

module.exports = { list, grouped, getActive, getById, add, activate, remove, PURPOSES };
