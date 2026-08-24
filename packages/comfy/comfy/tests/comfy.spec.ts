import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComfyRuntime, { ComfyError } from '@deepseek-ai/dsh-comfy'


/** The first recorded fetch call; throws when the recorder is empty. */
function firstCall(calls: { url: string; init: RequestInit | undefined }[]): { url: string; init: RequestInit | undefined } {
  const first = calls[0]
  if (first === undefined) throw new Error('expected at least one recorded fetch call')
  return first
}

/** Narrow an abort signal's `any` reason to an Error for stub rejections. */
function abortErrorOf(signal: AbortSignal | null | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error ? reason : new Error('aborted')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** JSON `Response` stub. */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** A wire-shaped job object. */
function wireJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job_1',
    status: 'queued',
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

/** Mount a ComfyRuntime on a fresh root context with the given config. */
async function mountComfy(config: ConstructorParameters<typeof ComfyRuntime>[1] = {}): Promise<{ ctx: Context; comfy: ComfyRuntime }> {
  const ctx = new Context()
  await ctx.plugin(ComfyRuntime, config)
  return { ctx, comfy: ctx.comfy }
}

/** Install a fetch mock and return its call recorder. */
function stubFetch(handler: (input: string | URL, init?: RequestInit) => Promise<Response>): {
  calls: { url: string; init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return handler(input, init)
  })
  return { calls }
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

describe('ComfyRuntime config validation', () => {
  it('rejects a non-http baseUrl', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ComfyRuntime, { baseUrl: 'ftp://x' })).rejects.toThrow('dsh-comfy: baseUrl must be an http(s) URL')
  })

  it('rejects a non-http serverUrl', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ComfyRuntime, { serverUrl: 'not a url' })).rejects.toThrow('dsh-comfy: serverUrl must be an http(s) URL')
  })

  it('rejects a non-positive requestTimeoutMs', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ComfyRuntime, { requestTimeoutMs: 0 })).rejects.toThrow('dsh-comfy: requestTimeoutMs')
  })

  it('rejects a non-positive pollIntervalMs', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(ComfyRuntime, { pollIntervalMs: -1 })).rejects.toThrow('dsh-comfy: pollIntervalMs')
  })

  it('trims a trailing slash from configured URLs', async () => {
    const { calls } = stubFetch(queueResponse(jsonResponse(wireJob())))
    const { comfy } = await mountComfy({ baseUrl: 'http://proxy:8189/', serverUrl: 'http://server:8188/' })
    await comfy.getJob('job_1')
    expect(firstCall(calls).url).toBe('http://proxy:8189/api/v2/jobs/job_1')
  })
})

describe('ComfyRuntime jobs', () => {
  it('submits a workflow with an idempotency key and parses the queued job', async () => {
    const { calls } = stubFetch(queueResponse(jsonResponse(wireJob({ status: 'queued' }))))
    const { comfy } = await mountComfy()
    const job = await comfy.submitWorkflow({ '1': { class_type: 'EmptyImage', inputs: { width: 64 } } })
    expect(job).toMatchObject({ id: 'job_1', status: 'queued' })
    const call = firstCall(calls)
    expect(call.url).toBe('http://127.0.0.1:8189/api/v2/jobs')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Headers
    expect(headers.get('idempotency-key')).toMatch(/[0-9a-f-]{36}/)
    expect(JSON.parse(call.init?.body as string)).toEqual({
      workflow: { '1': { class_type: 'EmptyImage', inputs: { width: 64 } } },
    })
  })

  it('sends the bearer token from config', async () => {
    const { calls } = stubFetch(queueResponse(jsonResponse(wireJob())))
    const { comfy } = await mountComfy({ token: 'secret-token' })
    await comfy.getJob('job_1')
    expect((firstCall(calls).init?.headers as Headers).get('authorization')).toBe('Bearer secret-token')
  })

  it('reads the token from COMFY_API_TOKEN when config omits it', async () => {
    vi.stubEnv('COMFY_API_TOKEN', 'env-token')
    try {
      const { calls } = stubFetch(queueResponse(jsonResponse(wireJob())))
      const { comfy } = await mountComfy()
      await comfy.getJob('job_1')
      expect((firstCall(calls).init?.headers as Headers).get('authorization')).toBe('Bearer env-token')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('parses the full job object with progress, outputs, and error', async () => {
    stubFetch(queueResponse(jsonResponse(wireJob({
      status: 'failed',
      started_at: '2026-08-24T12:00:01Z',
      completed_at: '2026-08-24T12:00:02Z',
      queue_position: 3,
      progress: {
        value: 0.5, nodes_done: 2, nodes_total: 4, current_node: '7', current_node_class: 'KSampler',
        step: 2, steps: 4, message: 'sampling',
      },
      outputs: [{
        node_id: '9', name: 'out.png', type: 'image', content_type: 'image/png', size_bytes: 10,
        id: 'asset-1', hash: null, url: 'http://x/asset', url_expires_at: '2026-08-25T12:00:00Z',
      }],
      error: { code: 'node_execution_error', message: 'boom', node_id: '7', class_type: 'KSampler', traceback: 'tb' },
    }))))
    const { comfy } = await mountComfy()
    const job = await comfy.getJob('job_1')
    expect(job.status).toBe('failed')
    expect(job.startedAt).toBe('2026-08-24T12:00:01Z')
    expect(job.completedAt).toBe('2026-08-24T12:00:02Z')
    expect(job.queuePosition).toBe(3)
    expect(job.progress).toMatchObject({ value: 0.5, nodesDone: 2, nodesTotal: 4, currentNodeClass: 'KSampler', step: 2, steps: 4, message: 'sampling' })
    expect(job.outputs[0]).toMatchObject({ nodeId: '9', name: 'out.png', type: 'image', assetId: 'asset-1', url: 'http://x/asset' })
    expect(job.error).toMatchObject({ code: 'node_execution_error', nodeId: '7', classType: 'KSampler', traceback: 'tb' })
  })

  it('drops fields whose wire type is unexpected', async () => {
    stubFetch(queueResponse(jsonResponse(wireJob({ started_at: 5, queue_position: 'x' }))))
    const { comfy } = await mountComfy()
    const job = await comfy.getJob('job_1')
    expect(job.startedAt).toBeUndefined()
    expect(job.queuePosition).toBeUndefined()
  })

  it('rejects a job object with an unknown status', async () => {
    stubFetch(queueResponse(jsonResponse(wireJob({ status: 'exploded' }))))
    const { comfy } = await mountComfy()
    await expect(comfy.getJob('job_1')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })

  it('rejects a job object without outputs', async () => {
    const wire = wireJob()
    delete wire.outputs
    stubFetch(queueResponse(jsonResponse(wire)))
    const { comfy } = await mountComfy()
    await expect(comfy.getJob('job_1')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })

  it('rejects a job output with an unknown type', async () => {
    stubFetch(queueResponse(jsonResponse(wireJob({
      outputs: [{ node_id: '9', name: 'x', type: 'hologram', content_type: 'x', size_bytes: 1, id: 'a', url: 'u', url_expires_at: 't' }],
    }))))
    const { comfy } = await mountComfy()
    await expect(comfy.getJob('job_1')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })

  it('rejects a non-object job body', async () => {
    stubFetch(queueResponse(jsonResponse([1, 2])))
    const { comfy } = await mountComfy()
    await expect(comfy.getJob('job_1')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })

  it('rejects a job body with a non-string id', async () => {
    stubFetch(queueResponse(jsonResponse(wireJob({ id: 7 }))))
    const { comfy } = await mountComfy()
    await expect(comfy.getJob('job_1')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })

  it('cancels a job via POST and returns its state', async () => {
    const { calls } = stubFetch(queueResponse(jsonResponse(wireJob({ status: 'canceling' }))))
    const { comfy } = await mountComfy()
    const job = await comfy.cancelJob('job_1')
    expect(job.status).toBe('canceling')
    expect(firstCall(calls).url).toBe('http://127.0.0.1:8189/api/v2/jobs/job_1/cancel')
    expect(firstCall(calls).init?.method).toBe('POST')
  })
})

describe('ComfyRuntime waitForJob', () => {
  it('polls until a terminal status and returns the terminal job', async () => {
    stubFetch(queueResponse(
      jsonResponse(wireJob({ status: 'queued' })),
      jsonResponse(wireJob({ status: 'running' })),
      jsonResponse(wireJob({ status: 'succeeded' })),
    ))
    const { comfy } = await mountComfy({ pollIntervalMs: 1 })
    const job = await comfy.waitForJob('job_1', { timeoutMs: 5_000 })
    expect(job.status).toBe('succeeded')
  })

  it('throws COMFY_TIMEOUT when the job stays non-terminal past the budget', async () => {
    stubFetch(queueResponse(jsonResponse(wireJob({ status: 'running' }))))
    const { comfy } = await mountComfy({ pollIntervalMs: 5 })
    const error = await comfy.waitForJob('job_1', { timeoutMs: 60 }).catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_TIMEOUT')
    expect(error.message).toContain('timed out')
  })

  it('throws COMFY_ABORTED when the caller aborts mid-wait', async () => {
    stubFetch(queueResponse(jsonResponse(wireJob({ status: 'running' }))))
    const { comfy } = await mountComfy({ pollIntervalMs: 10_000 })
    const controller = new AbortController()
    const waiting = comfy.waitForJob('job_1', { timeoutMs: 60_000 }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await expect(waiting).rejects.toThrow(expect.objectContaining({ code: 'COMFY_ABORTED' }))
  })

  it('throws COMFY_ABORTED when the caller aborts before the wait starts', async () => {
    stubFetch(queueResponse(jsonResponse(wireJob({ status: 'running' }))))
    const { comfy } = await mountComfy({ pollIntervalMs: 1 })
    const controller = new AbortController()
    controller.abort()
    await expect(comfy.waitForJob('job_1', { timeoutMs: 5_000 }, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'COMFY_ABORTED' }),
    )
  })

  it('surfaces a failed request error unchanged', async () => {
    stubFetch(() => Promise.reject(new TypeError('connection refused')))
    const { comfy } = await mountComfy({ pollIntervalMs: 1 })
    await expect(comfy.waitForJob('job_1', { timeoutMs: 5_000 })).rejects.toThrow(
      expect.objectContaining({ code: 'COMFY_REQUEST_FAILED' }),
    )
  })
})

describe('ComfyRuntime discovery', () => {
  it('lists model folders from the server', async () => {
    const { calls } = stubFetch(queueResponse(jsonResponse(['checkpoints', 'loras'])))
    const { comfy } = await mountComfy()
    await expect(comfy.listModelFolders()).resolves.toEqual(['checkpoints', 'loras'])
    expect(firstCall(calls).url).toBe('http://127.0.0.1:8188/models')
  })

  it('lists model files in one folder', async () => {
    const { calls } = stubFetch(queueResponse(jsonResponse(['a.safetensors'])))
    const { comfy } = await mountComfy()
    await expect(comfy.listModelFiles('diffusion models')).resolves.toEqual(['a.safetensors'])
    expect(firstCall(calls).url).toBe('http://127.0.0.1:8188/models/diffusion%20models')
  })

  it('rejects a malformed folder list', async () => {
    stubFetch(queueResponse(jsonResponse({ nope: true })))
    const { comfy } = await mountComfy()
    await expect(comfy.listModelFolders()).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })

  it('rejects a folder list with non-string entries', async () => {
    stubFetch(queueResponse(jsonResponse(['a', 3])))
    const { comfy } = await mountComfy()
    await expect(comfy.listModelFolders()).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })

  it('returns one node class schema keyed by the class name', async () => {
    stubFetch(queueResponse(jsonResponse({ KSampler: { input: { required: {} } } })))
    const { comfy } = await mountComfy()
    await expect(comfy.getNodeInfo('KSampler')).resolves.toEqual({ input: { required: {} } })
  })

  it('rejects a schema response that does not carry the class', async () => {
    stubFetch(queueResponse(jsonResponse({ Other: {} })))
    const { comfy } = await mountComfy()
    await expect(comfy.getNodeInfo('KSampler')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })

  it('rejects a non-object schema response', async () => {
    stubFetch(queueResponse(jsonResponse('nope')))
    const { comfy } = await mountComfy()
    await expect(comfy.getNodeInfo('KSampler')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })
})

describe('ComfyRuntime uploadAsset', () => {
  it('uploads multipart form fields and parses the asset', async () => {
    let captured: FormData | undefined
    stubFetch((_input, init) => {
      captured = init?.body as FormData
      return Promise.resolve(jsonResponse({
        id: 'asset-9', hash: 'blake3:abc', size_bytes: 3, content_type: 'image/png',
        file_path: 'p.png', created_at: '2026-08-24T12:00:00Z', url: 'http://x/a', url_expires_at: '2026-08-25T12:00:00Z',
      }))
    })
    const { comfy } = await mountComfy()
    const asset = await comfy.uploadAsset({ bytes: new Uint8Array([1, 2, 3]), filePath: 'p.png', contentType: 'image/png' })
    expect(asset).toMatchObject({ id: 'asset-9', hash: 'blake3:abc', sizeBytes: 3, contentType: 'image/png', filePath: 'p.png' })
    expect(captured).toBeInstanceOf(FormData)
    expect(captured!.get('content_type')).toBe('image/png')
    expect(captured!.get('file_path')).toBe('p.png')
    expect(captured!.get('file')).toBeInstanceOf(Blob)
  })

  it('tolerates a null hash and missing file path', async () => {
    stubFetch(queueResponse(jsonResponse({
      id: 'asset-9', hash: null, size_bytes: 0, content_type: 'application/octet-stream',
      created_at: '2026-08-24T12:00:00Z', url: 'http://x/a', url_expires_at: '2026-08-25T12:00:00Z',
    })))
    const { comfy } = await mountComfy()
    const asset = await comfy.uploadAsset({ bytes: new Uint8Array(), filePath: 'x', contentType: 'application/octet-stream' })
    expect(asset.hash).toBeUndefined()
    expect(asset.filePath).toBeUndefined()
  })

  it('rejects a malformed asset body', async () => {
    stubFetch(queueResponse(jsonResponse({ id: 'x' })))
    const { comfy } = await mountComfy()
    await expect(comfy.uploadAsset({ bytes: new Uint8Array(), filePath: 'x', contentType: 'text/plain' }))
      .rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })
})

describe('ComfyRuntime request failure translation', () => {
  it('maps an error envelope on a 422 to COMFY_API_ERROR', async () => {
    stubFetch(queueResponse(jsonResponse({ error: { code: 'invalid_workflow', message: 'Node 12: missing input' } }, 422)))
    const { comfy } = await mountComfy()
    const error = await comfy.getJob('job_1').catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_API_ERROR')
    expect(error.message).toContain('invalid_workflow: Node 12: missing input')
  })

  it('maps a plain 404 to COMFY_NOT_FOUND', async () => {
    stubFetch(queueResponse(new Response('no such job', { status: 404 })))
    const { comfy } = await mountComfy()
    const error = await comfy.getJob('job_1').catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_NOT_FOUND')
    expect(error.message).toContain('no such job')
  })

  it('maps an envelope-only 404 to COMFY_NOT_FOUND with the envelope detail', async () => {
    stubFetch(queueResponse(jsonResponse({ error: { code: 'not_found', message: 'gone' } }, 404)))
    const { comfy } = await mountComfy()
    const error = await comfy.getJob('job_1').catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_NOT_FOUND')
    expect(error.message).toContain('not_found: gone')
  })

  it('maps a 404 with an empty body to COMFY_NOT_FOUND without detail', async () => {
    stubFetch(queueResponse(new Response('', { status: 404 })))
    const { comfy } = await mountComfy()
    const error = await comfy.getJob('job_1').catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_NOT_FOUND')
    expect(error.message).not.toContain('(')
  })

  it('maps a 500 with an empty body to COMFY_API_ERROR without detail', async () => {
    stubFetch(queueResponse(new Response('', { status: 500 })))
    const { comfy } = await mountComfy()
    const error = await comfy.getJob('job_1').catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_API_ERROR')
    expect(error.message).not.toContain(': undefined')
  })

  it('keeps raw text for an error envelope whose code and message are not strings', async () => {
    stubFetch(queueResponse(jsonResponse({ error: { code: 7, message: false } }, 400)))
    const { comfy } = await mountComfy()
    const error = await comfy.getJob('job_1').catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_API_ERROR')
    expect(error.message).toContain('{"error":{"code":7,"message":false}}')
  })

  it('keeps raw text when the error body is JSON null', async () => {
    stubFetch(queueResponse(new Response('null', { status: 400 })))
    const { comfy } = await mountComfy()
    const error = await comfy.getJob('job_1').catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_API_ERROR')
    expect(error.message).toContain('null')
  })

  it('keeps raw text when the error body is a JSON array', async () => {
    stubFetch(queueResponse(jsonResponse([1, 2], 400)))
    const { comfy } = await mountComfy()
    const error = await comfy.getJob('job_1').catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_API_ERROR')
    expect(error.message).toContain('[1,2]')
  })

  it('keeps raw text when the error envelope itself is not an object', async () => {
    stubFetch(queueResponse(jsonResponse({ error: 'nope' }, 400)))
    const { comfy } = await mountComfy()
    const error = await comfy.getJob('job_1').catch((caught: unknown) => caught) as ComfyError
    expect(error.code).toBe('COMFY_API_ERROR')
    expect(error.message).toContain('nope')
  })

  it('maps a transport failure to COMFY_REQUEST_FAILED', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')))
    const { comfy } = await mountComfy()
    await expect(comfy.getJob('job_1')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_REQUEST_FAILED' }))
  })

  it('maps a request deadline to COMFY_TIMEOUT', async () => {
    stubFetch((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(abortErrorOf(init.signal))
      })
    }))
    const { comfy } = await mountComfy({ requestTimeoutMs: 20 })
    await expect(comfy.getJob('job_1')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_TIMEOUT' }))
  })

  it('maps caller cancellation to COMFY_ABORTED', async () => {
    stubFetch((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(abortErrorOf(init.signal))
      })
    }))
    const { comfy } = await mountComfy()
    const controller = new AbortController()
    const pending = comfy.getJob('job_1', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'COMFY_ABORTED' }))
  })

  it('rejects a 200 response with a non-JSON body', async () => {
    stubFetch(queueResponse(new Response('<html>', { status: 200 })))
    const { comfy } = await mountComfy()
    await expect(comfy.getJob('job_1')).rejects.toThrow(expect.objectContaining({ code: 'COMFY_INVALID_RESPONSE' }))
  })
})

describe('ComfyError', () => {
  it('carries its code', () => {
    const error = new ComfyError('boom', 'COMFY_TIMEOUT')
    expect(error.code).toBe('COMFY_TIMEOUT')
    expect(error.name).toBe('ComfyError')
  })
})
