import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../../../../examples/headless-agent/tests/fixtures/comfy/comfy/cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface StubServer {
  readonly url: string
  close(): Promise<void>
}

/** Minimal Comfy API v2 stub: one queued job that succeeds with a single image output. */
let serverPort = 0

async function stubV2Server(): Promise<StubServer> {
  let submits = 0
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method === 'POST' && request.url === '/api/v2/jobs') {
      submits += 1
      send(201, wireJob('queued'))
      return
    }
    if (request.method === 'GET' && request.url === '/api/v2/jobs/job_stub') {
      send(200, wireJob('succeeded', [{
        node_id: '2', name: 'dsh_smoke_00001_.png', type: 'image', content_type: 'image/png',
        size_bytes: 0, id: 'asset_stub', hash: null,
        url: `http://127.0.0.1:${serverPort}/api/v2/assets/asset_stub/content`,
        url_expires_at: '2026-08-25T12:00:00Z',
      }]))
      return
    }
    send(404, { error: { code: 'not_found', message: request.url ?? '' } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub server has no port')
  serverPort = address.port
  return {
    url: `http://127.0.0.1:${serverPort}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error: Error | undefined) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

function wireJob(status: string, outputs: unknown[] = []): Record<string, unknown> {
  return {
    id: 'job_stub', status, created_at: '2026-08-24T12:00:00Z', started_at: null, completed_at: null,
    expires_at: '2026-08-25T12:00:00Z', queue_position: null, progress: null, outputs, error: null,
  }
}

describe('comfy composition (keyless)', () => {
  it('boots the real Loader tree and drives one submit → wait → output round trip', async () => {
    const stub = await stubV2Server()
    process.env.COMFY_STUB_URL = stub.url
    try {
      const { stdout, stderr } = await runLoaderSmoke({
        label: 'comfy-composition',
        tempDirPrefix: 'comfy-composition-',
        binScript,
        libBinScript: binScript,
        configPath,
        binArgs: [configPath, 'generate one image'],
        tsconfigPath,
      })
      expect(stderr).toBe('')
      const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      const transcript = JSON.stringify(lines)
      expect(transcript).toContain('"name":"comfy_submit_workflow"')
      expect(transcript).toContain('"name":"comfy_get_job"')
      expect(transcript).toContain('COMFY_ROUND_TRIP')
      expect(transcript).toContain('/api/v2/assets/asset_stub/content')
    } finally {
      delete process.env.COMFY_STUB_URL
      await stub.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
