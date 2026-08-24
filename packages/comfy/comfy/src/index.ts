/**
 * Service Definition and HTTP provider for the ComfyUI capability (`ctx.comfy`): job
 * lifecycle and asset uploads against a Comfy API v2 endpoint (comfy-api-proxy, Comfy
 * Cloud, or a serverless deployment — one contract), plus model and node discovery
 * against the ComfyUI server itself. The runtime owns request deadlines, bearer
 * authentication, wire parsing, and the {@link ComfyError} taxonomy; consumers never
 * see transport details.
 * @module @deepseek-ai/dsh-comfy
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { ComfyError } from './types.ts'
import type {
  ComfyAsset,
  ComfyAssetUpload,
  ComfyJob,
  ComfyJobOutput,
  ComfyJobProgress,
  ComfyJobStatus,
  ComfyWorkflowGraph,
} from './types.ts'

export { ComfyError } from './types.ts'
export type {
  ComfyAsset,
  ComfyAssetUpload,
  ComfyJob,
  ComfyJobError,
  ComfyJobOutput,
  ComfyJobProgress,
  ComfyJobStatus,
  ComfyOutputType,
  ComfyWorkflowGraph,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    comfy: ComfyRuntime
  }
}

/** Terminal job states; every other state may still transition. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'canceled', 'failed', 'expired'])

const JOB_STATUSES: readonly string[] = [
  'queued', 'running', 'succeeded', 'canceling', 'canceled', 'failed', 'expired',
]

const OUTPUT_TYPES: readonly string[] = ['image', 'video', 'audio', 'text', 'file', 'latent']

/** Largest delay Node schedules without clamping it to 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Config for the ComfyUI runtime. `baseUrl` is the Comfy API v2 endpoint (the proxy in
 * front of a self-hosted ComfyUI); `serverUrl` is the ComfyUI server itself, used only
 * for the model and node discovery endpoints that the v2 API does not cover. `token`
 * omission reads `COMFY_API_TOKEN`.
 */
export interface Config {
  /** Comfy API v2 base URL. Defaults to the local proxy at `http://127.0.0.1:8189`. */
  baseUrl?: string
  /** ComfyUI server base URL for discovery. Defaults to `http://127.0.0.1:8188`. */
  serverUrl?: string
  /** Bearer token for `baseUrl`; omitted when the endpoint accepts unauthenticated requests. */
  token?: string
  /** Per-request deadline in milliseconds. Defaults to 30000. */
  requestTimeoutMs?: number
  /** Poll interval for {@link ComfyRuntime.waitForJob} in milliseconds. Defaults to 1000. */
  pollIntervalMs?: number
}

/** Complete config after schemastery applies every field default. */
interface ResolvedConfig {
  baseUrl: string
  serverUrl: string
  token: string | undefined
  requestTimeoutMs: number
  pollIntervalMs: number
}

/** Config shape schemastery produces (defaults already filled). */
type SchemaResolvedConfig = Required<Omit<Config, 'token'>> & Pick<Config, 'token'>

/**
 * The ComfyUI capability service, registered as `ctx.comfy`. One HTTP client for the
 * configured endpoints; every method accepts an optional cancellation signal, applies
 * the configured request deadline, and throws {@link ComfyError} on failure.
 */
export class ComfyRuntime extends Service {
  static Config: z<Config> = z.object({
    baseUrl: z.string().default('http://127.0.0.1:8189'),
    serverUrl: z.string().default('http://127.0.0.1:8188'),
    token: z.string(),
    requestTimeoutMs: z.number().default(30_000),
    pollIntervalMs: z.number().default(1_000),
  })

  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'comfy')
    // Schemastery fills these fields before construction; the type does not encode that step.
    const resolved = config as SchemaResolvedConfig
    this.config = {
      baseUrl: trimTrailingSlash(resolved.baseUrl),
      serverUrl: trimTrailingSlash(resolved.serverUrl),
      token: config.token ?? process.env.COMFY_API_TOKEN,
      requestTimeoutMs: resolved.requestTimeoutMs,
      pollIntervalMs: resolved.pollIntervalMs,
    }
    this.validate()
  }

  private validate(): void {
    assertHttpUrl('baseUrl', this.config.baseUrl)
    assertHttpUrl('serverUrl', this.config.serverUrl)
    assertPositiveMs('requestTimeoutMs', this.config.requestTimeoutMs)
    assertPositiveMs('pollIntervalMs', this.config.pollIntervalMs)
  }

  /**
   * Submit an API-format workflow graph for execution. Sends a fresh `Idempotency-Key`
   * per call, so retries submit new jobs and only network-level retries deduplicate.
   * @param workflow - the API-format graph, verbatim; UI-format exports are rejected
   *   server-side with `workflow_format_ui`.
   * @param signal - optional cancellation signal; aborting stops the submit, never a
   *   durably recorded job.
   * @returns the created job (initially `queued`).
   */
  async submitWorkflow(workflow: ComfyWorkflowGraph, signal?: AbortSignal): Promise<ComfyJob> {
    const body = await this.requestJson(
      `${this.config.baseUrl}/api/v2/jobs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ workflow }),
      },
      signal,
    )
    return parseJob(body)
  }

  /**
   * Fetch the authoritative state of one job: status, latest progress snapshot, and
   * every output committed so far.
   * @param id - the job id from {@link submitWorkflow}.
   * @param signal - optional cancellation signal.
   * @returns the full job object.
   */
  async getJob(id: string, signal?: AbortSignal): Promise<ComfyJob> {
    const body = await this.requestJson(`${this.config.baseUrl}/api/v2/jobs/${encodeURIComponent(id)}`, {}, signal)
    return parseJob(body)
  }

  /**
   * Request cancellation of one job. Idempotent: canceling a terminal job returns its
   * terminal state; a running job moves through `canceling`.
   * @param id - the job id.
   * @param signal - optional cancellation signal.
   * @returns the job object current at the cancel request.
   */
  async cancelJob(id: string, signal?: AbortSignal): Promise<ComfyJob> {
    const body = await this.requestJson(
      `${this.config.baseUrl}/api/v2/jobs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
      signal,
    )
    return parseJob(body)
  }

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
  async waitForJob(id: string, options: { timeoutMs: number }, signal?: AbortSignal): Promise<ComfyJob> {
    using d = deadline(signal, options.timeoutMs, 'COMFY_WAIT_TIMEOUT')
    try {
      for (;;) {
        const job = await this.getJob(id, d.signal)
        if (TERMINAL_STATUSES.has(job.status)) return job
        await sleep(this.config.pollIntervalMs, d.signal)
      }
    } catch (error: unknown) {
      const timeout = timeoutOf(d.signal, 'COMFY_WAIT_TIMEOUT')
      if (timeout !== undefined) {
        throw new ComfyError(`waiting for comfy job ${id} timed out after ${options.timeoutMs}ms`, 'COMFY_TIMEOUT', { cause: timeout })
      }
      if (!(error instanceof ComfyError) && d.signal.aborted) {
        throw new ComfyError(`waiting for comfy job ${id} aborted`, 'COMFY_ABORTED', { cause: error })
      }
      throw error
    }
  }

  /**
   * List the model folder names the ComfyUI server serves (for example
   * `checkpoints`, `diffusion_models`, `loras`).
   * @param signal - optional cancellation signal.
   * @returns the folder names.
   */
  async listModelFolders(signal?: AbortSignal): Promise<readonly string[]> {
    const body = await this.requestJson(`${this.config.serverUrl}/models`, {}, signal)
    return parseStringArray(body, 'model folders')
  }

  /**
   * List the model files in one folder of the ComfyUI server's model library.
   * @param folder - the folder name from {@link listModelFolders}.
   * @param signal - optional cancellation signal.
   * @returns the file names in that folder.
   */
  async listModelFiles(folder: string, signal?: AbortSignal): Promise<readonly string[]> {
    const body = await this.requestJson(`${this.config.serverUrl}/models/${encodeURIComponent(folder)}`, {}, signal)
    return parseStringArray(body, `model files in ${folder}`)
  }

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
  async getNodeInfo(classType: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const encoded = encodeURIComponent(classType)
    const body = await this.requestJson(`${this.config.serverUrl}/object_info/${encoded}`, {}, signal)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ComfyError(`comfy server returned a malformed node schema for ${classType}`, 'COMFY_INVALID_RESPONSE')
    }
    const schema = (body as Record<string, unknown>)[classType]
    if (schema === undefined) {
      throw new ComfyError(`comfy server node schema response does not carry ${classType}`, 'COMFY_INVALID_RESPONSE')
    }
    return schema as Record<string, unknown>
  }

  /**
   * Upload one asset through the v2 asset endpoint and mint its record. Assets are the
   * only way to feed external bytes (for example an input image) into a workflow:
   * reference the returned id in the graph as
   * `{"__type": "core/ASSET", "info": {"id": "<asset id>"}}`.
   * @param upload - the bytes, their placement path, and the media type.
   * @param signal - optional cancellation signal.
   * @returns the minted asset; `hash` may be absent while computed lazily.
   */
  async uploadAsset(upload: ComfyAssetUpload, signal?: AbortSignal): Promise<ComfyAsset> {
    const form = new FormData()
    form.append('file', new Blob([upload.bytes.slice()], { type: upload.contentType }), upload.filePath)
    form.append('content_type', upload.contentType)
    form.append('file_path', upload.filePath)
    const body = await this.requestJson(`${this.config.baseUrl}/api/v2/assets`, { method: 'POST', body: form }, signal)
    return parseAsset(body)
  }

  /**
   * One request against a configured endpoint: applies the request deadline and bearer
   * token, classifies failures into {@link ComfyError} codes, and parses the JSON body.
   * @param url - the absolute endpoint URL.
   * @param init - fetch options; headers carry no `authorization` unless a token is set.
   * @param signal - optional caller cancellation.
   * @returns the parsed JSON body.
   */
  private async requestJson(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<unknown> {
    using d = deadline(signal, this.config.requestTimeoutMs, 'COMFY_REQUEST_TIMEOUT')
    let response: Response
    try {
      // Headers merge: a caller's HeadersInit may be a string[][] whose object
      // spread would collapse to indices.
      const headers = new Headers(init.headers)
      if (this.config.token !== undefined) headers.set('authorization', `Bearer ${this.config.token}`)
      response = await fetch(url, { ...init, headers, signal: d.signal })
    } catch (error: unknown) {
      throw translateTransport(error, d.signal)
    }
    const text = await response.text()
    if (!response.ok) {
      throw requestError(url, response.status, text)
    }
    try {
      return JSON.parse(text) as unknown
    } catch (error: unknown) {
      throw new ComfyError(`comfy endpoint ${url} returned a non-JSON body`, 'COMFY_INVALID_RESPONSE', { cause: error })
    }
  }
}

/** Strip one trailing slash so endpoint joins never produce `//`. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function assertHttpUrl(name: string, value: string): void {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)')
  } catch (error: unknown) {
    throw new Error(`dsh-comfy: ${name} must be an http(s) URL: ${value}`, { cause: error })
  }
}

function assertPositiveMs(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-comfy: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * Translate a thrown fetch error into a `ComfyError` by the deadline signal: our
 * request timeout, caller cancellation, or a transport failure.
 */
function translateTransport(error: unknown, signal: AbortSignal): ComfyError {
  const timeout = timeoutOf(signal, 'COMFY_REQUEST_TIMEOUT')
  if (timeout !== undefined) return new ComfyError('comfy request timed out', 'COMFY_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new ComfyError('comfy request aborted', 'COMFY_ABORTED', { cause: error })
  return new ComfyError(`comfy request failed: ${String(error)}`, 'COMFY_REQUEST_FAILED', { cause: error })
}

/** Build the `ComfyError` for a non-2xx response, extracting the API error envelope when present. */
function requestError(url: string, status: number, body: string): ComfyError {
  let envelopeCode: string | undefined
  let envelopeMessage: string | undefined
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const envelope = (parsed as Record<string, unknown>).error
      if (typeof envelope === 'object' && envelope !== null) {
        const { code, message } = envelope as Record<string, unknown>
        if (typeof code === 'string') envelopeCode = code
        if (typeof message === 'string') envelopeMessage = message
      }
    }
  } catch {
    // Non-JSON error bodies keep their raw text; the status code alone still routes.
  }
  const detail = envelopeCode !== undefined || envelopeMessage !== undefined
    ? [envelopeCode, envelopeMessage].filter(part => part !== undefined).join(': ')
    : body.slice(0, 500)
  if (status === 404) {
    return new ComfyError(`comfy endpoint reports not found: ${url}${detail.length > 0 ? ` (${detail})` : ''}`, 'COMFY_NOT_FOUND')
  }
  return new ComfyError(`comfy endpoint ${url} rejected the request with HTTP ${status}${detail.length > 0 ? `: ${detail}` : ''}`, 'COMFY_API_ERROR')
}

/** A wire object whose unexpected shape becomes `COMFY_INVALID_RESPONSE`. */
function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ComfyError(`comfy endpoint returned a malformed ${what}`, 'COMFY_INVALID_RESPONSE')
  }
  return value as Record<string, unknown>
}

function requiredString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key]
  if (typeof value !== 'string') {
    throw new ComfyError(`comfy endpoint ${what} is missing the string field "${key}"`, 'COMFY_INVALID_RESPONSE')
  }
  return value
}

function requiredNumber(source: Record<string, unknown>, key: string, what: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ComfyError(`comfy endpoint ${what} is missing the numeric field "${key}"`, 'COMFY_INVALID_RESPONSE')
  }
  return value
}

/** Map a wire nullable/absent field to `undefined`. */
function optional<T>(source: Record<string, unknown>, key: string, check: (value: unknown) => value is T): T | undefined {
  const value = source[key]
  return value === null || value === undefined ? undefined : check(value) ? value : undefined
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseStringArray(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new ComfyError(`comfy endpoint returned a malformed ${what} list`, 'COMFY_INVALID_RESPONSE')
  }
  return value as readonly string[]
}

/** Parse and validate one v2 job object at the wire boundary. */
function parseJob(value: unknown): ComfyJob {
  const source = asObject(value, 'job object')
  const status = requiredString(source, 'status', 'job object')
  if (!JOB_STATUSES.includes(status)) {
    throw new ComfyError(`comfy endpoint job object carries an unknown status "${status}"`, 'COMFY_INVALID_RESPONSE')
  }
  const outputs = source.outputs
  if (!Array.isArray(outputs)) {
    throw new ComfyError('comfy endpoint job object is missing the outputs array', 'COMFY_INVALID_RESPONSE')
  }
  return {
    id: requiredString(source, 'id', 'job object'),
    status: status as ComfyJobStatus,
    createdAt: requiredString(source, 'created_at', 'job object'),
    startedAt: optional(source, 'started_at', isString),
    completedAt: optional(source, 'completed_at', isString),
    expiresAt: requiredString(source, 'expires_at', 'job object'),
    queuePosition: optional(source, 'queue_position', isNumber),
    progress: source.progress === null || source.progress === undefined ? undefined : parseProgress(source.progress),
    outputs: outputs.map(parseOutput),
    error: source.error === null || source.error === undefined ? undefined : parseJobError(source.error),
  }
}

function parseProgress(value: unknown): ComfyJobProgress {
  const source = asObject(value, 'job progress object')
  return {
    value: requiredNumber(source, 'value', 'job progress object'),
    nodesDone: requiredNumber(source, 'nodes_done', 'job progress object'),
    nodesTotal: requiredNumber(source, 'nodes_total', 'job progress object'),
    currentNode: optional(source, 'current_node', isString),
    currentNodeClass: optional(source, 'current_node_class', isString),
    step: optional(source, 'step', isNumber),
    steps: optional(source, 'steps', isNumber),
    message: optional(source, 'message', isString),
  }
}

function parseOutput(value: unknown): ComfyJobOutput {
  const source = asObject(value, 'job output object')
  const type = requiredString(source, 'type', 'job output object')
  if (!OUTPUT_TYPES.includes(type)) {
    throw new ComfyError(`comfy endpoint job output carries an unknown type "${type}"`, 'COMFY_INVALID_RESPONSE')
  }
  return {
    nodeId: requiredString(source, 'node_id', 'job output object'),
    name: requiredString(source, 'name', 'job output object'),
    type: type as ComfyJobOutput['type'],
    contentType: requiredString(source, 'content_type', 'job output object'),
    sizeBytes: requiredNumber(source, 'size_bytes', 'job output object'),
    assetId: requiredString(source, 'id', 'job output object'),
    url: requiredString(source, 'url', 'job output object'),
    urlExpiresAt: requiredString(source, 'url_expires_at', 'job output object'),
  }
}

function parseJobError(value: unknown): ComfyJob['error'] {
  const source = asObject(value, 'job error object')
  return {
    code: requiredString(source, 'code', 'job error object'),
    message: requiredString(source, 'message', 'job error object'),
    nodeId: optional(source, 'node_id', isString),
    classType: optional(source, 'class_type', isString),
    traceback: optional(source, 'traceback', isString),
  }
}

function parseAsset(value: unknown): ComfyAsset {
  const source = asObject(value, 'asset object')
  return {
    id: requiredString(source, 'id', 'asset object'),
    hash: optional(source, 'hash', isString),
    sizeBytes: requiredNumber(source, 'size_bytes', 'asset object'),
    contentType: requiredString(source, 'content_type', 'asset object'),
    filePath: optional(source, 'file_path', isString),
    createdAt: requiredString(source, 'created_at', 'asset object'),
    url: requiredString(source, 'url', 'asset object'),
    urlExpiresAt: requiredString(source, 'url_expires_at', 'asset object'),
  }
}

/** AbortSignal.reason carries an Error (a DOMException by default) once aborted. */
function asError(signal: AbortSignal): Error {
  return signal.reason as Error
}

/** Interruptible sleep; rejects immediately when `signal` fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(asError(signal))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(asError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export default ComfyRuntime
