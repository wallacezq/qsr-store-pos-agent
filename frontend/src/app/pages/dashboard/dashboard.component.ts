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
import { ExperienceService } from '../../services/experience.service';

interface TableState {
  id: string;
  status: 'clean' | 'occupied' | 'dirty';
  lastChanged?: string;
  occupiedBy?: string | null;
}

interface RawEvent {
  topic: string;
  eventType: string;
  severity: string;
  experience: string | null;
  source: string;
  ref: string | null;
  occurredAt: string;
  payload: any;
}

interface WorkflowEvent {
  tag: string;
  severity: string;
  source: string;
  text: string;
  time: string;
  topic: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
  <div class="ops-hub">
    <!-- Main content -->
    <main class="content">
      <!-- Header -->
      <header class="hub-header">
        <div class="hub-title">
          <h1>Operation Insights</h1>
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

      <!-- Bottom row: workflow engine events (live MQTT feed) -->
      <section class="bot-grid">
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">🏃 Workflow Engine Events</span>
            <span class="panel-conn" [class.offline]="!eventsConnected">
              <span class="conn-dot"></span> {{ eventsConnected ? 'Connected' : 'Disconnected' }}
            </span>
          </div>
          <div class="event-list">
            <div class="event-row" *ngFor="let e of workflowEvents">
              <div class="event-top">
                <span class="event-tag" [ngClass]="'sev-' + e.severity">🏃 {{ e.tag }}</span>
                <span class="event-src">{{ e.source }}</span>
                <span class="event-time">{{ e.time }}</span>
              </div>
              <div class="event-text">{{ e.text }}</div>
              <div class="event-meta">{{ e.topic }}</div>
            </div>
            <div class="event-empty" *ngIf="!workflowEvents.length">
              Waiting for MQTT workflow events…
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
      min-height: calc(100vh - 64px);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-family: 'Roboto', sans-serif;
      transition: background-color 0.3s, color 0.3s;
    }

    /* Content */
    .content { padding: 18px 22px 28px; overflow-x: hidden; }
    .hub-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
    .hub-title { display: flex; align-items: center; gap: 12px; }
    .hub-title h1 { font-size: 20px; font-weight: 700; }
    .badge-nrf { font-size: 10px; font-weight: 700; color: var(--success); background: rgba(76,175,80,.14); border: 1px solid rgba(76,175,80,.4); padding: 3px 8px; border-radius: 10px; }
    .live-indicator { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--success); letter-spacing: .5px; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); animation: pulse 1.6s infinite; }
    @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:.35;} }

    /* KPI cards */
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }
    .kpi-card {
      background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
      padding: 16px 18px; min-height: 96px; position: relative;
      transition: background-color 0.3s, border-color 0.3s;
    }
    .kpi-ico { position: absolute; top: 14px; left: 16px; font-size: 18px; opacity: .9; }
    .kpi-ico.dot-green { color: var(--success); font-size: 22px; }
    .kpi-value { font-size: 26px; font-weight: 700; margin-top: 30px; }
    .kpi-value-sm { font-size: 16px; }
    .kpi-label { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
    .accent-green { color: var(--success); }
    .accent-blue { color: #38bdf8; }
    .accent-purple { color: #a78bfa; }
    .accent-amber { color: #f0a020; }

    /* Panels */
    .panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; transition: background-color 0.3s, border-color 0.3s; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .panel-title { font-size: 14px; font-weight: 700; }
    .panel-time, .panel-flag, .panel-conn { font-size: 11px; color: var(--text-secondary); }
    .panel-flag { color: #e5484d; }
    .panel-conn { display: flex; align-items: center; gap: 5px; color: var(--success); }
    .conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }

    .mid-grid { display: grid; grid-template-columns: 1.3fr 1fr 1.3fr; gap: 14px; margin-bottom: 14px; }
    .bot-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }

    /* Trend chart */
    .trend-chart { width: 100%; height: 220px; }
    .trend-chart .grid line { stroke: var(--border); stroke-width: 1; }
    .trend-chart .axis-labels text, .trend-chart .x-labels text { fill: var(--text-secondary); font-size: 9px; }
    .trend-area { fill: rgba(76,175,80,.14); stroke: none; }
    .trend-line { fill: none; stroke: var(--success); stroke-width: 2; }
    .trend-dot { fill: var(--success); }

    /* Gauge */
    .gauge-wrap { display: flex; align-items: center; gap: 16px; padding: 10px 0; }
    .gauge { width: 130px; height: 130px; flex-shrink: 0; }
    .gauge-track { fill: none; stroke: var(--border); stroke-width: 10; }
    .gauge-fill { fill: none; stroke: var(--success); stroke-width: 10; stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
    .gauge-pct { fill: var(--success); font-size: 22px; font-weight: 700; }
    .gauge-legend { flex: 1; }
    .legend-main { font-size: 14px; color: var(--text-primary); }
    .legend-main strong { color: var(--success); }
    .legend-sub { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
    .legend-line { height: 2px; background: linear-gradient(90deg,var(--success),transparent); margin-top: 16px; border-radius: 2px; }

    /* Inventory */
    .inv-bars { display: flex; flex-direction: column; gap: 10px; }
    .inv-row { display: grid; grid-template-columns: 90px 1fr 24px; align-items: center; gap: 8px; }
    .inv-name { font-size: 12px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .inv-bar { height: 6px; background: var(--border); border-radius: 4px; overflow: hidden; }
    .inv-fill { height: 100%; background: #e5484d; border-radius: 4px; }
    .inv-qty { font-size: 12px; color: var(--text-secondary); text-align: right; }
    .inv-empty { font-size: 12px; color: var(--text-secondary); }
    .feed-sub { font-size: 11px; color: var(--text-secondary); margin: 16px 0 8px; }
    .detect-feed { display: flex; flex-direction: column; gap: 8px; max-height: 120px; overflow-y: auto; }
    .detect-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
    .detect-text { flex: 1; color: var(--text-primary); }
    .detect-time { color: var(--text-secondary); }

    /* Workflow event list (live MQTT feed) */
    .event-list { display: flex; flex-direction: column; gap: 14px; max-height: 300px; overflow-y: auto; padding-right: 6px; }
    .event-row { border-left: 2px solid #1b2436; padding-left: 10px; }
    .event-top { display: flex; align-items: center; gap: 8px; }
    .event-tag { font-size: 11px; font-weight: 700; color: #8b5cf6; }
    .event-tag.sev-warning { color: #f0a020; }
    .event-tag.sev-critical { color: #e5484d; }
    .event-src { font-size: 10px; color: var(--text-secondary); }
    .event-time { font-size: 10px; color: var(--text-secondary); margin-left: auto; }
    .event-text { font-size: 13px; color: var(--text-primary); margin: 4px 0; }
    .event-meta { font-size: 10px; color: var(--text-secondary); }
    .event-empty { font-size: 12px; color: var(--text-secondary); padding: 8px 0; }
    .panel-conn.offline { color: #e5484d; }
    .panel-conn.offline .conn-dot { background: #e5484d; }

    @media (max-width: 1100px) {
      .kpi-grid { grid-template-columns: repeat(2, 1fr); }
      .mid-grid, .bot-grid { grid-template-columns: 1fr; }
    }
  `]
})
export class DashboardComponent implements OnInit, OnDestroy {
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

  // Workflow Engine Events — live MQTT feed
  workflowEvents: WorkflowEvent[] = [];
  eventsConnected = false;
  private eventSource: EventSource | null = null;
  private readonly maxEvents = 50;

  private subs: Subscription[] = [];

  constructor(
    private http: HttpClient,
    private txService: TransactionService,
    private productService: ProductService,
    public themeService: ThemeService,
    private experienceService: ExperienceService
  ) {}

  ngOnInit(): void {
    this.tickClock();
    this.subs.push(interval(1000).subscribe(() => this.tickClock()));
    this.loadData();
    this.subs.push(interval(15000).subscribe(() => this.loadData()));
    this.loadRecentEvents();
    this.connectEvents();
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
    this.eventSource?.close();
  }

  private tickClock(): void {
    this.clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private loadData(): void {
    this.subs.push(
      forkJoin({
        stats: this.txService.getStats(),
        tables: this.http.get<Record<string, TableState>>('/api/chat/tables'),
        products: this.productService.getProducts(),
        txns: this.txService.getTransactions({ limit: 200 })
      }).subscribe({
        next: ({ stats, tables, products, txns }) => {
          this.applyStats(stats);
          this.applyTables(Object.values(tables || {}));
          this.applyProducts(products || []);
          this.buildTrend(txns || []);
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

  private loadRecentEvents(): void {
    const exp = this.experienceService.current;
    this.subs.push(
      this.http.get<{ connected: boolean; events: RawEvent[] }>(`/api/events/recent?experience=${exp}`).subscribe({
        next: ({ connected, events }) => {
          this.eventsConnected = connected;
          this.workflowEvents = (events || []).slice(0, this.maxEvents).map(e => this.toWorkflowEvent(e));
        },
        error: () => { /* stream will still try to connect */ }
      })
    );
  }

  private connectEvents(): void {
    const exp = this.experienceService.current;
    this.eventSource = new EventSource(`/api/events/stream?experience=${exp}`);
    this.eventSource.onopen = () => { this.eventsConnected = true; };
    this.eventSource.onerror = () => { this.eventsConnected = false; };
    this.eventSource.onmessage = (msg) => {
      try {
        const raw: RawEvent = JSON.parse(msg.data);
        this.workflowEvents = [this.toWorkflowEvent(raw), ...this.workflowEvents].slice(0, this.maxEvents);
        this.eventsConnected = true;
      } catch { /* ignore malformed frames */ }
    };
  }

  private toWorkflowEvent(e: RawEvent): WorkflowEvent {
    return {
      tag: (e.eventType || 'event').replace(/[._]/g, ' ').toUpperCase(),
      severity: e.severity || 'info',
      source: e.source || 'mqtt',
      text: this.describeEvent(e),
      time: new Date(e.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      topic: e.topic
    };
  }

  private describeEvent(e: RawEvent): string {
    const p = e.payload || {};
    const ref = e.ref ? ` [${e.ref}]` : '';
    switch (e.eventType) {
      case 'customer.arrived': return `Customer arrived${p.zone ? ' in ' + p.zone : ''}.`;
      case 'customer.departed': return `Customer departed${ref}.`;
      case 'table.occupied': return `Table occupied${ref}.`;
      case 'table.dirty': return `Table needs cleaning${ref}.`;
      case 'table.cleared': return `Table cleared and clean${ref}.`;
      case 'order.placed': return `Order placed${p.total ? ' — ' + p.total : ''}${ref}.`;
      case 'order.completed': return `Order completed${ref}.`;
      case 'queue.depth_changed': return `Queue depth is now ${p.depth ?? '—'}.`;
      case 'footfall.count': return `${p.count ?? '—'} people detected${p.zone ? ' in ' + p.zone : ''}.`;
      case 'zone.density_changed': return `Zone density changed to ${p.level ?? '—'}${p.zone ? ' in ' + p.zone : ''}.`;
      default:
        if (p.message) return String(p.message);
        return `${e.eventType}${ref}`;
    }
  }
}
