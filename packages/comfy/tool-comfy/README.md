# dsh-tool-comfy — model-facing ComfyUI tools

English | [中文](README.zh.md)

Exposes `ctx.comfy` to the model as six tools: workflow submission, job polling (optionally blocking), cancellation, model discovery, node-schema lookup, and input asset upload. This package owns schemas, prompt guidance, limits, and presentation; `dsh-comfy` owns transport.

## Tools

| Tool | Purpose | Concurrency |
|---|---|---|
| `comfy_submit_workflow` | Submit an API-format workflow graph; returns `{ jobId, status }` | exclusive |
| `comfy_get_job` | Job status, progress, outputs, error; `wait: true` blocks to a terminal state | concurrent |
| `comfy_cancel_job` | Request cancellation; idempotent | exclusive |
| `comfy_list_models` | Model folders (no argument) or files in one folder | concurrent |
| `comfy_get_node` | One node class's input schema | concurrent |
| `comfy_upload_asset` | Upload a local file; returns the `core/ASSET` reference id | exclusive |

Workflows are API-format graphs (a map of node id to `{"class_type": string, "inputs": object}`); UI-format exports are rejected server-side. Input files enter graphs by uploading them and referencing the returned asset id as `{"__type": "core/ASSET", "info": {"id": "<asset id>"}}`.

## Config

| Field | Default | Meaning |
|---|---|---|
| `submitTimeoutMs` | `30000` | Cooperative budget for `comfy_submit_workflow` |
| `getTimeoutMs` | `600000` | Cooperative budget for `comfy_get_job`, including a blocking wait |
| `cancelTimeoutMs` | `30000` | Cooperative budget for `comfy_cancel_job` |
| `listTimeoutMs` | `30000` | Cooperative budget for `comfy_list_models` |
| `nodeTimeoutMs` | `30000` | Cooperative budget for `comfy_get_node` |
| `uploadTimeoutMs` | `120000` | Cooperative budget for `comfy_upload_asset` |
| `listMaxEntries` | `200` | Model names carried by one listing result |
| `nodeMaxOutputChars` | `20000` | Rendered characters for one node schema |
| `uploadMaxBytes` | `104857600` | Largest accepted upload (the proxy default is 100 MB) |

Timeouts attach as `ToolDefinition.timeoutMs` for `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce; they are deployment policy, never model arguments.

## Model Experience

### System prompt

#### What the model sees

The ComfyUI capability registers one guidance section.

##### ComfyUI capability guidance

```markdown
Use the ComfyUI tools to run image, video, and audio generation workflows on the configured ComfyUI server. Build workflows in API format: a map of node id to {"class_type": string, "inputs": object}. Discover model files with comfy_list_models and node input schemas with comfy_get_node. Submit with comfy_submit_workflow, then call comfy_get_job with wait=true to block until the job finishes and get output URLs. Cancel unwanted jobs with comfy_cancel_job. To feed a local file (for example an input image) into a workflow, upload it with comfy_upload_asset and reference the returned asset id in the graph as {"__type": "core/ASSET", "info": {"id": "<asset id>"}}.
```

#### Token effect

Fixed guidance cost per request while the plugin is loaded; the section is unconditional, so no configuration changes its text.

#### KV Cache effect

Prefix-stable while the plugin is loaded; plugin lifecycle may invalidate reuse from the first changed prompt section.

### Tool schemas

#### What the model sees

The model sees the generated [`comfy_*` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-comfy). Budgets and caps are deployment settings, not model arguments.

#### Token effect

Fixed schema cost per request for the six tools; there is no per-tool enablement, so the set changes only with plugin lifecycle.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged; plugin lifecycle or a scoped schema restriction may invalidate reuse from the first changed schema token.

### Tool results

#### What the model sees

Data-dependent job state: a status line, optional queue position and progress line (`NN%` with optional ` step s/t (NodeClass)`), output lines shaped exactly `- <type> <name> → <url>`, and on failure an `error[ at node <id> (<class>)]: <code>: <message>` line with a 1500-character traceback excerpt. Listing results carry scope, names, and a truncation note when the cap cut them. Upload results carry the asset id and the verbatim `core/ASSET` reference form.

#### Token effect

Data-dependent results are resent until compaction; listings are capped by `listMaxEntries`, rendered schemas by `nodeMaxOutputChars`, and tracebacks by the fixed excerpt length.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No background jobs** — `comfy_get_job` with `wait: true` blocks inside the foreground call; a run longer than `getTimeoutMs` fails the call while the job keeps running server-side. The `ctx.jobs` runtime is the deferred home for true background waits.
- **Uploads read the harness host only** — `comfy_upload_asset` resolves `path` on the local filesystem; a sandboxed or remote execution world must stage the file onto the host first.
