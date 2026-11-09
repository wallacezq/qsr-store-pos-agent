/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Consumes DL Streamer detection metadata from MQTT (vision/detections/#),
// normalizes each table classification into a Live-Monitor event, keeps a short
// history, and republishes the table state onto cafe/vision/events so the
// existing TableStatusService / dashboard / agent reflect camera detections.

const EventEmitter = require('events');
const mqttPublisher = require('../services/mqtt-publisher');
const pipeline = require('./pipeline');

const RING_SIZE = 200;

// Zero-shot label -> internal table state -> table-status event.
const STATE_MAP = {
  'empty table': { state: 'empty', eventType: 'Empty Table', tableEvent: 'cleared' },
  'occupied table': { state: 'occupied', eventType: 'Occupied Table', tableEvent: 'occupied' },
  'dirty table': { state: 'dirty', eventType: 'Dirty Table', tableEvent: 'dirty' },
};

class VisionBridge extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.connected = false;
    this.recent = [];
    this._seq = 0;
    this._cameraLookup = () => null;
  }

  // The route injects a camera lookup so events carry name/zone.
  setCameraLookup(fn) { this._cameraLookup = fn; }

  connect() {
    if (this.client) return;
    let mqtt;
    try {
      mqtt = require('mqtt');
    } catch {
      console.warn('[VisionBridge] mqtt package not installed; detections will not be bridged.');
      return;
    }
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    this.client = mqtt.connect(brokerUrl, {
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      clientId: `vision-bridge-${process.pid}-${Date.now()}`,
    });
    this.client.on('connect', () => {
      this.connected = true;
      this.client.subscribe('vision/detections/#', (err) => {
        if (err) console.error('[VisionBridge] subscribe error:', err.message);
        else console.log('[VisionBridge] subscribed to vision/detections/#');
      });
    });
    this.client.on('message', (topic, buf) => this._onMessage(topic, buf));
    this.client.on('error', (err) => console.error('[VisionBridge] MQTT error:', err.message));
    this.client.on('offline', () => { this.connected = false; });
  }

  _onMessage(topic, buf) {
    const cameraId = topic.split('/').pop();
    let payload;
    try {
      payload = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const objects = Array.isArray(payload?.objects) ? payload.objects : [];
    for (const obj of objects) {
      const label = this._extractLabel(obj);
      const mapped = label && STATE_MAP[label.toLowerCase()];
      if (!mapped) continue;
      this._handleTableState(cameraId, obj, label, mapped, payload);
    }
  }

  // DL Streamer may place the zero-shot result on the object, on a nested
  // classification layer, or in a tensors array — tolerate all shapes.
  _extractLabel(obj) {
    if (typeof obj.label === 'string') return obj.label;
    if (obj.classification?.label) return obj.classification.label;
    if (Array.isArray(obj.tensors)) {
      const t = obj.tensors.find((x) => typeof x.label === 'string');
      if (t) return t.label;
    }
    return null;
  }

  _confidence(obj) {
    const c = obj.confidence ?? obj.classification?.confidence;
    return typeof c === 'number' ? c : 0.6;
  }

  _handleTableState(cameraId, obj, label, mapped, payload) {
    const camera = this._cameraLookup(cameraId) || {};
    const zone = camera.zone || 'Zone A';
    const trackId = obj.id ?? obj.track_id ?? 0;
    const tableId = `table-${zone}-${trackId}`.replace(/\s+/g, '').toLowerCase();
    const confidence = this._confidence(obj);
    const occurredAt = payload?.timestamp ? new Date(payload.timestamp).toISOString() : new Date().toISOString();
    const experience = camera.experience || 'cafe';

    const event = {
      eventId: `EV-${String(10000 + (this._seq++)).slice(-5)}`,
      cameraId,
      cameraName: camera.name || cameraId,
      zone,
      experience,
      tableId,
      trackId,
      eventType: mapped.eventType,
      state: mapped.state,
      confidence,
      status: this._verificationStatus(confidence),
      bbox: obj.detection?.bounding_box || null,
      occurredAt,
    };

    this._push(event);
    this.emit('event', event);
    pipeline.markEvent(cameraId);

    // Route to the chosen experience's vision topic; cafe also feeds the
    // table-status service (which subscribes to cafe/vision/events).
    mqttPublisher.publish(`${experience}/vision/events`, {
      tableId,
      event: mapped.tableEvent,
      source: `camera:${camera.name || cameraId}`,
      timestamp: occurredAt,
      experience,
      metadata: { zone, confidence, cameraId },
    });
  }

  _verificationStatus(confidence) {
    if (confidence >= 0.75) return 'VERIFIED';
    if (confidence >= 0.55) return 'PENDING REVIEW';
    return 'REJECTED';
  }

  _push(event) {
    this.recent.push(event);
    if (this.recent.length > RING_SIZE) this.recent.shift();
  }

  getRecent(limit = 50) {
    return this.recent.slice(-limit).reverse();
  }
}

let instance = null;
function getVisionBridge() {
  if (!instance) instance = new VisionBridge();
  return instance;
}

module.exports = { getVisionBridge };
