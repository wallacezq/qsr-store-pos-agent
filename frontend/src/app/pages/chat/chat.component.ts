/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { MatSelectModule } from '@angular/material/select';
import { Subscription } from 'rxjs';
import { ChatService, ChatMessage, ChatStatus, ModelOption } from '../../services/chat.service';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    CommonModule, FormsModule, MatCardModule, MatInputModule,
    MatButtonModule, MatIconModule, MatChipsModule, MatProgressBarModule,
    MatTooltipModule, MatDividerModule, MatSelectModule,
  ],
  template: `
    <div class="chat-container">
      <!-- Sidebar: Status & Tools -->
      <aside class="chat-sidebar">
        <div class="status-section">
          <h3><mat-icon>cloud</mat-icon> Connection Status</h3>
          <div class="status-item">
            <span class="status-dot" [class.connected]="status?.hermes?.reachable"></span>
            <span>Hermes Gateway</span>
          </div>
          <div class="status-item">
            <span class="status-dot" [class.connected]="status?.tableService?.connected"></span>
            <span>MQTT Broker</span>
          </div>
          <div class="status-detail" *ngIf="status?.hermes">
            <small>{{ status!.hermes!.url }}</small>
          </div>
        </div>

        <mat-divider></mat-divider>

        <div class="tools-section">
          <h3><mat-icon>build</mat-icon> Available Tools</h3>
          <div class="tool-chip" *ngFor="let tool of availableTools">
            <mat-icon class="tool-icon">{{ tool.icon }}</mat-icon>
            <span>{{ tool.name }}</span>
          </div>
        </div>

        <mat-divider></mat-divider>

        <div class="tables-section">
          <h3><mat-icon>table_restaurant</mat-icon> Table Status</h3>
          <div class="table-grid">
            <div *ngFor="let table of tableList" class="table-cell" [class]="'table-' + table.status" [matTooltip]="table.id + ': ' + table.status">
              {{ table.number }}
            </div>
          </div>
          <div class="table-legend">
            <span><span class="legend-dot clean"></span>Clean</span>
            <span><span class="legend-dot occupied"></span>Occupied</span>
            <span><span class="legend-dot dirty"></span>Dirty</span>
          </div>
        </div>

        <button mat-stroked-button class="refresh-btn" (click)="refreshStatus()">
          <mat-icon>refresh</mat-icon> Refresh
        </button>
      </aside>

      <!-- Main Chat Area -->
      <main class="chat-main">
        <div class="chat-header">
          <h2><mat-icon>smart_toy</mat-icon> Agent Chat</h2>
          <span class="chat-subtitle">Powered by Hermes + MCP Tools</span>
          <span class="spacer"></span>
          <mat-form-field *ngIf="models.length" class="model-select" appearance="outline" subscriptSizing="dynamic">
            <mat-label>Model</mat-label>
            <mat-select [value]="selectedModelId" (selectionChange)="onModelChange($event.value)">
              <mat-option [value]="null">Gateway default</mat-option>
              <mat-option *ngFor="let m of models" [value]="m.id">{{ m.label }} <small>({{ m.provider }})</small></mat-option>
            </mat-select>
          </mat-form-field>
          <button mat-icon-button matTooltip="Clear conversation" (click)="clearChat()">
            <mat-icon>delete_sweep</mat-icon>
          </button>
        </div>

        <div class="messages-container" #messagesContainer>
          <div *ngIf="messages.length === 0" class="empty-state">
            <mat-icon class="empty-icon">forum</mat-icon>
            <h3>Start a conversation</h3>
            <p>Ask about table status, sales data, or give operational commands.</p>
            <div class="suggestions">
              <button mat-stroked-button *ngFor="let s of suggestions" (click)="sendSuggestion(s)">{{ s }}</button>
            </div>
          </div>

          <div *ngFor="let msg of messages" class="message" [class]="'message-' + msg.role">
            <div class="message-avatar">
              <mat-icon>{{ msg.role === 'user' ? 'person' : 'smart_toy' }}</mat-icon>
            </div>
            <div class="message-content">
              <div class="message-text" [innerHTML]="formatMessage(msg.content)"></div>
              <!-- Tool call indicators -->
              <div *ngIf="msg.toolCalls?.length" class="tool-calls">
                <div *ngFor="let tc of msg.toolCalls" class="tool-call-chip" [class.pending]="!tc.result">
                  <mat-icon>build_circle</mat-icon>
                  <span class="tool-name">{{ tc.name }}</span>
                  <span class="tool-result" *ngIf="tc.result">✓</span>
                  <span class="tool-pending" *ngIf="!tc.result">calling…</span>
                </div>
              </div>
              <!-- Throughput metrics -->
              <div *ngIf="msg.throughput && msg.role === 'assistant'" class="throughput-info">
                <span class="throughput-chip" matTooltip="Prefill (prompt processing) speed">
                  <mat-icon>login</mat-icon> {{ msg.throughput.prefillToksPerSec }} tok/s
                </span>
                <span class="throughput-chip" matTooltip="Decode (generation) speed">
                  <mat-icon>logout</mat-icon> {{ msg.throughput.decodeToksPerSec }} tok/s
                </span>
                <span class="throughput-chip ttft" *ngIf="msg.throughput.ttft" matTooltip="Time to first token">
                  TTFT {{ msg.throughput.ttft }}ms
                </span>
                <span class="throughput-chip" matTooltip="Input / Output tokens">
                  <mat-icon>token</mat-icon> {{ msg.throughput.promptTokens }} / {{ msg.throughput.completionTokens }}
                </span>
              </div>
              <!-- Streaming indicator -->
              <div *ngIf="msg.isStreaming" class="streaming-indicator">
                <span class="dot"></span><span class="dot"></span><span class="dot"></span>
              </div>
              <!-- Retry button for failed messages -->
              <div *ngIf="msg.failed" class="retry-row">
                <button mat-stroked-button class="retry-btn" (click)="retryMessage()">
                  <mat-icon>refresh</mat-icon> Retry
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Input Area -->
        <div class="chat-input-area">
          <mat-progress-bar *ngIf="isLoading" mode="indeterminate" class="loading-bar"></mat-progress-bar>
          <div class="input-row">
            <input matInput
              [(ngModel)]="inputMessage"
              (keydown.enter)="sendMessage()"
              placeholder="Ask about tables, sales, or give commands..."
              [disabled]="isLoading"
              class="chat-input" />
            <button mat-fab color="primary" (click)="sendMessage()" [disabled]="!inputMessage.trim() || isLoading">
              <mat-icon>send</mat-icon>
            </button>
          </div>
        </div>
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; height: calc(100vh - 64px); }

    .chat-container {
      display: flex;
      height: 100%;
      background: var(--bg-primary, #fafafa);
    }

    /* Sidebar */
    .chat-sidebar {
      width: 280px;
      background: var(--bg-secondary, #fff);
      border-right: 1px solid var(--border-color, #e0e0e0);
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .chat-sidebar h3 {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.9em;
      margin: 8px 0 4px;
      color: var(--text-primary, #333);
    }

    .status-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      font-size: 0.85em;
      color: var(--text-primary, #333);
    }

    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #f44336;
    }
    .status-dot.connected { background: #4caf50; }

    .status-detail small {
      color: var(--text-secondary, #666);
      font-size: 0.75em;
    }

    .tool-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      font-size: 0.8em;
      border-radius: 4px;
      background: rgba(0,0,0,0.04);
      margin: 2px 0;
      color: var(--text-primary, #333);
    }
    .tool-icon { font-size: 16px; width: 16px; height: 16px; color: var(--text-secondary, #666); }

    .table-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
      margin: 8px 0;
    }
    .table-cell {
      width: 100%; aspect-ratio: 1;
      display: flex; align-items: center; justify-content: center;
      border-radius: 4px;
      font-size: 0.75em;
      font-weight: 600;
      color: #fff;
    }
    .table-clean { background: #4caf50; }
    .table-occupied { background: #ff9800; }
    .table-dirty { background: #f44336; }

    .table-legend {
      display: flex; gap: 12px; font-size: 0.7em; color: var(--text-secondary, #666);
    }
    .table-legend span { display: flex; align-items: center; gap: 4px; }
    .legend-dot { width: 8px; height: 8px; border-radius: 50%; }
    .legend-dot.clean { background: #4caf50; }
    .legend-dot.occupied { background: #ff9800; }
    .legend-dot.dirty { background: #f44336; }

    .refresh-btn { margin-top: auto; }

    /* Main Chat */
    .chat-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .chat-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 20px;
      background: var(--bg-secondary, #fff);
      border-bottom: 1px solid var(--border-color, #e0e0e0);
    }
    .chat-header h2 {
      display: flex; align-items: center; gap: 8px;
      margin: 0; font-size: 1.1em;
      color: var(--text-primary, #333);
    }
    .chat-subtitle { font-size: 0.8em; color: var(--text-secondary, #666); }
    .spacer { flex: 1; }
    .model-select { width: 220px; font-size: 0.85em; }

    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--text-secondary, #666);
    }
    .empty-icon { font-size: 64px; width: 64px; height: 64px; opacity: 0.3; }
    .empty-state h3 { margin: 16px 0 8px; color: var(--text-primary, #333); }
    .suggestions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; justify-content: center; }

    /* Messages */
    .message {
      display: flex;
      gap: 12px;
      max-width: 80%;
    }
    .message-user { align-self: flex-end; flex-direction: row-reverse; }
    .message-assistant { align-self: flex-start; }

    .message-avatar {
      width: 32px; height: 32px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .message-user .message-avatar { background: #1976d2; color: #fff; }
    .message-assistant .message-avatar { background: #7b1fa2; color: #fff; }
    .message-avatar mat-icon { font-size: 18px; width: 18px; height: 18px; }

    .message-content {
      background: var(--bg-secondary, #fff);
      border-radius: 12px;
      padding: 12px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      color: var(--text-primary, #333);
    }
    .message-user .message-content { background: #1976d2; color: #fff; }

    .message-text { white-space: pre-wrap; word-break: break-word; font-size: 0.9em; line-height: 1.5; }

    .tool-calls {
      display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px;
    }
    .tool-call-chip {
      display: flex; align-items: center; gap: 4px;
      padding: 2px 8px;
      background: rgba(123, 31, 162, 0.1);
      border-radius: 12px;
      font-size: 0.75em;
    }
    .tool-call-chip mat-icon { font-size: 14px; width: 14px; height: 14px; color: #7b1fa2; }
    .tool-name { font-weight: 500; }
    .tool-result { color: #4caf50; }
    .tool-call-chip.pending { background: rgba(240, 160, 32, 0.14); }
    .tool-pending { color: #b45309; font-style: italic; animation: toolPulse 1.2s ease-in-out infinite; }
    @keyframes toolPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

    .throughput-info {
      display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid rgba(128,128,128,0.15);
    }
    .throughput-chip {
      display: flex; align-items: center; gap: 3px;
      font-size: 0.7em;
      color: var(--text-secondary, #666);
      background: rgba(128,128,128,0.08);
      padding: 2px 8px;
      border-radius: 10px;
    }
    .throughput-chip mat-icon {
      font-size: 12px; width: 12px; height: 12px;
      color: var(--text-secondary, #888);
    }
    .throughput-chip.ttft { font-style: italic; }

    .retry-row {
      margin-top: 8px;
    }
    .retry-btn {
      font-size: 0.8em;
      color: var(--accent, #1976d2);
      border-color: var(--accent, #1976d2);
    }
    .retry-btn mat-icon {
      font-size: 16px; width: 16px; height: 16px; margin-right: 4px;
    }

    .streaming-indicator {
      display: flex; gap: 4px; margin-top: 4px;
    }
    .streaming-indicator .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #7b1fa2;
      animation: pulse 1.4s infinite;
    }
    .streaming-indicator .dot:nth-child(2) { animation-delay: 0.2s; }
    .streaming-indicator .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes pulse { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

    /* Input */
    .chat-input-area {
      padding: 16px 20px;
      background: var(--bg-secondary, #fff);
      border-top: 1px solid var(--border-color, #e0e0e0);
    }
    .loading-bar { position: absolute; top: 0; left: 0; right: 0; }
    .input-row {
      display: flex; gap: 12px; align-items: center;
    }
    .chat-input {
      flex: 1;
      padding: 12px 16px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 24px;
      font-size: 0.95em;
      outline: none;
      background: var(--bg-primary, #fafafa);
      color: var(--text-primary, #333);
    }
    .chat-input:focus { border-color: #1976d2; }

    /* Dark mode fixes */
    :host-context(.dark-theme) .suggestions button {
      color: var(--text-primary, #e6e6e6);
      border-color: var(--border, #2a2a4a);
    }
    :host-context(.dark-theme) .refresh-btn {
      color: var(--text-primary, #e6e6e6);
      border-color: var(--border, #2a2a4a);
    }
    :host-context(.dark-theme) .chat-header button {
      color: var(--text-primary, #e6e6e6);
    }
    :host-context(.dark-theme) .input-row button {
      color: #fff;
    }
  `]
})
export class ChatComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('messagesContainer') messagesContainer!: ElementRef;

  messages: ChatMessage[] = [];
  inputMessage = '';
  isLoading = false;
  status: ChatStatus | null = null;
  tableList: { id: string; number: number; status: string }[] = [];
  models: ModelOption[] = [];
  selectedModelId: string | null = null;

  private subscription?: Subscription;
  private statusInterval: any;
  private shouldScroll = false;

  availableTools = [
    { name: 'POS Sales & Products', icon: 'point_of_sale' },
    { name: 'Table Status (MQTT)', icon: 'table_restaurant' },
    { name: 'Customer Data', icon: 'people' },
    { name: 'Vision AI Events', icon: 'visibility' },
    { name: 'SQL Queries', icon: 'storage' },
  ];

  suggestions = [
    'Which tables need cleaning?',
    'Show me today\'s sales summary',
    'What are the busiest tables?',
    'List top-selling products',
  ];

  constructor(private chatService: ChatService) {}

  ngOnInit(): void {
    this.subscription = this.chatService.messages$.subscribe(msgs => {
      this.messages = msgs;
      this.shouldScroll = true;
    });
    this.refreshStatus();
    this.statusInterval = setInterval(() => this.refreshStatus(), 15000);
    this.loadModels();
  }

  loadModels(): void {
    this.chatService.getModels().subscribe({
      next: res => {
        this.models = res.models || [];
        const current = this.chatService.getSelectedModel();
        this.selectedModelId = current?.id ?? null;
      },
      error: () => { this.models = []; },
    });
  }

  onModelChange(id: string | null): void {
    this.selectedModelId = id;
    const model = this.models.find(m => m.id === id) || null;
    this.chatService.setSelectedModel(model);
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    clearInterval(this.statusInterval);
  }

  ngAfterViewChecked(): void {
    if (this.shouldScroll) {
      this.scrollToBottom();
      this.shouldScroll = false;
    }
  }

  sendMessage(): void {
    const msg = this.inputMessage.trim();
    if (!msg || this.isLoading) return;

    this.inputMessage = '';
    this.isLoading = true;

    this.chatService.sendMessage(msg).subscribe({
      next: () => {},
      error: () => { this.isLoading = false; },
      complete: () => { this.isLoading = false; },
    });
  }

  sendSuggestion(text: string): void {
    this.inputMessage = text;
    this.sendMessage();
  }

  clearChat(): void {
    this.chatService.clearConversation();
  }

  retryMessage(): void {
    if (this.isLoading) return;
    this.isLoading = true;
    const obs = this.chatService.retryLast();
    if (obs) {
      obs.subscribe({
        next: () => {},
        error: () => { this.isLoading = false; },
        complete: () => { this.isLoading = false; },
      });
    } else {
      this.isLoading = false;
    }
  }

  refreshStatus(): void {
    this.chatService.getStatus().subscribe({
      next: (status) => this.status = status,
      error: () => {},
    });
    this.chatService.getTableStatus().subscribe({
      next: (tables) => {
        this.tableList = Object.entries(tables).map(([id, data]: [string, any]) => ({
          id,
          number: parseInt(id.replace('table-', '')) || 0,
          status: data.status,
        })).sort((a, b) => a.number - b.number);
      },
      error: () => {},
    });
  }

  formatMessage(content: string): string {
    if (!content) return '';
    // Basic markdown-like formatting
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  private scrollToBottom(): void {
    try {
      const el = this.messagesContainer?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    } catch {}
  }
}
