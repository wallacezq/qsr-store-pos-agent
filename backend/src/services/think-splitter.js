/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming-safe splitter that separates inline reasoning (<think>…</think>)
 * from answer text.
 *
 * Many local reasoning models (Qwen3, DeepSeek-R1 distills, …) emit their
 * chain of thought inline in `delta.content` wrapped in <think> tags, and the
 * tags can be split across streamed chunks ("<thi" + "nk>"). This keeps a
 * small tail buffer so a partial tag is never leaked as text.
 *
 * Usage:
 *   const s = new ThinkTagSplitter();
 *   for (const chunk of stream) for (const seg of s.push(chunk)) emit(seg);
 *   for (const seg of s.flush()) emit(seg);
 *
 * Each segment is { type: 'content' | 'thinking', text: string }.
 */

const TAG_PAIRS = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
];

class ThinkTagSplitter {
  constructor() {
    this.inThink = false;
    this.closeTag = null; // close tag matching the open tag we are inside
    this.buf = '';
    this.skipLeadingWs = false; // drop whitespace between </think> and the answer, even across chunks
  }

  /** Candidate tags to look for in the current state. */
  _candidates() {
    return this.inThink ? [this.closeTag] : TAG_PAIRS.map(p => p.open);
  }

  /** Length of the longest suffix of `text` that is a proper prefix of a candidate tag. */
  _partialTagLen(text, candidates) {
    let best = 0;
    for (const tag of candidates) {
      const max = Math.min(tag.length - 1, text.length);
      for (let len = max; len > best; len--) {
        if (tag.startsWith(text.slice(text.length - len))) {
          best = len;
          break;
        }
      }
    }
    return best;
  }

  push(text) {
    const out = [];
    if (!text) return out;
    this.buf += text;

    while (this.buf.length > 0) {
      if (!this.inThink && this.skipLeadingWs) {
        this.buf = this.buf.replace(/^\s+/, '');
        if (this.buf.length === 0) break; // keep skipping on the next chunk
        this.skipLeadingWs = false;
      }

      const candidates = this._candidates();

      // Find the earliest full tag.
      let idx = -1;
      let tag = null;
      for (const c of candidates) {
        const i = this.buf.indexOf(c);
        if (i !== -1 && (idx === -1 || i < idx)) { idx = i; tag = c; }
      }

      const type = this.inThink ? 'thinking' : 'content';

      if (idx !== -1) {
        if (idx > 0) out.push({ type, text: this.buf.slice(0, idx) });
        this.buf = this.buf.slice(idx + tag.length);
        if (this.inThink) {
          this.inThink = false;
          this.closeTag = null;
          // Models usually put a blank line after </think>; drop it.
          this.skipLeadingWs = true;
        } else {
          this.inThink = true;
          this.closeTag = TAG_PAIRS.find(p => p.open === tag).close;
        }
        continue;
      }

      // No full tag: emit everything except a possible partial tag at the end.
      const hold = this._partialTagLen(this.buf, candidates);
      const emitLen = this.buf.length - hold;
      if (emitLen > 0) out.push({ type, text: this.buf.slice(0, emitLen) });
      this.buf = this.buf.slice(emitLen);
      break;
    }

    return out;
  }

  /** Emit whatever is still buffered (a partial tag that never completed is plain text). */
  flush() {
    const out = [];
    if (this.buf) {
      out.push({ type: this.inThink ? 'thinking' : 'content', text: this.buf });
      this.buf = '';
    }
    return out;
  }
}

module.exports = { ThinkTagSplitter };
