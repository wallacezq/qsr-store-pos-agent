/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  message: string;
  type: 'info' | 'warn' | 'error';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;
  private lastShown = new Map<string, number>();

  show(message: string, type: Toast['type'] = 'info', ttlMs = 4000): void {
    // Collapse identical messages fired in quick succession.
    const now = Date.now();
    if (now - (this.lastShown.get(message) || 0) < 3000) return;
    this.lastShown.set(message, now);
    const id = ++this.seq;
    this.toasts.update((list) => [...list, { id, message, type }]);
    setTimeout(() => this.dismiss(id), ttlMs);
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
