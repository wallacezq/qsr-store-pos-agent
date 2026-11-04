/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const settingsRoutes = require('./settings');

// Standalone sim-services whose MQTT event fanout the Sim toggle also controls.
// URLs default to the docker-compose service names; override via env if needed.
const SIM_SERVICES = [
  { name: 'sim', url: process.env.SIM_SERVICE_URL || 'http://sim-service:3100', path: '/sim/control', apiKey: process.env.SIM_API_KEY },
  { name: 'table-sim', url: process.env.TABLE_SIM_SERVICE_URL || 'http://table-sim-service:3200', path: '/table-sim/control', apiKey: process.env.TABLE_SIM_API_KEY },
  { name: 'footfall-sim', url: process.env.FOOTFALL_SIM_SERVICE_URL || 'http://footfall-sim-service:3300', path: '/footfall-sim/control', apiKey: process.env.FOOTFALL_SIM_API_KEY },
];

// Fan the Sim on/off state out to every sim-service's fanout control. Best-effort:
// a missing/unreachable service is logged, never fails the toggle request.
async function syncSimServices(enabled) {
  if (typeof fetch !== 'function') {
    console.warn('[simulator] global fetch unavailable (Node < 18); cannot sync sim-services.');
    return;
  }
  await Promise.all(SIM_SERVICES.map(async (svc) => {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (svc.apiKey) headers['X-Api-Key'] = svc.apiKey;
      const resp = await fetch(`${svc.url}${svc.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled }),
      });
      if (!resp.ok) console.warn(`[simulator] ${svc.name} control responded ${resp.status}`);
    } catch (err) {
      console.warn(`[simulator] Failed to reach ${svc.name} control: ${err.message}`);
    }
  }));
}

// POST - Generate a random simulator transaction
router.post('/generate-transaction', async (req, res) => {
  const client = await db.getClient(req.experience);
  try {
    await client.query('BEGIN');

    // Get random products (1-5 items)
    const itemCount = Math.floor(Math.random() * 5) + 1;
    const settings = settingsRoutes.getSettings();
    const stockFilter = settings.stockCheckEnabled ? 'AND stock_quantity > 0' : '';
    const products = await client.query(
      `SELECT * FROM products WHERE is_active = true ${stockFilter} ORDER BY RANDOM() LIMIT $1`,
      [itemCount]
    );

    if (products.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No products available' });
    }

    // Get random staff
    const staff = await client.query('SELECT id FROM staff WHERE is_active = true ORDER BY RANDOM() LIMIT 1');
    const staffId = staff.rows.length > 0 ? staff.rows[0].id : null;

    // Build transaction
    const txnNumber = `SIM-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    let subtotal = 0;
    const items = [];

    for (const product of products.rows) {
      const quantity = Math.floor(Math.random() * 3) + 1;
      const unitPrice = parseFloat(product.price);
      const itemTotal = unitPrice * quantity;
      subtotal += itemTotal;

      items.push({
        product_id: product.id,
        quantity,
        unit_price: unitPrice,
        discount: 0,
        total: itemTotal
      });

      // Update stock
      await client.query(
        'UPDATE products SET stock_quantity = GREATEST(stock_quantity - $1, 0) WHERE id = $2',
        [quantity, product.id]
      );
    }

    const paymentMethods = ['cash', 'credit_card', 'debit_card', 'mobile_pay'];
    const paymentMethod = paymentMethods[Math.floor(Math.random() * paymentMethods.length)];

    const taxAmount = subtotal * 0.08;
    const total = subtotal + taxAmount;

    // Create transaction
    let txnResult;
    if (req.experience === 'cafe') {
      const orderType = req.body.order_type || 'dine-in';
      txnResult = await client.query(
        `INSERT INTO transactions (transaction_number, staff_id, subtotal, tax_amount, total, payment_method, source, status, order_type)
         VALUES ($1, $2, $3, $4, $5, $6, 'simulator', 'completed', $7) RETURNING *`,
        [txnNumber, staffId, subtotal.toFixed(2), taxAmount.toFixed(2), total.toFixed(2), paymentMethod, orderType]
      );
    } else {
      txnResult = await client.query(
        `INSERT INTO transactions (transaction_number, staff_id, subtotal, tax_amount, total, payment_method, source, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'simulator', 'completed') RETURNING *`,
        [txnNumber, staffId, subtotal.toFixed(2), taxAmount.toFixed(2), total.toFixed(2), paymentMethod]
      );
    }

    // Create transaction items
    for (const item of items) {
      await client.query(
        `INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, discount, total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [txnResult.rows[0].id, item.product_id, item.quantity, item.unit_price, item.discount, item.total]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      transaction: txnResult.rows[0],
      items_count: items.length,
      message: 'Simulator transaction generated'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to generate simulator transaction' });
  } finally {
    client.release();
  }
});

// Shared simulator state
let simulatorEnabled = false;
const sseClients = new Set();

function broadcastState() {
  const data = JSON.stringify({ enabled: simulatorEnabled });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// SSE endpoint for real-time state sync
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ enabled: simulatorEnabled })}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// GET simulator status
router.get('/status', (req, res) => {
  res.json({ active: true, enabled: simulatorEnabled, message: 'Simulator endpoint ready' });
});

// PUT toggle simulator state (broadcast to all clients)
router.put('/toggle', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    simulatorEnabled = enabled;
  } else {
    simulatorEnabled = !simulatorEnabled;
  }
  broadcastState();
  syncSimServices(simulatorEnabled); // best-effort fan-out; don't block the response
  res.json({ enabled: simulatorEnabled });
});

module.exports = router;
