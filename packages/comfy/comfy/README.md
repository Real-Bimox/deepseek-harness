# dsh-comfy — ComfyUI capability service (`ctx.comfy`)

English | [中文](README.zh.md)

One HTTP client for driving [ComfyUI](https://comfy.org) generation servers: job lifecycle and asset uploads against a [Comfy API v2](https://docs.comfy.org/api-reference/v2/overview) endpoint, plus model and node discovery against the ComfyUI server itself. `dsh-tool-comfy` renders the capability to the model; this package owns transport, deadlines, and the `ComfyError` taxonomy.

## Service API

`ComfyRuntime` (default export) registers as `ctx.comfy`. Every method takes an optional `AbortSignal`, applies the configured per-request deadline, and throws `ComfyError` on failure.

| Method | Endpoint | Returns |
|---|---|---|
| `submitWorkflow(workflow, signal?)` | `POST /api/v2/jobs` | The queued `ComfyJob` |
| `getJob(id, signal?)` | `GET /api/v2/jobs/{id}` | The authoritative `ComfyJob` |
| `cancelJob(id, signal?)` | `POST /api/v2/jobs/{id}/cancel` | The `ComfyJob` current at the cancel request |
| `waitForJob(id, { timeoutMs }, signal?)` | polls `getJob` | The terminal `ComfyJob`, or `COMFY_TIMEOUT` / `COMFY_ABORTED` |
| `listModelFolders(signal?)` | `GET {serverUrl}/models` | Folder names the ComfyUI server serves |
| `listModelFiles(folder, signal?)` | `GET {serverUrl}/models/{folder}` | File names in one folder |
| `getNodeInfo(classType, signal?)` | `GET {serverUrl}/object_info/{classType}` | One node class's input schema |
| `uploadAsset({ bytes, filePath, contentType }, signal?)` | `POST /api/v2/assets` | The minted `ComfyAsset` |

Job statuses: `queued → running → succeeded | failed | expired`; a cancel request moves `running → canceling → canceled`. Terminal states are `succeeded`, `canceled`, `failed`, and `expired`.

## Config

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8189` | Comfy API v2 endpoint (comfy-api-proxy, Comfy Cloud, or a serverless deployment — one contract) |
| `serverUrl` | `http://127.0.0.1:8188` | ComfyUI server used for the discovery endpoints the v2 API does not cover |
| `token` | `COMFY_API_TOKEN` | Bearer token for `baseUrl`; omit when the endpoint accepts unauthenticated requests |
| `requestTimeoutMs` | `30000` | Per-request deadline |
| `pollIntervalMs` | `1000` | Poll interval inside `waitForJob` |

## Design notes

- Two endpoints by contract split: the v2 API owns durable jobs and assets; the ComfyUI server owns its model library and node schemas. Neither is derivable from the other, so both are explicit required-by-default config.
- Wire responses are parsed at the boundary: unknown statuses, output types, or missing required fields become `COMFY_INVALID_RESPONSE` rather than leaking partial jobs.
- `submitWorkflow` sends a fresh `Idempotency-Key` per call, so retries submit new jobs; the key exists to keep the proxy's reject-on-duplicate semantics honest for one attempt.
- `waitForJob` returns or throws without touching the job; `cancelJob` is the only way work stops. An aborted wait is a caller concern, never a server-side cancel.

## Errors

`ComfyError` extends `HarnessError` with an open-string `code`: `COMFY_REQUEST_FAILED` (transport), `COMFY_TIMEOUT` (request or wait budget), `COMFY_ABORTED` (caller cancellation), `COMFY_API_ERROR` (non-2xx; the API envelope code and message travel in the message), `COMFY_NOT_FOUND` (404), and `COMFY_INVALID_RESPONSE` (malformed body).

## Model Experience

None, as the HTTP client registers no model context; `dsh-tool-comfy` owns every rendered effect.

#### KV Cache effect

The service contributes no prompt or schema tokens and cannot invalidate any reusable prefix; only its consumer's registrations affect model requests.

## Known Limitations and Deferred Work

- **Output sizes are advisory** — comfy-api-proxy 0.1.x records `sizeBytes: 0` for job outputs; consumers treat sizes as unreliable until the proxy fills them.
- **No asset byte download** — the service fetches asset metadata only; consumers download bytes from the output `url` (Range-capable) or read the server's output directory.
