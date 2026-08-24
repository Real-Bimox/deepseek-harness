/**
 * The model-facing ComfyUI tools. This module owns schemas, validation, render text,
 * and presentation; `ctx.comfy` owns transport. Timeouts are deployment policy declared
 * via config (`ToolDefinition.timeoutMs`), never model arguments.
 */

import { basename } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, JsonValue, ToolResult } from '@deepseek-ai/dsh-tools'
import type { ComfyJob, ComfyJobOutput } from '@deepseek-ai/dsh-comfy'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Fixed media-type map for uploads, keyed by file extension; unknown extensions upload as `application/octet-stream`. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain',
  '.json': 'application/json',
}


/** Concurrency classifier for tools that change remote ComfyUI state.
 * @returns `false`; mutating tools dispatch exclusively.
 */
export function exclusiveRemoteMutation(): boolean {
  return false
}

/** Concurrency classifier for tools that only read remote ComfyUI state.
 * @returns `true`; read-only tools may dispatch concurrently.
 */
export function concurrentRemoteRead(): boolean {
  return true
}

/** Pending-call card for `comfy_submit_workflow`.
 * @returns the execute-kind generic card.
 */
export function presentSubmitCall(): GenericCallView {
  return { card: 'generic', title: 'comfy: submit workflow', kind: 'execute' }
}

/** Pending-call card for `comfy_get_job`.
 * @param args - carries `jobId` for the card title.
 * @returns the read-kind generic card.
 */
export function presentGetJobCall(args: { jobId: string }): GenericCallView {
  return { card: 'generic', title: `comfy: job ${args.jobId}`, kind: 'read', rawInput: args.jobId }
}

/** Pending-call card for `comfy_cancel_job`.
 * @param args - carries `jobId` for the card title.
 * @returns the execute-kind generic card.
 */
export function presentCancelCall(args: { jobId: string }): GenericCallView {
  return { card: 'generic', title: `comfy: cancel job ${args.jobId}`, kind: 'execute', rawInput: args.jobId }
}

/** Pending-call card for `comfy_list_models`.
 * @param args - optionally carries `folder` for the card title.
 * @returns the search-kind generic card.
 */
export function presentListModelsCall(args: { folder?: string }): GenericCallView {
  return { card: 'generic', title: args.folder === undefined ? 'comfy: list model folders' : `comfy: list models in ${args.folder}`, kind: 'search' }
}

/** Pending-call card for `comfy_get_node`.
 * @param args - carries `classType` for the card title.
 * @returns the search-kind generic card.
 */
export function presentGetNodeCall(args: { classType: string }): GenericCallView {
  return { card: 'generic', title: `comfy: node schema ${args.classType}`, kind: 'search' }
}

/** Pending-call card for `comfy_upload_asset`.
 * @param args - carries `path` for the card title.
 * @returns the execute-kind generic card.
 */
export function presentUploadCall(args: { path: string }): GenericCallView {
  return { card: 'generic', title: `comfy: upload ${args.path}`, kind: 'execute', rawInput: args.path }
}

/** Longest excerpt of a job error traceback included in rendered output. */
const TRACEBACK_EXCERPT_CHARS = 1_500

/**
 * Validate value constraints the schema DSL cannot express.
 * @param value - a non-empty string argument.
 */
function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
}

/** Render one job's state, progress, outputs, and error for the model.
 * @param job - the normalized job object.
 * @returns the complete model-facing text block.
 */
export function formatJobOutput(job: ComfyJob): string {
  const lines = [`ComfyUI job ${job.id}: ${job.status}`]
  if (job.queuePosition !== undefined) lines.push(`queue position: ${job.queuePosition}`)
  if (job.progress !== undefined) {
    const step = job.progress.step !== undefined && job.progress.steps !== undefined ? ` step ${job.progress.step}/${job.progress.steps}` : ''
    const node = job.progress.currentNodeClass !== undefined ? ` (${job.progress.currentNodeClass})` : ''
    const message = job.progress.step === undefined && job.progress.message !== undefined ? ` ${job.progress.message}` : ''
    lines.push(`progress: ${Math.round(job.progress.value * 100)}%${step}${node}${message}`)
  }
  if (job.outputs.length > 0) {
    lines.push('outputs:')
    for (const output of job.outputs) lines.push(`- ${describeOutput(output)}`)
  }
  if (job.error !== undefined) {
    const at = job.error.nodeId !== undefined ? ` at node ${job.error.nodeId}${job.error.classType !== undefined ? ` (${job.error.classType})` : ''}` : ''
    lines.push(`error${at}: ${job.error.code}: ${job.error.message}`)
    if (job.error.traceback !== undefined) {
      lines.push(`traceback excerpt:\n${job.error.traceback.slice(0, TRACEBACK_EXCERPT_CHARS)}`)
    }
  }
  return lines.join('\n')
}

function describeOutput(output: ComfyJobOutput): string {
  return `${output.type} ${output.name} → ${output.url}`
}

/** Render a model-listing result; caps the names shown and flags the cut.
 * @param scope - the listing's scope line.
 * @param entries - the discovered names.
 * @param maxEntries - cap on names shown.
 * @returns the rendered text and whether the cap cut it.
 */
export function formatModelList(scope: string, entries: readonly string[], maxEntries: number): { text: string; truncated: boolean } {
  const shown = entries.slice(0, maxEntries)
  const truncated = entries.length > shown.length
  const suffix = truncated ? `\n…and ${entries.length - shown.length} more` : ''
  return { text: `${scope} (${entries.length}):\n${shown.join('\n')}${suffix}`, truncated }
}

/** Render a node schema as bounded JSON text; flags the cut.
 * @param classType - the node class name.
 * @param info - the class's input schema.
 * @param maxChars - cap on rendered characters.
 * @returns the rendered text and whether the cap cut it.
 */
export function formatNodeInfo(classType: string, info: Record<string, unknown>, maxChars: number): { text: string; truncated: boolean } {
  const full = `Node ${classType}:\n${JSON.stringify(info, null, 2)}`
  if (full.length <= maxChars) return { text: full, truncated: false }
  return { text: `${full.slice(0, maxChars)}\n\n(schema truncated at ${maxChars} characters)`, truncated: true }
}

/** Narrow opaque live or replayed result metadata to a job card payload. */
function jobMetaFromResult(meta: unknown): { jobId: string; status: string } | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { jobId, status } = meta as Record<string, unknown>
  if (typeof jobId !== 'string' || typeof status !== 'string') return undefined
  return { jobId, status }
}

/**
 * Completed-call presentation for `comfy_get_job`: a generic card titled by job id
 * and status, derived from the persisted result meta. Malformed meta falls back to
 * the generic card.
 *
 * @param _args - the raw tool arguments; unused beyond the signature.
 * @param result - the final model-facing tool result; `meta` carries the job summary.
 * @returns the completed generic card, or `undefined` on error or malformed meta.
 */
export function presentJobResult(_args: { jobId: string }, result: ToolResult): GenericCallView | undefined {
  if (result.isError) return undefined
  const meta = jobMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return { card: 'generic', title: `comfy: job ${meta.jobId}: ${meta.status}` }
}

/** Output-schema projection of one job; the same shape is the canonical tool value. */
function jobValue(job: ComfyJob) {
  return {
    jobId: job.id,
    status: job.status,
    ...job.queuePosition !== undefined ? { queuePosition: job.queuePosition } : {},
    ...job.progress !== undefined ? {
      progress: {
        value: job.progress.value,
        nodesDone: job.progress.nodesDone,
        nodesTotal: job.progress.nodesTotal,
        ...job.progress.currentNode !== undefined ? { currentNode: job.progress.currentNode } : {},
        ...job.progress.currentNodeClass !== undefined ? { currentNodeClass: job.progress.currentNodeClass } : {},
        ...job.progress.step !== undefined ? { step: job.progress.step } : {},
        ...job.progress.steps !== undefined ? { steps: job.progress.steps } : {},
        ...job.progress.message !== undefined ? { message: job.progress.message } : {},
      },
    } : {},
    outputs: job.outputs.map(output => ({
      nodeId: output.nodeId,
      name: output.name,
      type: output.type,
      contentType: output.contentType,
      sizeBytes: output.sizeBytes,
      assetId: output.assetId,
      url: output.url,
    })),
    ...job.error !== undefined ? {
      error: {
        code: job.error.code,
        message: job.error.message,
        ...job.error.nodeId !== undefined ? { nodeId: job.error.nodeId } : {},
        ...job.error.classType !== undefined ? { classType: job.error.classType } : {},
        ...job.error.traceback !== undefined ? { traceback: job.error.traceback } : {},
      },
    } : {},
  }
}

/**
 * Register the ComfyUI tool suite. Every registration is effect-scoped.
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the registrations.
 * @param limits - resolved per-tool timeout budgets and result caps.
 */

export function registerComfyTools(ctx: Context, limits: {
  submitTimeoutMs: number
  getTimeoutMs: number
  cancelTimeoutMs: number
  listTimeoutMs: number
  nodeTimeoutMs: number
  uploadTimeoutMs: number
  listMaxEntries: number
  nodeMaxOutputChars: number
  uploadMaxBytes: number
}): void {
  ctx.systemPrompt.section({
    name: 'capability:comfy',
    order: 130,
    text: 'Use the ComfyUI tools to run image, video, and audio generation workflows on the configured ComfyUI server. Build workflows in API format: a map of node id to {"class_type": string, "inputs": object}. Discover model files with comfy_list_models and node input schemas with comfy_get_node. Submit with comfy_submit_workflow, then call comfy_get_job with wait=true to block until the job finishes and get output URLs. Cancel unwanted jobs with comfy_cancel_job. To feed a local file (for example an input image) into a workflow, upload it with comfy_upload_asset and reference the returned asset id in the graph as {"__type": "core/ASSET", "info": {"id": "<asset id>"}}.',
  })

  ctx.tools.register(defineTool({
    name: 'comfy_submit_workflow',
    description: 'Submit an API-format ComfyUI workflow graph for execution and return the queued job id.',
    parameters: {
      workflow: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: 'API-format workflow graph: a map of node id to {"class_type": string, "inputs": object}. UI-format exports (with "nodes"/"links") are rejected.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Submitted ComfyUI workflow job ${value.jobId} (${value.status}). Call comfy_get_job with this job id and wait=true to wait for completion and collect outputs.`,
      }],
    },
    timeoutMs: limits.submitTimeoutMs,
    // Submits remote work; not safe to retry blindly against agent state.
    isConcurrencySafe: exclusiveRemoteMutation,
    async execute(args, exec) {
      const graph = args.workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>
      const job = await ctx.comfy.submitWorkflow(graph, exec.signal)
      return { jobId: job.id, status: job.status }
    },
    presentCall: presentSubmitCall,
  }))

  ctx.tools.register(defineTool({
    name: 'comfy_get_job',
    description: 'Fetch a ComfyUI job\'s status, progress, outputs, and error; optionally block until the job reaches a terminal state.',
    parameters: {
      jobId: { type: 'string', required: true, description: 'The job id returned by comfy_submit_workflow.' },
      wait: { type: 'boolean', description: 'Block until the job is terminal (succeeded/canceled/failed/expired). Defaults to an immediate status snapshot.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          queuePosition: { type: 'integer' },
          progress: {
            type: 'object',
            additionalProperties: false,
            properties: {
              value: { type: 'number', required: true },
              nodesDone: { type: 'integer', required: true },
              nodesTotal: { type: 'integer', required: true },
              currentNode: { type: 'string' },
              currentNodeClass: { type: 'string' },
              step: { type: 'integer' },
              steps: { type: 'integer' },
              message: { type: 'string' },
            },
          },
          outputs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                nodeId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                contentType: { type: 'string', required: true },
                sizeBytes: { type: 'integer', required: true },
                assetId: { type: 'string', required: true },
                url: { type: 'string', required: true },
              },
            },
          },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              message: { type: 'string', required: true },
              nodeId: { type: 'string' },
              classType: { type: 'string' },
              traceback: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatJobOutput(value as unknown as ComfyJob) }],
      presentationMeta: (_args, value) => ({ jobId: (value as { jobId: string }).jobId, status: (value as { status: string }).status }),
    },
    timeoutMs: limits.getTimeoutMs,
    // Reads remote state only.
    isConcurrencySafe: concurrentRemoteRead,
    async execute(args, exec) {
      requireNonEmpty(args.jobId, 'jobId')
      const job = args.wait === true
        ? await ctx.comfy.waitForJob(args.jobId, { timeoutMs: limits.getTimeoutMs }, exec.signal)
        : await ctx.comfy.getJob(args.jobId, exec.signal)
      return jobValue(job)
    },
    presentCall: presentGetJobCall,
    presentResult: presentJobResult,
  }))

  ctx.tools.register(defineTool({
    name: 'comfy_cancel_job',
    description: 'Request cancellation of a ComfyUI job. Idempotent; returns the job\'s current state.',
    parameters: {
      jobId: { type: 'string', required: true, description: 'The job id to cancel.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Cancel requested for ComfyUI job ${value.jobId}; status is now ${value.status}.` }],
    },
    timeoutMs: limits.cancelTimeoutMs,
    // Changes remote job state.
    isConcurrencySafe: exclusiveRemoteMutation,
    async execute(args, exec) {
      requireNonEmpty(args.jobId, 'jobId')
      const job = await ctx.comfy.cancelJob(args.jobId, exec.signal)
      return { jobId: job.id, status: job.status }
    },
    presentCall: presentCancelCall,
  }))

  ctx.tools.register(defineTool({
    name: 'comfy_list_models',
    description: 'List ComfyUI model folders (when folder is omitted) or the model files inside one folder.',
    parameters: {
      folder: { type: 'string', description: 'A folder name from the folder listing, for example checkpoints, diffusion_models, loras, vae, or text_encoders.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          entries: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${formatModelList(value.scope, value.entries, value.entries.length).text}${value.truncated ? '\n(list truncated by the deployment cap)' : ''}`,
      }],
    },
    timeoutMs: limits.listTimeoutMs,
    // Reads remote state only.
    isConcurrencySafe: concurrentRemoteRead,
    async execute(args, exec) {
      const entries = args.folder === undefined
        ? await ctx.comfy.listModelFolders(exec.signal)
        : await ctx.comfy.listModelFiles(args.folder, exec.signal)
      const scope = args.folder === undefined ? 'model folders' : `model files in ${args.folder}`
      const list = formatModelList(scope, entries, limits.listMaxEntries)
      return { scope, entries: list.truncated ? [...entries.slice(0, limits.listMaxEntries)] : [...entries], truncated: list.truncated }
    },
    presentCall: presentListModelsCall,
  }))

  ctx.tools.register(defineTool({
    name: 'comfy_get_node',
    description: 'Fetch one ComfyUI node class\'s input schema: input names, types, defaults, and allowed values.',
    parameters: {
      classType: { type: 'string', required: true, description: 'The node class name, for example KSampler or CLIPTextEncode.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          classType: { type: 'string', required: true },
          schema: { type: 'object', required: true, additionalProperties: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatNodeInfo(value.classType, value.schema as Record<string, unknown>, limits.nodeMaxOutputChars).text,
      }],
    },
    timeoutMs: limits.nodeTimeoutMs,
    // Reads remote state only.
    isConcurrencySafe: concurrentRemoteRead,
    async execute(args, exec) {
      requireNonEmpty(args.classType, 'classType')
      const info = await ctx.comfy.getNodeInfo(args.classType, exec.signal)
      const rendered = formatNodeInfo(args.classType, info, limits.nodeMaxOutputChars)
      return { classType: args.classType, schema: info as Record<string, JsonValue>, truncated: rendered.truncated }
    },
    presentCall: presentGetNodeCall,
  }))

  ctx.tools.register(defineTool({
    name: 'comfy_upload_asset',
    description: 'Upload a local file to the ComfyUI server as a workflow input asset and return its asset id.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the file to upload (for example an input image).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          assetId: { type: 'string', required: true },
          hash: { type: 'string' },
          filePath: { type: 'string', required: true },
          contentType: { type: 'string', required: true },
          sizeBytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Uploaded ${value.filePath} (${value.sizeBytes} bytes) as asset ${value.assetId}. Reference it in a workflow input as {"__type": "core/ASSET", "info": {"id": "${value.assetId}"}}.`,
      }],
    },
    timeoutMs: limits.uploadTimeoutMs,
    // Reads local state and changes remote state.
    isConcurrencySafe: exclusiveRemoteMutation,
    async execute(args, exec) {
      requireNonEmpty(args.path, 'path')
      const info = await stat(args.path)
      if (!info.isFile()) throw new Error(`path is not a regular file: ${args.path}`)
      if (info.size > limits.uploadMaxBytes) {
        throw new Error(`file is ${info.size} bytes; the configured upload cap is ${limits.uploadMaxBytes}`)
      }
      const filePath = basename(args.path)
      const contentType = CONTENT_TYPES[filePath.slice(filePath.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream'
      const bytes = await readFile(args.path, { signal: exec.signal })
      const asset = await ctx.comfy.uploadAsset({ bytes, filePath, contentType }, exec.signal)
      return {
        assetId: asset.id,
        ...asset.hash !== undefined ? { hash: asset.hash } : {},
        filePath,
        contentType,
        sizeBytes: info.size,
      }
    },
    presentCall: presentUploadCall,
  }))
}
