/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type ModelPurpose = 'detection' | 'classification' | 'clip';

export interface VisionModel {
  id: string;
  name: string;
  purpose: ModelPurpose;
  modelPath: string;
  embeddingsPath?: string;
  labelsFile?: string;
  device?: string;
  active: boolean;
  createdAt?: string;
}

export interface GroupedModels {
  detection: VisionModel[];
  classification: VisionModel[];
  clip: VisionModel[];
}

export interface NewModel {
  name: string;
  purpose: ModelPurpose;
  modelPath: string;
  embeddingsPath?: string;
  labelsFile?: string;
  device?: string;
}

export interface VisionStatus {
  invoke: string;
  image: string;
  network: string | null;
  device: string;
  modelsDirConfigured: boolean;
  simulate: boolean;
  realEnabled: boolean;
  activeModels: { detection: string | null; classification: string | null; clip: string | null };
}

@Injectable({ providedIn: 'root' })
export class ModelService {
  private apiUrl = '/api/vision';

  constructor(private http: HttpClient) {}

  list(): Observable<GroupedModels> {
    return this.http.get<GroupedModels>(`${this.apiUrl}/models`);
  }

  add(model: NewModel): Observable<VisionModel> {
    return this.http.post<VisionModel>(`${this.apiUrl}/models`, model);
  }

  activate(id: string): Observable<VisionModel> {
    return this.http.post<VisionModel>(`${this.apiUrl}/models/${id}/activate`, {});
  }

  remove(id: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.apiUrl}/models/${id}`);
  }

  status(): Observable<VisionStatus> {
    return this.http.get<VisionStatus>(`${this.apiUrl}/status`);
  }
}
