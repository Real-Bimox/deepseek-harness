import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ComfyRuntime from '@deepseek-ai/dsh-comfy'
import * as ToolComfy from '@deepseek-ai/dsh-tool-comfy'
import {
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
} from '@deepseek-ai/dsh-tool-comfy'

const testToolSignal = new AbortController().signal

/** JSON `Response` stub. */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** A wire-shaped job object. */
function wireJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job_1',
    status: 'running',
    created_at: '2026-08-24T12:00:00Z',
    started_at: null,
    completed_at: null,
    expires_at: '2026-08-25T12:00:00Z',
    queue_position: null,
    progress: null,
    outputs: [],
    error: null,
    ...overrides,
  }
}

/** A fetch handler serving responses from a queue; the last response repeats. */
function queueResponse(...responses: Response[]): (input: string | URL, init?: RequestInit) => Promise<Response> {
  let index = 0
  const next = () => {
    const response = responses[Math.min(index++, responses.length - 1)]
    if (response === undefined) throw new Error('queueResponse requires at least one response')
    return response
  }
  return () => Promise.resolve(next().clone())
}

/**
 * Mount the real tool registry, system prompt, ComfyUI runtime, and tool-comfy, with a
 * scripted fetch; return an executor helper.
 */
async function mountTools(opts: {
  config?: ToolComfy.Config
  responses?: Response[]
} = {}): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>>; call: (name: string, args: unknown) => Promise<ToolExecutionResult> }> {
  const handler = opts.responses !== undefined ? queueResponse(...opts.responses) : () => Promise.resolve(jsonResponse(wireJob()))
  vi.stubGlobal('fetch', handler)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ComfyRuntime, { pollIntervalMs: 1 })
  const fiber = await ctx.plugin(ToolComfy, opts.config ?? {})
  let counter = 0
  const call = (name: string, args: unknown) =>
    ctx.tools.execute({ signal: testToolSignal, callId: CallId(`call-${++counter}`), name, arguments: args })
  return { ctx, fiber, call }
}



afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tool registration and disposal', () => {
  it('registers all six tools and unregisters them on fiber dispose (HMR safety)', async () => {
    const { ctx, fiber } = await mountTools()
    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const name of [
      'comfy_submit_workflow', 'comfy_get_job', 'comfy_cancel_job',
      'comfy_list_models', 'comfy_get_node', 'comfy_upload_asset',
    ]) {
      expect(names).toContain(name)
    }
    await fiber.dispose()
    const after = ctx.tools.schemas().map(schema => schema.name)
    expect(after).not.toContain('comfy_submit_workflow')
    expect(after).not.toContain('comfy_get_job')
  })

  it('rejects a non-positive configured budget at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ComfyRuntime, {})
    await expect(ctx.plugin(ToolComfy, { submitTimeoutMs: 0 })).rejects.toThrow('tool-comfy: submitTimeoutMs must be a positive integer')
  })

  it('rejects a non-positive result cap at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ComfyRuntime, {})
    await expect(ctx.plugin(ToolComfy, { listMaxEntries: -3 })).rejects.toThrow('tool-comfy: listMaxEntries must be a positive integer')
  })
})

describe('comfy_submit_workflow', () => {
  it('submits the graph and returns the job id with render guidance', async () => {
    const { call } = await mountTools({ responses: [jsonResponse(wireJob({ status: 'queued' }))] })
    const result = await call('comfy_submit_workflow', { workflow: { '1': { class_type: 'EmptyImage', inputs: {} } } })
    expect(result.isError).toBeFalsy()
    expect(result.value).toEqual({ jobId: 'job_1', status: 'queued' })
    const block = result.content[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('comfy_get_job')
  })
})

describe('comfy_get_job', () => {
  it('returns an immediate snapshot', async () => {
    const { call } = await mountTools({ responses: [jsonResponse(wireJob({
      status: 'running',
      queue_position: 2,
      progress: { value: 0.5, nodes_done: 1, nodes_total: 2, step: 1, steps: 4, current_node_class: 'KSampler' },
    }))] })
    const result = await call('comfy_get_job', { jobId: 'job_1' })
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ jobId: 'job_1', status: 'running', queuePosition: 2 })
    expect(result.value).toHaveProperty('progress.value', 0.5)
    const block = result.content[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('50%')
  })

  it('waits to a terminal state and reports outputs and the error block', async () => {
    const { call } = await mountTools({ responses: [
      jsonResponse(wireJob({ status: 'queued' })),
      jsonResponse(wireJob({
        status: 'failed',
        outputs: [{
          node_id: '9', name: 'out.png', type: 'image', content_type: 'image/png', size_bytes: 5,
          id: 'asset-1', hash: null, url: 'http://x/a', url_expires_at: '2026-08-25T12:00:00Z',
        }],
        error: { code: 'node_execution_error', message: 'boom', node_id: '7', class_type: 'KSampler', traceback: 'line1\nline2' },
      })),
    ] })
    const result = await call('comfy_get_job', { jobId: 'job_1', wait: true })
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ jobId: 'job_1', status: 'failed' })
    const value = result.value as { outputs: { name: string; url: string }[]; error: { code: string } }
    expect(value.outputs[0]).toMatchObject({ name: 'out.png', url: 'http://x/a' })
    expect(value.error.code).toBe('node_execution_error')
    const text = result.content[0]
    const block = text as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('http://x/a')
    const block1 = text as { type: 'text'; text: string }
    expect(block1.type).toBe('text')
    expect(block1.text).toContain('node_execution_error: boom')
    const block2 = text as { type: 'text'; text: string }
    expect(block2.type).toBe('text')
    expect(block2.text).toContain('at node 7 (KSampler)')
  })

  it('rejects a blank jobId', async () => {
    const { call } = await mountTools()
    const result = await call('comfy_get_job', { jobId: '  ' })
    expect(result.isError).toBeTruthy()
  })

  it('projects progress that carries only node id and message', async () => {
    const { call } = await mountTools({ responses: [jsonResponse(wireJob({
      status: 'running',
      progress: { value: 0.1, nodes_done: 1, nodes_total: 9, current_node: '4', message: 'encoding' },
    }))] })
    const result = await call('comfy_get_job', { jobId: 'job_1' })
    expect(result.value).toMatchObject({ progress: { value: 0.1, currentNode: '4', message: 'encoding' } })
    const progress = (result.value as { progress: Record<string, unknown> }).progress
    expect(progress).not.toHaveProperty('currentNodeClass')
    expect(progress).not.toHaveProperty('step')
    const block = result.content[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('encoding')
  })

  it('projects a failed job whose error carries only code and message', async () => {
    const { call } = await mountTools({ responses: [jsonResponse(wireJob({
      status: 'failed',
      error: { code: 'canceled_mid_run', message: 'stopped' },
    }))] })
    const result = await call('comfy_get_job', { jobId: 'job_1' })
    expect(result.value).toMatchObject({ status: 'failed' })
    const value = result.value as { error: { code: string; nodeId?: string } }
    expect(value.error).toEqual({ code: 'canceled_mid_run', message: 'stopped' })
    const block = result.content[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('stopped')
  })
})

describe('comfy_cancel_job', () => {
  it('requests cancellation and reports the resulting state', async () => {
    const { call } = await mountTools({ responses: [jsonResponse(wireJob({ status: 'canceling' }))] })
    const result = await call('comfy_cancel_job', { jobId: 'job_1' })
    expect(result.value).toEqual({ jobId: 'job_1', status: 'canceling' })
    const block = result.content[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('canceling')
  })

  it('rejects a blank jobId', async () => {
    const { call } = await mountTools()
    const result = await call('comfy_cancel_job', { jobId: '' })
    expect(result.isError).toBeTruthy()
  })
})

describe('comfy_list_models', () => {
  it('lists folders when folder is omitted', async () => {
    const { call } = await mountTools({ responses: [jsonResponse(['checkpoints', 'loras'])] })
    const result = await call('comfy_list_models', {})
    expect(result.value).toEqual({ scope: 'model folders', entries: ['checkpoints', 'loras'], truncated: false })
  })

  it('lists files in one folder and truncates at the configured cap', async () => {
    const { call } = await mountTools({ config: { listMaxEntries: 2 }, responses: [jsonResponse(['a', 'b', 'c'])] })
    const result = await call('comfy_list_models', { folder: 'loras' })
    expect(result.value).toEqual({ scope: 'model files in loras', entries: ['a', 'b'], truncated: true })
    const block = result.content[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('deployment cap')
  })
})

describe('comfy_get_node', () => {
  it('returns the node schema and flags a rendered truncation', async () => {
    const { call } = await mountTools({ config: { nodeMaxOutputChars: 40 }, responses: [jsonResponse({ KSampler: { input: { required: { seed: ['INT', { default: 0 }] } } } })] })
    const result = await call('comfy_get_node', { classType: 'KSampler' })
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ classType: 'KSampler', truncated: true })
    const block = result.content[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('truncated at 40')
  })

  it('rejects a blank classType', async () => {
    const { call } = await mountTools()
    const result = await call('comfy_get_node', { classType: '' })
    expect(result.isError).toBeTruthy()
  })
})

describe('comfy_upload_asset', () => {
  it('uploads a file and returns the asset reference guidance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-'))
    const path = join(dir, 'photo.png')
    await writeFile(path, new Uint8Array([1, 2, 3]))
    const { call } = await mountTools({ responses: [jsonResponse({
      id: 'asset-1', hash: 'blake3:z', size_bytes: 3, content_type: 'image/png',
      file_path: 'photo.png', created_at: '2026-08-24T12:00:00Z', url: 'http://x/a', url_expires_at: '2026-08-25T12:00:00Z',
    })] })
    const result = await call('comfy_upload_asset', { path })
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ assetId: 'asset-1', hash: 'blake3:z', filePath: 'photo.png', contentType: 'image/png', sizeBytes: 3 })
    const block = result.content[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('core/ASSET')
  })

  it('falls back to octet-stream for an unknown extension and omits a lazy hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-'))
    const path = join(dir, 'mystery.bin')
    await writeFile(path, new Uint8Array([9]))
    const { call } = await mountTools({ responses: [jsonResponse({
      id: 'asset-2', hash: null, size_bytes: 1, content_type: 'application/octet-stream',
      created_at: '2026-08-24T12:00:00Z', url: 'http://x/b', url_expires_at: '2026-08-25T12:00:00Z',
    })] })
    const result = await call('comfy_upload_asset', { path })
    expect(result.value).toMatchObject({ assetId: 'asset-2', contentType: 'application/octet-stream' })
    expect(result.value).not.toHaveProperty('hash')
  })

  it('rejects a file over the configured cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-'))
    const path = join(dir, 'big.png')
    await writeFile(path, new Uint8Array(8))
    const { call } = await mountTools({ config: { uploadMaxBytes: 4 } })
    const result = await call('comfy_upload_asset', { path })
    expect(result.isError).toBeTruthy()
    const block = result.content[0] as { type: 'text'; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('upload cap')
  })

  it('rejects a directory path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-'))
    const { call } = await mountTools()
    const result = await call('comfy_upload_asset', { path: dir })
    expect(result.isError).toBeTruthy()
  })

  it('rejects a missing path argument as an error', async () => {
    const { call } = await mountTools()
    const result = await call('comfy_upload_asset', { path: ' ' })
    expect(result.isError).toBeTruthy()
  })
})

describe('comfy_get_job presentation', () => {
  it('derives the completed card from persisted result meta', () => {
    const view = presentJobResult({ jobId: 'job_1' }, {
      isError: false,
      content: [],
      meta: { jobId: 'job_1', status: 'succeeded' },
    })
    expect(view).toEqual({ card: 'generic', title: 'comfy: job job_1: succeeded' })
  })

  it('falls back to the generic card on error results', () => {
    expect(presentJobResult({ jobId: 'job_1' }, { isError: true, content: [] })).toBeUndefined()
  })

  it('falls back to the generic card on malformed meta', () => {
    expect(presentJobResult({ jobId: 'job_1' }, { isError: false, content: [], meta: { jobId: 3 } })).toBeUndefined()
    expect(presentJobResult({ jobId: 'job_1' }, { isError: false, content: [], meta: 'nope' })).toBeUndefined()
    expect(presentJobResult({ jobId: 'job_1' }, { isError: false, content: [] })).toBeUndefined()
  })
})

describe('presentation and concurrency classifiers', () => {
  it('classifies mutating tools as exclusive and read-only tools as concurrent', () => {
    expect(exclusiveRemoteMutation()).toBe(false)
    expect(concurrentRemoteRead()).toBe(true)
  })

  it('derives each pending card from its arguments', () => {
    expect(presentSubmitCall()).toEqual({ card: 'generic', title: 'comfy: submit workflow', kind: 'execute' })
    expect(presentGetJobCall({ jobId: 'j1' })).toEqual({ card: 'generic', title: 'comfy: job j1', kind: 'read', rawInput: 'j1' })
    expect(presentCancelCall({ jobId: 'j1' })).toEqual({ card: 'generic', title: 'comfy: cancel job j1', kind: 'execute', rawInput: 'j1' })
    expect(presentListModelsCall({})).toEqual({ card: 'generic', title: 'comfy: list model folders', kind: 'search' })
    expect(presentListModelsCall({ folder: 'loras' })).toEqual({ card: 'generic', title: 'comfy: list models in loras', kind: 'search' })
    expect(presentGetNodeCall({ classType: 'KSampler' })).toEqual({ card: 'generic', title: 'comfy: node schema KSampler', kind: 'search' })
    expect(presentUploadCall({ path: '/tmp/x.png' })).toEqual({ card: 'generic', title: 'comfy: upload /tmp/x.png', kind: 'execute', rawInput: '/tmp/x.png' })
  })
})

describe('render helpers', () => {
  it('formats a job with progress message and without optional fields', () => {
    const text = formatJobOutput({
      id: 'j', status: 'running', createdAt: 't', expiresAt: 't',
      progress: { value: 0.25, nodesDone: 1, nodesTotal: 4, message: 'sampling' },
      outputs: [],
    })
    expect(text).toContain('ComfyUI job j: running')
    expect(text).toContain('25%')
    expect(text).toContain('sampling')
  })

  it('formats an error without node context', () => {
    const text = formatJobOutput({
      id: 'j', status: 'failed', createdAt: 't', expiresAt: 't',
      outputs: [],
      error: { code: 'c', message: 'm', traceback: 'x'.repeat(2_000) },
    })
    expect(text).toContain('error: c: m')
    expect(text).toContain('traceback excerpt')
    expect(text).not.toContain('at node')
  })

  it('formats progress with a step but no steps, node, or message', () => {
    const text = formatJobOutput({
      id: 'j', status: 'running', createdAt: 't', expiresAt: 't', queuePosition: 4,
      progress: { value: 0.5, nodesDone: 1, nodesTotal: 2, step: 3 },
      outputs: [],
    })
    expect(text).toContain('queue position: 4')
    expect(text).toContain('progress: 50%')
    expect(text).not.toContain('step')
    expect(text).not.toContain('(')
  })

  it('formats a succeeded job with outputs and no error', () => {
    const text = formatJobOutput({
      id: 'j', status: 'succeeded', createdAt: 't', expiresAt: 't',
      outputs: [{ nodeId: '9', name: 'o.png', type: 'image', contentType: 'image/png', sizeBytes: 1, assetId: 'a', url: 'http://x', urlExpiresAt: 't' }],
    })
    expect(text).toContain('- image o.png → http://x')
    expect(text).not.toContain('error')
  })

  it('formats an error with a node id but no class type', () => {
    const text = formatJobOutput({
      id: 'j', status: 'failed', createdAt: 't', expiresAt: 't',
      outputs: [],
      error: { code: 'node_execution_error', message: 'm', nodeId: '7' },
    })
    expect(text).toContain('error at node 7: node_execution_error: m')
    expect(text).not.toContain('(')
  })

  it('formats a model list and flags truncation', () => {
    const full = formatModelList('scope', ['a', 'b'], 2)
    expect(full.truncated).toBeFalsy()
    const cut = formatModelList('scope', ['a', 'b', 'c'], 2)
    expect(cut.truncated).toBeTruthy()
    expect(cut.text).toContain('1 more')
  })

  it('formats a node schema uncut and cut', () => {
    expect(formatNodeInfo('N', { a: 1 }, 1_000).truncated).toBeFalsy()
    const cut = formatNodeInfo('N', { a: 'x'.repeat(100) }, 20)
    expect(cut.truncated).toBeTruthy()
    expect(cut.text).toContain('truncated at 20')
  })
})
