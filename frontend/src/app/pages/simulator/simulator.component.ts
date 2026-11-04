/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component, OnInit, OnDestroy, ElementRef, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatSliderModule } from '@angular/material/slider';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { HttpClient } from '@angular/common/http';
import { SimulatorService } from '../../services/simulator.service';
import { ExperienceService } from '../../services/experience.service';
import { GroceryScene } from './grocery-scene';
import { CafeScene } from './cafe-scene';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-simulator',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatIconModule, MatSlideToggleModule, MatCardModule, MatSliderModule, MatSnackBarModule],
  template: `
    <div class="simulator-container">
      <canvas #simulatorCanvas></canvas>

      <!-- Overlay Controls -->
      <div class="simulator-overlay">
        <mat-card class="control-panel">
          <h3><mat-icon>{{ isCafe ? 'local_cafe' : 'local_grocery_store' }}</mat-icon> {{ isCafe ? 'Café' : 'Grocery' }} Simulator</h3>
          <div class="control-row">
            <span>Auto-generate Transactions:</span>
            <mat-slide-toggle
              [checked]="simulatorService.isEnabled"
              (change)="simulatorService.toggle()"
              color="accent">
            </mat-slide-toggle>
          </div>
          <div class="control-row">
            <span>Status:</span>
            <span class="status" [class.active]="simulatorService.isEnabled">
              {{ simulatorService.isEnabled ? '● Running' : '○ Stopped' }}
            </span>
          </div>
          <div class="control-row">
            <span>Transactions Generated:</span>
            <span class="counter">{{ transactionCount }}</span>
          </div>
          <div class="control-row interval-row">
            <span>Customers: {{ customerCount }}</span>
            <mat-slider [min]="3" [max]="isCafe ? 30 : 100" step="1" [discrete]="true">
              <input matSliderThumb [ngModel]="customerCount" (ngModelChange)="onCustomerCountChange($event)">
            </mat-slider>
          </div>
          <div class="control-row interval-row">
            <span>Speed: {{ simulationSpeed }}x</span>
            <mat-slider min="0.25" max="5" step="0.25" [discrete]="true">
              <input matSliderThumb [ngModel]="simulationSpeed" (ngModelChange)="onSpeedChange($event)">
            </mat-slider>
          </div>
          <div class="control-row interval-row" *ngIf="isCafe">
            <span>Tables: {{ floorTableCount }} (+ 6 bar = {{ floorTableCount + 6 }} total)</span>
            <mat-slider [min]="1" [max]="20" step="1" [discrete]="true">
              <input matSliderThumb [ngModel]="floorTableCount" (ngModelChange)="onFloorTableCountChange($event)">
            </mat-slider>
          </div>
          <button mat-raised-button color="primary" (click)="resetScene()">
            <mat-icon>refresh</mat-icon> Reset Scene
          </button>
        </mat-card>
      </div>

      <!-- Legend -->
      <div class="simulator-legend" *ngIf="!isCafe">
        <div class="legend-item"><span class="dot customer"></span> Customers</div>
        <div class="legend-item"><span class="dot staff"></span> Staff</div>
        <div class="legend-item"><span class="dot shelf"></span> Shelves</div>
        <div class="legend-divider">|</div>
        <div class="legend-item"><kbd>G</kbd> Move</div>
        <div class="legend-item"><kbd>R</kbd> Rotate</div>
        <div class="legend-item"><kbd>S</kbd> Scale</div>
        <div class="legend-item"><kbd>Esc</kbd> Deselect</div>
      </div>
      <div class="simulator-legend" *ngIf="isCafe">
        <div class="legend-item"><span class="dot takeout"></span> Takeout</div>
        <div class="legend-item"><span class="dot dinein"></span> Dine-in</div>
        <div class="legend-divider">|</div>
        <div class="legend-item"><kbd>G</kbd> Move</div>
        <div class="legend-item"><kbd>R</kbd> Rotate</div>
        <div class="legend-item"><kbd>S</kbd> Scale</div>
        <div class="legend-item"><kbd>Esc</kbd> Deselect</div>
      </div>
    </div>
  `,
  styles: [`
    .simulator-container {
      position: relative;
      width: 100%;
      height: calc(100vh - 64px);
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    .simulator-overlay {
      position: absolute;
      top: 16px;
      left: 16px;
      z-index: 10;
    }
    .control-panel {
      padding: 16px;
      min-width: 280px;
      background: rgba(30, 30, 50, 0.92) !important;
      color: white;
      border-radius: 12px;
    }
    .control-panel h3 {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
    }
    .control-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .status {
      color: #999;
    }
    .status.active {
      color: #4caf50;
      font-weight: 700;
    }
    .counter {
      font-weight: 700;
      font-size: 1.2em;
      color: #64b5f6;
    }
    .interval-row {
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
    }
    .interval-row mat-slider {
      width: 100%;
    }
    .simulator-legend {
      position: absolute;
      bottom: 16px;
      left: 16px;
      display: flex;
      gap: 16px;
      background: rgba(30, 30, 50, 0.85);
      padding: 8px 16px;
      border-radius: 8px;
      color: white;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85em;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }
    .dot.customer { background: #ff9800; }
    .dot.staff { background: #4caf50; }
    .dot.shelf { background: #2196f3; }
    .dot.takeout { background: #ff9800; }
    .dot.dinein { background: #7b1fa2; }
    .legend-divider {
      color: rgba(255,255,255,0.3);
      margin: 0 4px;
    }
    kbd {
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.3);
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 0.8em;
      font-family: monospace;
    }
  `]
})
export class SimulatorComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('simulatorCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  transactionCount = 0;
  customerCount = 8;
  simulationSpeed = 1;
  floorTableCount = 9;
  isCafe = false;
  private scene!: GroceryScene | CafeScene;
  private sub!: Subscription;

  constructor(
    public simulatorService: SimulatorService,
    private experienceService: ExperienceService,
    private snackBar: MatSnackBar,
    private http: HttpClient
  ) {
    this.isCafe = this.experienceService.current === 'cafe';
    this.customerCount = this.isCafe ? 6 : 8;
  }

  ngOnInit(): void {
    this.sub = this.simulatorService.enabled$.subscribe(enabled => {
      if (enabled && this.scene) {
        this.scene.setSimulationActive(true);
      } else if (this.scene) {
        this.scene.setSimulationActive(false);
      }
    });
  }

  ngAfterViewInit(): void {
    this.simulatorService.setSceneActive(true);
    if (this.isCafe) {
      const cafeScene = new CafeScene(this.canvasRef.nativeElement);
      cafeScene.onTransaction = (orderType) => {
        this.transactionCount++;
        if (this.simulatorService.isEnabled) {
          this.simulatorService.generateTransaction({ order_type: orderType }).subscribe({
            next: () => {
              this.snackBar.open(`☕ ${orderType === 'takeout' ? 'Takeout' : 'Dine-in'} order completed!`, '', { duration: 2000 });
            }
          });
        }
      };
      cafeScene.onTableEvent = (tableId, event, source) => {
        this.http.post('/api/chat/tables/event', { tableId, event, source }).subscribe();
      };
      cafeScene.onFootfall = (count, zone) => {
        this.http.post('/api/chat/footfall/event', { count, zone }).subscribe();
      };
      this.scene = cafeScene;
    } else {
      const groceryScene = new GroceryScene(this.canvasRef.nativeElement);
      groceryScene.onTransaction = () => {
        this.transactionCount++;
        if (this.simulatorService.isEnabled) {
          this.simulatorService.generateTransaction().subscribe({
            next: () => {
              this.snackBar.open('🛒 New transaction generated!', '', { duration: 2000 });
            }
          });
        }
      };
      this.scene = groceryScene;
    }
    this.scene.init();
    this.scene.setSimulationActive(this.simulatorService.isEnabled);

    // Restore table states from backend (sync scene with persisted status)
    if (this.isCafe) {
      this.http.get<Record<string, { status: string }>>('/api/chat/tables').subscribe({
        next: (tables) => (this.scene as CafeScene).restoreTableStates(tables),
        error: () => {},
      });
    }
  }

  ngOnDestroy(): void {
    this.simulatorService.setSceneActive(false);
    this.scene?.dispose();
    this.sub?.unsubscribe();
  }

  resetScene(): void {
    this.scene.reset();
    this.transactionCount = 0;
  }

  onCustomerCountChange(value: number): void {
    this.customerCount = value;
    this.scene.setCustomerCount(value);
  }

  onSpeedChange(value: number): void {
    this.simulationSpeed = value;
    this.scene.setSpeed(value);
  }

  onFloorTableCountChange(value: number): void {
    this.floorTableCount = value;
    if (this.scene instanceof CafeScene) {
      this.scene.setFloorTableCount(value);
      // Table config changed — reset backend table state to match
      this.http.post('/api/chat/tables/reset', {}).subscribe();
    }
  }
}
