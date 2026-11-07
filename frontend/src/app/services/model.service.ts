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

export interface ExportRequest {
  source: 'yolo' | 'huggingface' | 'clip-zeroshot';
  model: string;
  purpose: ModelPurpose;
  precision: 'FP32' | 'FP16' | 'INT8';
  name?: string;
  task?: string;
  labels?: string;
}

export interface ExportJob {
  id: string;
  source: string;
  model: string;
  purpose: string;
  precision: string;
  name: string;
  status: 'running' | 'success' | 'failed';
  xml: string | null;
  error: string | null;
  log?: string;
  startedAt: string;
  endedAt: string | null;
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

  export(req: ExportRequest): Observable<ExportJob> {
    return this.http.post<ExportJob>(`${this.apiUrl}/models/export`, req);
  }

  exportJobs(): Observable<ExportJob[]> {
    return this.http.get<ExportJob[]>(`${this.apiUrl}/models/export/jobs`);
  }
}
