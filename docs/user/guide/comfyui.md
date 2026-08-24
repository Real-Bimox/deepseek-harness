# Generate with ComfyUI

English | [中文](comfyui.zh.md)

The ComfyUI capability lets an agent run image, video, and audio generation workflows on a [ComfyUI](https://comfy.org) server: it discovers the installed models and node schemas, submits API-format workflow graphs, waits for jobs, and returns output URLs. This guide covers the server-side prerequisite, the composition overlay, and the model-facing tools, then the workflow for a typical generation task.

## Prerequisites: a Comfy API v2 endpoint

The versioned [Comfy API v2](https://docs.comfy.org/api-reference/v2/overview) (jobs and assets) is not served by the ComfyUI process itself. A self-hosted deployment runs [comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy) in front of ComfyUI:

```sh
pip install comfy-api-proxy
comfy-api-proxy run --host 127.0.0.1 --port 8189 --comfyui http://127.0.0.1:8188
```

ComfyUI serves the model and node discovery endpoints on `8188`; the proxy serves `/api/v2/*` on `8189` and keeps durable job state (pass `--state-dir` for persistence across restarts). A Comfy Cloud or serverless endpoint works without the proxy — the client contract is identical, with a bearer token in `token`.

The example deployment on the machine this guide was written on runs both as containers on a shared network, with the ComfyUI model library and output directory bind-mounted from the host.

## Compose the capability into a profile

The capability is two plugins: `dsh-comfy` registers `ctx.comfy`; `dsh-tool-comfy` exposes the tools. Add them to any composition:

```yaml
- id: comfy
  name: '@deepseek-ai/dsh-comfy'
  config:
    baseUrl: http://127.0.0.1:8189
    serverUrl: http://127.0.0.1:8188
- id: tool-comfy
  name: '@deepseek-ai/dsh-tool-comfy'
```

For the headless profile, [`examples/headless-agent/comfy.cordis.yml`](../../../examples/headless-agent/comfy.cordis.yml) is a ready overlay:

```sh
pnpm dsh --profile headless --patch examples/headless-agent/comfy.cordis.yml "<task>"
```

`baseUrl` accepts any Comfy API v2 endpoint; `serverUrl` points at the ComfyUI server itself and backs model and node discovery. Both default to the loopback ports above; `token` reads `COMFY_API_TOKEN` when the endpoint requires one.

## The tools

| Tool | Purpose |
|---|---|
| `comfy_list_models` | Model folders (no argument) or the files in one folder |
| `comfy_get_node` | One node class's input schema: names, types, defaults, allowed values |
| `comfy_submit_workflow` | Submit an API-format graph; returns `{ jobId, status }` |
| `comfy_get_job` | Status, progress, outputs, error; `wait: true` blocks to a terminal state |
| `comfy_cancel_job` | Request cancellation; idempotent |
| `comfy_upload_asset` | Upload a local file and reference it in a graph by asset id |

Workflows are API format — a map of node id to `{"class_type": string, "inputs": object}`. UI-format exports (the `nodes`/`links` shape) are rejected server-side. Inputs connect as `["<source node id>", <output slot>]`.

## A generation, step by step

Ask for what you want in plain language; the tools below are what the agent does.

1. **Discover**. `comfy_list_models` with `folder: "diffusion_models"` finds the installed generators; `comfy_get_node` with `classType: "KSampler"` (or any node about to be used) returns its exact inputs — which model slot names, samplers, and value ranges the server accepts.
2. **Build the graph**. Loaders first (UNET/CLIP/VAE), then conditioning, sampler, decode, and a `SaveImage` node so outputs persist in the server's output directory and as job assets.
3. **Submit and wait**. `comfy_submit_workflow`, then `comfy_get_job` with the returned `jobId` and `wait: true`. Jobs run `queued → running → succeeded`; progress arrives in the polled state, and outputs carry download URLs valid until the job's retention deadline.
4. **Read the result**. Successful jobs list outputs as `- <type> <name> → <url>`; the same files also land in the server's output directory. A failed job reports the failing node, class, and traceback excerpt.

To use a local file (for example an input image with an edit model), `comfy_upload_asset` it first and place the returned asset id in the graph where a filename would go: `{"__type": "core/ASSET", "info": {"id": "<asset id>"}}`.

## Failure and limits

Submission validates synchronously: an invalid graph is rejected with per-node detail before any work starts, surfaced as a `COMFY_API_ERROR` message. A run longer than the deployment's `getTimeoutMs` budget (default 10 minutes) fails the *call*, not the job — re-check with `comfy_get_job` or cancel with `comfy_cancel_job`; cancellation takes effect at node and step boundaries. Model files must fit the server's VRAM alongside its other tenants; a generation workload on a shared GPU needs headroom.

The [package READMEs](../../../packages/comfy/README.md) own the config surface, the error taxonomy, and the known limitations.
