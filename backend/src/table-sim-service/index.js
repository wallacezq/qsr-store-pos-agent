/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Headless runner for the table occupancy & cleaning sim service. Standalone
// process/port, independent of backend/src/server.js and of sim-service's
// index.js. Reuses sim-service's hub (SSE + MQTT) and envelope validation
// directly; owns its own log and producer.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { TableEventLog, rowToWireEnvelope } = require('./eventLog');
const { SimEventHub } = require('../sim-service/hub');
const { TableSimProducer } = require('./producer');
const { EVENT_TYPES, SEVERITIES, createEnvelope, validateEnvelope } = require('../sim-service/envelope');
const { requireApiKey } = require('../sim-service/requireApiKey');

const SOURCE = process.env.SOURCE || 'sim'; // 'sim' | 'real'
const BENCHMARK = process.env.SIM_BENCHMARK === '1' || process.env.SIM_BENCHMARK === 'true';
const MODE = process.env.SIM_MODE || 'live'; // 'live' | 'replay'
const EXPERIENCE = process.env.SIM_EXPERIENCE || 'cafe';
const SEED = process.env.SIM_SEED || 'edgemart-default-seed';
const SPEED = parseFloat(process.env.SIM_SPEED || '60');
const PORT = parseInt(process.env.TABLE_SIM_PORT || '3200');
const TABLE_COUNT = parseInt(process.env.CAFE_TABLE_COUNT || '15');
// Unset by default (open, matching prior behavior) — set to require X-Api-Key on writes.
const API_KEY = process.env.TABLE_SIM_API_KEY || null;
// '*' is treated as a literal origin string to match (never matches a real
// browser Origin header), not a wildcard — CORS here is always an explicit,
// comma-separated allowlist. (Previously '*' was special-cased to `true`,
// reflecting any origin; removed per a CodeQL "permissive CORS" finding —
// this service is never consumed cross-origin by a non-browser/MCP client,
// which ignores CORS entirely, so the narrower behavior costs nothing there.)
const CORS_ORIGIN_RAW = process.env.TABLE_SIM_CORS_ORIGIN || 'http://localhost:4200';
const CORS_ORIGIN = CORS_ORIGIN_RAW.split(',').map((s) => s.trim());
if (CORS_ORIGIN.includes('*')) {
  console.error('[table-sim-service] TABLE_SIM_CORS_ORIGIN=* no longer allows any origin — list the specific origin(s) to allow instead.');
}

const TABLE_EVENT_TYPE_DESCRIPTIONS = {
  [EVENT_TYPES.TABLE_OCCUPIED]: 'A table was seated by a dine-in customer.',
  [EVENT_TYPES.TABLE_DIRTY]: 'A table was vacated and needs clearing.',
  [EVENT_TYPES.TABLE_CLEARED]: 'A table was cleared and is available again.',
};

async function main() {
  const log = new TableEventLog();
  await log.init();

  const hub = new SimEventHub({ enabled: !BENCHMARK, mqttTopicPrefix: 'table-sim' });
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

  app.get('/table-sim/health', async (req, res) => {
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

  app.get('/table-sim/events/stream', (req, res) => {
    const lastEventId = req.get('Last-Event-ID');
    hub.attachSSE(req, res, {
      getReplay: lastEventId ? async () => {
        const sinceId = await log.findLogId(lastEventId);
        if (sinceId == null) return [];
        return (await log.drainTail({ sinceId })).map(rowToWireEnvelope);
      } : undefined,
    });
  });

  // SOURCE=real ingestion path — same envelope contract as the producer, so
  // swapping SOURCE requires no agent-facing change.
  app.post('/table-sim/ingest', writeLimiter, requireApiKey(API_KEY), async (req, res) => {
    if (SOURCE !== 'real') {
      return res.status(409).json({ error: `Ingestion only accepted when SOURCE=real (current SOURCE=${SOURCE})` });
    }
    try {
      const envelope = validateEnvelope(req.body);
      if (!envelope.ref) {
        return res.status(400).json({ error: 'ref is required for this service (table_sim_events.ref is NOT NULL)' });
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
  app.post('/table-sim/control', writeLimiter, requireApiKey(API_KEY), (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    hub.setEnabled(enabled);
    res.json({ enabled, fanout: enabled ? 'on' : 'off' });
  });

  // Plain-HTTP mirrors of the MCP read tools, for clients that can't spawn an
  // MCP stdio process (browsers, curl, monitoring tools).
  app.get('/table-sim/event-types', (req, res) => {
    res.json(Object.entries(TABLE_EVENT_TYPE_DESCRIPTIONS).map(([event_type, description]) => ({ event_type, description })));
  });

  app.get('/table-sim/utilization', async (req, res) => {
    const { experience, table_ref: tableRef, start_date: startDate, end_date: endDate } = req.query;
    res.json(await log.getUtilization({ experience: experience || EXPERIENCE, tableRef, startDate, endDate }));
  });

  app.get('/table-sim/dirty-duration', async (req, res) => {
    const { experience, table_ref: tableRef, start_date: startDate, end_date: endDate } = req.query;
    res.json(await log.getDirtyDurationStats({ experience: experience || EXPERIENCE, tableRef, startDate, endDate }));
  });

  app.get('/table-sim/history', async (req, res) => {
    const { experience, table_ref: tableRef, limit } = req.query;
    if (!tableRef) return res.status(400).json({ error: 'table_ref is required' });
    res.json(await log.getTableHistory({ experience: experience || EXPERIENCE, tableRef, limit: Number(limit) || 100 }));
  });

  // Plain-HTTP mirrors of the MCP action tools, same envelope/log/hub path.
  async function markTable(req, res, eventType) {
    const tableRef = req.body?.table_ref;
    if (!tableRef) return res.status(400).json({ error: 'table_ref is required' });
    const envelope = createEnvelope({
      eventType,
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
  }

  app.post('/table-sim/actions/mark-table-cleared', writeLimiter, requireApiKey(API_KEY), (req, res) =>
    markTable(req, res, EVENT_TYPES.TABLE_CLEARED));
  app.post('/table-sim/actions/mark-table-occupied', writeLimiter, requireApiKey(API_KEY), (req, res) =>
    markTable(req, res, EVENT_TYPES.TABLE_OCCUPIED));

  let producer = null;
  if (SOURCE === 'sim') {
    producer = new TableSimProducer({ log, hub, seed: SEED, experience: EXPERIENCE, tableCount: TABLE_COUNT });
    if (MODE === 'replay') {
      const simDate = process.env.SIM_REPLAY_DATE || new Date().toISOString().slice(0, 10);
      const count = await producer.runReplay({ simDate, speed: SPEED });
      console.log(`[table-sim-service] replaying ${count} recorded events for ${simDate} at ${SPEED}x`);
    } else {
      const simDate = new Date().toISOString().slice(0, 10);
      const count = await producer.runLive({ simDate, speed: SPEED });
      console.log(`[table-sim-service] running live schedule (${count} events) for ${simDate} at ${SPEED}x, seed=${SEED}`);
    }
  } else {
    console.log('[table-sim-service] SOURCE=real — internal producer disabled, waiting for POST /table-sim/ingest');
  }

  const server = app.listen(PORT, () => {
    console.log(`[table-sim-service] listening on ${PORT} (source=${SOURCE}, mode=${MODE}, benchmark=${BENCHMARK})`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[table-sim-service] Port ${PORT} is already in use — set TABLE_SIM_PORT to a free port.`);
    } else {
      console.error('[table-sim-service] Server error:', err.message);
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
