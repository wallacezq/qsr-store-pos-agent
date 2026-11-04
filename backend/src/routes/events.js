/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const router = express.Router();

// Mirror only what the Agent tab's table-status service observes: the café
// simulator / vision events on the cafe/* topics (cafe/vision|pos|staff/events).
const TOPIC_FILTERS = ['cafe/#'];
const RING_SIZE = 100;

let client = null;
let connected = false;
const recent = []; // ring buffer of normalized events (newest last)
const sseClients = new Set();

function normalize(topic, payload) {
  // Sim-service envelope shape (issue #100/#101 contract).
  if (payload && payload.event_type) {
    return {
      topic,
      eventType: payload.event_type,
      severity: payload.severity || 'info',
      experience: payload.experience || null,
      source: payload.source || 'sim',
      ref: payload.ref || null,
      occurredAt: payload.occurred_at || new Date().toISOString(),
      payload: payload.payload || {},
    };
  }
  // Table-status vision bridge shape: { tableId, event, source, metadata }.
  if (payload && payload.tableId && payload.event) {
    return {
      topic,
      eventType: `table.${payload.event}`,
      severity: payload.event === 'dirty' ? 'warning' : 'info',
      experience: 'cafe',
      source: payload.source || 'vision',
      ref: payload.tableId,
      occurredAt: payload.timestamp || new Date().toISOString(),
      payload: payload.metadata || {},
    };
  }
  // Fallback: surface the raw message so nothing is silently dropped.
  return {
    topic,
    eventType: (topic || '').split('/').pop() || 'event',
    severity: 'info',
    experience: null,
    source: 'mqtt',
    ref: null,
    occurredAt: new Date().toISOString(),
    payload: payload && typeof payload === 'object' ? payload : { value: payload },
  };
}

function broadcast(event) {
  recent.push(event);
  if (recent.length > RING_SIZE) recent.shift();
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    if (res.writableEnded) continue;
    if (res.experienceFilter && event.experience && event.experience !== res.experienceFilter) continue;
    res.write(frame);
  }
}

function ensureMqtt() {
  if (client) return;
  let mqtt;
  try {
    mqtt = require('mqtt');
  } catch {
    console.warn('[Events] mqtt package not installed. Workflow event stream disabled.');
    return;
  }

  const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
  client = mqtt.connect(brokerUrl, {
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clientId: `pos-events-feed-${process.pid}-${Date.now()}`,
  });

  client.on('connect', () => {
    connected = true;
    console.log(`[Events] Connected to MQTT broker at ${brokerUrl}`);
    TOPIC_FILTERS.forEach((filter) => {
      client.subscribe(filter, (err) => {
        if (err) console.error(`[Events] Subscribe error for ${filter}:`, err.message);
        else console.log(`[Events] Subscribed to ${filter}`);
      });
    });
  });

  client.on('message', (topic, message) => {
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      payload = message.toString();
    }
    broadcast(normalize(topic, payload));
  });

  client.on('error', (err) => console.error('[Events] MQTT error:', err.message));
  client.on('offline', () => { connected = false; });
}

/**
 * GET /api/events/recent
 * Returns the most recent workflow events (newest first) for initial backfill.
 * Optional ?experience= filters to a single experience (plus experience-less events).
 */
router.get('/recent', (req, res) => {
  ensureMqtt();
  const exp = req.query.experience;
  let items = [...recent].reverse();
  if (exp) items = items.filter((e) => !e.experience || e.experience === exp);
  res.json({ connected, events: items });
});

/**
 * GET /api/events/stream
 * Server-Sent Events stream of live MQTT workflow events.
 * Optional ?experience= filters the live stream.
 */
router.get('/stream', (req, res) => {
  ensureMqtt();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': connected\n\n');

  // Per-client experience filter stored on the response so broadcast() can honor it.
  res.experienceFilter = req.query.experience || null;
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

module.exports = router;
