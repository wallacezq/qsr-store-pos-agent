/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { interval, Subscription } from 'rxjs';
import { CameraService, Camera, VisionEvent, NewCamera } from '../../services/camera.service';
import { ModelService, GroupedModels, VisionModel, NewModel, ModelPurpose, VisionStatus } from '../../services/model.service';

@Component({
  selector: 'app-monitor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div class="monitor">
    <header class="mon-header">
      <div class="mon-title">
        <span class="mon-eyebrow">AI Vision</span>
        <h1>Live Monitor</h1>
      </div>
      <button class="btn-primary" *ngIf="tab === 'cameras'" (click)="showAdd = !showAdd">
        {{ showAdd ? 'Close' : '+ Add Camera' }}
      </button>
    </header>

    <nav class="tabs">
      <button class="tab" [class.active]="tab === 'cameras'" (click)="tab = 'cameras'">Cameras</button>
      <button class="tab" [class.active]="tab === 'models'" (click)="tab = 'models'">Models</button>
      <div class="vision-status" *ngIf="status">
        <span class="vs-dot" [class.live]="status.realEnabled"></span>
        {{ status.realEnabled ? 'DLStreamer' : 'Simulation' }} · {{ status.invoke }}
        <span class="vs-img" *ngIf="status.realEnabled" [title]="status.image">{{ status.image }}</span>
      </div>
    </nav>

    <!-- CAMERAS TAB -->
    <ng-container *ngIf="tab === 'cameras'">
    <!-- Add camera form -->
    <section class="add-card" *ngIf="showAdd">
      <div class="add-grid">
        <label>Name<input [(ngModel)]="draft.name" placeholder="restaurant_cam1"></label>
        <label>Protocol
          <select [(ngModel)]="draft.protocol">
            <option value="rtsp">RTSP</option>
            <option value="onvif">ONVIF</option>
          </select>
        </label>
        <label class="wide">Stream URL
          <input [(ngModel)]="draft.url" placeholder="rtsp://user:pass@192.168.1.10:554/stream">
        </label>
        <label>Zone<input [(ngModel)]="draft.zone" placeholder="Zone A"></label>
        <label>Inference Device
          <select [(ngModel)]="draft.device">
            <option value="CPU">CPU</option>
            <option value="GPU">GPU</option>
            <option value="NPU">NPU</option>
          </select>
        </label>
      </div>
      <div class="add-actions">
        <span class="add-error" *ngIf="addError">{{ addError }}</span>
        <button class="btn-primary" [disabled]="!draft.url || saving" (click)="addCamera()">
          {{ saving ? 'Adding…' : 'Add Camera' }}
        </button>
      </div>
    </section>

    <!-- Live feed grid -->
    <section class="feeds">
      <div class="feed-card" *ngFor="let cam of cameras">
        <div class="feed-top">
          <span class="feed-name">📹 {{ cam.name }}</span>
          <span class="feed-badge" [ngClass]="healthClass(cam)">{{ healthLabel(cam) }}</span>
        </div>
        <div class="feed-view">
          <img *ngIf="!failed.has(cam.id)" [src]="feedUrl(cam)" (error)="onImgError(cam.id)" alt="feed">
          <div class="feed-placeholder" *ngIf="failed.has(cam.id)">
            <span class="ph-icon">🎥</span>
            <span class="ph-text">{{ cam.mode === 'simulated' ? 'SIMULATED FEED' : 'NO SIGNAL' }}</span>
          </div>
          <div class="feed-overlay" *ngIf="latestByCamera[cam.id] as ev">
            <span class="ov-state" [ngClass]="'state-' + ev.state">{{ ev.eventType }}</span>
            <span class="ov-conf">{{ (ev.confidence * 100) | number:'1.0-0' }}%</span>
          </div>
          <span class="feed-zone">{{ cam.zone }}</span>
        </div>
        <div class="feed-foot">
          <span class="feed-url" [title]="cam.url">{{ cam.url }}</span>
          <div class="feed-controls">
            <button class="icon-btn" *ngIf="cam.status !== 'detecting'" (click)="start(cam)" title="Start">▶</button>
            <button class="icon-btn" *ngIf="cam.status === 'detecting'" (click)="stop(cam)" title="Stop">⏸</button>
            <button class="icon-btn danger" (click)="remove(cam)" title="Remove">🗑</button>
          </div>
        </div>
      </div>

      <div class="feeds-empty" *ngIf="!cameras.length">
        No cameras yet. Click <strong>+ Add Camera</strong> to connect an RTSP/ONVIF stream.
      </div>
    </section>

    <!-- Event stream -->
    <section class="event-stream">
      <div class="es-head">
        <div>
          <span class="es-title">⦿ Event stream</span>
          <span class="es-sub">Table detections (empty / occupied / dirty) across all cameras.</span>
        </div>
        <select class="es-filter" [(ngModel)]="statusFilter">
          <option value="">All statuses</option>
          <option value="VERIFIED">Verified</option>
          <option value="PENDING REVIEW">Pending review</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>
      <table class="es-table">
        <thead>
          <tr><th>TIME</th><th>EVENT ID</th><th>EVENT TYPE</th><th>CAMERA</th><th>ZONE</th><th class="right">STATUS</th></tr>
        </thead>
        <tbody>
          <tr *ngFor="let ev of filteredEvents()">
            <td class="mono">{{ ev.occurredAt | date:'HH:mm:ss' }}</td>
            <td class="mono">{{ ev.eventId }}</td>
            <td><span class="etype" [ngClass]="'state-' + ev.state">{{ ev.eventType }}</span></td>
            <td>{{ ev.cameraName }}</td>
            <td>{{ ev.zone }}</td>
            <td class="right">
              <span class="status-badge" [ngClass]="statusClass(ev.status)">{{ ev.status }}</span>
            </td>
          </tr>
          <tr *ngIf="!filteredEvents().length">
            <td colspan="6" class="es-empty">Waiting for detections…</td>
          </tr>
        </tbody>
      </table>
    </section>
    </ng-container>

    <!-- MODELS TAB -->
    <ng-container *ngIf="tab === 'models'">
      <section class="add-card">
        <div class="add-grid">
          <label>Name<input [(ngModel)]="modelDraft.name" placeholder="yolov8n"></label>
          <label>Purpose
            <select [(ngModel)]="modelDraft.purpose">
              <option value="detection">Detection</option>
              <option value="classification">Classification</option>
              <option value="clip">CLIP (zero-shot)</option>
            </select>
          </label>
          <label class="wide">Model path (.xml)<input [(ngModel)]="modelDraft.modelPath" placeholder="/models/yolov8n/yolov8n.xml"></label>
          <label class="wide" *ngIf="modelDraft.purpose === 'clip'">Embeddings (.safetensors)<input [(ngModel)]="modelDraft.embeddingsPath" placeholder="/models/clip/table-states.safetensors"></label>
          <label *ngIf="modelDraft.purpose === 'classification'">Labels file<input [(ngModel)]="modelDraft.labelsFile" placeholder="/models/labels.txt"></label>
          <label>Device
            <select [(ngModel)]="modelDraft.device">
              <option value="">(camera default)</option>
              <option value="CPU">CPU</option>
              <option value="GPU">GPU</option>
              <option value="NPU">NPU</option>
            </select>
          </label>
        </div>
        <div class="add-actions">
          <span class="add-error" *ngIf="modelError">{{ modelError }}</span>
          <button class="btn-primary" [disabled]="!modelDraft.modelPath || modelSaving" (click)="addModel()">
            {{ modelSaving ? 'Adding…' : 'Add Model' }}
          </button>
        </div>
      </section>

      <section class="model-group" *ngFor="let g of purposeGroups">
        <h3 class="mg-title">{{ g.label }} <span class="mg-count">{{ (models[g.key] || []).length }}</span></h3>
        <div class="model-list">
          <div class="model-row" *ngFor="let m of models[g.key]" [class.active]="m.active">
            <div class="model-info">
              <span class="model-name">{{ m.name }} <span class="active-pill" *ngIf="m.active">ACTIVE</span></span>
              <span class="model-path">{{ m.modelPath }}</span>
              <span class="model-path sub" *ngIf="m.embeddingsPath">⟐ {{ m.embeddingsPath }}</span>
              <span class="model-path sub" *ngIf="m.labelsFile">🟐 {{ m.labelsFile }}</span>
            </div>
            <div class="model-controls">
              <button class="icon-btn" *ngIf="!m.active" (click)="activateModel(m)" title="Set active">★</button>
              <button class="icon-btn danger" (click)="removeModel(m)" title="Delete">🗑</button>
            </div>
          </div>
          <div class="model-empty" *ngIf="!(models[g.key] || []).length">No {{ g.label.toLowerCase() }} models registered.</div>
        </div>
      </section>
    </ng-container>
  </div>
  `,
  styles: [`
    :host { display: block; }
    .monitor { min-height: calc(100vh - 64px); background: var(--bg-primary); color: var(--text-primary); padding: 18px 22px 28px; }
    .mon-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
    .mon-eyebrow { font-size: 11px; color: var(--text-secondary); letter-spacing: .5px; }
    .mon-title h1 { font-size: 22px; font-weight: 700; }
    .btn-primary { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 9px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn-primary:disabled { opacity: .5; cursor: default; }

    .tabs { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); margin-bottom: 18px; }
    .tab { background: none; border: none; color: var(--text-secondary); font-size: 13px; font-weight: 600; padding: 10px 14px; cursor: pointer; border-bottom: 2px solid transparent; }
    .tab.active { color: var(--text-primary); border-bottom-color: var(--accent); }
    .vision-status { margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-secondary); }
    .vs-dot { width: 8px; height: 8px; border-radius: 50%; background: #f0a020; }
    .vs-dot.live { background: #34d399; }
    .vs-img { color: var(--text-secondary); opacity: .8; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .feed-badge.hb-detecting { color: #34d399; border-color: rgba(52,211,153,.4); }
    .feed-badge.hb-starting { color: #f0a020; border-color: rgba(240,160,32,.4); }
    .feed-badge.hb-sim { color: #38bdf8; border-color: rgba(56,189,248,.4); }
    .feed-badge.hb-off { color: var(--text-secondary); }

    .model-group { margin-bottom: 18px; }
    .mg-title { font-size: 13px; font-weight: 700; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
    .mg-count { font-size: 11px; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; }
    .model-list { display: flex; flex-direction: column; gap: 8px; }
    .model-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
    .model-row.active { border-color: rgba(52,211,153,.5); }
    .model-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .model-name { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .active-pill { font-size: 9px; font-weight: 700; color: #34d399; background: rgba(52,211,153,.14); border-radius: 8px; padding: 1px 6px; }
    .model-path { font-size: 11px; color: var(--text-secondary); font-family: 'Roboto Mono', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .model-path.sub { opacity: .8; }
    .model-controls { display: flex; gap: 4px; flex-shrink: 0; }
    .model-empty { font-size: 12px; color: var(--text-secondary); padding: 8px; }

    .add-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 18px; }
    .add-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .add-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); }
    .add-grid label.wide { grid-column: span 2; }
    .add-grid input, .add-grid select { background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary); border-radius: 6px; padding: 8px; font-size: 13px; }
    .add-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 12px; }
    .add-error { color: #e5484d; font-size: 12px; }

    .feeds { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .feed-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .feed-top { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; }
    .feed-name { font-size: 13px; font-weight: 600; }
    .feed-badge { font-size: 10px; font-weight: 700; letter-spacing: .4px; color: var(--text-secondary); border: 1px solid var(--border); border-radius: 10px; padding: 2px 8px; }
    .feed-badge.detecting { color: #34d399; border-color: rgba(52,211,153,.4); }
    .feed-view { position: relative; aspect-ratio: 16 / 9; background: #05070d; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .feed-view img { width: 100%; height: 100%; object-fit: cover; }
    .feed-placeholder { display: flex; flex-direction: column; align-items: center; gap: 6px; color: #5b6a85; }
    .ph-icon { font-size: 30px; opacity: .6; }
    .ph-text { font-size: 11px; letter-spacing: .5px; }
    .feed-overlay { position: absolute; top: 8px; left: 8px; display: flex; align-items: center; gap: 6px; }
    .ov-state { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 6px; color: #fff; }
    .ov-conf { font-size: 10px; color: #fff; background: rgba(0,0,0,.5); padding: 2px 6px; border-radius: 6px; }
    .feed-zone { position: absolute; bottom: 8px; right: 8px; font-size: 10px; color: #cbd5e1; background: rgba(0,0,0,.5); padding: 2px 8px; border-radius: 6px; }
    .feed-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; }
    .feed-url { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .feed-controls { display: flex; gap: 4px; flex-shrink: 0; }
    .icon-btn { background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary); border-radius: 6px; width: 28px; height: 28px; cursor: pointer; font-size: 12px; }
    .icon-btn.danger:hover { border-color: #e5484d; color: #e5484d; }
    .feeds-empty { grid-column: 1 / -1; text-align: center; color: var(--text-secondary); padding: 32px; border: 1px dashed var(--border); border-radius: 12px; }

    .event-stream { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
    .es-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .es-title { font-size: 14px; font-weight: 700; }
    .es-sub { display: block; font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
    .es-filter { background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary); border-radius: 6px; padding: 6px 8px; font-size: 12px; }
    .es-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .es-table th { text-align: left; font-size: 10px; letter-spacing: .5px; color: var(--text-secondary); padding: 8px; border-bottom: 1px solid var(--border); }
    .es-table td { padding: 10px 8px; border-bottom: 1px solid var(--border); }
    .es-table .right, .es-table th.right { text-align: right; }
    .mono { font-family: 'Roboto Mono', monospace; color: var(--text-secondary); }
    .etype { font-weight: 600; }
    .state-occupied { color: #38bdf8; background: #38bdf8; }
    .state-empty { color: #34d399; background: #34d399; }
    .state-dirty { color: #f0a020; background: #f0a020; }
    .etype.state-occupied { background: transparent; }
    .etype.state-empty { background: transparent; }
    .etype.state-dirty { background: transparent; }
    .status-badge { font-size: 10px; font-weight: 700; padding: 3px 10px; border-radius: 10px; }
    .st-verified { color: #34d399; background: rgba(52,211,153,.14); }
    .st-pending { color: #f0a020; background: rgba(240,160,32,.14); }
    .st-rejected { color: #e5484d; background: rgba(229,72,77,.14); }
    .es-empty { text-align: center; color: var(--text-secondary); padding: 20px; }

    @media (max-width: 900px) { .add-grid { grid-template-columns: 1fr 1fr; } .add-grid label.wide { grid-column: span 2; } }
  `]
})
export class MonitorComponent implements OnInit, OnDestroy {
  tab: 'cameras' | 'models' = 'cameras';
  cameras: Camera[] = [];
  events: VisionEvent[] = [];
  latestByCamera: Record<string, VisionEvent> = {};
  failed = new Set<string>();
  statusFilter = '';

  showAdd = false;
  saving = false;
  addError = '';
  draft: NewCamera = { name: '', url: '', protocol: 'rtsp', zone: 'Zone A', device: 'CPU' };

  // Models tab
  status: VisionStatus | null = null;
  models: GroupedModels = { detection: [], classification: [], clip: [] };
  readonly purposeGroups: { key: ModelPurpose; label: string }[] = [
    { key: 'detection', label: 'Detection' },
    { key: 'classification', label: 'Classification' },
    { key: 'clip', label: 'CLIP (Zero-shot)' },
  ];
  modelDraft: NewModel = { name: '', purpose: 'detection', modelPath: '', embeddingsPath: '', labelsFile: '', device: '' };
  modelSaving = false;
  modelError = '';

  private feedTick = Date.now();
  private eventSource: EventSource | null = null;
  private subs: Subscription[] = [];
  private readonly maxEvents = 100;

  constructor(private cameraService: CameraService, private modelService: ModelService) {}

  ngOnInit(): void {
    this.loadCameras();
    this.loadRecentEvents();
    this.connectEvents();
    this.loadModels();
    this.loadStatus();
    // Refresh camera status + live snapshots periodically.
    this.subs.push(interval(4000).subscribe(() => this.loadCameras()));
    this.subs.push(interval(1000).subscribe(() => { this.feedTick = Date.now(); }));
    this.subs.push(interval(10000).subscribe(() => this.loadStatus()));
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.eventSource?.close();
  }

  private loadCameras(): void {
    this.cameraService.list().subscribe({
      next: (cams) => {
        this.cameras = cams;
        // Live feeds may produce a snapshot after a short delay — let them retry.
        for (const c of cams) if (c.mode === 'live') this.failed.delete(c.id);
      },
      error: () => {},
    });
  }

  private loadRecentEvents(): void {
    this.cameraService.recentEvents(this.maxEvents).subscribe({
      next: ({ events }) => {
        this.events = events || [];
        for (const ev of [...this.events].reverse()) this.latestByCamera[ev.cameraId] = ev;
      },
      error: () => {},
    });
  }

  private connectEvents(): void {
    this.eventSource = new EventSource('/api/cameras/events/stream');
    this.eventSource.onmessage = (msg) => {
      try {
        const ev: VisionEvent = JSON.parse(msg.data);
        this.events = [ev, ...this.events].slice(0, this.maxEvents);
        this.latestByCamera[ev.cameraId] = ev;
      } catch { /* ignore */ }
    };
  }

  addCamera(): void {
    this.saving = true;
    this.addError = '';
    this.cameraService.add(this.draft).subscribe({
      next: () => {
        this.saving = false;
        this.showAdd = false;
        this.draft = { name: '', url: '', protocol: 'rtsp', zone: 'Zone A', device: 'CPU' };
        this.loadCameras();
      },
      error: (err) => {
        this.saving = false;
        this.addError = err?.error?.error || 'Failed to add camera';
      },
    });
  }

  start(cam: Camera): void {
    this.cameraService.start(cam.id).subscribe(() => { this.failed.delete(cam.id); this.loadCameras(); });
  }

  stop(cam: Camera): void {
    this.cameraService.stop(cam.id).subscribe(() => this.loadCameras());
  }

  remove(cam: Camera): void {
    if (!confirm(`Remove camera "${cam.name}"?`)) return;
    this.cameraService.remove(cam.id).subscribe(() => this.loadCameras());
  }

  feedUrl(cam: Camera): string {
    return `${this.cameraService.snapshotUrl(cam.id)}?t=${this.feedTick}`;
  }

  onImgError(id: string): void {
    this.failed.add(id);
  }

  filteredEvents(): VisionEvent[] {
    if (!this.statusFilter) return this.events;
    return this.events.filter((e) => e.status === this.statusFilter);
  }

  statusClass(status: string): string {
    if (status === 'VERIFIED') return 'st-verified';
    if (status === 'PENDING REVIEW') return 'st-pending';
    return 'st-rejected';
  }

  // --- Camera health ---
  healthLabel(cam: Camera): string {
    switch (cam.health) {
      case 'detecting': return 'DETECTING';
      case 'starting': return 'STARTING';
      case 'simulated': return 'SIMULATED';
      default: return 'OFFLINE';
    }
  }

  healthClass(cam: Camera): string {
    switch (cam.health) {
      case 'detecting': return 'hb-detecting';
      case 'starting': return 'hb-starting';
      case 'simulated': return 'hb-sim';
      default: return 'hb-off';
    }
  }

  // --- Models tab ---
  private loadModels(): void {
    this.modelService.list().subscribe({
      next: (m) => { this.models = m; },
      error: () => {},
    });
  }

  private loadStatus(): void {
    this.modelService.status().subscribe({
      next: (s) => { this.status = s; },
      error: () => {},
    });
  }

  addModel(): void {
    this.modelSaving = true;
    this.modelError = '';
    this.modelService.add(this.modelDraft).subscribe({
      next: () => {
        this.modelSaving = false;
        this.modelDraft = { name: '', purpose: this.modelDraft.purpose, modelPath: '', embeddingsPath: '', labelsFile: '', device: '' };
        this.loadModels();
        this.loadStatus();
      },
      error: (err) => {
        this.modelSaving = false;
        this.modelError = err?.error?.error || 'Failed to add model';
      },
    });
  }

  activateModel(m: VisionModel): void {
    this.modelService.activate(m.id).subscribe(() => { this.loadModels(); this.loadStatus(); });
  }

  removeModel(m: VisionModel): void {
    if (!confirm(`Delete model "${m.name}"?`)) return;
    this.modelService.remove(m.id).subscribe(() => { this.loadModels(); this.loadStatus(); });
  }
}
