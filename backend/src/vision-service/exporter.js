/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs the model exporter as a sibling container and tracks jobs. On success
// the produced OpenVINO IR is auto-registered in the model store.

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const modelStore = require('./modelStore');

const DOCKER_BIN = process.env.VISION_DOCKER_BIN || 'docker';
const EXPORTER_IMAGE = process.env.VISION_EXPORTER_IMAGE || 'edgemart/vision-exporter:latest';
// Named volume (or host path) that both the exporter and the DL Streamer
// containers mount at /models.
const MODELS_VOLUME = process.env.VISION_MODELS_DIR || 'vision_models';
// HuggingFace token for authenticated (higher rate-limit) downloads.
const HF_TOKEN = process.env.HF_TOKEN || process.env.VISION_HF_TOKEN || '';
const SOURCES = ['yolo', 'huggingface', 'clip-zeroshot'];

const jobs = new Map(); // id -> job

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'model';
}

function listJobs() {
  return [...jobs.values()].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

function startExport(input = {}) {
  const source = input.source;
  const model = (input.model || '').trim();
  if (!SOURCES.includes(source)) throw new Error('source must be one of: yolo, huggingface, clip-zeroshot');
  if (!model) throw new Error('model is required');

  const id = randomUUID();
  const slug = slugify(input.name || model);
  const outContainer = `/models/${slug}`;
  // clip-zeroshot always produces a clip model (IR + embeddings).
  const purpose = source === 'clip-zeroshot' ? 'clip' : (input.purpose || 'detection');
  const job = {
    id,
    source,
    model,
    purpose,
    precision: input.precision || 'FP32',
    name: input.name || model,
    slug,
    status: 'running',
    xml: null,
    embeddings: null,
    modelId: null,
    error: null,
    log: '',
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  jobs.set(id, job);

  const args = ['run', '--rm', '-v', `${MODELS_VOLUME}:/models`];
  // Pass the HF token so huggingface_hub / optimum / the DL Streamer scripts
  // authenticate and get the higher download rate limit.
  if (HF_TOKEN) args.push('-e', `HF_TOKEN=${HF_TOKEN}`);
  args.push(
    EXPORTER_IMAGE,
    '--source', source, '--model', model, '--out', outContainer, '--precision', job.precision,
  );
  if (input.task) args.push('--task', String(input.task));
  if (source === 'clip-zeroshot' && input.labels) args.push('--labels', String(input.labels));

  const proc = spawn(DOCKER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (buf) => { job.log = (job.log + buf.toString()).slice(-8000); };

  proc.stdout.on('data', (d) => {
    append(d);
    const text = d.toString();
    const xmlMatch = text.match(/EXPORT_RESULT xml=(.+)/);
    if (xmlMatch) job.xml = xmlMatch[1].trim();
    const embMatch = text.match(/EXPORT_RESULT embeddings=(.+)/);
    if (embMatch) job.embeddings = embMatch[1].trim();
  });
  proc.stderr.on('data', append);

  proc.on('error', (err) => {
    job.status = 'failed';
    job.error = `exporter launch failed: ${err.message}`;
    job.endedAt = new Date().toISOString();
  });

  proc.on('exit', (code) => {
    job.endedAt = new Date().toISOString();
    if (code === 0 && job.xml) {
      job.status = 'success';
      try {
        const registered = modelStore.add({
          name: job.name,
          purpose: job.purpose,
          precision: job.precision,
          modelPath: job.xml,
          embeddingsPath: job.embeddings || '',
          device: '',
        });
        job.modelId = registered.id;
      } catch (e) {
        job.error = `exported but registration failed: ${e.message}`;
      }
    } else {
      job.status = 'failed';
      if (!job.error) {
        const tail = (job.log || '').trim().split('\n').slice(-3).join(' ').slice(-400);
        job.error = tail
          ? `exporter exited with code ${code}: ${tail}`
          : `exporter exited with code ${code} (no output — is the edgemart/vision-exporter image built and the docker socket accessible?)`;
      }
    }
  });

  return job;
}

module.exports = { startExport, listJobs };
