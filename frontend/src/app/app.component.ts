/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { ThemeService } from './services/theme.service';
import { SimulatorService } from './services/simulator.service';
import { ExperienceService, Experience } from './services/experience.service';
import { ToastService } from './services/toast.service';
import { MetricsPanelComponent } from './components/metrics-panel/metrics-panel.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterModule, MatToolbarModule, MatButtonModule, MatIconModule, MatSlideToggleModule, MatTooltipModule, MatButtonToggleModule, MetricsPanelComponent],
  template: `
    <div [class]="themeService.currentTheme()">
      <mat-toolbar color="primary">
        <span class="logo">{{ experienceService.current === 'cafe' ? '☕' : '🛒' }} EdgeMart {{ experienceService.current === 'cafe' ? 'Café' : 'Grocery' }}</span>
        <span class="spacer"></span>

        <!-- Experience Switcher -->
        <mat-button-toggle-group class="experience-toggle" [value]="experienceService.current" (change)="switchExperience($event.value)">
          <mat-button-toggle value="grocery" matTooltip="Grocery Store">
            <mat-icon>local_grocery_store</mat-icon>
          </mat-button-toggle>
          <mat-button-toggle value="cafe" matTooltip="Café">
            <mat-icon>local_cafe</mat-icon>
          </mat-button-toggle>
        </mat-button-toggle-group>

        <span class="spacer"></span>
        <button mat-button routerLink="/dashboard" routerLinkActive="active-link">
          <mat-icon>dashboard</mat-icon> Dashboard
        </button>
        <button mat-button routerLink="/pos" routerLinkActive="active-link">
          <mat-icon>point_of_sale</mat-icon> POS
        </button>
        <button mat-button routerLink="/transactions" routerLinkActive="active-link">
          <mat-icon>receipt_long</mat-icon> Transactions
        </button>
        <button mat-button routerLink="/simulator" routerLinkActive="active-link">
          <mat-icon>sports_esports</mat-icon> Simulator
        </button>
        <button mat-button routerLink="/monitor" routerLinkActive="active-link">
          <mat-icon>videocam</mat-icon> Live Monitor
        </button>
        <button mat-button routerLink="/chat" routerLinkActive="active-link">
          <mat-icon>smart_toy</mat-icon> Agent
        </button>
        <button mat-button routerLink="/config" routerLinkActive="active-link">
          <mat-icon>settings</mat-icon> Config
        </button>
        <span class="spacer"></span>

        <!-- Simulator Snap-On Toggle -->
        <div class="sim-toggle" matTooltip="Enable simulator to auto-generate transactions">
          <mat-slide-toggle
            [checked]="simulatorService.isEnabled"
            (change)="simulatorService.toggle()"
            color="warn">
            <span class="sim-label">
              <mat-icon class="sim-icon" [class.active]="simulatorService.isEnabled">
                {{ simulatorService.isEnabled ? 'play_circle' : 'pause_circle' }}
              </mat-icon>
              Sim
            </span>
          </mat-slide-toggle>
        </div>

        <div class="divider"></div>

        <!-- Theme Toggle -->
        <mat-slide-toggle
          [checked]="themeService.isDark()"
          (change)="themeService.toggleTheme()"
          color="accent">
          <mat-icon>{{ themeService.isDark() ? 'dark_mode' : 'light_mode' }}</mat-icon>
        </mat-slide-toggle>
      </mat-toolbar>
      <router-outlet></router-outlet>
      <app-metrics-panel></app-metrics-panel>

      <div class="toast-stack">
        <div class="toast" *ngFor="let t of toastService.toasts()" [ngClass]="'toast-' + t.type" (click)="toastService.dismiss(t.id)">
          {{ t.message }}
        </div>
      </div>
    </div>
  `,
  styles: [`
    .logo {
      font-weight: 700;
      font-size: 1.2em;
      margin-right: 24px;
    }
    .spacer {
      flex: 1 1 auto;
    }
    .active-link {
      border-bottom: 2px solid var(--accent);
    }
    mat-toolbar {
      position: sticky;
      top: 0;
      z-index: 1000;
    }
    .experience-toggle {
      margin: 0 8px;
    }
    .sim-toggle {
      margin-right: 16px;
    }
    .sim-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 0.85em;
      font-weight: 500;
      color: var(--text-primary);
    }
    .sim-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
      color: var(--text-primary);
    }
    .sim-icon.active {
      color: #4caf50;
      animation: pulse 1.5s infinite;
    }
    .divider {
      width: 1px;
      height: 24px;
      background: var(--border);
      margin: 0 12px;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .toast-stack {
      position: fixed; right: 16px; bottom: 16px; z-index: 2000;
      display: flex; flex-direction: column; gap: 8px; max-width: 360px;
    }
    .toast {
      padding: 10px 14px; border-radius: 8px; font-size: 13px; color: #fff;
      cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.25);
    }
    .toast-info { background: #334155; }
    .toast-warn { background: #b45309; }
    .toast-error { background: #b91c1c; }
  `]
})
export class AppComponent {
  constructor(
    public themeService: ThemeService,
    public simulatorService: SimulatorService,
    public experienceService: ExperienceService,
    public toastService: ToastService
  ) {}

  switchExperience(value: Experience): void {
    this.experienceService.switch(value);
    window.location.reload();
  }
}
