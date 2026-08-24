/**
 * Real Loader-path guard for an injected namespace plugin. A default export would make
 * `unwrapExports` collapse the namespace and drop `inject`, causing access to `ctx.comfy`
 * to fail. Hand-built mounting bypasses that path, so this test unwraps through the real
 * Loader first; see postmortem 0001.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ComfyRuntime from '@deepseek-ai/dsh-comfy'
import * as toolComfy from '@deepseek-ai/dsh-tool-comfy'

describe('dsh-tool-comfy real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolComfy).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolComfy) as Record<string, unknown>
    expect(unwrapped).toBe(toolComfy)
    expect(unwrapped.name).toBe('tool-comfy')
    expect(unwrapped.inject).toEqual(['tools', 'comfy', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.comfy through the unwrapped module without an inject error', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ComfyRuntime, {})

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolComfy) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped)
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining(['comfy_submit_workflow', 'comfy_get_job']))
    await fiber.dispose()
  })
})
