# EdgeMart

A complete Point-of-Sale system with dual experiences (**Grocery** and **Café**), 3D floor simulators, an **Operation Insights** dashboard, an AI **Live Monitor** (RTSP/ONVIF cameras + Intel DL Streamer vision), an MCP server for agentic LLM integration, and an **Agent Chat** powered by [Hermes Gateway](https://github.com/nousresearch/hermes-agent) with real-time table tracking via MQTT.

## Experiences

Switch between experiences from the toolbar toggle. Each experience has its own database, products, simulation model, and visual layout.

| Feature | Grocery | Café |
| ------- | ------- | ---- |
| Layout | 60×50 supermarket (produce, bakery, dairy, meat, aisles, 4 checkout lanes) | 30×30 café (L-shaped counter, espresso bar, pastry case, seating, window bar) |
| Customer flow | Wander → shop aisles → checkout → leave | Enter → queue → order → wait for drink → sit (dine-in) or leave (takeout) |
| Customer types | Shoppers | 60% takeout (orange) / 40% dine-in (purple) |
| Products | 20 grocery items across 8 categories | 32 items: espresso, coffee, tea, cold drinks, bagels, donuts, pastries, cakes |
| Customer range | 3–100 | 3–30 |
| Staff | — | Baristas (behind counter) + Floor staff (1:10 ratio, clears dirty tables) |

## Components

### Frontend (Angular POS)
- Angular framework with Material Design
- Dark/Standard theme switching
- Experience switcher (Grocery / Café)
- **Operation Insights** dashboard (default landing page) — live KPIs, revenue trend, table status, inventory, and a **Workflow Engine Events** MQTT feed
- **Live Monitor** tab — RTSP/ONVIF cameras + AI vision with live annotated preview ([docs](docs/LIVE-MONITOR.md))
- Integrated simulator snap-on option
- Configuration page for MCP server management, POS settings (stock check / replenish), and **Agent (LLM) latency tuning**
- **Agent Chat** tab for agentic AI interaction

### Backend (RESTful API)
- Node.js + Express
- Dual PostgreSQL databases (one per experience)
- Experience-aware routing via `X-Experience` header
- Product and transaction management
- **MQTT Table-Status Service** — real-time table state tracking
- **Chat Route** — proxies to Hermes Gateway with SSE streaming

### Simulator (WebGL 3D Floor)
- Angular + Three.js (WebGL)
- Experience-specific scene (grocery or café)
- Configurable customer count and simulation speed (0.25x–5x)
- Interactive: orbit camera, click to select fixtures, move/rotate/scale (G/R/S keys)
- Zone labels and dollar sign effect on transactions
- **Simulated vision events** — emits table state changes (occupied/dirty/cleared) to backend

### MCP Servers (Model Context Protocol)
- **pos-tools** — 11 tools for querying products, sales, customers, and schema
- **table-status** — 9 tools for real-time table monitoring via MQTT vision events
- Toggle on/off from the Config UI or run standalone

### Agent Chat (Hermes + MCP)
- Chat UI with streaming responses and live "calling &lt;tool&gt;…" indicators
- Sidebar showing connection status, available tools, and live table grid
- Hermes Gateway connects to multiple MCP servers (POS, table-status, external vision AI)
- Simulator generates synthetic vision events when external hardware is unavailable
- **Latency controls** (Config tab): max response tokens, temperature, and history window; short-TTL caching on hot MCP read tools

### Live Monitor (AI Vision)
- Add any number of **RTSP / ONVIF** cameras
- Per-camera Intel DL Streamer pipeline: detection + **zero-shot CLIP** classification of empty / occupied / dirty tables
- **Live annotated preview** — the camera tile shows a frame grab with detection boxes and the classification label overlaid
- **Per-camera overrides** (⚙ panel): choose the detection / CLIP / classification model and the inference **device (CPU / GPU / NPU)**
- **Graceful degradation** — if CLIP can't initialize, the pipeline auto-falls back to detection-only (boxes still shown, **DETECT-ONLY** badge)
- Detections publish to MQTT and feed the table-status service, dashboard, and agent
- Model manager (Detection / Classification / CLIP) with **quantization (FP32 / FP16 / INT8)** tracking + **model exporter** (YOLO, HuggingFace, CLIP zero-shot → OpenVINO IR, incl. INT8 CLIP)
- GPU/NPU acceleration via `/dev/dri` + Intel NPU accel-node passthrough
- 📖 [Full Live Monitor documentation →](docs/LIVE-MONITOR.md)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (Angular)                                              │
│  POS │ Transactions │ Simulator │ Agent Chat │ Config            │
└──────────────────────────────────────────────────┬──────────────┘
                                                   │ HTTP/SSE
┌──────────────────────────────────────────────────┼──────────────┐
│  Backend (Express)                               │              │
│  REST API │ MQTT Service │ Chat Proxy ───────────┘              │
│                │                                                 │
│  MCP Servers: pos-tools │ table-status                          │
└────────────────┼────────────────────────────────────────────────┘
                 │ MQTT                    │ stdio
┌────────────────┼────────┐    ┌──────────┴──────────┐
│  MQTT Broker             │    │  Hermes Gateway      │
│  (Mosquitto)             │    │  (LLM + MCP client)  │
└────────────────┬─────────┘    └──────────────────────┘
                 │
┌────────────────┴─────────┐
│  Vision AI System         │
│  (or Simulator fallback)  │
└───────────────────────────┘
```

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Angular CLI (`npm install -g @angular/cli`)
- MQTT Broker (optional, for table tracking — see below)
- Hermes Gateway (optional, for agent chat — see below)

### Database Setup
```bash
# Grocery database
createdb -U postgres pos_grocery
psql -U postgres -d pos_grocery -f database/grocery/schema.sql

# Café database
createdb -U postgres pos_cafe
psql -U postgres -d pos_cafe -f database/cafe/schema.sql
```

### Backend
```bash
cd backend
npm install
cp .env.example .env  # Configure your DB connections
npm run dev
```

### Frontend (includes Simulator)
```bash
cd frontend
npm install
ng serve
```

Navigate to `http://localhost:4200`

---

## MQTT Broker Setup

The table-status service subscribes to MQTT topics to receive vision events. Any MQTT v3.1.1/v5 broker works. [Eclipse Mosquitto](https://mosquitto.org/) is recommended.

### Install Mosquitto

**Windows (winget):**
```bash
winget install EclipseMosquitto.Mosquitto
```

**macOS:**
```bash
brew install mosquitto
brew services start mosquitto
```

**Linux (apt):**
```bash
sudo apt install -y mosquitto mosquitto-clients
sudo systemctl enable --now mosquitto
```

**Docker:**
```bash
docker run -d --name mosquitto -p 1883:1883 eclipse-mosquitto:2
```

### Verify
```bash
# In one terminal, subscribe:
mosquitto_sub -t "cafe/vision/events"

# In another, publish a test event:
mosquitto_pub -t "cafe/vision/events" -m '{"tableId":"table-3","event":"dirty","source":"test","timestamp":"2026-01-01T00:00:00Z"}'
```

### Configure in Backend
Add to `backend/.env`:
```env
MQTT_BROKER_URL=mqtt://localhost:1883
CAFE_TABLE_COUNT=15
```

### MQTT Topics

| Topic | Publisher | Description |
|-------|----------|-------------|
| `cafe/vision/events` | Vision AI / Simulator | Table state detections (occupied, dirty) |
| `cafe/pos/events` | POS Backend | Internal state changes |
| `cafe/staff/events` | Staff App | Manual table clearing |

### Event Payload Format
```json
{
  "tableId": "table-4",
  "event": "occupied|dirty|cleared",
  "timestamp": "2026-05-19T10:30:00Z",
  "source": "camera-2|simulator-vision|staff-app",
  "metadata": {}
}
```

> **Note:** When no MQTT broker is available, the table-status service runs in offline mode. The café simulator still sends events directly via HTTP to `/api/chat/tables/event`.

---

## Hermes Agent Setup

The Agent Chat tab communicates with [Hermes Agent](https://github.com/nousresearch/hermes-agent) (v0.14+), an autonomous AI agent by Nous Research that connects to MCP servers and runs an LLM reasoning loop. It exposes a gateway API that the backend proxies to.

📖 [Full Hermes documentation →](https://hermes-agent.nousresearch.com/docs/)

### Install Hermes Agent

**Linux / macOS / WSL2:**
```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc
```

**Windows (native PowerShell — early beta):**
```powershell
iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)
```

**Via pip:**
```bash
pip install hermes-agent
hermes postinstall
```

### Choose a Model Provider

Run the interactive model selector:
```bash
hermes model
```

Select **"Custom Endpoint"** for local models (LM Studio, Ollama, vLLM, etc.) or choose a hosted provider (OpenRouter, Anthropic, OpenAI, Nous Portal, etc.).

> **Important:** Hermes requires a model with at least **64K tokens of context**. If using a local model, set context length to at least 65536.

### Configure MCP Servers

Add the EdgeMart MCP servers to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  edgemart-pos:
    command: node
    args:
      - /path/to/pos-simulator/backend/src/mcp-server.js
    env:
      DB_HOST: localhost
      DB_PORT: "5432"
      MCP_DB_NAME: pos_cafe
      DB_USER: postgres
      DB_PASSWORD: ""

  edgemart-table-status:
    command: node
    args:
      - /path/to/pos-simulator/backend/src/mcp-table-status.js
    env:
      MQTT_BROKER_URL: mqtt://localhost:1883
      CAFE_TABLE_COUNT: "15"
```

Replace `/path/to/pos-simulator` with your actual project path.

Or set via CLI:
```bash
hermes config set mcp_servers.edgemart-pos.command node
hermes config set mcp_servers.edgemart-pos.args '["/path/to/pos-simulator/backend/src/mcp-server.js"]'
```

### Enable the API Server

The gateway includes an **API Server** that exposes Hermes as an OpenAI-compatible HTTP endpoint with full tool access. This is what the POS backend connects to.

Add to `~/.hermes/.env`:
```env
API_SERVER_ENABLED=true
API_SERVER_PORT=3001
API_SERVER_HOST=0.0.0.0
API_SERVER_KEY=change-me-local-dev
```

> **Note:** `API_SERVER_HOST=0.0.0.0` is required when running the POS stack in Docker so the backend container can reach Hermes on the host via the Docker bridge network. Use `127.0.0.1` only if running everything natively without Docker.

### Start the Gateway

The API server runs as part of the gateway process:

```bash
# In the foreground (recommended for WSL/Docker/Termux):
hermes gateway run

# As a systemd/launchd service (Linux/macOS):
hermes gateway start
```

You should see:
```
[API Server] API server listening on http://127.0.0.1:3001
```

> **WSL users:** Use `hermes gateway run` — WSL's systemd support is unreliable.
> Wrap in tmux for persistence: `tmux new -s hermes 'hermes gateway run'`

### Using OpenVINO Model Serving (OVMS) as the Local LLM

**1. Follow the README in this [repo](https://github.com/wallacezq/ovms-ptl) to setup model server. 

**2. Configure Hermes to use LM Studio:**

```bash
hermes model
# Select: "Custom Endpoint"
# Base URL: http://localhost:1234/v1
# API Key: lm-studio  (any non-empty string)
# Model: hermes-3-llama-3.1-8b  (as shown in LM Studio)
```

Or set manually in `~/.hermes/config.yaml`:
```yaml
model: <your-model>
provider: lmstudio
base_url: http://localhost:8000/v3
```

**3. Verify OVMS is serving:**
```bash
curl http://localhost:8000/v3/models
# Should list the loaded model
```

**4. Start the gateway (API server starts automatically):**
```bash
hermes gateway run
```

> **Tips for local models:**
> - EdgeMart does not recommend or endorse any specific model — choose one that fits your hardware and use case
> - Use at least Q4_K_M quantization for reliable function calling
> - Models with native tool-use training work best
> - Ensure enough VRAM for model + 32K context
> - If tool calls fail, try a larger model or higher quantization

### Configure Backend Connection

Add to `backend/.env`:
```env
HERMES_GATEWAY_URL=http://localhost:3001
HERMES_API_KEY=change-me-local-dev
```

The backend proxies to the API server's OpenAI-compatible endpoints:
- `POST /v1/chat/completions` — streaming chat with tool use
- `GET /health` — health check
- `GET /v1/models` — list available models

### Verify

```bash
hermes doctor          # Check overall health
hermes gateway status  # Check gateway is running

# Test the API server directly:
curl http://localhost:3001/health
# → {"status":"ok"}

curl http://localhost:3001/v1/models \
  -H "Authorization: Bearer <your-api-key>"
# → lists "hermes-agent" model
```

### Quick Reference

| Command | Purpose |
|---------|---------|
| `hermes setup` | Full setup wizard |
| `hermes model` | Choose/switch LLM provider |
| `hermes mcp add` | Add an MCP server |
| `hermes tools` | Configure enabled tools |
| `hermes gateway run` | Start gateway + API server in foreground |
| `hermes gateway start` | Start as background service (systemd/launchd) |
| `hermes gateway status` | Check gateway health |
| `hermes doctor` | Diagnose issues |
| `hermes update` | Update to latest version |

Once running, the **Agent** tab in the frontend will show a green connection indicator and you can chat with the agent.

---

## MCP Server (POS Tools)

The MCP server exposes POS data to agentic LLMs via the Model Context Protocol. By default it connects to the grocery database. Set `MCP_DB_NAME` env variable to target a specific database.

### Running Standalone
```bash
cd backend
npm run mcp                           # uses grocery DB
MCP_DB_NAME=pos_cafe npm run mcp      # uses café DB
```

### POS Tools

| Tool                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `list_categories`        | List all product categories                              |
| `search_products`        | Search products by name or category                      |
| `get_product_details`    | Get details for a specific product                       |
| `get_sales_summary`      | Revenue summary with top products and category breakdown |
| `get_sales_by_date`      | Daily sales totals for trend analysis                    |
| `get_product_sales`      | Full sales history for a product                         |
| `list_customers`         | List customers, optionally loyalty-only                  |
| `get_customer_purchases` | Purchase history for a customer                          |
| `get_top_customers`      | Top customers by spending                                |
| `run_query`              | Run ad-hoc read-only SQL queries                         |
| `get_schema`             | View the database schema                                 |

## MCP Server (Table Status)

Exposes real-time table tracking to the Hermes agent.

### Running Standalone
```bash
cd backend
npm run mcp:tables
```

### Table Status Tools

| Tool                  | Description                                        |
| --------------------- | -------------------------------------------------- |
| `get_all_tables`      | Current status of all café tables                  |
| `get_dirty_tables`    | List tables needing cleaning                       |
| `get_occupied_tables` | List tables currently in use                       |
| `get_clean_tables`    | List available tables                              |
| `get_table_history`   | State change timeline for a specific table         |
| `get_table_stats`     | Aggregate stats (avg dirty duration, busiest, etc) |
| `mark_table_cleared`  | Mark a table as cleared by staff                   |
| `mark_table_occupied` | Mark a table as occupied                           |
| `get_service_status`  | MQTT connection and service health                 |

### Client Configuration

Add to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "edgemart-grocery": {
      "command": "node",
      "args": ["<path-to>/backend/src/mcp-server.js"]
    },
    "edgemart-table-status": {
      "command": "node",
      "args": ["<path-to>/backend/src/mcp-table-status.js"]
    }
  }
}
```

---

## Simulated Vision Events

When the external vision AI system is not available, the **café simulator** generates synthetic vision events:

| Simulator Event | MQTT Equivalent | Timing |
|----------------|-----------------|--------|
| Customer sits at table | `occupied` | Immediate |
| Customer leaves table | `dirty` | 1–4s delay (simulates CV processing) |
| Staff clears table | `cleared` | Immediate |

These events are POSTed to `POST /api/chat/tables/event` and feed into the TableStatusService, exercising the full pipeline without hardware.

---

## Live Monitor (AI Vision)

Connect RTSP/ONVIF cameras and run Intel DL Streamer pipelines (object detection + zero-shot CLIP
classification) to detect **empty / occupied / dirty tables** and emit events to MQTT — feeding the
Operation Insights dashboard, the agent, and the table-status service. Add/manage any number of cameras,
manage OpenVINO models grouped by purpose, and export/convert open models (YOLO, HuggingFace, CLIP zero-shot)
to OpenVINO IR from the UI.

📖 **[Full Live Monitor documentation →](docs/LIVE-MONITOR.md)**

---

## Docker Deployment

Run the entire stack (frontend, backend, PostgreSQL, MQTT, GPU metrics) in containers with a single command.

### Prerequisites
- Docker Engine 24+ and Docker Compose v2

### Start All Services

```bash
docker compose up --build
```

### Services

| Service | Container | Port | Description |
|---------|-----------|------|-------------|
| `frontend` | pos-frontend | **80** | Angular UI + nginx reverse proxy |
| `backend` | pos-backend | 3000 | Express API + metrics SSE |
| `postgres` | pos-postgres | 5432 | Dual databases (pos_grocery, pos_cafe) |
| `mqtt` | pos-mqtt | 1883, 9001 | MQTT broker (TCP + WebSocket) |
| `qmmd` | pos-qmmd | 9101 | Intel GPU metrics (Prometheus endpoint) |

Open http://localhost after startup.

### Live Monitor / Vision (Docker)

The AI **Live Monitor** launches Intel DL Streamer pipelines (and the model exporter) as **sibling
containers** via the Docker socket, which the `backend` service mounts (and runs as `user: root` to
access). Two named volumes hold vision data:

| Volume | Purpose |
|--------|---------|
| `vision_models` | OpenVINO model files, shared with the pipeline/exporter containers |
| `vision_snapshots` | Live annotated preview frames, written by the pipeline and served to the UI |
| `vision_data` | Camera/model/settings registry JSON (survives rebuilds) |

The `vision-exporter` service is **build-only** (profile `tools`) — it is not started by `docker compose up`.
Build it on demand:

```bash
docker compose --profile tools build vision-exporter
```

See [docs/LIVE-MONITOR.md](docs/LIVE-MONITOR.md) for the full setup, models, and troubleshooting.

### Docker Compose Environment

Configure via `.env` in the project root (or export variables):

```env
DB_PASSWORD=posdev2024
CAFE_TABLE_COUNT=15
HERMES_API_KEY=change-me-local-dev
```

### Rebuild After Code Changes

```bash
docker compose up --build backend frontend
```

### Stop and Clean Up

```bash
docker compose down           # Stop containers (keeps data volumes)
docker compose down -v        # Stop and remove data volumes (full reset)
```

### Database Initialization

On first run, PostgreSQL automatically:
1. Creates `pos_grocery` and `pos_cafe` databases
2. Runs the schema + seed data from `database/grocery/schema.sql` and `database/cafe/schema.sql`

To re-initialize, remove the postgres volume:
```bash
docker compose down -v
docker compose up --build
```

### Connecting Hermes Agent to Dockerized Services

If running Hermes outside Docker, point it at the exposed ports:

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  edgemart-pos:
    command: node
    args: ["/path/to/pos-simulator/backend/src/mcp-server.js"]
    env:
      DB_HOST: localhost
      DB_PORT: "5432"
      DB_PASSWORD: "posdev2024"
      MCP_DB_NAME: pos_cafe

  edgemart-table-status:
    command: node
    args: ["/path/to/pos-simulator/backend/src/mcp-table-status.js"]
    env:
      MQTT_BROKER_URL: "mqtt://localhost:1883"
      CAFE_TABLE_COUNT: "15"
```

### GPU Metrics in Docker

The `qmmd` container runs [qmmd](https://github.com/ulissesf/qmassa) (Prometheus daemon from the qmassa project) with `privileged: true`, host PID namespace, and host networking. It exposes Intel GPU metrics on port 9101 which the backend scrapes every second.

The backend's `/api/metrics/stream` SSE endpoint collects:
- **CPU/Memory** — natively via Node.js `os` module
- **GPU** — scraped from qmmd at `http://host.docker.internal:9101/metrics`
- **NPU** — read from sysfs when available

---

## GPU Metrics (qmmd)

The system metrics panel uses [qmmd](https://github.com/ulissesf/qmassa) (a Prometheus daemon from the qmassa project) to read Intel GPU engine utilization, frequency, power, and temperature.

In Docker, qmmd runs as a dedicated container with host networking and PID namespace. For local development you can run it manually.

### Install qmmd (Manual / Non-Docker)

**From crates.io (requires Rust toolchain):**
```bash
# Install Rust if not already present
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install qmmd
cargo install qmmd
```

**Run:**
```bash
sudo qmmd -f -p 9101 -m 1000
# -f = use DRM fdinfo (no perf PMU needed)
# -p = port
# -m = update interval in ms
```

**Verify:**
```bash
curl http://localhost:9101/metrics
```

### Requirements

- Linux with Intel GPU (i915 or xe driver)
- Root access (or appropriate capabilities)
- Access to `/dev/dri/`, `/sys/`, and `/proc/`

### Exposed Metrics

| Metric | Description |
|--------|-------------|
| `qmmd_gpu_engine_utilization_ratio` | Per-engine utilization (render, compute, video, copy, video-enhance) |
| `qmmd_gpu_actual_frequency_hertz` | Current GPU frequency |
| `qmmd_gpu_power_watts` | GPU and package power draw |
| `qmmd_gpu_temperature_celsius` | Package temperature |

> **Note:** If qmmd is not reachable, the metrics panel gracefully hides the GPU section — all other metrics (CPU, NPU, memory) continue to work.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` | `postgres` | PostgreSQL user |
| `DB_PASSWORD` | — | PostgreSQL password |
| `GROCERY_DB_NAME` | `pos_grocery` | Grocery database name |
| `CAFE_DB_NAME` | `pos_cafe` | Café database name |
| `MCP_DB_NAME` | (uses GROCERY_DB_NAME) | MCP server target DB |
| `MQTT_BROKER_URL` | `mqtt://localhost:1883` | MQTT broker connection string |
| `CAFE_TABLE_COUNT` | `15` | Number of tracked tables (9 floor + 6 bar) |
| `HERMES_GATEWAY_URL` | `http://localhost:3001` | Hermes agent gateway URL |
| `QMMD_URL` | `http://qmmd:9101` | qmmd GPU metrics endpoint |
| `CHAT_MAX_TOKENS` | `768` | Default agent max response tokens (tunable in the Config tab) |
| `CHAT_TEMPERATURE` | `0.2` | Default agent sampling temperature (tunable in the Config tab) |
| `CHAT_HISTORY_LIMIT` | `8` | Prior chat turns sent per request (tunable in the Config tab) |
| `MCP_CACHE_TTL_MS` | `10000` | Short-TTL cache for hot MCP read tools |
| `PORT` | `3000` | Backend API port |

> **Live Monitor / vision** variables (`VISION_*` incl. `VISION_RENDER_GID`, `VISION_NPU_DEVICE`, `DATA_DIR`) are documented in [docs/LIVE-MONITOR.md](docs/LIVE-MONITOR.md).

Or toggle the MCP server from the **Config** tab in the UI.

---

## Changelog

Notable changes, newest first. Dates are `YYYY-MM-DD`.

### 2026-11-10
**Live Monitor / vision**
- Live annotated camera preview (detection boxes + classification label overlaid, ~2 fps) via a shared `vision_snapshots` volume.
- Per-camera model and inference-device (CPU/GPU/NPU) overrides from the ⚙ panel.
- Graceful degradation: pipeline auto-falls back to detection-only when CLIP can't initialize, with a **DETECT-ONLY** badge; health now reflects a streaming pipeline (not just table events).
- GPU/NPU passthrough: `--device /dev/dri` + render-group `--group-add` (`VISION_RENDER_GID`, auto-detected) and Intel NPU accel node (`VISION_NPU_DEVICE`).
- Model exporter hardening: world-readable outputs, `clip_zeroshot` tag verification, `DLS_REF` pinned to the runtime (`VISION_DLS_REF`), and **INT8 CLIP** export via NNCF weight compression.
- Model store tracks **precision** (FP32/FP16/INT8); precision selector shown for all export sources incl. CLIP.

**Agent / LLM**
- Config-tab **Agent (LLM) latency controls**: max response tokens, temperature, and history window (persisted; env defaults `CHAT_MAX_TOKENS` / `CHAT_TEMPERATURE` / `CHAT_HISTORY_LIMIT`).
- Short-TTL caching of hot MCP read tools (`MCP_CACHE_TTL_MS`); tighter system prompt to reduce redundant tool calls; live "calling &lt;tool&gt;…" indicators in the chat UI.

**Platform**
- Rate limiter no longer throttles the app's own high-frequency polling (`/snapshot`, `/stream`) and ceiling raised, fixing stack-wide `429` lockouts; global 429 toast with automatic GET retry.

