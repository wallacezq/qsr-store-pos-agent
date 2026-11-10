/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import { McpService, McpStatus } from '../../services/mcp.service';
import { ExperienceService } from '../../services/experience.service';
import { SettingsService, Settings } from '../../services/settings.service';

@Component({
  selector: 'app-config',
  standalone: true,
  imports: [CommonModule, FormsModule, MatCardModule, MatButtonModule, MatIconModule, MatSlideToggleModule, MatSnackBarModule, MatChipsModule],
  template: `
    <div class="config-container">
      <h2><mat-icon>settings</mat-icon> Configuration</h2>

      <!-- POS MCP Server Section -->
      <mat-card class="config-card">
        <mat-card-header>
          <mat-icon mat-card-avatar class="section-icon">smart_toy</mat-icon>
          <mat-card-title>POS MCP Server</mat-card-title>
          <mat-card-subtitle>Model Context Protocol server for product/sales/customer queries ({{ experienceService.current }} database)</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="status-row">
            <div class="status-info">
              <span class="status-label">Status:</span>
              <span class="status-badge" [class]="mcpStatus.pos.status">
                {{ mcpStatus.pos.status === 'running' ? '● Running' : mcpStatus.pos.status === 'error' ? '● Error' : '○ Stopped' }}
              </span>
              <span class="pid" *ngIf="mcpStatus.pos.pid">PID: {{ mcpStatus.pos.pid }}</span>
              <span class="experience-tag" *ngIf="mcpStatus.pos.experience">{{ mcpStatus.pos.experience }}</span>
            </div>
            <mat-slide-toggle
              [checked]="mcpStatus.pos.status === 'running'"
              (change)="toggleMcp($event.checked)"
              color="accent">
            </mat-slide-toggle>
          </div>

          <div class="tools-section">
            <h4>Available Tools ({{ posTools.length }})</h4>
            <div class="tools-grid">
              <div class="tool-chip" *ngFor="let tool of posTools">
                <mat-icon class="tool-icon">build</mat-icon>
                <div class="tool-info">
                  <span class="tool-name">{{ tool.name }}</span>
                  <span class="tool-desc">{{ tool.description }}</span>
                </div>
              </div>
            </div>
          </div>
        </mat-card-content>
      </mat-card>

      <!-- Table Status MCP Server Section (Café only) -->
      <mat-card class="config-card" *ngIf="isCafe">
        <mat-card-header>
          <mat-icon mat-card-avatar class="section-icon table-icon">table_restaurant</mat-icon>
          <mat-card-title>Table Status MCP Server</mat-card-title>
          <mat-card-subtitle>Real-time table tracking via MQTT vision events</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="status-row">
            <div class="status-info">
              <span class="status-label">Status:</span>
              <span class="status-badge" [class]="mcpStatus.tableStatus.status">
                {{ mcpStatus.tableStatus.status === 'running' ? '● Running' : mcpStatus.tableStatus.status === 'error' ? '● Error' : '○ Stopped' }}
              </span>
              <span class="pid" *ngIf="mcpStatus.tableStatus.pid">PID: {{ mcpStatus.tableStatus.pid }}</span>
            </div>
            <mat-slide-toggle
              [checked]="mcpStatus.tableStatus.status === 'running'"
              (change)="toggleTableStatus($event.checked)"
              color="accent">
            </mat-slide-toggle>
          </div>

          <div class="tools-section">
            <h4>Available Tools ({{ tableTools.length }})</h4>
            <div class="tools-grid">
              <div class="tool-chip" *ngFor="let tool of tableTools">
                <mat-icon class="tool-icon">build</mat-icon>
                <div class="tool-info">
                  <span class="tool-name">{{ tool.name }}</span>
                  <span class="tool-desc">{{ tool.description }}</span>
                </div>
              </div>
            </div>
          </div>
        </mat-card-content>
      </mat-card>

      <!-- Client Configuration -->
      <mat-card class="config-card" *ngIf="mcpConfig">
        <mat-card-header>
          <mat-icon mat-card-avatar class="section-icon config-icon">integration_instructions</mat-icon>
          <mat-card-title>Client Configuration</mat-card-title>
          <mat-card-subtitle>Add to your MCP client config (e.g. Claude Desktop, VS Code)</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <pre class="config-json">{{ mcpConfig | json }}</pre>
        </mat-card-content>
      </mat-card>

      <!-- POS Settings -->
      <mat-card class="config-card">
        <mat-card-header>
          <mat-icon mat-card-avatar class="section-icon pos-icon">point_of_sale</mat-icon>
          <mat-card-title>POS Settings</mat-card-title>
          <mat-card-subtitle>Transaction and inventory behavior</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Stock Check</div>
              <div class="setting-desc">When disabled, POS allows checkout regardless of available stock (infinite stock mode)</div>
            </div>
            <mat-slide-toggle
              [checked]="settings.stockCheckEnabled"
              (change)="toggleStockCheck($event.checked)"
              color="accent">
            </mat-slide-toggle>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Replenish Stock</div>
              <div class="setting-desc">Set the stock level of all active products to 999 units for the {{ experienceService.current }} database</div>
            </div>
            <button mat-raised-button color="primary" (click)="replenishStock()">
              <mat-icon>inventory_2</mat-icon> Replenish
            </button>
          </div>
        </mat-card-content>
      </mat-card>

      <!-- Agent (LLM) Settings -->
      <mat-card class="config-card">
        <mat-card-header>
          <mat-icon mat-card-avatar class="section-icon">tune</mat-icon>
          <mat-card-title>Agent (LLM) Settings</mat-card-title>
          <mat-card-subtitle>Latency vs. quality controls for the Hermes → OVMS (Qwen3.5-9B, GPU) agent</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="agent-grid">
            <label class="agent-field">
              <span class="setting-label">Max response tokens</span>
              <span class="setting-desc">Caps answer length. Lower = faster. (64–8192)</span>
              <input type="number" min="64" max="8192" step="64" [(ngModel)]="settings.agentMaxTokens">
            </label>
            <label class="agent-field">
              <span class="setting-label">Temperature</span>
              <span class="setting-desc">Lower = more deterministic & slightly faster. (0–2)</span>
              <input type="number" min="0" max="2" step="0.1" [(ngModel)]="settings.agentTemperature">
            </label>
            <label class="agent-field">
              <span class="setting-label">History turns</span>
              <span class="setting-desc">Prior messages sent each turn. Lower = faster prefill. (0–50)</span>
              <input type="number" min="0" max="50" step="1" [(ngModel)]="settings.agentHistoryLimit">
            </label>
          </div>
          <div class="agent-actions">
            <button mat-raised-button color="primary" (click)="saveAgentSettings()">
              <mat-icon>save</mat-icon> Save agent settings
            </button>
          </div>
        </mat-card-content>
      </mat-card>

      <!-- Data Management -->
      <mat-card class="config-card">
        <mat-card-header>
          <mat-icon mat-card-avatar class="section-icon danger-icon">delete_forever</mat-icon>
          <mat-card-title>Data Management</mat-card-title>
          <mat-card-subtitle>Clear data for the current experience ({{ experienceService.current }})</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Clear All Transactions</div>
              <div class="setting-desc">Permanently delete all transaction records and items from the {{ experienceService.current }} database</div>
            </div>
            <button mat-raised-button color="warn" (click)="clearTransactions()">
              <mat-icon>delete_sweep</mat-icon> Clear
            </button>
          </div>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .config-container {
      padding: 24px;
      max-width: 900px;
      margin: 0 auto;
    }
    .config-container h2 {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 24px;
    }
    .config-card {
      margin-bottom: 24px;
    }
    .agent-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
    .agent-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .agent-field input {
      margin-top: 4px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-secondary, #fff);
      color: var(--text-primary);
      font-size: 14px;
    }
    .agent-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 16px;
    }
    @media (max-width: 700px) { .agent-grid { grid-template-columns: 1fr; } }
    .section-icon {
      background: var(--accent);
      color: white;
      border-radius: 50%;
      padding: 8px;
      font-size: 24px;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 16px;
    }
    .status-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .status-label {
      font-weight: 500;
    }
    .status-badge {
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.85em;
    }
    .status-badge.running {
      color: #4caf50;
      background: rgba(76, 175, 80, 0.1);
    }
    .status-badge.stopped {
      color: #9e9e9e;
      background: rgba(158, 158, 158, 0.1);
    }
    .status-badge.error {
      color: #f44336;
      background: rgba(244, 67, 54, 0.1);
    }
    .pid {
      font-size: 0.8em;
      color: var(--text-secondary);
      font-family: monospace;
    }
    .tools-section {
      margin: 16px 0;
    }
    .tools-section h4 {
      margin-bottom: 12px;
      color: var(--text-secondary);
    }
    .tools-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 8px;
    }
    .tool-chip {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      background: rgba(128, 128, 128, 0.08);
      border: 1px solid var(--border);
    }
    .tool-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      margin-top: 2px;
      color: var(--accent);
    }
    .tool-info {
      display: flex;
      flex-direction: column;
    }
    .tool-name {
      font-family: monospace;
      font-weight: 600;
      font-size: 0.85em;
    }
    .tool-desc {
      font-size: 0.8em;
      color: var(--text-secondary);
    }
    .config-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .config-section h4 {
      margin-bottom: 8px;
    }
    .config-hint {
      font-size: 0.85em;
      color: var(--text-secondary);
      margin-bottom: 8px;
    }
    .config-json {
      background: rgba(0, 0, 0, 0.06);
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 0.8em;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .experience-tag {
      font-size: 0.75em;
      padding: 2px 8px;
      border-radius: 10px;
      background: rgba(25, 118, 210, 0.1);
      color: #1976d2;
      font-weight: 600;
      text-transform: capitalize;
    }
    .table-icon { background: #ff9800 !important; }
    .config-icon { background: #607d8b !important; }
    .pos-icon { background: #4caf50 !important; }
    .danger-icon { background: #f44336 !important; }
    .setting-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0;
    }
    .setting-row + .setting-row {
      border-top: 1px solid var(--border);
    }
    .setting-info {
      flex: 1;
      margin-right: 24px;
    }
    .setting-label {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .setting-desc {
      font-size: 0.85em;
      color: var(--text-secondary);
    }
  `]
})
export class ConfigComponent implements OnInit, OnDestroy {
  mcpStatus: McpStatus = {
    pos: { status: 'stopped', pid: null },
    tableStatus: { status: 'stopped', pid: null },
    status: 'stopped',
    pid: null,
  };
  mcpConfig: any = null;
  isCafe = false;
  settings: Settings = { stockCheckEnabled: true, agentMaxTokens: 768, agentTemperature: 0.2, agentHistoryLimit: 8 };
  private pollInterval: any;

  posTools = [
    { name: 'list_categories', description: 'List all product categories' },
    { name: 'search_products', description: 'Search products by name or category' },
    { name: 'get_product_details', description: 'Get details for a specific product' },
    { name: 'get_sales_summary', description: 'Revenue summary with top products and category breakdown' },
    { name: 'get_sales_summary_by_date', description: 'Revenue summary for a specific date (YYYY-MM-DD)' },
    { name: 'get_sales_by_date', description: 'Daily sales totals for trend analysis' },
    { name: 'get_product_sales', description: 'Full sales history for a product' },
    { name: 'list_customers', description: 'List customers, optionally loyalty-only' },
    { name: 'get_customer_purchases', description: 'Purchase history for a customer' },
    { name: 'get_top_customers', description: 'Top customers by spending' },
    { name: 'run_query', description: 'Run ad-hoc read-only SQL queries' },
    { name: 'get_schema', description: 'View the database schema' },
  ];

  tableTools = [
    { name: 'get_all_tables', description: 'Current status of all café tables' },
    { name: 'get_dirty_tables', description: 'List tables needing cleaning' },
    { name: 'get_occupied_tables', description: 'List tables currently in use' },
    { name: 'get_clean_tables', description: 'List available tables' },
    { name: 'get_table_history', description: 'State change timeline for a table' },
    { name: 'get_table_stats', description: 'Aggregate stats (avg dirty duration)' },
    { name: 'mark_table_cleared', description: 'Mark a table as cleared by staff' },
    { name: 'mark_table_occupied', description: 'Mark a table as occupied' },
    { name: 'get_service_status', description: 'MQTT connection and service health' },
  ];

  constructor(
    private mcpService: McpService,
    private snackBar: MatSnackBar,
    public experienceService: ExperienceService,
    private settingsService: SettingsService,
  ) {
    this.isCafe = this.experienceService.current === 'cafe';
  }

  ngOnInit(): void {
    this.refreshStatus();
    this.loadConfig();
    this.loadSettings();
    this.pollInterval = setInterval(() => this.refreshStatus(), 5000);
  }

  ngOnDestroy(): void {
    clearInterval(this.pollInterval);
  }

  refreshStatus(): void {
    this.mcpService.getStatus().subscribe({
      next: (status) => this.mcpStatus = status,
      error: () => {}
    });
  }

  loadConfig(): void {
    this.mcpService.getConfig().subscribe({
      next: (config) => this.mcpConfig = config,
      error: () => {}
    });
  }

  toggleMcp(enabled: boolean): void {
    if (enabled) {
      this.mcpService.start().subscribe({
        next: () => {
          this.refreshStatus();
          this.snackBar.open(`POS MCP server started (${this.experienceService.current} DB)`, 'OK', { duration: 3000 });
        },
        error: () => {
          this.snackBar.open('Failed to start POS MCP server', 'OK', { duration: 3000 });
        }
      });
    } else {
      this.mcpService.stop().subscribe({
        next: () => {
          this.refreshStatus();
          this.snackBar.open('POS MCP server stopped', 'OK', { duration: 3000 });
        },
        error: () => {
          this.snackBar.open('Failed to stop POS MCP server', 'OK', { duration: 3000 });
        }
      });
    }
  }

  toggleTableStatus(enabled: boolean): void {
    if (enabled) {
      this.mcpService.startTableStatus().subscribe({
        next: () => {
          this.refreshStatus();
          this.snackBar.open('Table Status MCP server started', 'OK', { duration: 3000 });
        },
        error: () => {
          this.snackBar.open('Failed to start Table Status MCP server', 'OK', { duration: 3000 });
        }
      });
    } else {
      this.mcpService.stopTableStatus().subscribe({
        next: () => {
          this.refreshStatus();
          this.snackBar.open('Table Status MCP server stopped', 'OK', { duration: 3000 });
        },
        error: () => {
          this.snackBar.open('Failed to stop Table Status MCP server', 'OK', { duration: 3000 });
        }
      });
    }
  }

  loadSettings(): void {
    this.settingsService.getSettings().subscribe({
      next: (s) => this.settings = s,
      error: () => {}
    });
  }

  toggleStockCheck(enabled: boolean): void {
    this.settingsService.updateSettings({ stockCheckEnabled: enabled }).subscribe({
      next: (s) => {
        this.settings = s;
        this.snackBar.open(
          enabled ? 'Stock checking enabled' : 'Stock checking disabled (infinite stock)',
          'OK', { duration: 3000 }
        );
      },
      error: () => {
        this.snackBar.open('Failed to update setting', 'OK', { duration: 3000 });
      }
    });
  }

  saveAgentSettings(): void {
    const patch = {
      agentMaxTokens: Number(this.settings.agentMaxTokens),
      agentTemperature: Number(this.settings.agentTemperature),
      agentHistoryLimit: Number(this.settings.agentHistoryLimit),
    };
    this.settingsService.updateSettings(patch).subscribe({
      next: (s) => { this.settings = s; this.snackBar.open('Agent settings saved', 'OK', { duration: 3000 }); },
      error: () => this.snackBar.open('Failed to save agent settings', 'OK', { duration: 3000 }),
    });
  }

  clearTransactions(): void {
    if (!confirm('Are you sure? This will permanently delete ALL transactions for the ' + this.experienceService.current + ' experience.')) {
      return;
    }
    this.settingsService.clearTransactions().subscribe({
      next: () => {
        this.snackBar.open('All transactions cleared', 'OK', { duration: 3000 });
      },
      error: () => {
        this.snackBar.open('Failed to clear transactions', 'OK', { duration: 3000 });
      }
    });
  }

  replenishStock(): void {
    this.settingsService.replenishStock().subscribe({
      next: (r) => {
        this.snackBar.open(`Stock replenished to 999 units for ${r.updated} products`, 'OK', { duration: 3000 });
      },
      error: () => {
        this.snackBar.open('Failed to replenish stock', 'OK', { duration: 3000 });
      }
    });
  }
}
