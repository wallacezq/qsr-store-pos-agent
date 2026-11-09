# Copyright (c) 2026 Intel Corporation
#
# SPDX-License-Identifier: Apache-2.0
#
# Model exporter image: pulls open models (YOLO / HuggingFace / CLIP zero-shot)
# and converts them to OpenVINO IR. Invoked on demand by the backend as a
# sibling container:
#   docker run --rm -v vision_models:/models edgemart/vision-exporter \
#     --source yolo --model yolov8n --out /models/yolov8n --precision FP16
#
# Build it (not started by `docker compose up`, it's a one-shot tool):
#   docker compose --profile tools build vision-exporter

FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

# DL Streamer ref to pull the HF/CLIP export helpers from. Pin to the SAME
# release as the runtime image (VISION_DOCKER_IMAGE) so the exported model's
# rt_info matches the converter that consumes it. A mismatch yields a model the
# runtime can't post-process ("post-processing is NULL").
ARG DLS_REF=v2026.3.0-rc1

# git for the sparse checkout; OpenCV/torch runtime libs for ultralytics.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Vendor DL Streamer's download_models scripts (download_hf_models.py,
# clip_text_embeddings.py, hf_utils.py) for the clip-zeroshot variant.
RUN git clone --depth 1 --filter=blob:none --sparse --branch "${DLS_REF}" \
      https://github.com/open-edge-platform/dlstreamer.git /tmp/dls \
    && git -C /tmp/dls sparse-checkout set scripts/download_models \
    && mkdir -p /opt/exporter/download_models \
    && cp -r /tmp/dls/scripts/download_models/. /opt/exporter/download_models/ \
    && rm -rf /tmp/dls

RUN pip install --no-cache-dir \
      "ultralytics" \
      "optimum-intel[openvino]" \
      "openvino" \
      "nncf" \
      "defusedxml" \
      "huggingface_hub" \
      "safetensors" \
      "transformers"

WORKDIR /opt/exporter
COPY export.py .

ENTRYPOINT ["python", "export.py"]
