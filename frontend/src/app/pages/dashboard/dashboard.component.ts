/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { forkJoin, Subscription, interval } from 'rxjs';
import { TransactionService, Transaction } from '../../services/transaction.service';
import { ProductService, Product } from '../../services/product.service';
import { ThemeService } from '../../services/theme.service';

interface TableState {
  id: string;
  status: 'clean' | 'occupied' | 'dirty';
  lastChanged?: string;
  occupiedBy?: string | null;
}

interface FeedItem {
  tag: string;
  tagClass: string;
  label: string;
  text: string;
  time: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
  <div class="ops-hub" [class.collapsed]="collapsed">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">◎</span>
        <span class="brand-text">tapway<span class="brand-dot">●</span></span>
      </div>

      <nav class="nav">
        <a class="nav-item active">
          <span class="nav-ico">🟢</span><span class="nav-label">Dashboard</span>
          <span class="nav-live"></span>
        </a>
        <a class="nav-item" routerLink="/simulator">
          <span class="nav-ico">🧊</span><span class="nav-label">3D Cafe</span>
        </a>
        <a class="nav-item" routerLink="/pos">
          <span class="nav-ico">🛒</span><span class="nav-label">Sales</span>
        </a>
        <a class="nav-item" routerLink="/chat">
          <span class="nav-ico">👥</span><span class="nav-label">CRM</span>
        </a>
        <a class="nav-item" routerLink="/transactions">
          <span class="nav-ico">📦</span><span class="nav-label">Inventory</span>
        </a>
        <a class="nav-item" routerLink="/config">
          <span class="nav-ico">⚙️</span><span class="nav-label">Operations</span>
        </a>
      </nav>

      <div class="sidebar-footer">
        <button class="foot-btn" (click)="collapsed = !collapsed">
          <span>{{ collapsed ? '›' : '‹' }}</span><span class="nav-label">Collapse</span>
        </button>
        <button class="foot-btn" (click)="themeService.toggleTheme()">
          <span>{{ themeService.isDark() ? '🌙' : '🔆' }}</span>
          <span class="nav-label">{{ themeService.isDark() ? 'Dark Mode' : 'Light Mode' }}</span>
        </button>
        <div class="tagline">Turning Vision into Actions</div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="content">
      <!-- Header -->
      <header class="hub-header">
        <div class="hub-title">
          <h1>Cafe Operations Hub</h1>
          <span class="badge-nrf">NRF 2026</span>
        </div>
        <div class="live-indicator"><span class="live-dot"></span> LIVE</div>
      </header>

      <!-- KPI row 1 -->
      <section class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-ico">🎃</div>
          <div class="kpi-value accent-green">\${{ todayRevenue | number:'1.2-2' }}</div>
          <div class="kpi-label">Today's Revenue</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-ico">🧾</div>
          <div class="kpi-value">{{ totalTransactions | number }}</div>
          <div class="kpi-label">Transactions</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-ico">📊</div>
          <div class="kpi-value accent-blue">\${{ avgOrder | number:'1.2-2' }}</div>
          <div class="kpi-label">Avg Order</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-ico">👥</div>
          <div class="kpi-value">{{ activeCustomers }}</div>
          <div class="kpi-label">Active Customers</div>
        </div>
      </section>

      <!-- KPI row 2 -->
      <section class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-ico dot-green">●</div>
          <div class="kpi-value accent-green">{{ occupiedTables }}</div>
          <div class="kpi-label">Occupied Tables</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-ico">🧹</div>
          <div class="kpi-value">{{ dirtyTables }}</div>
          <div class="kpi-label">Dirty Tables</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-ico">📈</div>
          <div class="kpi-value accent-purple">\${{ monthSales | number:'1.2-2' }}</div>
          <div class="kpi-label">Total Sales (Month)</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-ico">🏆</div>
          <div class="kpi-value kpi-value-sm accent-amber">{{ topProduct || '—' }}</div>
          <div class="kpi-label">Top Product</div>
        </div>
      </section>

      <!-- Middle row: trend | table status | inventory -->
      <section class="mid-grid">
        <!-- Revenue trend -->
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">📊 Revenue Trend (Hourly)</span>
          </div>
          <svg class="trend-chart" viewBox="0 0 520 220" preserveAspectRatio="none">
            <g class="grid">
              <line *ngFor="let y of [0,1,2,3,4]" x1="40" [attr.y1]="20 + y*40" x2="510" [attr.y2]="20 + y*40"/>
            </g>
            <g class="axis-labels">
              <text *ngFor="let v of yLabels; let i = index" x="32" [attr.y]="24 + i*40" text-anchor="end">{{ v }}</text>
            </g>
            <path class="trend-area" [attr.d]="areaPath"></path>
            <path class="trend-line" [attr.d]="linePath"></path>
            <g>
              <circle *ngFor="let p of points" class="trend-dot" [attr.cx]="p.x" [attr.cy]="p.y" r="3"></circle>
            </g>
            <g class="x-labels">
              <text *ngFor="let p of points; let i = index" [attr.x]="p.x" y="212" text-anchor="middle">{{ hourLabels[i] }}</text>
            </g>
          </svg>
        </div>

        <!-- Table Status (was Kitchen Compliance) -->
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">🍽️ Table Status</span>
            <span class="panel-time">{{ clock }}</span>
          </div>
          <div class="gauge-wrap">
            <svg class="gauge" viewBox="0 0 140 140">
              <circle class="gauge-track" cx="70" cy="70" r="52"></circle>
              <circle class="gauge-fill" cx="70" cy="70" r="52"
                      [attr.stroke-dasharray]="gaugeCirc"
                      [attr.stroke-dashoffset]="gaugeOffset"
                      transform="rotate(-90 70 70)"></circle>
              <text class="gauge-pct" x="70" y="78" text-anchor="middle">{{ availablePct }}%</text>
            </svg>
            <div class="gauge-legend">
              <div class="legend-main">
                <strong>{{ cleanTables }} available</strong> · {{ busyTables }} busy
              </div>
              <div class="legend-sub">of {{ totalTables }} tables</div>
              <div class="legend-line"></div>
            </div>
          </div>
        </div>

        <!-- Inventory -->
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">🧃 Inventory</span>
            <span class="panel-flag" *ngIf="lowStock.length">{{ lowStock.length }} low-stock items</span>
          </div>
          <div class="inv-bars">
            <div class="inv-row" *ngFor="let p of lowStock.slice(0, 5)">
              <span class="inv-name">{{ p.name }}</span>
              <div class="inv-bar"><div class="inv-fill" [style.width.%]="stockPct(p)"></div></div>
              <span class="inv-qty">{{ p.stock_quantity }}</span>
            </div>
            <div class="inv-empty" *ngIf="!lowStock.length">All items in healthy stock.</div>
          </div>
          <div class="feed-sub">AI Detection Feed</div>
          <div class="detect-feed">
            <div class="detect-row" *ngFor="let d of detectionFeed">
              <span class="detect-ico">🔍</span>
              <span class="detect-text">⚠️ {{ d.text }}</span>
              <span class="detect-time">{{ d.time }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Bottom row: workflow events | agent activity -->
      <section class="bot-grid">
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">🏃 Workflow Engine Events</span>
            <span class="panel-conn"><span class="conn-dot"></span> Connected</span>
          </div>
          <div class="event-list">
            <div class="event-row" *ngFor="let e of workflowEvents">
              <div class="event-top">
                <span class="event-tag">🏃 {{ e.tag }}</span>
              </div>
              <div class="event-text">{{ e.text }}</div>
              <div class="event-meta">{{ e.time }} · Testing <span class="match">{{ e.label }}</span></div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">⚡ Live Agent Activity</span>
          </div>
          <div class="agent-list">
            <div class="agent-row" *ngFor="let a of agentActivity">
              <div class="agent-top">
                <span class="agent-dot" [ngClass]="a.tagClass"></span>
                <span class="agent-tag" [ngClass]="a.tagClass">{{ a.tag }}</span>
                <span class="agent-sub">{{ a.label }}</span>
                <span class="agent-time">{{ a.time }}</span>
              </div>
              <div class="agent-text">{{ a.text }}</div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
  `,
  styles: [`
    :host { display: block; }
    .ops-hub {
      display: grid;
      grid-template-columns: 210px 1fr;
      min-height: calc(100vh - 64px);
      background: #0a0e1a;
      color: #e5e7eb;
      font-family: 'Roboto', sans-serif;
    }
    .ops-hub.collapsed { grid-template-columns: 64px 1fr; }
    .ops-hub.collapsed .nav-label,
    .ops-hub.collapsed .brand-text,
    .ops-hub.collapsed .tagline { display: none; }

    /* Sidebar */
    .sidebar {
      background: #0b1020;
      border-right: 1px solid #1b2436;
      display: flex;
      flex-direction: column;
      padding: 18px 12px;
    }
    .brand { display: flex; align-items: center; gap: 8px; padding: 4px 8px 22px; font-weight: 700; }
    .brand-mark { color: #34d399; font-size: 20px; }
    .brand-text { font-size: 18px; letter-spacing: .5px; }
    .brand-dot { color: #34d399; font-size: 10px; margin-left: 2px; }
    .nav { display: flex; flex-direction: column; gap: 6px; flex: 1; }
    .nav-item {
      display: flex; align-items: center; gap: 12px;
      padding: 11px 12px; border-radius: 8px;
      color: #94a3b8; cursor: pointer; text-decoration: none;
      font-size: 14px; font-weight: 500; transition: background .2s, color .2s;
    }
    .nav-item:hover { background: #121a2b; color: #e5e7eb; }
    .nav-item.active { background: #13311f; color: #34d399; }
    .nav-ico { width: 18px; text-align: center; }
    .nav-live { width: 7px; height: 7px; border-radius: 50%; background: #34d399; margin-left: auto; }
    .sidebar-footer { display: flex; flex-direction: column; gap: 6px; padding-top: 14px; border-top: 1px solid #1b2436; }
    .foot-btn {
      display: flex; align-items: center; gap: 12px; background: none; border: none;
      color: #94a3b8; cursor: pointer; padding: 9px 12px; border-radius: 8px;
      font-size: 13px; font-family: inherit; text-align: left;
    }
    .foot-btn:hover { background: #121a2b; color: #e5e7eb; }
    .tagline { font-size: 11px; color: #4b5873; padding: 8px 12px 0; }

    /* Content */
    .content { padding: 18px 22px 28px; overflow-x: hidden; }
    .hub-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
    .hub-title { display: flex; align-items: center; gap: 12px; }
    .hub-title h1 { font-size: 20px; font-weight: 700; }
    .badge-nrf { font-size: 10px; font-weight: 700; color: #34d399; background: #10271c; border: 1px solid #1f4d36; padding: 3px 8px; border-radius: 10px; }
    .live-indicator { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #34d399; letter-spacing: .5px; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; animation: pulse 1.6s infinite; }
    @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:.35;} }

    /* KPI cards */
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }
    .kpi-card {
      background: #0f1626; border: 1px solid #1b2436; border-radius: 12px;
      padding: 16px 18px; min-height: 96px; position: relative;
    }
    .kpi-ico { position: absolute; top: 14px; left: 16px; font-size: 18px; opacity: .9; }
    .kpi-ico.dot-green { color: #34d399; font-size: 22px; }
    .kpi-value { font-size: 26px; font-weight: 700; margin-top: 30px; }
    .kpi-value-sm { font-size: 16px; }
    .kpi-label { font-size: 12px; color: #7c89a3; margin-top: 4px; }
    .accent-green { color: #34d399; }
    .accent-blue { color: #38bdf8; }
    .accent-purple { color: #a78bfa; }
    .accent-amber { color: #fbbf24; }

    /* Panels */
    .panel { background: #0f1626; border: 1px solid #1b2436; border-radius: 12px; padding: 16px; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .panel-title { font-size: 14px; font-weight: 700; }
    .panel-time, .panel-flag, .panel-conn { font-size: 11px; color: #7c89a3; }
    .panel-flag { color: #f87171; }
    .panel-conn { display: flex; align-items: center; gap: 5px; color: #34d399; }
    .conn-dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; }

    .mid-grid { display: grid; grid-template-columns: 1.3fr 1fr 1.3fr; gap: 14px; margin-bottom: 14px; }
    .bot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

    /* Trend chart */
    .trend-chart { width: 100%; height: 220px; }
    .trend-chart .grid line { stroke: #1b2436; stroke-width: 1; }
    .trend-chart .axis-labels text, .trend-chart .x-labels text { fill: #5b6a85; font-size: 9px; }
    .trend-area { fill: rgba(52,211,153,.12); stroke: none; }
    .trend-line { fill: none; stroke: #34d399; stroke-width: 2; }
    .trend-dot { fill: #34d399; }

    /* Gauge */
    .gauge-wrap { display: flex; align-items: center; gap: 16px; padding: 10px 0; }
    .gauge { width: 130px; height: 130px; flex-shrink: 0; }
    .gauge-track { fill: none; stroke: #1b2436; stroke-width: 10; }
    .gauge-fill { fill: none; stroke: #34d399; stroke-width: 10; stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
    .gauge-pct { fill: #34d399; font-size: 22px; font-weight: 700; }
    .gauge-legend { flex: 1; }
    .legend-main { font-size: 14px; color: #e5e7eb; }
    .legend-main strong { color: #34d399; }
    .legend-sub { font-size: 12px; color: #7c89a3; margin-top: 2px; }
    .legend-line { height: 2px; background: linear-gradient(90deg,#34d399,transparent); margin-top: 16px; border-radius: 2px; }

    /* Inventory */
    .inv-bars { display: flex; flex-direction: column; gap: 10px; }
    .inv-row { display: grid; grid-template-columns: 90px 1fr 24px; align-items: center; gap: 8px; }
    .inv-name { font-size: 12px; color: #c7d0e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .inv-bar { height: 6px; background: #1b2436; border-radius: 4px; overflow: hidden; }
    .inv-fill { height: 100%; background: #ef4444; border-radius: 4px; }
    .inv-qty { font-size: 12px; color: #94a3b8; text-align: right; }
    .inv-empty { font-size: 12px; color: #7c89a3; }
    .feed-sub { font-size: 11px; color: #5b6a85; margin: 16px 0 8px; }
    .detect-feed { display: flex; flex-direction: column; gap: 8px; max-height: 120px; overflow-y: auto; }
    .detect-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
    .detect-text { flex: 1; color: #cbd5e1; }
    .detect-time { color: #5b6a85; }

    /* Event / agent lists */
    .event-list, .agent-list { display: flex; flex-direction: column; gap: 16px; max-height: 240px; overflow-y: auto; padding-right: 6px; }
    .event-tag { font-size: 11px; font-weight: 700; color: #a78bfa; }
    .event-text { font-size: 13px; color: #cbd5e1; margin: 4px 0; }
    .event-meta { font-size: 10px; color: #5b6a85; }
    .event-meta .match { color: #34d399; }

    .agent-row { border-left: 2px solid #1b2436; padding-left: 10px; }
    .agent-top { display: flex; align-items: center; gap: 6px; }
    .agent-dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; }
    .agent-tag { font-size: 10px; font-weight: 700; letter-spacing: .4px; }
    .agent-sub { font-size: 10px; color: #5b6a85; }
    .agent-time { font-size: 10px; color: #5b6a85; margin-left: auto; }
    .agent-text { font-size: 12px; color: #cbd5e1; margin-top: 3px; }
    .tag-compliance, .agent-tag.tag-compliance { color: #38bdf8; }
    .tag-compliance.agent-dot { background: #38bdf8; }
    .tag-operations, .agent-tag.tag-operations { color: #34d399; }
    .tag-operations.agent-dot { background: #34d399; }
    .tag-sales, .agent-tag.tag-sales { color: #fbbf24; }
    .tag-sales.agent-dot { background: #fbbf24; }
    .tag-inventory, .agent-tag.tag-inventory { color: #f87171; }
    .tag-inventory.agent-dot { background: #f87171; }

    @media (max-width: 1100px) {
      .kpi-grid { grid-template-columns: repeat(2, 1fr); }
      .mid-grid, .bot-grid { grid-template-columns: 1fr; }
    }
  `]
})
export class DashboardComponent implements OnInit, OnDestroy {
  collapsed = false;
  clock = '';

  // KPIs
  todayRevenue = 0;
  totalTransactions = 0;
  avgOrder = 0;
  activeCustomers = 0;
  monthSales = 0;
  topProduct = '';

  // Tables
  totalTables = 0;
  cleanTables = 0;
  occupiedTables = 0;
  dirtyTables = 0;
  busyTables = 0;
  availablePct = 0;
  readonly gaugeCirc = 2 * Math.PI * 52;
  gaugeOffset = this.gaugeCirc;

  // Inventory
  lowStock: Product[] = [];
  detectionFeed: { text: string; time: string }[] = [];
  private reorderPoint = 5;

  // Trend chart
  points: { x: number; y: number }[] = [];
  linePath = '';
  areaPath = '';
  yLabels: number[] = [];
  hourLabels = ['8:00', '9:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];

  // Demo feeds
  workflowEvents: FeedItem[] = [
    { tag: 'PEOPLE_DETECTION', tagClass: '', label: '88% match', text: 'Multiple individuals are visible, including two standing in the foreground and others working in the background aisles.', time: '06:58:37 am' },
    { tag: 'PEOPLE_DETECTION', tagClass: '', label: '88% match', text: 'Multiple individuals are visible, including one walking in the foreground and others in the background.', time: '06:59:49 am' },
    { tag: 'PEOPLE_DETECTION', tagClass: '', label: '88% match', text: 'Multiple individuals are visible walking through the warehouse aisles and working near equipment.', time: '07:00:11 am' },
    { tag: 'PEOPLE_DETECTION', tagClass: '', label: '85% match', text: 'Multiple workers are visible throughout the facility.', time: '07:00:44 am' }
  ];
  agentActivity: FeedItem[] = [];

  private subs: Subscription[] = [];

  constructor(
    private http: HttpClient,
    private txService: TransactionService,
    private productService: ProductService,
    public themeService: ThemeService
  ) {}

  ngOnInit(): void {
    this.tickClock();
    this.subs.push(interval(1000).subscribe(() => this.tickClock()));
    this.loadData();
    this.subs.push(interval(15000).subscribe(() => this.loadData()));
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }

  private tickClock(): void {
    this.clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private loadData(): void {
    this.subs.push(
      forkJoin({
        stats: this.txService.getStats(),
        tables: this.http.get<TableState[]>('/api/chat/tables'),
        products: this.productService.getProducts(),
        txns: this.txService.getTransactions({ limit: 200 })
      }).subscribe({
        next: ({ stats, tables, products, txns }) => {
          this.applyStats(stats);
          this.applyTables(tables || []);
          this.applyProducts(products || []);
          this.buildTrend(txns || []);
          this.buildAgentActivity(tables || [], txns || []);
        },
        error: () => { /* keep last-known values on transient errors */ }
      })
    );
  }

  private applyStats(stats: any): void {
    this.totalTransactions = Number(stats?.total_transactions) || 0;
    this.todayRevenue = Number(stats?.total_revenue) || 0;
    this.avgOrder = Number(stats?.avg_transaction) || 0;
    this.monthSales = Number(stats?.total_revenue) || 0;
  }

  private applyTables(tables: TableState[]): void {
    this.totalTables = tables.length;
    this.cleanTables = tables.filter(t => t.status === 'clean').length;
    this.occupiedTables = tables.filter(t => t.status === 'occupied').length;
    this.dirtyTables = tables.filter(t => t.status === 'dirty').length;
    this.busyTables = this.occupiedTables + this.dirtyTables;
    this.activeCustomers = this.occupiedTables;
    this.availablePct = this.totalTables ? Math.round((this.cleanTables / this.totalTables) * 100) : 0;
    this.gaugeOffset = this.gaugeCirc * (1 - this.availablePct / 100);
  }

  private applyProducts(products: Product[]): void {
    this.lowStock = products
      .filter(p => p.is_active !== false && Number(p.stock_quantity) <= this.reorderPoint)
      .sort((a, b) => Number(a.stock_quantity) - Number(b.stock_quantity));

    const top = [...products].sort((a, b) => Number(b.price) - Number(a.price))[0];
    this.topProduct = top ? top.name : '';

    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.detectionFeed = this.lowStock.slice(0, 4).map(p => ({
      text: `Low stock: ${p.name} (${p.stock_quantity} left, reorder at ${this.reorderPoint}). Alert triggered.`,
      time: now
    }));
  }

  stockPct(p: Product): number {
    return Math.min(100, (Number(p.stock_quantity) / this.reorderPoint) * 100);
  }

  private buildTrend(txns: Transaction[]): void {
    const startHour = 8;
    const buckets = new Array(this.hourLabels.length).fill(0);
    for (const t of txns) {
      const h = new Date(t.created_at).getHours();
      const idx = h - startHour;
      if (idx >= 0 && idx < buckets.length) buckets[idx] += Number(t.total) || 0;
    }

    const maxVal = Math.max(...buckets, 1);
    const niceMax = Math.ceil(maxVal / 150) * 150 || 600;
    this.yLabels = [niceMax, Math.round(niceMax * 0.75), Math.round(niceMax * 0.5), Math.round(niceMax * 0.25), 0];

    const x0 = 40, x1 = 510, yTop = 20, yBottom = 180;
    const n = buckets.length;
    this.points = buckets.map((v, i) => ({
      x: n > 1 ? x0 + (x1 - x0) * (i / (n - 1)) : x0,
      y: yBottom - (yBottom - yTop) * (v / niceMax)
    }));

    this.linePath = this.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    if (this.points.length) {
      const first = this.points[0], last = this.points[this.points.length - 1];
      this.areaPath = `M${first.x.toFixed(1)},${yBottom} ` +
        this.points.map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
        ` L${last.x.toFixed(1)},${yBottom} Z`;
    }
  }

  private buildAgentActivity(tables: TableState[], txns: Transaction[]): void {
    const feed: FeedItem[] = [];
    const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    feed.push({ tag: 'COMPLIANCE', tagClass: 'tag-compliance', label: 'compliance_audit', text: '**Kitchen Compliance Audit #821**', time: time() });

    const dirty = tables.find(t => t.status === 'dirty');
    if (dirty) {
      feed.push({ tag: 'OPERATIONS', tagClass: 'tag-operations', label: 'cleaning', text: `🧹 ${dirty.id} is dirty — cleaning dispatched`, time: time() });
    }

    const latest = txns[0];
    if (latest) {
      const items = (latest.items || []).map(i => `${i.quantity}x ${i.product_name}`).join(', ');
      feed.push({ tag: 'SALES', tagClass: 'tag-sales', label: `txn #${latest.transaction_number}`, text: `${items || 'Order'} — RM ${Number(latest.total).toFixed(2)} (${latest.customer_name || latest.staff_name || 'Guest'})`, time: time() });
    }

    const low = this.lowStock[0];
    if (low) {
      feed.push({ tag: 'SMART-INVENTORY', tagClass: 'tag-inventory', label: 'low_stock', text: `⚠️ Low stock: ${low.name} (${low.stock_quantity} left, reorder at ${this.reorderPoint}). Alert triggered.`, time: time() });
    }

    const occupied = tables.find(t => t.status === 'occupied');
    if (occupied) {
      feed.push({ tag: 'OPERATIONS', tagClass: 'tag-operations', label: 'seating', text: `🧍 ${occupied.occupiedBy || 'Guest'} seated at ${occupied.id}`, time: time() });
    }

    this.agentActivity = feed;
  }
}
