/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Camera {
  id: string;
  name: string;
  url: string;
  protocol: 'rtsp' | 'onvif';
  zone: string;
  device: 'CPU' | 'GPU' | 'NPU';
  experience: 'cafe' | 'grocery';
  detectionModelId?: string;
  clipModelId?: string;
  classificationModelId?: string;
  enabled: boolean;
  status?: 'detecting' | 'stopped';
  mode?: 'live' | 'simulated' | null;
  health?: 'detecting' | 'starting' | 'simulated' | 'stopped';
  lastEventAt?: string | null;
}

export interface VisionEvent {
  eventId: string;
  cameraId: string;
  cameraName: string;
  zone: string;
  tableId: string;
  trackId: number;
  eventType: string;
  state: 'empty' | 'occupied' | 'dirty';
  confidence: number;
  status: 'VERIFIED' | 'PENDING REVIEW' | 'REJECTED';
  occurredAt: string;
}

export interface NewCamera {
  name: string;
  url: string;
  protocol: 'rtsp' | 'onvif';
  zone: string;
  device: 'CPU' | 'GPU' | 'NPU';
  experience: 'cafe' | 'grocery';
}

@Injectable({ providedIn: 'root' })
export class CameraService {
  private apiUrl = '/api/cameras';

  constructor(private http: HttpClient) {}

  list(): Observable<Camera[]> {
    return this.http.get<Camera[]>(this.apiUrl);
  }

  add(camera: NewCamera): Observable<Camera> {
    return this.http.post<Camera>(this.apiUrl, camera);
  }

  update(id: string, patch: Partial<Camera>): Observable<Camera> {
    return this.http.put<Camera>(`${this.apiUrl}/${id}`, patch);
  }

  remove(id: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.apiUrl}/${id}`);
  }

  start(id: string): Observable<any> {
    return this.http.post(`${this.apiUrl}/${id}/start`, {});
  }

  stop(id: string): Observable<any> {
    return this.http.post(`${this.apiUrl}/${id}/stop`, {});
  }

  recentEvents(limit = 50): Observable<{ connected: boolean; events: VisionEvent[] }> {
    return this.http.get<{ connected: boolean; events: VisionEvent[] }>(`${this.apiUrl}/events/recent?limit=${limit}`);
  }

  snapshotUrl(id: string): string {
    return `${this.apiUrl}/${id}/snapshot`;
  }
}
