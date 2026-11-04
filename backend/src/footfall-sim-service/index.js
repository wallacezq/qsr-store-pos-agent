/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Headless runner for the footfall/movement sim service. Standalone
// process/port. Reuses sim-service's hub (SSE + MQTT) and this service's own
// log/producer/envelope.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { FootfallEventLog, rowToWireEnvelope } = require('./eventLog');
const { SimEventHub } = require('../sim-service/hub');
const { FootfallSimProducer } = require('./producer');
const { EVENT_TYPES, validateEnvelope } = require('./envelope');
const { requireApiKey } = require('../sim-service/requireApiKey');

const SOURCE = process.env.SOURCE || 'sim'; // 'sim' | 'real'
const BENCHMARK = process.env.SIM_BENCHMARK === '1' || process.env.SIM_BENCHMARK === 'true';
const MODE = process.env.SIM_MODE || 'live'; // 'live' | 'replay'
const EXPERIENCE = process.env.SIM_EXPERIENCE || 'cafe';
const SEED = process.env.SIM_SEED || 'edgemart-default-seed';
const SPEED = parseFloat(process.env.SIM_SPEED || '60');
const PORT = parseInt(process.env.FOOTFALL_SIM_PORT || '3300');
// Unset by default (open, matching prior behavior) — set to require X-Api-Key on writes.
const API_KEY = process.env.FOOTFALL_SIM_API_KEY || null;
// '*' is treated as a literal origin string to match (never matches a real
// browser Origin header), not a wildcard — CORS here is always an explicit,
// comma-separated allowlist. (Previously '*' was special-cased to `true`,
// reflecting any origin; removed per a CodeQL "permissive CORS" finding —
// this service is never consumed cross-origin by a non-browser/MCP client,
// which ignores CORS entirely, so the narrower behavior costs nothing there.)
const CORS_ORIGIN_RAW = process.env.FOOTFALL_SIM_CORS_ORIGIN || 'http://localhost:4200';
const CORS_ORIGIN = CORS_ORIGIN_RAW.split(',').map((s) => s.trim());
if (CORS_ORIGIN.includes('*')) {
  console.error('[footfall-sim-service] FOOTFALL_SIM_CORS_ORIGIN=* no longer allows any origin — list the specific origin(s) to allow instead.');
}

const FOOTFALL_EVENT_TYPE_DESCRIPTIONS = {
  [EVENT_TYPES.FOOTFALL_COUNT]: 'Number of people observed in a zone during a 15-minute interval.',
  [EVENT_TYPES.ZONE_DENSITY_CHANGED]: "A zone's density level (low/medium/high) changed.",
};

async function main() {
  const log = new FootfallEventLog();
  await log.init();

  const hub = new SimEventHub({ enabled: !BENCHMARK, mqttTopicPrefix: 'footfall-sim' });
  hub.connectMqtt();

  const app = express();
  app.use(helmet());
  app.use(cors({
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'Last-Event-ID'],
  }));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 }));
  app.use(express.json({ limit: '1mb' }));
  const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

  app.get('/footfall-sim/health', async (req, res) => {
    let dbOk = true;
    try {
      await log.ping();
    } catch {
      dbOk = false;
    }
    const mqttOk = !hub.mqttClient || hub.mqttClient.connected === true;
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      source: SOURCE,
      mode: MODE,
      benchmark: BENCHMARK,
      experience: EXPERIENCE,
      db: dbOk ? 'ok' : 'error',
      mqtt: mqttOk ? 'ok' : 'disconnected',
    });
  });

  app.get('/footfall-sim/events/stream', (req, res) => {
    const lastEventId = req.get('Last-Event-ID');
    hub.attachSSE(req, res, {
      getReplay: lastEventId ? async () => {
        const sinceId = await log.findLogId(lastEventId);
        if (sinceId == null) return [];
        return (await log.drainTail({ sinceId })).map(rowToWireEnvelope);
      } : undefined,
    });
  });

  app.post('/footfall-sim/ingest', writeLimiter, requireApiKey(API_KEY), async (req, res) => {
    if (SOURCE !== 'real') {
      return res.status(409).json({ error: `Ingestion only accepted when SOURCE=real (current SOURCE=${SOURCE})` });
    }
    try {
      const envelope = validateEnvelope(req.body);
      if (!envelope.ref) {
        return res.status(400).json({ error: 'ref is required for this service (footfall_sim_events.ref is NOT NULL)' });
      }
      const saved = await log.append(envelope);
      if (saved) hub.publish(envelope);
      res.json({ accepted: !!saved, duplicate: !saved });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Runtime fanout control: pause/resume MQTT+SSE event fanout without a
  // restart. The POS backend's Sim toggle calls this to stop/start the stream.
  app.post('/footfall-sim/control', writeLimiter, requireApiKey(API_KEY), (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    hub.setEnabled(enabled);
    res.json({ enabled, fanout: enabled ? 'on' : 'off' });
  });

  // Plain-HTTP mirrors of the MCP read tools (no action tools — this service is read-only by design).
  app.get('/footfall-sim/event-types', (req, res) => {
    res.json(Object.entries(FOOTFALL_EVENT_TYPE_DESCRIPTIONS).map(([event_type, description]) => ({ event_type, description })));
  });

  app.get('/footfall-sim/total', async (req, res) => {
    const { experience, zone, start_date: startDate, end_date: endDate } = req.query;
    res.json(await log.getTotalFootfall({ experience: experience || EXPERIENCE, zone, startDate, endDate }));
  });

  app.get('/footfall-sim/busy-patterns', async (req, res) => {
    const { experience, zone, start_date: startDate, end_date: endDate } = req.query;
    res.json(await log.getBusyTimePatterns({ experience: experience || EXPERIENCE, zone, startDate, endDate }));
  });

  let producer = null;
  if (SOURCE === 'sim') {
    producer = new FootfallSimProducer({ log, hub, seed: SEED, experience: EXPERIENCE });
    if (MODE === 'replay') {
      const simDate = process.env.SIM_REPLAY_DATE || new Date().toISOString().slice(0, 10);
      const count = await producer.runReplay({ simDate, speed: SPEED });
      console.log(`[footfall-sim-service] replaying ${count} recorded events for ${simDate} at ${SPEED}x`);
    } else {
      const simDate = new Date().toISOString().slice(0, 10);
      const count = await producer.runLive({ simDate, speed: SPEED });
      console.log(`[footfall-sim-service] running live schedule (${count} events) for ${simDate} at ${SPEED}x, seed=${SEED}`);
    }
  } else {
    console.log('[footfall-sim-service] SOURCE=real — internal producer disabled, waiting for POST /footfall-sim/ingest');
  }

  const server = app.listen(PORT, () => {
    console.log(`[footfall-sim-service] listening on ${PORT} (source=${SOURCE}, mode=${MODE}, benchmark=${BENCHMARK})`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[footfall-sim-service] Port ${PORT} is already in use — set FOOTFALL_SIM_PORT to a free port.`);
    } else {
      console.error('[footfall-sim-service] Server error:', err.message);
    }
    process.exit(1);
  });

  const shutdown = async () => {
    if (producer) producer.stop();
    hub.close();
    await log.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
