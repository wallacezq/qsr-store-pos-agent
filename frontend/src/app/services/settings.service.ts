/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Settings {
  stockCheckEnabled: boolean;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private apiUrl = '/api/settings';

  constructor(private http: HttpClient) {}

  getSettings(): Observable<Settings> {
    return this.http.get<Settings>(this.apiUrl);
  }

  updateSettings(settings: Partial<Settings>): Observable<Settings> {
    return this.http.put<Settings>(this.apiUrl, settings);
  }

  clearTransactions(): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.apiUrl}/transactions`);
  }

  replenishStock(): Observable<{ message: string; updated: number }> {
    return this.http.post<{ message: string; updated: number }>(`${this.apiUrl}/replenish-stock`, {});
  }
}
