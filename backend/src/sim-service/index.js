/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Headless runner for the sim service. Runs standalone (its own process/port),
// independent of backend/src/server.js. Owns: the durable log, the hub
// (SSE + MQTT fanout), and — when SOURCE=sim — the deterministic producer.
//
// See SIM-SERVICE.md for the full SOURCE=sim|real switch and env var reference.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { SimEventLog, rowToWireEnvelope } = require('./eventLog');
const { SimEventHub } = require('./hub');
const { SimProducer } = require('./producer');
const { EVENT_TYPES, SEVERITIES, createEnvelope, validateEnvelope } = require('./envelope');
const { requireApiKey } = require('./requireApiKey');

const SOURCE = process.env.SOURCE || 'sim'; // 'sim' | 'real'
const BENCHMARK = process.env.SIM_BENCHMARK === '1' || process.env.SIM_BENCHMARK === 'true';
const MODE = process.env.SIM_MODE || 'live'; // 'live' | 'replay'
const EXPERIENCE = process.env.SIM_EXPERIENCE || 'cafe';
const SEED = process.env.SIM_SEED || 'edgemart-default-seed';
const SPEED = parseFloat(process.env.SIM_SPEED || '60');
const PORT = parseInt(process.env.SIM_PORT || '3100');
const TABLE_COUNT = parseInt(process.env.CAFE_TABLE_COUNT || '15');
// Unset by default (open, matching prior behavior) — set to require X-Api-Key on writes.
const API_KEY = process.env.SIM_API_KEY || null;
// '*' is treated as a literal origin string to match (never matches a real
// browser Origin header), not a wildcard — CORS here is always an explicit,
// comma-separated allowlist. (Previously '*' was special-cased to `true`,
// reflecting any origin; removed per a CodeQL "permissive CORS" finding —
// this service is never consumed cross-origin by a non-browser/MCP client,
// which ignores CORS entirely, so the narrower behavior costs nothing there.)
const CORS_ORIGIN_RAW = process.env.SIM_CORS_ORIGIN || 'http://localhost:4200';
const CORS_ORIGIN = CORS_ORIGIN_RAW.split(',').map((s) => s.trim());
if (CORS_ORIGIN.includes('*')) {
  console.error('[sim-service] SIM_CORS_ORIGIN=* no longer allows any origin — list the specific origin(s) to allow instead.');
}

const EVENT_TYPE_DESCRIPTIONS = {
  [EVENT_TYPES.CUSTOMER_ARRIVED]: 'A customer entered the store/café.',
  [EVENT_TYPES.CUSTOMER_DEPARTED]: 'A customer left, dine-in or takeout.',
  [EVENT_TYPES.TABLE_OCCUPIED]: 'A table was seated by a dine-in customer.',
  [EVENT_TYPES.TABLE_DIRTY]: 'A table was vacated and needs clearing.',
  [EVENT_TYPES.TABLE_CLEARED]: 'A table was cleared and is available again.',
  [EVENT_TYPES.ORDER_PLACED]: 'An order was placed.',
  [EVENT_TYPES.ORDER_COMPLETED]: 'An order was prepared and handed off.',
  [EVENT_TYPES.QUEUE_DEPTH_CHANGED]: 'The number of customers waiting on an order changed.',
};

async function main() {
  const log = new SimEventLog();
  await log.init();

  const hub = new SimEventHub({ enabled: !BENCHMARK });
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

  app.get('/sim/health', async (req, res) => {
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

  // Live/replay push path for agents: subscribe once, get every event as it happens.
  // A reconnecting client's Last-Event-ID (an event_id) is resolved back to a log
  // row so events fired during the disconnect gap are replayed, not silently missed.
  app.get('/sim/events/stream', (req, res) => {
    const lastEventId = req.get('Last-Event-ID');
    hub.attachSSE(req, res, {
      getReplay: lastEventId ? async () => {
        const sinceId = await log.findLogId(lastEventId);
        if (sinceId == null) return [];
        return (await log.drainTail({ sinceId })).map(rowToWireEnvelope);
      } : undefined,
    });
  });

  // The SOURCE=real ingestion path. Same envelope contract as the sim producer,
  // so swapping SOURCE requires no agent-facing change (see SIM-SERVICE.md).
  app.post('/sim/ingest', writeLimiter, requireApiKey(API_KEY), async (req, res) => {
    if (SOURCE !== 'real') {
      return res.status(409).json({ error: `Ingestion only accepted when SOURCE=real (current SOURCE=${SOURCE})` });
    }
    try {
      const envelope = validateEnvelope(req.body);
      const saved = await log.append(envelope);
      if (saved) hub.publish(envelope);
      res.json({ accepted: !!saved, duplicate: !saved });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Runtime fanout control: pause/resume MQTT+SSE event fanout without a
  // restart. The POS backend's Sim toggle calls this to stop/start the stream.
  app.post('/sim/control', writeLimiter, requireApiKey(API_KEY), (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    hub.setEnabled(enabled);
    res.json({ enabled, fanout: enabled ? 'on' : 'off' });
  });

  // Plain-HTTP mirrors of the MCP read tools, for clients that can't spawn an
  // MCP stdio process (browsers, curl, monitoring tools).
  app.get('/sim/event-types', (req, res) => {
    res.json(Object.entries(EVENT_TYPE_DESCRIPTIONS).map(([event_type, description]) => ({ event_type, description })));
  });

  app.get('/sim/history', async (req, res) => {
    const { experience, event_type: eventType, group_by: groupBy, start_date: startDate, end_date: endDate } = req.query;
    res.json(await log.queryHistory({ experience: experience || EXPERIENCE, eventType, groupBy, startDate, endDate }));
  });

  app.get('/sim/compare', async (req, res) => {
    const { experience, event_type: eventType, date, baseline_date: baselineDate } = req.query;
    if (!date || !baselineDate) return res.status(400).json({ error: 'date and baseline_date are required' });
    res.json(await log.compareToBaseline({ experience: experience || EXPERIENCE, eventType, date, baselineDate }));
  });

  app.get('/sim/tail', async (req, res) => {
    res.json(await log.tail({ sinceId: Number(req.query.since_id) || 0, limit: Number(req.query.limit) || 100 }));
  });

  app.get('/sim/snapshot', async (req, res) => {
    res.json(await log.getCurrentSnapshot({ experience: req.query.experience || EXPERIENCE }));
  });

  // Plain-HTTP mirrors of the MCP action tools, same envelope/log/hub path.
  app.post('/sim/actions/mark-table-cleared', writeLimiter, requireApiKey(API_KEY), async (req, res) => {
    const tableRef = req.body?.table_ref;
    if (!tableRef) return res.status(400).json({ error: 'table_ref is required' });
    const envelope = createEnvelope({
      eventType: EVENT_TYPES.TABLE_CLEARED,
      severity: SEVERITIES.INFO,
      source: 'sim',
      experience: req.body?.experience || EXPERIENCE,
      ref: tableRef,
      simDate: new Date().toISOString().slice(0, 10),
      payload: { via: 'http-action' },
    });
    const saved = await log.append(envelope);
    if (saved) hub.publish(envelope);
    res.json({ success: true, event: envelope });
  });

  app.post('/sim/actions/inject-event', writeLimiter, requireApiKey(API_KEY), async (req, res) => {
    const eventType = req.body?.event_type;
    if (!Object.values(EVENT_TYPES).includes(eventType)) {
      return res.status(400).json({ error: `Unknown event_type: ${eventType}` });
    }
    const envelope = createEnvelope({
      eventType,
      severity: req.body?.severity || SEVERITIES.INFO,
      source: SOURCE === 'real' ? 'real' : 'sim',
      experience: req.body?.experience || EXPERIENCE,
      ref: req.body?.ref || null,
      simDate: new Date().toISOString().slice(0, 10),
      payload: req.body?.payload || {},
    });
    const saved = await log.append(envelope);
    if (saved) hub.publish(envelope);
    res.json({ success: true, event: envelope });
  });

  let producer = null;
  if (SOURCE === 'sim') {
    producer = new SimProducer({ log, hub, seed: SEED, experience: EXPERIENCE, tableCount: TABLE_COUNT });
    if (MODE === 'replay') {
      const simDate = process.env.SIM_REPLAY_DATE || new Date().toISOString().slice(0, 10);
      const count = await producer.runReplay({ simDate, speed: SPEED });
      console.log(`[sim-service] replaying ${count} recorded events for ${simDate} at ${SPEED}x`);
    } else {
      const simDate = new Date().toISOString().slice(0, 10);
      const count = await producer.runLive({ simDate, speed: SPEED });
      console.log(`[sim-service] running live schedule (${count} events) for ${simDate} at ${SPEED}x, seed=${SEED}`);
    }
  } else {
    console.log('[sim-service] SOURCE=real — internal producer disabled, waiting for POST /sim/ingest');
  }

  const server = app.listen(PORT, () => {
    console.log(`[sim-service] listening on ${PORT} (source=${SOURCE}, mode=${MODE}, benchmark=${BENCHMARK})`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[sim-service] Port ${PORT} is already in use — set SIM_PORT to a free port.`);
    } else {
      console.error('[sim-service] Server error:', err.message);
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
