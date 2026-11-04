/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Load env from backend/.env
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.MCP_DB_NAME || process.env.GROCERY_DB_NAME || 'pos_grocery',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 10,
  idleTimeoutMillis: 30000,
});

const TOOLS = [
  {
    name: 'list_categories',
    description: 'List all product categories',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_products',
    description: 'Search products by name or category. Call this for "find product", "do we sell X", "look up item", or filtering products by category.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term for product name, SKU, or barcode' },
        category: { type: 'string', description: 'Category name to filter by' },
      },
    },
  },
  {
    name: 'get_product_details',
    description: 'Get details for a specific product by ID or SKU',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Product UUID' },
        sku: { type: 'string', description: 'Product SKU' },
      },
    },
  },
  {
    name: 'get_last_replenished',
    description: 'Get when a product was last replenished/restocked (its last_replenished_at time) and current stock. Call this for "when was X last replenished", "last restock time", or "how long since we restocked X". Match by product name, SKU, or ID.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Product name (partial match allowed), SKU, or barcode' },
        id: { type: 'string', description: 'Product UUID (optional, exact match)' },
      },
    },
  },
  {
    name: 'get_sales_summary',
    description: 'Revenue summary with TOP PRODUCTS by revenue and category breakdown. Call this for questions like "top/best products by revenue", "overall sales", "how are we doing", "total revenue", "best sellers". Use days=0 for today only.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of calendar days to look back from today (0 = today only, 1 = today and yesterday, 7 = last week). Default 30.' },
      },
    },
  },
  {
    name: 'get_sales_summary_by_date',
    description: 'Get revenue summary for a specific calendar date. Use this tool when the user asks about sales on a particular date (e.g. yesterday, last Monday, May 20th). Returns top products and category breakdown for that exact date.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The target date in YYYY-MM-DD format (e.g. 2026-05-21). Required.' },
      },
      required: ['date'],
    },
  },
  {
    name: 'get_sales_by_date',
    description: 'Daily sales totals over time for trend analysis. Call this for "sales trend", "revenue over the last N days", "daily sales", or charting sales by day.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to look back (default 30)' },
      },
    },
  },
  {
    name: 'get_product_sales',
    description: 'Full sales history for a product',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'list_customers',
    description: 'List customers, optionally loyalty-only',
    inputSchema: {
      type: 'object',
      properties: {
        loyalty_only: { type: 'boolean', description: 'Only return customers with loyalty points > 0' },
      },
    },
  },
  {
    name: 'get_customer_purchases',
    description: 'Purchase history for a customer',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer UUID' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'get_top_customers',
    description: 'Top customers by spending. Call this for "best customers", "top spenders", "who buys the most", or loyalty leaderboard questions.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of top customers to return (default 10)' },
        days: { type: 'number', description: 'Number of days to look back (default 30)' },
      },
    },
  },
  {
    name: 'run_query',
    description: 'Run ad-hoc read-only SQL queries (SELECT only)',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL SELECT query to execute' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'get_schema',
    description: 'View the database schema',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// Tool handlers
async function handleTool(name, args) {
  switch (name) {
    case 'list_categories': {
      const result = await pool.query('SELECT * FROM categories ORDER BY name');
      return result.rows;
    }

    case 'search_products': {
      let query = `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE 1=1`;
      const params = [];
      if (args.query) {
        params.push(`%${args.query}%`);
        query += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`;
      }
      if (args.category) {
        params.push(`%${args.category}%`);
        query += ` AND c.name ILIKE $${params.length}`;
      }
      query += ' ORDER BY p.name LIMIT 50';
      const result = await pool.query(query, params);
      return result.rows;
    }

    case 'get_product_details': {
      let query, params;
      if (args.id) {
        query = `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = $1`;
        params = [args.id];
      } else if (args.sku) {
        query = `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.sku = $1`;
        params = [args.sku];
      } else {
        return { error: 'Provide either id or sku' };
      }
      const result = await pool.query(query, params);
      return result.rows[0] || { error: 'Product not found' };
    }

    case 'get_last_replenished': {
      // Tolerate databases provisioned before the column existed.
      await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS last_replenished_at TIMESTAMPTZ');
      let query, params;
      if (args.id) {
        query = `SELECT id, name, sku, stock_quantity, last_replenished_at FROM products WHERE id = $1`;
        params = [args.id];
      } else if (args.query) {
        query = `SELECT id, name, sku, stock_quantity, last_replenished_at FROM products
                 WHERE name ILIKE $1 OR sku ILIKE $1 OR barcode ILIKE $1
                 ORDER BY name LIMIT 10`;
        params = [`%${args.query}%`];
      } else {
        return { error: 'Provide a product name/sku via "query", or a product "id"' };
      }
      const result = await pool.query(query, params);
      if (result.rows.length === 0) return { error: 'Product not found' };
      return result.rows.map((r) => ({
        ...r,
        last_replenished_at: r.last_replenished_at || 'never (no replenish recorded)',
      }));
    }

    case 'get_sales_summary': {
      const days = args.days != null ? Math.max(0, Math.floor(Number(args.days))) : 30;
      const dateFilter = days === 0
        ? `created_at::date = CURRENT_DATE`
        : `created_at::date >= CURRENT_DATE - ${days}`;
      const summary = await pool.query(
        `SELECT 
          COUNT(*) as total_transactions,
          COALESCE(SUM(total), 0) as total_revenue,
          COALESCE(SUM(tax_amount), 0) as total_tax,
          COALESCE(AVG(total), 0) as avg_transaction
        FROM transactions 
        WHERE ${dateFilter}`
      );
      const topProducts = await pool.query(
        `SELECT p.name, p.sku, SUM(ti.quantity) as units_sold, SUM(ti.total) as revenue
        FROM transaction_items ti
        JOIN products p ON ti.product_id = p.id
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.${dateFilter}
        GROUP BY p.id, p.name, p.sku
        ORDER BY revenue DESC LIMIT 5`
      );
      const byCategory = await pool.query(
        `SELECT c.name as category, SUM(ti.total) as revenue, SUM(ti.quantity) as units_sold
        FROM transaction_items ti
        JOIN products p ON ti.product_id = p.id
        JOIN categories c ON p.category_id = c.id
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.${dateFilter}
        GROUP BY c.name
        ORDER BY revenue DESC`
      );
      return {
        period_days: days,
        ...summary.rows[0],
        top_products: topProducts.rows,
        by_category: byCategory.rows,
      };
    }

    case 'get_sales_summary_by_date': {
      const date = args.date;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { error: 'Invalid date format. Use YYYY-MM-DD.' };
      }
      const summary = await pool.query(
        `SELECT 
          COUNT(*) as total_transactions,
          COALESCE(SUM(total), 0) as total_revenue,
          COALESCE(SUM(tax_amount), 0) as total_tax,
          COALESCE(AVG(total), 0) as avg_transaction,
          COUNT(CASE WHEN source = 'pos' THEN 1 END) as pos_transactions,
          COUNT(CASE WHEN source = 'simulator' THEN 1 END) as simulator_transactions
        FROM transactions 
        WHERE created_at::date = $1`,
        [date]
      );
      const topProducts = await pool.query(
        `SELECT p.name, p.sku, SUM(ti.quantity) as units_sold, SUM(ti.total) as revenue
        FROM transaction_items ti
        JOIN products p ON ti.product_id = p.id
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.created_at::date = $1
        GROUP BY p.id, p.name, p.sku
        ORDER BY revenue DESC LIMIT 5`,
        [date]
      );
      const byCategory = await pool.query(
        `SELECT c.name as category, SUM(ti.total) as revenue, SUM(ti.quantity) as units_sold
        FROM transaction_items ti
        JOIN products p ON ti.product_id = p.id
        JOIN categories c ON p.category_id = c.id
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.created_at::date = $1
        GROUP BY c.name
        ORDER BY revenue DESC`,
        [date]
      );
      return {
        date,
        ...summary.rows[0],
        top_products: topProducts.rows,
        by_category: byCategory.rows,
      };
    }

    case 'get_sales_by_date': {
      const days = args.days != null ? Math.max(0, Math.floor(Number(args.days))) : 30;
      const result = await pool.query(
        `SELECT 
          DATE(created_at) as date,
          COUNT(*) as transactions,
          COALESCE(SUM(total), 0) as revenue
        FROM transactions
        WHERE created_at::date >= CURRENT_DATE - $1
        GROUP BY DATE(created_at)
        ORDER BY date DESC`,
        [days]
      );
      return result.rows;
    }

    case 'get_product_sales': {
      const limit = args.limit || 50;
      const result = await pool.query(
        `SELECT t.transaction_number, t.created_at, ti.quantity, ti.unit_price, ti.total,
                t.payment_method, t.source
        FROM transaction_items ti
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE ti.product_id = $1
        ORDER BY t.created_at DESC LIMIT $2`,
        [args.product_id, limit]
      );
      return result.rows;
    }

    case 'list_customers': {
      let query = 'SELECT * FROM customers';
      if (args.loyalty_only) {
        query += ' WHERE loyalty_points > 0';
      }
      query += ' ORDER BY name LIMIT 100';
      const result = await pool.query(query);
      return result.rows;
    }

    case 'get_customer_purchases': {
      const limit = args.limit || 50;
      const result = await pool.query(
        `SELECT t.*, 
          json_agg(json_build_object(
            'product', p.name,
            'quantity', ti.quantity,
            'unit_price', ti.unit_price,
            'total', ti.total
          )) as items
        FROM transactions t
        JOIN transaction_items ti ON t.id = ti.transaction_id
        JOIN products p ON ti.product_id = p.id
        WHERE t.customer_id = $1
        GROUP BY t.id
        ORDER BY t.created_at DESC LIMIT $2`,
        [args.customer_id, limit]
      );
      return result.rows;
    }

    case 'get_top_customers': {
      const limit = args.limit || 10;
      const days = args.days || 30;
      const result = await pool.query(
        `SELECT c.id, c.name, c.email, c.loyalty_points,
                COUNT(t.id) as transaction_count,
                COALESCE(SUM(t.total), 0) as total_spent
        FROM customers c
        JOIN transactions t ON t.customer_id = c.id
        WHERE t.created_at >= NOW() - INTERVAL '1 day' * $1
        GROUP BY c.id
        ORDER BY total_spent DESC LIMIT $2`,
        [days, limit]
      );
      return result.rows;
    }

    case 'run_query': {
      const sql = (args.sql || '').trim();
      // Only allow SELECT statements
      if (!/^SELECT\s/i.test(sql)) {
        return { error: 'Only SELECT queries are allowed' };
      }
      // Block dangerous patterns
      if (/;\s*(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE)/i.test(sql)) {
        return { error: 'Only single SELECT queries are allowed' };
      }
      const result = await pool.query(sql);
      return { columns: result.fields.map(f => f.name), rows: result.rows.slice(0, 100) };
    }

    case 'get_schema': {
      const schemaPath = path.resolve(__dirname, '../../database/schema.sql');
      try {
        const schema = fs.readFileSync(schemaPath, 'utf-8');
        return { schema };
      } catch {
        // Fallback: query information_schema
        const tables = await pool.query(
          `SELECT table_name, column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
          ORDER BY table_name, ordinal_position`
        );
        return { tables: tables.rows };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function main() {
  const server = new Server(
    { name: 'pos-simulator-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleTool(name, args || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
