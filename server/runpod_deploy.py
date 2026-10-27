"""Create or update Azaad's RunPod Serverless endpoint (vLLM worker, LoRA adapters).

    RUNPOD_API_KEY=... python server/runpod_deploy.py

The Hugging Face token comes from the RunPod secret `azaad_hf`, so neither key
is ever written into this repo or the template in plain text.
"""

import json
import os
import urllib.error
import urllib.request

API = "https://rest.runpod.io/v1"
KEY = os.environ["RUNPOD_API_KEY"]
NAME = os.environ.get("AZAAD_NAME", "azaad")

BASE = os.environ.get("AZAAD_BASE", "RedHatAI/gemma-4-31B-it-FP8-dynamic")
ADAPTERS = {"azaad": "Sejibeji/azaad-lora", "azaad-research": "Sejibeji/azaad-research-lora"}

ENV = {
    "MODEL_NAME": BASE,
    "OPENAI_SERVED_MODEL_NAME_OVERRIDE": "google/gemma-4-31B-it",
    "HF_TOKEN": "{{ RUNPOD_SECRET_azaad_hf }}",
    "MAX_MODEL_LEN": "32768",
    "GPU_MEMORY_UTILIZATION": "0.92",
    "MAX_NUM_SEQS": "24",
    "MAX_CONCURRENCY": "24",
    "LANGUAGE_MODEL_ONLY": "true",
    "REASONING_PARSER": "gemma4",
    "ENABLE_PREFIX_CACHING": "true",
    "ENABLE_LORA": "true",
    "MAX_LORA_RANK": "32",
    "MAX_LORAS": "2",
    "VLLM_EXTRA_ARGS": "--lora-modules " + " ".join(f"{k}={v}" for k, v in ADAPTERS.items()),
    # Gemma 4's multi-token-prediction drafter: same output, fewer forward passes.
    "SPECULATIVE_CONFIG": json.dumps({"model": "google/gemma-4-31B-it-assistant", "num_speculative_tokens": int(os.environ.get("AZAAD_SPEC_TOKENS", "3"))}),
}
if os.environ.get("AZAAD_SPEC_TOKENS") == "0":
    del ENV["SPECULATIVE_CONFIG"]

# 48 GB Ada/Hopper cards run FP8 natively; 80 GB cards are the fallback.
GPUS_48 = ["NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation", "NVIDIA L40"]
# Blackwell RTX PRO 6000 workers exited at startup with this vLLM build, so they're left out.
GPUS_80 = ["NVIDIA H100 80GB HBM3", "NVIDIA H100 PCIe", "NVIDIA H100 NVL", "NVIDIA H200", "NVIDIA A100-SXM4-80GB", "NVIDIA A100 80GB PCIe"]
# The MTP drafter needs headroom a 48 GB card doesn't have at 32K context.
GPUS = GPUS_80 if "SPECULATIVE_CONFIG" in ENV else GPUS_48 + GPUS_80


def call(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body else None, method=method,
                                 headers={"authorization": f"Bearer {KEY}", "content-type": "application/json", "user-agent": "azaad-deploy/1.0"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path}: {e.code} {e.read().decode()[:500]}") from None


def main():
    template = {
        "name": NAME,
        "imageName": "runpod/worker-v1-vllm:v2.30.1",
        "isServerless": True,
        "containerDiskInGb": 80,
        "env": ENV,
        "readme": "Azaad: Gemma 4 31B (FP8) with Bunga Azaadi's LoRA adapters.",
    }
    existing = {t["name"]: t for t in call("GET", "/templates") if t.get("isServerless")}
    if NAME in existing:
        tid = existing[NAME]["id"]
        call("POST", f"/templates/{tid}/update", {k: v for k, v in template.items() if k != "isServerless"})
    else:
        tid = call("POST", "/templates", template)["id"]
    endpoint = {
        "name": NAME,
        "templateId": tid,
        "computeType": "GPU",
        "gpuTypeIds": GPUS,
        "gpuCount": 1,
        "workersMin": int(os.environ.get("AZAAD_MIN_WORKERS", "0")),
        "workersMax": 2,
        "idleTimeout": 480,
        "flashboot": True,
        "scalerType": "QUEUE_DELAY",
        "scalerValue": 4,
        "executionTimeoutMs": 600000,
    }
    eps = {e["name"]: e for e in call("GET", "/endpoints")}
    if NAME in eps:
        eid = eps[NAME]["id"]
        call("POST", f"/endpoints/{eid}/update", {k: v for k, v in endpoint.items() if k not in ("computeType", "gpuCount")})
    else:
        eid = call("POST", "/endpoints", endpoint)["id"]
    print(json.dumps({"template": tid, "endpoint": eid}))


if __name__ == "__main__":
    main()
