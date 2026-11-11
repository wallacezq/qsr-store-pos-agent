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
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { getTableStatusService } = require('./services/table-status');

// Initialize and connect the table status service
const tableService = getTableStatusService({
  brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
  tableCount: parseInt(process.env.CAFE_TABLE_COUNT || '15'),
});
tableService.connect();

const TOOLS = [
  {
    name: 'get_all_tables',
    description: 'Get current status of all café tables (clean, occupied, or dirty)',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_dirty_tables',
    description: 'List tables that are currently dirty and need cleaning by staff',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_occupied_tables',
    description: 'List tables that are currently occupied by customers',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_clean_tables',
    description: 'List tables that are clean and available for seating',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_table_history',
    description: 'Get the state change timeline for a specific table',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID (e.g., "table-4")' },
      },
      required: ['table_id'],
    },
  },
  {
    name: 'get_table_stats',
    description: 'Get aggregate statistics: total tables, status breakdown, average dirty duration',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'mark_table_cleared',
    description: 'Mark a table as cleared/clean by staff. Use this when staff has cleaned a dirty table.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID to mark as cleared (e.g., "table-4")' },
        staff_id: { type: 'string', description: 'Optional staff member ID who cleared the table' },
      },
      required: ['table_id'],
    },
  },
  {
    name: 'mark_table_occupied',
    description: 'Mark a table as occupied by a customer',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID (e.g., "table-4")' },
        customer_id: { type: 'string', description: 'Optional customer identifier' },
      },
      required: ['table_id'],
    },
  },
  {
    name: 'get_service_status',
    description: 'Get MQTT connection status and service health info',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'get_all_tables':
      return JSON.stringify(tableService.getAllTables(), null, 2);

    case 'get_dirty_tables': {
      const dirty = tableService.getDirtyTables();
      if (dirty.length === 0) return 'No dirty tables. All tables are either clean or occupied.';
      return JSON.stringify(dirty, null, 2);
    }

    case 'get_occupied_tables': {
      const occupied = tableService.getOccupiedTables();
      if (occupied.length === 0) return 'No tables are currently occupied.';
      return JSON.stringify(occupied, null, 2);
    }

    case 'get_clean_tables': {
      const clean = tableService.getCleanTables();
      if (clean.length === 0) return 'No clean tables available.';
      return JSON.stringify(clean, null, 2);
    }

    case 'get_table_history': {
      // Models sometimes use the sim-service key (table_ref) or a short name; accept them.
      const tableId = args.table_id ?? args.table_ref ?? args.table ?? args.id;
      if (!tableId) return 'Error: table_id is required (e.g. "table-4").';
      const history = tableService.getTableHistory(String(tableId));
      if (!history || history.length === 0) return `No history found for ${tableId}.`;
      return JSON.stringify(history, null, 2);
    }

    case 'get_table_stats':
      return JSON.stringify(tableService.getStats(), null, 2);

    case 'mark_table_cleared': {
      tableService.updateTable(args.table_id, 'cleared', args.staff_id || 'agent');
      return `Table ${args.table_id} marked as cleared.`;
    }

    case 'mark_table_occupied': {
      tableService.updateTable(args.table_id, 'occupied', 'agent', { customerId: args.customer_id });
      return `Table ${args.table_id} marked as occupied.`;
    }

    case 'get_service_status':
      return JSON.stringify(tableService.getStatus(), null, 2);

    default:
      return `Unknown tool: ${name}`;
  }
}

async function main() {
  const server = new Server(
    { name: 'pos-table-status', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleToolCall(name, args || {});
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP Table Status] Server running on stdio');
}

main().catch((err) => {
  console.error('[MCP Table Status] Fatal error:', err);
  process.exit(1);
});
