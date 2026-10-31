/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const router = express.Router();
const { getTableStatusService } = require('../services/table-status');

const HERMES_GATEWAY_URL = process.env.HERMES_GATEWAY_URL || 'http://localhost:3001';
const HERMES_API_KEY = process.env.HERMES_API_KEY || 'change-me-local-dev';

const SYSTEM_PROMPT = `You are an intelligent café operations assistant for EdgeMart Café.

You have live tools connected to the POS database, real-time table status (MQTT vision events), and the vision AI system. These tools are always available in this environment — never claim a tool or database is unavailable, and never answer data questions from memory or guesses.

Tool-use rules:
- For ANY question about sales, revenue, best/top products, categories, trends, customers, or schema, you MUST call a POS tool. Do not answer such questions without first calling a tool.
- "top/best products by revenue", "overall sales", "how are we doing", "today's revenue" → call get_sales_summary (use days=0 for today).
- Sales for a specific calendar date → call get_sales_summary_by_date.
- Daily sales trend over time → call get_sales_by_date.
- Table availability, occupancy, dirty/clean status → call the table-status tools.
- If no dedicated tool fits, use run_query with a read-only SELECT rather than refusing.

After a tool returns, summarize the actual numbers concisely. Be helpful and brief.`;

// Builds the optional model-selection fields for a Hermes request.
// Per Hermes docs, a bare `model` is ignored on /v1/chat/completions unless
// `direct_model_requests` is enabled, so we only forward it alongside a provider.
function buildModelFields({ model, provider, modelOptions }) {
  const fields = {};
  if (model && typeof model === 'string') fields.model = model;
  if (provider && typeof provider === 'string') fields.provider = provider;
  if (modelOptions && typeof modelOptions === 'object') fields.model_options = modelOptions;
  return fields;
}

// Initialize table status service (connects to MQTT on first use)
let tableServiceInitialized = false;

function ensureTableService() {
  if (!tableServiceInitialized) {
    const service = getTableStatusService();
    service.connect();
    tableServiceInitialized = true;
  }
}

/**
 * POST /api/chat
 * Send a message to the Hermes agent gateway and stream the response back via SSE.
 * Body: { message: string, conversationId?: string, context?: object }
 */
router.post('/', async (req, res) => {
  const { message, conversationId, context, model, provider, modelOptions } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (message.length > 10000) {
    return res.status(400).json({ error: 'Message too long (max 10000 chars)' });
  }

  // Set up SSE headers for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Keep-alive heartbeat to prevent connection timeout during long tool-call processing
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 5000);

  // Abort Hermes request if client disconnects
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
    clearInterval(keepAlive);
  });

  try {
    const fetchTimeout = setTimeout(() => controller.abort(), 300000); // 5 min max

    const response = await fetch(`${HERMES_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HERMES_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT
          },
          ...(context?.history || []),
          { role: 'user', content: message.trim() }
        ],
        stream: true,
        conversation_id: conversationId || undefined,
        ...buildModelFields({ model, provider, modelOptions }),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.write(`data: ${JSON.stringify({ type: 'error', content: `Hermes gateway error: ${response.status} - ${errText}` })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let hasContent = false;

    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (readErr) {
        // Stream interrupted (Hermes dropped connection mid-response)
        console.warn('[Chat] Stream read error:', readErr.message);
        if (!hasContent) {
          res.write(`data: ${JSON.stringify({ type: 'error', content: `Stream interrupted: ${readErr.message}` })}\n\n`);
        }
        break;
      }

      const { done, value } = readResult;
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
          } else {
            try {
              const parsed = JSON.parse(data);
              // Forward content chunks
              if (parsed.choices?.[0]?.delta?.content) {
                hasContent = true;
                res.write(`data: ${JSON.stringify({ type: 'content', content: parsed.choices[0].delta.content })}\n\n`);
              }
              // Forward tool call information
              if (parsed.choices?.[0]?.delta?.tool_calls) {
                res.write(`data: ${JSON.stringify({ type: 'tool_call', content: parsed.choices[0].delta.tool_calls })}\n\n`);
              }
              // Forward tool results
              if (parsed.type === 'tool_result') {
                res.write(`data: ${JSON.stringify({ type: 'tool_result', tool: parsed.tool, result: parsed.result })}\n\n`);
              }
              // Forward usage stats (token counts)
              if (parsed.usage) {
                res.write(`data: ${JSON.stringify({ type: 'usage', prompt_tokens: parsed.usage.prompt_tokens, completion_tokens: parsed.usage.completion_tokens })}\n\n`);
              }
            } catch {
              // Forward raw line if not JSON
              res.write(`data: ${JSON.stringify({ type: 'content', content: data })}\n\n`);
            }
          }
        }
      }
    }

    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
    clearInterval(keepAlive);
    clearTimeout(fetchTimeout);
  } catch (err) {
    clearInterval(keepAlive);
    console.error('[Chat] Hermes gateway error:', err.message);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: `Connection failed: ${err.message}. Ensure the Hermes gateway is running at ${HERMES_GATEWAY_URL}` })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

/**
 * POST /api/chat/message (non-streaming fallback)
 * For clients that don't support SSE.
 */
router.post('/message', async (req, res) => {
  const { message, conversationId, context } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (message.length > 10000) {
    return res.status(400).json({ error: 'Message too long (max 10000 chars)' });
  }

  try {
    const response = await fetch(`${HERMES_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HERMES_API_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT
          },
          ...(context?.history || []),
          { role: 'user', content: message.trim() }
        ],
        stream: false,
        conversation_id: conversationId || undefined,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `Hermes gateway error: ${errText}` });
    }

    const data = await response.json();
    res.json({
      message: data.choices?.[0]?.message?.content || '',
      toolCalls: data.choices?.[0]?.message?.tool_calls || [],
      conversationId: data.conversation_id || conversationId,
    });
  } catch (err) {
    console.error('[Chat] Non-streaming error:', err.message);
    res.status(503).json({ error: `Hermes gateway unavailable: ${err.message}` });
  }
});

/**
 * GET /api/chat/status
 * Check Hermes gateway connectivity and table service status.
 */
router.get('/status', async (req, res) => {
  ensureTableService();
  const tableService = getTableStatusService();

  let hermesReachable = false;
  try {
    const resp = await fetch(`${HERMES_GATEWAY_URL}/health`, {
      headers: { 'Authorization': `Bearer ${HERMES_API_KEY}` },
      signal: AbortSignal.timeout(3000),
    });
    hermesReachable = resp.ok;
  } catch {
    hermesReachable = false;
  }

  res.json({
    hermes: {
      url: HERMES_GATEWAY_URL,
      reachable: hermesReachable,
    },
    tableService: tableService.getStatus(),
  });
});

/**
 * GET /api/chat/models
 * Proxy Hermes' curated provider/model inventory (dashboard/TUI model picker).
 * Returns a flattened list of { id, provider, label } for the frontend dropdown.
 */
router.get('/models', async (req, res) => {
  try {
    const refresh = req.query.refresh ? '?refresh=1' : '';
    const resp = await fetch(`${HERMES_GATEWAY_URL}/api/model/options${refresh}`, {
      headers: { 'Authorization': `Bearer ${HERMES_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `Hermes model options error: ${errText}` });
    }

    const data = await resp.json();
    // Hermes groups models under providers; flatten to a simple, UI-friendly list.
    const providers = data.providers || data.data || [];
    const models = [];
    for (const p of providers) {
      const providerSlug = p.provider || p.slug || p.id || p.name;
      for (const m of (p.models || [])) {
        const id = typeof m === 'string' ? m : (m.id || m.model || m.name);
        if (!id) continue;
        models.push({
          id,
          provider: providerSlug,
          label: (typeof m === 'object' && (m.label || m.display_name)) || id,
        });
      }
    }

    res.json({ models, raw: data });
  } catch (err) {
    console.error('[Chat] Model options error:', err.message);
    res.status(503).json({ error: `Hermes model options unavailable: ${err.message}` });
  }
});

/**
 * GET /api/chat/tables
 * Direct REST endpoint for table status (useful for frontend dashboard).
 */
router.get('/tables', (req, res) => {
  ensureTableService();
  const tableService = getTableStatusService();
  res.json(tableService.getAllTables());
});

/**
 * GET /api/chat/tables/dirty
 * Quick endpoint for dirty tables.
 */
router.get('/tables/dirty', (req, res) => {
  ensureTableService();
  const tableService = getTableStatusService();
  res.json(tableService.getDirtyTables());
});

/**
 * POST /api/chat/tables/:id/clear
 * Mark a table as cleared via REST (alternative to agent tool call).
 */
router.post('/tables/:id/clear', (req, res) => {
  ensureTableService();
  const tableService = getTableStatusService();
  const tableId = req.params.id;
  tableService.updateTable(tableId, 'cleared', 'rest-api');
  res.json({ success: true, tableId, status: 'clean' });
});

/**
 * POST /api/chat/tables/event
 * Receive simulated vision events from the café simulator.
 * This endpoint acts as a stand-in for the external vision AI system.
 * Body: { tableId: string, event: 'occupied'|'dirty'|'cleared', source?: string, metadata?: object }
 */
router.post('/tables/event', (req, res) => {
  ensureTableService();
  const tableService = getTableStatusService();
  const { tableId, event, source, metadata } = req.body;

  if (!tableId || !event) {
    return res.status(400).json({ error: 'tableId and event are required' });
  }

  const validEvents = ['occupied', 'dirty', 'cleared', 'clean'];
  if (!validEvents.includes(event)) {
    return res.status(400).json({ error: `Invalid event. Must be one of: ${validEvents.join(', ')}` });
  }

  tableService.updateTable(tableId, event, source || 'simulator-vision', metadata || {});
  res.json({ success: true, tableId, event, timestamp: new Date().toISOString() });
});

/**
 * POST /api/chat/tables/events/batch
 * Receive multiple simulated vision events at once.
 * Body: { events: [{ tableId, event, source?, metadata? }] }
 */
router.post('/tables/events/batch', (req, res) => {
  ensureTableService();
  const tableService = getTableStatusService();
  const { events } = req.body;

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events array is required' });
  }

  const results = [];
  for (const evt of events) {
    if (evt.tableId && evt.event) {
      tableService.updateTable(evt.tableId, evt.event, evt.source || 'simulator-vision', evt.metadata || {});
      results.push({ tableId: evt.tableId, event: evt.event, success: true });
    }
  }
  res.json({ success: true, processed: results.length, results });
});

/**
 * POST /api/chat/tables/reset
 * Reset all tables to clean state (called when simulator scene reinitializes).
 */
router.post('/tables/reset', (req, res) => {
  ensureTableService();
  const tableService = getTableStatusService();
  tableService.resetAllTables();
  res.json({ success: true, timestamp: new Date().toISOString() });
});

module.exports = router;
