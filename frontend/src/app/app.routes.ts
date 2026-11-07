/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Routes } from '@angular/router';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { PosComponent } from './pages/pos/pos.component';
import { TransactionsComponent } from './pages/transactions/transactions.component';
import { SimulatorComponent } from './pages/simulator/simulator.component';
import { ConfigComponent } from './pages/config/config.component';
import { ChatComponent } from './pages/chat/chat.component';
import { MonitorComponent } from './pages/monitor/monitor.component';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: 'dashboard', component: DashboardComponent },
  { path: 'pos', component: PosComponent },
  { path: 'transactions', component: TransactionsComponent },
  { path: 'simulator', component: SimulatorComponent },
  { path: 'monitor', component: MonitorComponent },
  { path: 'chat', component: ChatComponent },
  { path: 'config', component: ConfigComponent }
];
