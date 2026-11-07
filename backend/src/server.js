/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const productRoutes = require('./routes/products');
const categoryRoutes = require('./routes/categories');
const transactionRoutes = require('./routes/transactions');
const staffRoutes = require('./routes/staff');
const simulatorRoutes = require('./routes/simulator');
const settingsRoutes = require('./routes/settings');
const mcpRoutes = require('./routes/mcp');
const chatRoutes = require('./routes/chat');
const metricsRoutes = require('./routes/metrics');
const eventsRoutes = require('./routes/events');
const camerasRoutes = require('./routes/cameras');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: ['http://localhost:4200'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Experience']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000
});
app.use(limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));

// Experience middleware - extracts experience from header or query
app.use((req, res, next) => {
  req.experience = req.headers['x-experience'] || req.query.experience || 'grocery';
  next();
});

// Routes
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/simulator', simulatorRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/cameras', camerasRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`POS Backend running on port ${PORT}`);
});

module.exports = app;
