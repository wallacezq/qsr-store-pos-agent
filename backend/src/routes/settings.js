/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { randomUUID } = require('crypto');
const mqttPublisher = require('../services/mqtt-publisher');

const SETTINGS_FILE = path.join(__dirname, '..', '..', 'settings.json');

const defaults = {
  stockCheckEnabled: true,
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch (err) {
    console.error('Failed to load settings file, using defaults:', err.message);
  }
  return { ...defaults };
}

function saveSettings() {
  try {
    // explicit boolean coercion severs the HTTP-request taint chain before file write
    const safe = { stockCheckEnabled: settings.stockCheckEnabled === true };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save settings file:', err.message);
  }
}

const settings = loadSettings();

// GET current settings
router.get('/', (req, res) => {
  res.json(settings);
});

// PUT update settings
router.put('/', (req, res) => {
  const { stockCheckEnabled } = req.body;
  if (typeof stockCheckEnabled === 'boolean') {
    settings.stockCheckEnabled = stockCheckEnabled;
  }
  saveSettings();
  res.json(settings);
});

// DELETE all transactions
router.delete('/transactions', async (req, res) => {
  try {
    await db.query('DELETE FROM transaction_items', [], req.experience);
    await db.query('DELETE FROM transactions', [], req.experience);
    res.json({ message: 'All transactions cleared' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear transactions' });
  }
});

// POST replenish stock - set all active products to 999 units
router.post('/replenish-stock', async (req, res) => {
  const experience = req.experience;
  try {
    // Ensure the timestamp column exists on already-provisioned databases.
    await db.query(
      'ALTER TABLE products ADD COLUMN IF NOT EXISTS last_replenished_at TIMESTAMPTZ',
      [],
      experience
    );

    const result = await db.query(
      `UPDATE products SET stock_quantity = 999, last_replenished_at = NOW()
       WHERE is_active = true
       RETURNING id, name, sku, stock_quantity, last_replenished_at`,
      [],
      experience
    );

    const replenishedAt = result.rows[0]?.last_replenished_at || new Date().toISOString();

    // Push an inventory event onto the broker so the workflow feed and any
    // listeners can react; the agent reads last_replenished_at from the DB.
    mqttPublisher.publish(`pos/${experience}/events/inventory.replenished`, {
      event_id: randomUUID(),
      event_type: 'inventory.replenished',
      severity: 'info',
      source: 'pos',
      experience,
      occurred_at: new Date(replenishedAt).toISOString(),
      payload: {
        level: 999,
        product_count: result.rowCount,
        products: result.rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku })),
      },
    });

    res.json({ message: 'Stock replenished', updated: result.rowCount, last_replenished_at: replenishedAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to replenish stock' });
  }
});

// Export settings object for use by other routes
router.getSettings = () => settings;

module.exports = router;
