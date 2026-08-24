/**
 * Model-facing ComfyUI tools (`comfy_submit_workflow`, `comfy_get_job`, `comfy_cancel_job`,
 * `comfy_list_models`, `comfy_get_node`, `comfy_upload_asset`) over `ctx.comfy`. This
 * package owns schemas, prompt guidance, limits, and presentation, never transport.
 * @module @deepseek-ai/dsh-tool-comfy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-comfy'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerComfyTools } from './tools.ts'

export {
  concurrentRemoteRead,
  exclusiveRemoteMutation,
  formatJobOutput,
  formatModelList,
  formatNodeInfo,
  presentCancelCall,
  presentGetJobCall,
  presentGetNodeCall,
  presentJobResult,
  presentListModelsCall,
  presentSubmitCall,
  presentUploadCall,
  registerComfyTools,
} from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-comfy'

/** Services required by the ComfyUI tool suite. */
export const inject = ['tools', 'comfy', 'systemPrompt']

/** Default cooperative budget (ms) for one `comfy_get_job` call, including a blocking wait. */
export const DEFAULT_JOB_TIMEOUT_MS = 600_000

/** Default cap on model names carried by one `comfy_list_models` result. */
export const DEFAULT_LIST_MAX_ENTRIES = 200

/** Default cap on rendered `comfy_get_node` output characters. */
export const DEFAULT_NODE_MAX_OUTPUT_CHARS = 20_000

/** Default cap on one `comfy_upload_asset` file size in bytes (the proxy default is 100 MB). */
export const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024

/** Plugin config: per-tool cooperative budgets and result caps. */
export interface Config {
  /** Cooperative timeout budget (ms) for `comfy_submit_workflow`. Defaults to 30000. */
  submitTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `comfy_get_job`, including a blocking wait. Defaults to 600000. */
  getTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `comfy_cancel_job`. Defaults to 30000. */
  cancelTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `comfy_list_models`. Defaults to 30000. */
  listTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `comfy_get_node`. Defaults to 30000. */
  nodeTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `comfy_upload_asset`. Defaults to 120000. */
  uploadTimeoutMs?: number
  /** Cap on model names carried by one `comfy_list_models` result. Defaults to 200. */
  listMaxEntries?: number
  /** Cap on rendered `comfy_get_node` output characters. Defaults to 20000. */
  nodeMaxOutputChars?: number
  /** Cap on one `comfy_upload_asset` file size in bytes. Defaults to 104857600. */
  uploadMaxBytes?: number
}

export const Config: z<Config> = z.object({
  submitTimeoutMs: z.number().default(30_000),
  getTimeoutMs: z.number().default(DEFAULT_JOB_TIMEOUT_MS),
  cancelTimeoutMs: z.number().default(30_000),
  listTimeoutMs: z.number().default(30_000),
  nodeTimeoutMs: z.number().default(30_000),
  uploadTimeoutMs: z.number().default(120_000),
  listMaxEntries: z.number().default(DEFAULT_LIST_MAX_ENTRIES),
  nodeMaxOutputChars: z.number().default(DEFAULT_NODE_MAX_OUTPUT_CHARS),
  uploadMaxBytes: z.number().default(DEFAULT_UPLOAD_MAX_BYTES),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Positive-integer check shared by every configured budget and cap. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-comfy: ${name} must be a positive integer`)
  }
}

/**
 * Register the ComfyUI tool suite. Each tool's cooperative timeout budget is resolved
 * here and attached as `ToolDefinition.timeoutMs` for the timeout policy to enforce;
 * result caps bound listing size, rendered schema text, and uploads.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('submitTimeoutMs', resolved.submitTimeoutMs)
  assertPositiveInteger('getTimeoutMs', resolved.getTimeoutMs)
  assertPositiveInteger('cancelTimeoutMs', resolved.cancelTimeoutMs)
  assertPositiveInteger('listTimeoutMs', resolved.listTimeoutMs)
  assertPositiveInteger('nodeTimeoutMs', resolved.nodeTimeoutMs)
  assertPositiveInteger('uploadTimeoutMs', resolved.uploadTimeoutMs)
  assertPositiveInteger('listMaxEntries', resolved.listMaxEntries)
  assertPositiveInteger('nodeMaxOutputChars', resolved.nodeMaxOutputChars)
  assertPositiveInteger('uploadMaxBytes', resolved.uploadMaxBytes)
  registerComfyTools(ctx, resolved)
}
