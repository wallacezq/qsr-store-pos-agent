/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const settingsRoutes = require('./settings');

// GET all transactions
router.get('/', async (req, res) => {
  try {
    const { source, status, from, to, limit } = req.query;
    let query = `
      SELECT t.*, s.name as staff_name, c.name as customer_name
      FROM transactions t
      LEFT JOIN staff s ON t.staff_id = s.id
      LEFT JOIN customers c ON t.customer_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (source) {
      params.push(source);
      query += ` AND t.source = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND t.status = $${params.length}`;
    }
    if (from) {
      params.push(from);
      query += ` AND t.created_at >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      query += ` AND t.created_at <= $${params.length}`;
    }

    query += ' ORDER BY t.created_at DESC';

    if (limit) {
      params.push(parseInt(limit));
      query += ` LIMIT $${params.length}`;
    }

    const result = await db.query(query, params, req.experience);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// GET single transaction with items
router.get('/:id', async (req, res) => {
  try {
    const transaction = await db.query(
      `SELECT t.*, s.name as staff_name, c.name as customer_name
       FROM transactions t
       LEFT JOIN staff s ON t.staff_id = s.id
       LEFT JOIN customers c ON t.customer_id = c.id
       WHERE t.id = $1`,
      [req.params.id],
      req.experience
    );
    if (transaction.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const items = await db.query(
      `SELECT ti.*, p.name as product_name, p.sku
       FROM transaction_items ti
       JOIN products p ON ti.product_id = p.id
       WHERE ti.transaction_id = $1`,
      [req.params.id],
      req.experience
    );

    res.json({ ...transaction.rows[0], items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

// POST create transaction
router.post('/', async (req, res) => {
  const client = await db.getClient(req.experience);
  try {
    await client.query('BEGIN');

    const { staff_id, customer_id, items, payment_method, source } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Transaction must have at least one item' });
    }

    // Generate transaction number
    const txnNumber = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    // Calculate totals
    let subtotal = 0;
    const processedItems = [];

    for (const item of items) {
      const product = await client.query('SELECT * FROM products WHERE id = $1', [item.product_id]);
      if (product.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Product ${item.product_id} not found` });
      }

      const unitPrice = parseFloat(product.rows[0].price);
      const quantity = parseInt(item.quantity);
      const discount = parseFloat(item.discount || 0);
      const currentStock = parseInt(product.rows[0].stock_quantity);
      const settings = settingsRoutes.getSettings();

      if (settings.stockCheckEnabled && currentStock < quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient stock for ${product.rows[0].name} (available: ${currentStock})` });
      }

      const itemTotal = (unitPrice * quantity) - discount;

      subtotal += itemTotal;
      processedItems.push({
        product_id: item.product_id,
        quantity,
        unit_price: unitPrice,
        discount,
        total: itemTotal
      });

      // Update stock
      if (settings.stockCheckEnabled) {
        await client.query(
          'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
          [quantity, item.product_id]
        );
      } else {
        await client.query(
          'UPDATE products SET stock_quantity = GREATEST(stock_quantity - $1, 0) WHERE id = $2',
          [quantity, item.product_id]
        );
      }
    }

    const taxRate = 0.08;
    const taxAmount = subtotal * taxRate;
    const total = subtotal + taxAmount;

    // Create transaction
    const txnResult = await client.query(
      `INSERT INTO transactions (transaction_number, staff_id, customer_id, subtotal, tax_amount, total, payment_method, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed') RETURNING *`,
      [txnNumber, staff_id, customer_id, subtotal.toFixed(2), taxAmount.toFixed(2), total.toFixed(2), payment_method || 'cash', source || 'pos']
    );

    // Create transaction items
    for (const item of processedItems) {
      await client.query(
        `INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, discount, total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [txnResult.rows[0].id, item.product_id, item.quantity, item.unit_price, item.discount, item.total]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(txnResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create transaction' });
  } finally {
    client.release();
  }
});

// GET transaction stats
router.get('/stats/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const stats = await db.query(`
      SELECT 
        COUNT(*) as total_transactions,
        COALESCE(SUM(total), 0) as total_revenue,
        COALESCE(AVG(total), 0) as avg_transaction,
        COUNT(CASE WHEN source = 'simulator' THEN 1 END) as simulator_transactions,
        COUNT(CASE WHEN source = 'pos' THEN 1 END) as pos_transactions
      FROM transactions
      WHERE created_at::date = $1
    `, [today], req.experience);

    // Top-selling product today by units sold (not price).
    const topProduct = await db.query(`
      SELECT p.name, SUM(ti.quantity) as units_sold
      FROM transaction_items ti
      JOIN products p ON ti.product_id = p.id
      JOIN transactions t ON ti.transaction_id = t.id
      WHERE t.created_at::date = $1
      GROUP BY p.id, p.name
      ORDER BY units_sold DESC
      LIMIT 1
    `, [today], req.experience);

    res.json({
      ...stats.rows[0],
      top_product: topProduct.rows[0]?.name || null,
      top_product_units: topProduct.rows[0]?.units_sold || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
