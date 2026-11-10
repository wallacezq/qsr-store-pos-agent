/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Persistent store for vision cameras (RTSP/ONVIF). Backed by a JSON file so an
// arbitrary number of cameras survive restarts. Runtime fields (status/mode)
// live only in memory and are merged in by the pipeline manager.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Registry persists under DATA_DIR (a named volume in docker) so cameras survive
// container rebuilds; defaults to the backend root for local dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..');
const STORE_FILE = path.join(DATA_DIR, 'vision-cameras.json');

let cameras = load();

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.error('[CameraStore] Failed to load store, starting empty:', err.message);
  }
  return [];
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Persist only declarative fields; never the live runtime status.
    const safe = cameras.map(({ status, mode, lastEventAt, ...rest }) => rest);
    fs.writeFileSync(STORE_FILE, JSON.stringify(safe, null, 2), 'utf8');
  } catch (err) {
    console.error('[CameraStore] Failed to persist store:', err.message);
  }
}

const PROTOCOLS = ['rtsp', 'onvif'];
const DEVICES = ['CPU', 'GPU', 'NPU'];
const EXPERIENCES = ['cafe', 'grocery'];

function sanitize(input = {}) {
  const protocol = PROTOCOLS.includes(input.protocol) ? input.protocol : 'rtsp';
  const device = DEVICES.includes(input.device) ? input.device : 'CPU';
  const experience = EXPERIENCES.includes(input.experience) ? input.experience : 'cafe';
  return {
    name: String(input.name || 'Camera').slice(0, 80),
    url: String(input.url || '').slice(0, 500),
    protocol,
    zone: String(input.zone || 'Zone A').slice(0, 60),
    device,
    // Which experience's dashboard these events route to.
    experience,
    // Optional per-camera model overrides (ids from the model store); empty = use active.
    detectionModelId: String(input.detectionModelId || '').slice(0, 64),
    clipModelId: String(input.clipModelId || '').slice(0, 64),
    classificationModelId: String(input.classificationModelId || '').slice(0, 64),
    enabled: input.enabled !== false,
  };
}

function list() {
  return cameras.slice();
}

function get(id) {
  return cameras.find((c) => c.id === id) || null;
}

function add(input) {
  const data = sanitize(input);
  if (!data.url) throw new Error('url is required');
  const camera = { id: randomUUID(), ...data, createdAt: new Date().toISOString() };
  cameras.push(camera);
  persist();
  return camera;
}

function update(id, patch) {
  const camera = get(id);
  if (!camera) return null;
  const data = sanitize({ ...camera, ...patch });
  Object.assign(camera, data);
  persist();
  return camera;
}

function remove(id) {
  const idx = cameras.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  cameras.splice(idx, 1);
  persist();
  return true;
}

module.exports = { list, get, add, update, remove, PROTOCOLS, DEVICES, EXPERIENCES };
