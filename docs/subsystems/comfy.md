# ComfyUI Capability

English | [中文](comfy.zh.md)

The ComfyUI capability drives one generation server end to end: the model submits API-format workflow graphs, waits for jobs, and reads output asset URLs, or cancels work it no longer wants. The [ComfyUI capability decision](../../.agents/notes/implemented/feature/2026-08-24-comfy-capability.md) owns the endpoint split and package topology; the [package READMEs](../../packages/comfy/README.md) own composition, config, and tool behavior. This page records the wire-derived vocabulary from [`packages/comfy/comfy/src/types.ts`](../../packages/comfy/comfy/src/types.ts).

## Job lifecycle

A job is one execution of a workflow graph, durable from creation until `expiresAt`. Status transitions are `queued → running → succeeded | failed | expired`; a cancel request moves `running → canceling → canceled`. Terminal states are `succeeded`, `canceled`, `failed`, and `expired`. `outputs` populates incrementally while the job runs; `progress` is the latest server-computed snapshot.

```ts type-equiv
/**
 * Job lifecycle from the Comfy API v2 job object: `queued → running → succeeded | failed |
 * expired`; a cancel request moves `running → canceling → canceled`. Terminal states are
 * `succeeded`, `canceled`, `failed`, and `expired`.
 */
type ComfyJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'canceling'
  | 'canceled'
  | 'failed'
  | 'expired'
```

```ts type-equiv
/**
 * The v2 job object, normalized to camelCase. Durable from creation until `expiresAt`;
 * `outputs` populates incrementally while the job runs.
 */
interface ComfyJob {
  readonly id: string
  readonly status: ComfyJobStatus
  readonly createdAt: string
  readonly startedAt?: string | undefined
  readonly completedAt?: string | undefined
  readonly expiresAt: string
  readonly queuePosition?: number | undefined
  readonly progress?: ComfyJobProgress | undefined
  readonly outputs: readonly ComfyJobOutput[]
  readonly error?: ComfyJobError | undefined
}
```

```ts type-equiv
/** Server-computed progress snapshot; complete per snapshot. */
interface ComfyJobProgress {
  /** Overall fraction in `[0, 1]`. */
  readonly value: number
  readonly nodesDone: number
  readonly nodesTotal: number
  readonly currentNode?: string | undefined
  readonly currentNodeClass?: string | undefined
  readonly step?: number | undefined
  readonly steps?: number | undefined
  readonly message?: string | undefined
}
```

```ts type-equiv
/** One committed job output; `url` serves the bytes until `urlExpiresAt`. */
interface ComfyJobOutput {
  readonly nodeId: string
  readonly name: string
  readonly type: ComfyOutputType
  readonly contentType: string
  readonly sizeBytes: number
  /** Asset UUID; downloadable via the v2 asset endpoint for the job's retention window. */
  readonly assetId: string
  readonly url: string
  readonly urlExpiresAt: string
}
```

```ts type-equiv
/** Execution failure detail carried in the job object (not an HTTP error). */
interface ComfyJobError {
  readonly code: string
  readonly message: string
  readonly nodeId?: string | undefined
  readonly classType?: string | undefined
  readonly traceback?: string | undefined
}
```

## Assets

An asset is a UUID record over a content-addressed blob. Uploaded inputs and committed outputs are both assets; a workflow references one where a filename would normally go, as `{"__type": "core/ASSET", "info": {"id": "<asset uuid>"}}`.

```ts type-equiv
/** A v2 asset record over a content-addressed blob. */
interface ComfyAsset {
  readonly id: string
  /** `blake3:<hex>`; absent while the platform computes it lazily. */
  readonly hash?: string | undefined
  readonly sizeBytes: number
  readonly contentType: string
  readonly filePath?: string | undefined
  readonly createdAt: string
  readonly url: string
  readonly urlExpiresAt: string
}
```

## Workflows and errors

The workflow graph is API format — a map of node id to `class_type` plus inputs — passed through verbatim; the endpoint validates it authoritatively and rejects UI-format exports. Failures carry a typed error with an open-string code: `COMFY_REQUEST_FAILED`, `COMFY_TIMEOUT`, `COMFY_ABORTED`, `COMFY_API_ERROR`, `COMFY_NOT_FOUND`, and `COMFY_INVALID_RESPONSE`.

```ts type-equiv
/**
 * An API-format workflow graph: node id to `class_type` plus inputs. Values pass through
 * verbatim; the proxy validates the graph authoritatively and rejects UI-format exports.
 */
type ComfyWorkflowGraph = Readonly<Record<string, {
  readonly class_type: string
  readonly inputs: Readonly<Record<string, unknown>>
}>>
```

```ts type-equiv
/**
 * Typed ComfyUI capability error with a machine-routable, open-string `code` and chained
 * `cause`. Codes cover transport failure, timeouts, caller cancellation, non-2xx API
 * responses (whose envelope code travels in the message), and malformed response bodies.
 */
class ComfyError extends HarnessError {}
```

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomfy--comfyruntime"></a>

### `ctx.comfy` — `ComfyRuntime`

The ComfyUI capability service, registered as `ctx.comfy`. One HTTP client for the configured endpoints; every method accepts an optional cancellation signal, applies the configured request deadline, and throws ComfyError on failure.

```ts cordis-catalog
/**
 * Submit an API-format workflow graph for execution. Sends a fresh `Idempotency-Key`
 * per call, so retries submit new jobs and only network-level retries deduplicate.
 * @param workflow - the API-format graph, verbatim; UI-format exports are rejected
 *   server-side with `workflow_format_ui`.
 * @param signal - optional cancellation signal; aborting stops the submit, never a
 *   durably recorded job.
 * @returns the created job (initially `queued`).
 */
async submitWorkflow(workflow: ComfyWorkflowGraph, signal?: AbortSignal): Promise<ComfyJob>

/**
 * Fetch the authoritative state of one job: status, latest progress snapshot, and
 * every output committed so far.
 * @param id - the job id from {@link submitWorkflow}.
 * @param signal - optional cancellation signal.
 * @returns the full job object.
 */
async getJob(id: string, signal?: AbortSignal): Promise<ComfyJob>

/**
 * Request cancellation of one job. Idempotent: canceling a terminal job returns its
 * terminal state; a running job moves through `canceling`.
 * @param id - the job id.
 * @param signal - optional cancellation signal.
 * @returns the job object current at the cancel request.
 */
async cancelJob(id: string, signal?: AbortSignal): Promise<ComfyJob>

/**
 * Poll one job until it reaches a terminal state (`succeeded`, `canceled`, `failed`,
 * `expired`) or the wait budget ends. The job itself keeps running server-side when
 * the wait aborts or times out; {@link cancelJob} stops it.
 * @param id - the job id.
 * @param options - `timeoutMs` bounds the complete wait.
 * @param signal - optional cancellation signal fused into the wait.
 * @returns the terminal job object.
 * @throws {@link ComfyError} `COMFY_TIMEOUT` when the job is not terminal within
 *   `timeoutMs`, or `COMFY_ABORTED` when `signal` fires.
 */
async waitForJob(id: string, options: { timeoutMs: number }, signal?: AbortSignal): Promise<ComfyJob>

/**
 * List the model folder names the ComfyUI server serves (for example
 * `checkpoints`, `diffusion_models`, `loras`).
 * @param signal - optional cancellation signal.
 * @returns the folder names.
 */
async listModelFolders(signal?: AbortSignal): Promise<readonly string[]>

/**
 * List the model files in one folder of the ComfyUI server's model library.
 * @param folder - the folder name from {@link listModelFolders}.
 * @param signal - optional cancellation signal.
 * @returns the file names in that folder.
 */
async listModelFiles(folder: string, signal?: AbortSignal): Promise<readonly string[]>

/**
 * Fetch one node class's input schema from the ComfyUI server: required and optional
 * inputs with their types, defaults, and enumerated values. The schema is what a
 * workflow author needs to connect the node; the full catalog is deliberately not
 * offered through this method.
 * @param classType - the node class name (for example `KSampler`).
 * @param signal - optional cancellation signal.
 * @returns the node class's input schema as opaque JSON.
 * @throws {@link ComfyError} `COMFY_NOT_FOUND` when the server does not know the class.
 */
async getNodeInfo(classType: string, signal?: AbortSignal): Promise<Record<string, unknown>>

/**
 * Upload one asset through the v2 asset endpoint and mint its record. Assets are the
 * only way to feed external bytes (for example an input image) into a workflow:
 * reference the returned id in the graph as
 * `{"__type": "core/ASSET", "info": {"id": "<asset id>"}}`.
 * @param upload - the bytes, their placement path, and the media type.
 * @param signal - optional cancellation signal.
 * @returns the minted asset; `hash` may be absent while computed lazily.
 */
async uploadAsset(upload: ComfyAssetUpload, signal?: AbortSignal): Promise<ComfyAsset>
```

Source: [`packages/comfy/comfy/src/index.ts`](../../packages/comfy/comfy/src/index.ts)
<!-- END GENERATED cordis-surface -->

Source: [`packages/comfy/comfy/src/index.ts`](../../packages/comfy/comfy/src/index.ts)
