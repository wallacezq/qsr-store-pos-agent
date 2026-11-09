# Live Monitor (AI Vision)

The **Live Monitor** tab adds an AI vision system that connects an arbitrary number of
**RTSP / ONVIF** cameras, runs object detection + zero‑shot classification with
[Intel DL Streamer](https://github.com/open-edge-platform/dlstreamer), and detects
**empty / occupied / dirty tables**. Detections are published to the MQTT bus and flow
into the existing table‑status pipeline, so the **Agent**, **Operation Insights dashboard**,
and the **Workflow Engine Events** feed all reflect real camera activity.

> Open it from the toolbar: **Live Monitor** (`/monitor`).

---

## What it does

- **Add arbitrary cameras** — RTSP or ONVIF stream URLs, each with a name, zone, and inference device (CPU/GPU/NPU).
- **AI table detection** — per camera, a DL Streamer pipeline runs
  `rtspsrc → gvadetect → gvatrack → gvaclassify (zero‑shot CLIP) → gvametapublish (MQTT)`.
- **Zero‑shot classification** — the table state (`empty table` / `occupied table` / `dirty table`)
  is scored by a CLIP image encoder against a `.safetensors` label bank — no retraining to change labels.
- **Event stream** — a live table of detections (time, event id, type, camera, zone, verification status).
- **Health indicators** — each camera shows `DETECTING`, `STARTING` (launched but no detections yet),
  `SIMULATED`, or `OFFLINE`.
- **Model management** — register / activate / delete OpenVINO models grouped by purpose
  (Detection, Classification, CLIP), and **export/convert** open models (YOLO, HuggingFace, CLIP zero‑shot)
  to OpenVINO IR directly from the UI.

---

## UI

### Cameras tab
- **Add Camera** — name, protocol (RTSP/ONVIF), stream URL, zone, inference device.
- **Live feed grid** — one tile per camera with an annotated snapshot (when available), a state overlay
  (`Occupied · 82%`), a health badge, and start/stop/remove controls.
- **Event stream** — detections across all cameras with a status filter (Verified / Pending review / Rejected,
  derived from detection confidence).

### Models tab
- **Export / Convert → OpenVINO IR** — pull and convert an open model (see [Model exporter](#model-exporter)).
- **Register existing model** — point at an already‑present IR (`.xml`, plus CLIP `.safetensors` embeddings).
- **Grouped lists** — Detection / Classification / CLIP, each with an **ACTIVE** marker, ★ activate, and 🗑 delete.
- **Status banner** — shows whether real pipelines are enabled (`DLStreamer`) or `Simulation`, and the image in use.

---

## Architecture

Everything flows through MQTT, so **real and simulated** pipelines are handled identically:

```
camera ──► DL Streamer pipeline (or simulator) ──► MQTT  vision/detections/<cameraId>
                                                     │
                                            visionBridge (normalize)
                                             │                    │
                           SSE: Live Monitor event stream   republish ► cafe/vision/events
                                                                         │
                                                        TableStatusService ► dashboard / agent
```

- **Pipeline** — per camera, launched as a sibling DL Streamer container (or simulated). Publishes
  DL‑Streamer metadata JSON to `vision/detections/<cameraId>`.
- **visionBridge** — subscribes to `vision/detections/#`, maps zero‑shot labels to table states, emits
  normalized events over SSE, and republishes to `cafe/vision/events` so the table‑status service updates.
- **Simulation fallback** — if DL Streamer isn’t available or models are missing, a simulator publishes
  DL‑Streamer‑shaped detections to the same topic, so the whole flow works end‑to‑end in dev.

### DL Streamer pipeline

```
rtspsrc location=<URL> latency=100 protocols=tcp ! rtph264depay ! decodebin3 !
gvadetect model=<detector>.xml device=<DEV> threshold=0.3 inference-interval=3 !
gvatrack tracking-type=short-term-imageless !
gvaclassify model=<clip-image-encoder>.xml zeroshot-embeddings-file=<labels>.safetensors object-class="dining table" device=<DEV> !
gvawatermark ! tee
  ├─ gvametaconvert format=json ! gvametapublish method=mqtt topic=vision/detections/<id>
  └─ jpegenc ! multifilesink   (annotated snapshot, optional)
```

The pipeline is run **via Docker** — the backend launches it as a sibling container using the mounted
Docker socket:

```
docker run --rm --name vision-<id> --network edgemart-net [--device /dev/dri] \
  -v vision_models:/models:ro \
  intel/dlstreamer:2026.3.0-ubuntu24-rc1 \
  bash -c 'source /opt/intel/dlstreamer/setupvars.sh; exec gst-launch-1.0 -v "$@"' gst <pipeline...>
```

---

## Running real pipelines

By default (no models present) the Live Monitor runs in **simulation**. To run real DL Streamer:

1. **Build the exporter image** (one‑off tool, not started by `docker compose up`):
   ```bash
   docker compose --profile tools build vision-exporter
   ```
2. **Get models onto the `vision_models` volume** — either export them from the **Models** tab, or populate
   the volume manually, e.g.:
   ```bash
   docker run --rm -v vision_models:/models -v ${PWD}/my-models:/src alpine \
     sh -c "cp -r /src/* /models/"
   ```
   The pipeline expects (defaults, overridable via env / the Models tab):
   - `/models/yolov8n/yolov8n.xml` — detector
   - `/models/clip/clip-image-encoder.xml` — CLIP image encoder (`model_type=clip_zeroshot`)
   - `/models/clip/table-states.safetensors` — label bank (empty / occupied / dirty table)
3. **Add a camera** — adding an enabled camera auto‑starts its pipeline. Real mode engages automatically
   once the active detection + CLIP models exist under `/models`; otherwise it stays simulated.

A camera’s `mode` is `live` (DL Streamer) or `simulated`, visible via the health badge and status banner.

---

## Model exporter

Pull and convert open models to OpenVINO IR from **Models → Export**, or via `POST /api/vision/models/export`.
The backend runs the [`exporter`](../exporter) image as a sibling container that writes IR into the
`vision_models` volume and **auto‑registers** the result.

| Source | Tooling | Notes |
|--------|---------|-------|
| **YOLO** | Ultralytics `YOLO(...).export(format="openvino")` | e.g. `yolov8n`, `yolov8n-cls`. Supports FP32/FP16/INT8. |
| **HuggingFace** | `optimum-cli export openvino` | generic HF → IR (e.g. `openai/clip-vit-base-patch32`). |
| **CLIP (zero‑shot)** | DL Streamer `download_hf_models.py --export-variant clip-zeroshot` + `clip_text_embeddings.py` | produces the `clip_zeroshot` IR **and** the `table-states.safetensors` label bank (labels configurable). |

Build the exporter image with `docker compose --profile tools build vision-exporter`. First build is large
(ultralytics pulls torch) and the image sparse‑clones DL Streamer’s `scripts/download_models/` for the
CLIP zero‑shot variant (pin with the `DLS_REF` build arg).

---

## Docker volumes

| Volume | Mounted at | Purpose |
|--------|-----------|---------|
| `vision_models` | backend `/models:ro`, exporter/pipeline containers `/models` | OpenVINO model files (shared across containers). |
| `vision_data` | backend `/app/data` | Registry JSON (cameras, models, settings) — survives rebuilds. |

Both use fixed names (no compose project prefix) so sibling containers launched via
`docker run -v vision_models:/models …` reference the same volume.

> The `backend` service runs as `user: root` so it can access the mounted Docker socket to launch the
> vision/exporter containers (on Docker Desktop the socket is root‑owned).

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VISION_INVOKE` | `docker` | `docker` (sibling container) or `native` (gst on PATH). |
| `VISION_DOCKER_IMAGE` | `intel/dlstreamer:2026.3.0-ubuntu24-rc1` | DL Streamer image for pipelines. |
| `VISION_DOCKER_NETWORK` | `edgemart-net` | Network the pipeline container joins (to reach MQTT). |
| `VISION_DEVICE` | `CPU` | Inference device (`CPU`/`GPU`/`NPU`). |
| `VISION_MODELS_DIR` | `vision_models` | Named volume (or host path) mounted at `/models`. |
| `VISION_DETECT_MODEL` | `/models/yolov8n/yolov8n.xml` | Default detector (overridden by the active model). |
| `VISION_CLIP_MODEL` | `/models/clip/clip-image-encoder.xml` | Default CLIP encoder. |
| `VISION_ZEROSHOT_EMBEDDINGS` | `/models/clip/table-states.safetensors` | Default label bank. |
| `VISION_TABLE_CLASS` | `dining table` | gvadetect label the classifier runs on. |
| `VISION_SNAPSHOT_HOST_DIR` | — | Optional host dir for annotated snapshots (`/snapshots`). |
| `VISION_SIMULATE` | — | `1` forces simulation. |
| `VISION_EXPORTER_IMAGE` | `edgemart/vision-exporter:latest` | Exporter image. |
| `DATA_DIR` | `/app/data` (docker) | Where the registry JSON is persisted. |

---

## API reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/cameras` | List cameras with live status/health. |
| `POST` | `/api/cameras` | Add a camera (auto‑starts if enabled). |
| `PUT` | `/api/cameras/:id` | Update a camera. |
| `DELETE` | `/api/cameras/:id` | Remove a camera (stops its pipeline). |
| `POST` | `/api/cameras/:id/start` · `/stop` | Start / stop a camera’s pipeline. |
| `GET` | `/api/cameras/:id/snapshot` | Latest annotated frame (real pipeline). |
| `GET` | `/api/cameras/events/stream` | SSE of normalized vision events. |
| `GET` | `/api/cameras/events/recent` | Recent events (backfill). |
| `GET` | `/api/vision/models` | Models grouped by purpose. |
| `POST` | `/api/vision/models` | Register a model. |
| `POST` | `/api/vision/models/:id/activate` | Set the active model for its purpose. |
| `DELETE` | `/api/vision/models/:id` | Delete a model. |
| `POST` | `/api/vision/models/export` | Pull + convert a model to OpenVINO IR. |
| `GET` | `/api/vision/models/export/jobs` | Export job statuses (with logs). |
| `GET` | `/api/vision/status` | Invocation mode + active models. |

---

## Troubleshooting

- **Export fails with “exporter exited with code 1”** — the failed job’s inline log shows the real reason.
  Common causes: the `edgemart/vision-exporter` image isn’t built (`docker compose --profile tools build vision-exporter`);
  the backend can’t reach the Docker socket (ensure the `backend` service has socket access — it runs as `user: root`);
  or the export itself failed (no network/proxy to pull weights, gated HF model, model id typo).
- **Camera shows `STARTING` but never `DETECTING`** — the pipeline launched but produced no detections.
  Check the models exist at the expected `/models` paths, the RTSP URL is reachable, and (for GPU/NPU)
  the device is passed through.
- **Everything stays `SIMULATED`** — no models present on `vision_models`, or `VISION_SIMULATE=1`. Export/populate
  models, then restart the camera.
- **Verify socket access from the backend** — `docker compose exec backend docker ps`.
