/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject, BehaviorSubject } from 'rxjs';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  toolCalls?: ToolCallInfo[];
  isStreaming?: boolean;
  throughput?: ThroughputInfo;
  failed?: boolean;
  /** Model reasoning streamed separately from the answer. */
  thinking?: string;
  /** True while reasoning tokens are actively streaming. */
  isThinking?: boolean;
  /** Total time spent thinking (ms), set once a thinking phase ends. */
  thinkingMs?: number;
  /** Whether the thinking panel is expanded. Opens when thinking starts, collapses when it ends. */
  thinkingOpen?: boolean;
}

export interface ThroughputInfo {
  prefillToksPerSec: number;
  decodeToksPerSec: number;
  promptTokens?: number;
  completionTokens?: number;
  ttft?: number; // time to first token (ms)
}

export interface ToolCallInfo {
  name: string;
  arguments?: any;
  result?: string;
}

export interface ChatStatus {
  hermes: { url: string; reachable: boolean };
  tableService: { connected: boolean; brokerUrl: string; tableCount: number; subscribedTopics: string[] };
}

export interface ModelOption {
  id: string;
  provider: string;
  label: string;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private conversationId: string | null = null;
  private messagesSubject = new BehaviorSubject<ChatMessage[]>([]);
  messages$ = this.messagesSubject.asObservable();

  private streamingSubject = new Subject<string>();
  streaming$ = this.streamingSubject.asObservable();

  private selectedModel: ModelOption | null = null;

  constructor(private http: HttpClient) {}

  getMessages(): ChatMessage[] {
    return this.messagesSubject.value;
  }

  getStatus(): Observable<ChatStatus> {
    return this.http.get<ChatStatus>('/api/chat/status');
  }

  getModels(refresh = false): Observable<{ models: ModelOption[] }> {
    return this.http.get<{ models: ModelOption[] }>(`/api/chat/models${refresh ? '?refresh=1' : ''}`);
  }

  setSelectedModel(model: ModelOption | null): void {
    this.selectedModel = model;
  }

  getSelectedModel(): ModelOption | null {
    return this.selectedModel;
  }

  /** Expand/collapse the thinking panel of the message at `index`. */
  toggleThinking(index: number): void {
    const msgs = this.messagesSubject.value;
    if (!msgs[index]) return;
    const next = [...msgs];
    next[index] = { ...next[index], thinkingOpen: !next[index].thinkingOpen };
    this.messagesSubject.next(next);
  }

  /**
   * Send a message and receive a streamed response via SSE.
   * Returns an observable that emits partial content as it arrives.
   */
  sendMessage(content: string): Observable<{ type: string; content: string; toolCalls?: ToolCallInfo[] }> {
    const messages = this.messagesSubject.value;

    // Add user message
    const userMsg: ChatMessage = { role: 'user', content, timestamp: new Date() };
    this.messagesSubject.next([...messages, userMsg]);

    // Add placeholder for assistant response
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', timestamp: new Date(), isStreaming: true, toolCalls: [] };
    this.messagesSubject.next([...this.messagesSubject.value, assistantMsg]);

    return new Observable(subscriber => {
      const history = messages.map(m => ({ role: m.role, content: m.content }));
      const requestStart = performance.now();
      let firstTokenTime: number | null = null;
      let tokenCount = 0;
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;

      // Thinking state. A reply can think more than once (e.g. before and after a
      // tool call), so durations accumulate across phases.
      let thinkingText = '';
      let thinkStart: number | null = null;
      let thinkingMs = 0;
      let autoCollapsed = false;

      const patchLast = (patch: Partial<ChatMessage>) => {
        const msgs = this.messagesSubject.value;
        const lastIdx = msgs.length - 1;
        msgs[lastIdx] = { ...msgs[lastIdx], ...patch };
        this.messagesSubject.next([...msgs]);
      };

      /** Ends the current thinking phase (no-op if not thinking) and auto-collapses the panel once. */
      const closeThinking = () => {
        if (thinkStart === null) return;
        thinkingMs += performance.now() - thinkStart;
        thinkStart = null;
        const patch: Partial<ChatMessage> = { isThinking: false, thinkingMs: Math.round(thinkingMs) };
        if (!autoCollapsed) { patch.thinkingOpen = false; autoCollapsed = true; }
        patchLast(patch);
      };

      fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          conversationId: this.conversationId,
          context: { history },
          model: this.selectedModel?.id,
          provider: this.selectedModel?.provider,
        }),
      }).then(async response => {
        if (!response.ok) {
          const errText = await response.text();
          subscriber.error(new Error(`Chat API error: ${response.status} - ${errText}`));
          return;
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let buffer = '';
        const toolCalls: ToolCallInfo[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // Keep the last element as it may be an incomplete line
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              closeThinking();
              // Calculate throughput
              const endTime = performance.now();
              const ttft = firstTokenTime ? firstTokenTime - requestStart : undefined;
              const decodeTime = firstTokenTime ? endTime - firstTokenTime : endTime - requestStart;
              const estimatedPromptTokens = promptTokens || Math.ceil(content.length / 4);
              const finalCompletionTokens = completionTokens || tokenCount;

              const throughput: ThroughputInfo = {
                prefillToksPerSec: ttft && ttft > 0 ? Math.round(estimatedPromptTokens / (ttft / 1000)) : 0,
                decodeToksPerSec: decodeTime > 0 ? Math.round(finalCompletionTokens / (decodeTime / 1000) * 10) / 10 : 0,
                promptTokens: estimatedPromptTokens,
                completionTokens: finalCompletionTokens,
                ttft: ttft ? Math.round(ttft) : undefined,
              };

              // Finalize the assistant message
              const msgs = this.messagesSubject.value;
              const lastIdx = msgs.length - 1;
              msgs[lastIdx] = { ...msgs[lastIdx], content: fullContent, isStreaming: false, toolCalls, throughput };
              this.messagesSubject.next([...msgs]);
              subscriber.complete();
              return;
            }

            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'thinking') {
                // Reasoning counts as generated tokens, so TTFT/decode speed stay consistent.
                if (!firstTokenTime) firstTokenTime = performance.now();
                tokenCount++;
                const isFirstPhase = !thinkingText;
                if (thinkStart === null) {
                  thinkStart = performance.now();
                  if (thinkingText) thinkingText += '\n\n'; // visual break between phases
                }
                thinkingText += parsed.content;
                patchLast({
                  thinking: thinkingText,
                  isThinking: true,
                  ...(isFirstPhase ? { thinkingOpen: true } : {}),
                });
                subscriber.next({ type: 'thinking', content: parsed.content });
              } else if (parsed.type === 'content') {
                closeThinking();
                if (!firstTokenTime) firstTokenTime = performance.now();
                tokenCount++;
                fullContent += parsed.content;
                // Update streaming message
                const msgs = this.messagesSubject.value;
                const lastIdx = msgs.length - 1;
                msgs[lastIdx] = { ...msgs[lastIdx], content: fullContent };
                this.messagesSubject.next([...msgs]);
                subscriber.next({ type: 'content', content: parsed.content });
              } else if (parsed.type === 'tool_call') {
                closeThinking();
                const tc: ToolCallInfo = { name: parsed.content?.[0]?.function?.name || 'unknown', arguments: parsed.content?.[0]?.function?.arguments };
                toolCalls.push(tc);
                subscriber.next({ type: 'tool_call', content: tc.name, toolCalls: [tc] });
              } else if (parsed.type === 'tool_result') {
                const existing = toolCalls.find(t => t.name === parsed.tool);
                if (existing) existing.result = parsed.result;
                subscriber.next({ type: 'tool_result', content: parsed.result });
              } else if (parsed.type === 'usage') {
                promptTokens = parsed.prompt_tokens;
                completionTokens = parsed.completion_tokens;
              } else if (parsed.type === 'error') {
                closeThinking();
                fullContent += `\n⚠️ ${parsed.content}`;
                const msgs = this.messagesSubject.value;
                const lastIdx = msgs.length - 1;
                msgs[lastIdx] = { ...msgs[lastIdx], content: fullContent, isStreaming: false };
                this.messagesSubject.next([...msgs]);
                subscriber.next({ type: 'error', content: parsed.content });
              }
            } catch {
              // Skip malformed lines
            }
          }
        }

        // Process any remaining buffered data
        if (buffer.trim().startsWith('data: ')) {
          const data = buffer.trim().slice(6).trim();
          if (data && data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content') {
                fullContent += parsed.content;
              }
            } catch { /* ignore */ }
          }
        }

        // If stream ended without [DONE]
        closeThinking();
        const msgs = this.messagesSubject.value;
        const lastIdx = msgs.length - 1;
        msgs[lastIdx] = { ...msgs[lastIdx], content: fullContent, isStreaming: false, toolCalls };
        this.messagesSubject.next([...msgs]);
        subscriber.complete();
      }).catch(err => {
        // Update message with error and mark as failed
        closeThinking();
        const msgs = this.messagesSubject.value;
        const lastIdx = msgs.length - 1;
        msgs[lastIdx] = { ...msgs[lastIdx], content: `⚠️ Connection error: ${err.message}`, isStreaming: false, failed: true };
        this.messagesSubject.next([...msgs]);
        subscriber.error(err);
      });
    });
  }

  retryLast(): Observable<{ type: string; content: string; toolCalls?: ToolCallInfo[] }> | null {
    const msgs = this.messagesSubject.value;
    if (msgs.length < 2) return null;

    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg.failed) return null;

    // Find the last user message
    let userMsg = '';
    for (let i = msgs.length - 2; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        userMsg = msgs[i].content;
        break;
      }
    }
    if (!userMsg) return null;

    // Remove the failed assistant message
    const trimmed = msgs.slice(0, -1);
    this.messagesSubject.next(trimmed);

    // Resend
    return this.sendMessage(userMsg);
  }

  clearConversation(): void {
    this.conversationId = null;
    this.messagesSubject.next([]);
  }

  getTableStatus(): Observable<any> {
    return this.http.get('/api/chat/tables');
  }

  getDirtyTables(): Observable<any> {
    return this.http.get('/api/chat/tables/dirty');
  }
}
