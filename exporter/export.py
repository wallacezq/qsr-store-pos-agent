#!/usr/bin/env python3
# Copyright (c) 2026 Intel Corporation
# SPDX-License-Identifier: Apache-2.0
#
# Pulls an open model and converts it to OpenVINO IR (.xml/.bin).
#   - YOLO (Ultralytics):   https://docs.ultralytics.com/integrations/openvino
#   - HuggingFace / others: optimum-cli export openvino
#     (mirrors openvinotoolkit/model_server export_models/export_model.py)
# Prints `EXPORT_RESULT xml=<path>` on success for the caller to parse.

import argparse
import glob
import os
import shutil
import subprocess
import sys

import defusedxml.ElementTree as ET

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_MODELS_DIR = os.path.join(SCRIPT_DIR, "download_models")
DEFAULT_CLIP_LABELS = ["empty table", "occupied table", "dirty table"]


def _first_xml(root):
    hits = sorted(glob.glob(os.path.join(root, "**", "*.xml"), recursive=True))
    return hits[0] if hits else None


def _model_type(xml):
    """Read model_info/model_type from an OpenVINO IR's rt_info section, or None."""
    try:
        node = ET.parse(xml).getroot().find("rt_info/model_info/model_type")
        return node.get("value") if node is not None else None
    except Exception:  # noqa: BLE001 - unreadable/!IR XML
        return None


def _find_clip_zeroshot_xml(root):
    """Pick the IR tagged model_type=clip_zeroshot; the converter is selected by
    this tag, so an untagged IR causes gvaclassify 'post-processing is NULL'."""
    hits = sorted(glob.glob(os.path.join(root, "**", "*.xml"), recursive=True))
    for xml in hits:
        if _model_type(xml) == "clip_zeroshot":
            return xml
    return None


def _make_world_readable(root):
    """Widen perms on exported files. The exporter runs as root but the DL Streamer
    runtime reads models as a non-root user, and safetensors save_file writes 0600,
    which the runtime reports as the file not existing."""
    for dirpath, _dirnames, filenames in os.walk(root):
        try:
            os.chmod(dirpath, 0o755)
        except OSError:
            pass
        for name in filenames:
            try:
                os.chmod(os.path.join(dirpath, name), 0o644)
            except OSError:
                pass


def export_yolo(model_id, out_dir, precision):
    """Ultralytics: YOLO(...).export(format='openvino')."""
    from ultralytics import YOLO

    weights = model_id if model_id.endswith(".pt") else f"{model_id}.pt"
    model = YOLO(weights)  # auto-downloads the weights if not present
    exported = model.export(
        format="openvino",
        half=(precision == "FP16"),
        int8=(precision == "INT8"),
    )
    os.makedirs(out_dir, exist_ok=True)
    src = str(exported)
    if os.path.isdir(src):
        for f in glob.glob(os.path.join(src, "*")):
            shutil.copy(f, out_dir)
    return _first_xml(out_dir)


def export_hf(model_id, out_dir, precision, task):
    """Generic HuggingFace -> OpenVINO IR via optimum-cli."""
    os.makedirs(out_dir, exist_ok=True)
    weight_format = {"FP32": "fp32", "FP16": "fp16", "INT8": "int8"}.get(precision, "fp32")
    cmd = ["optimum-cli", "export", "openvino", "--model", model_id, "--weight-format", weight_format]
    if task:
        cmd += ["--task", task]
    cmd += [out_dir]
    subprocess.check_call(cmd)
    return _first_xml(out_dir)


def export_clip_zeroshot(model_id, out_dir, labels):
    """CLIP zero-shot IR + text-label embeddings via DL Streamer's helpers.

    Produces the clip_zeroshot image-encoder IR and a .safetensors label bank
    that gvaclassify consumes. Returns (xml, embeddings).
    """
    os.makedirs(out_dir, exist_ok=True)
    labels = labels or DEFAULT_CLIP_LABELS

    # 1) Image-encoder IR (model_type=clip_zeroshot).
    subprocess.check_call([
        sys.executable, os.path.join(DOWNLOAD_MODELS_DIR, "download_hf_models.py"),
        "--model", model_id, "--outdir", out_dir, "--export-variant", "clip-zeroshot",
    ])
    xml = _find_clip_zeroshot_xml(out_dir)
    if not xml:
        raise RuntimeError(
            "export produced no IR tagged model_type=clip_zeroshot; gvaclassify needs "
            "this tag (ensure the exporter's DL Streamer scripts match the runtime)."
        )

    # 2) Text-label embeddings (.safetensors) aligned to the same CLIP model.
    labels_path = os.path.join(out_dir, "labels.txt")
    with open(labels_path, "w", encoding="utf-8") as f:
        f.write("\n".join(labels) + "\n")
    embeddings = os.path.join(out_dir, "table-states.safetensors")
    subprocess.check_call([
        sys.executable, os.path.join(DOWNLOAD_MODELS_DIR, "clip_text_embeddings.py"),
        "--model", model_id, "--labels", labels_path, "--output", embeddings,
    ])
    return xml, embeddings


def main():
    p = argparse.ArgumentParser(description="Export open models to OpenVINO IR.")
    p.add_argument("--source", required=True, choices=["yolo", "huggingface", "clip-zeroshot"])
    p.add_argument("--model", required=True, help="e.g. yolov8n, yolov8n-cls, openai/clip-vit-base-patch32")
    p.add_argument("--out", required=True, help="output directory (IR written here)")
    p.add_argument("--precision", default="FP32", choices=["FP32", "FP16", "INT8"])
    p.add_argument("--task", default=None, help="optimum task override (huggingface only)")
    p.add_argument("--labels", default=None, help="comma-separated labels (clip-zeroshot only)")
    args = p.parse_args()

    embeddings = None
    try:
        if args.source == "yolo":
            xml = export_yolo(args.model, args.out, args.precision)
        elif args.source == "clip-zeroshot":
            labels = [s.strip() for s in args.labels.split(",")] if args.labels else None
            xml, embeddings = export_clip_zeroshot(args.model, args.out, labels)
        else:
            xml = export_hf(args.model, args.out, args.precision, args.task)
    except Exception as exc:  # noqa: BLE001 - surface any export error to the caller
        print(f"ERROR: export failed: {exc}", file=sys.stderr)
        sys.exit(1)

    if not xml:
        print("ERROR: no .xml produced", file=sys.stderr)
        sys.exit(2)

    _make_world_readable(args.out)

    print(f"EXPORT_RESULT xml={xml}")
    if embeddings:
        print(f"EXPORT_RESULT embeddings={embeddings}")


if __name__ == "__main__":
    main()
