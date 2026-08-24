/**
 * Vocabulary for the ComfyUI capability (`ctx.comfy`): the Comfy API v2 job and asset
 * contracts served by comfy-api-proxy, plus the ComfyUI server's model and node discovery.
 * @module @deepseek-ai/dsh-comfy/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Job lifecycle from the Comfy API v2 job object: `queued → running → succeeded | failed |
 * expired`; a cancel request moves `running → canceling → canceled`. Terminal states are
 * `succeeded`, `canceled`, `failed`, and `expired`.
 */
export type ComfyJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'canceling'
  | 'canceled'
  | 'failed'
  | 'expired'

/** Server-computed progress snapshot; complete per snapshot. */
export interface ComfyJobProgress {
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

/** Normalized output kind from the v2 job object. */
export type ComfyOutputType = 'image' | 'video' | 'audio' | 'text' | 'file' | 'latent'

/** One committed job output; `url` serves the bytes until `urlExpiresAt`. */
export interface ComfyJobOutput {
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

/** Execution failure detail carried in the job object (not an HTTP error). */
export interface ComfyJobError {
  readonly code: string
  readonly message: string
  readonly nodeId?: string | undefined
  readonly classType?: string | undefined
  readonly traceback?: string | undefined
}

/**
 * The v2 job object, normalized to camelCase. Durable from creation until `expiresAt`;
 * `outputs` populates incrementally while the job runs.
 */
export interface ComfyJob {
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

/** A v2 asset record over a content-addressed blob. */
export interface ComfyAsset {
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

/**
 * An API-format workflow graph: node id to `class_type` plus inputs. Values pass through
 * verbatim; the proxy validates the graph authoritatively and rejects UI-format exports.
 */
export type ComfyWorkflowGraph = Readonly<Record<string, {
  readonly class_type: string
  readonly inputs: Readonly<Record<string, unknown>>
}>>

/** Input for an asset upload: the bytes plus the placement path and media type. */
export interface ComfyAssetUpload {
  readonly bytes: Uint8Array
  /** Placement path in the global input namespace (for example `photo.png`). */
  readonly filePath: string
  readonly contentType: string
}

/**
 * Typed ComfyUI capability error with a machine-routable, open-string `code` and chained
 * `cause`. Codes cover transport failure, timeouts, caller cancellation, non-2xx API
 * responses (whose envelope code travels in the message), and malformed response bodies.
 */
export class ComfyError extends HarnessError {}
