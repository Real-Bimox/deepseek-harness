import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

const SUBMIT_ARGS = JSON.stringify({
  workflow: {
    '1': { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
    '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'dsh_smoke' } },
  },
})

/**
 * Keyless ComfyUI composition adapter: submit one no-model workflow, wait for the job,
 * then answer with the output URL from the tool results.
 */
class ComfyMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = options.messages
    const lastToolResult = messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (lastToolResult === undefined) {
      const id = CallId('comfy-smoke-submit')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'comfy_submit_workflow', argumentsDelta: SUBMIT_ARGS }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'comfy_submit_workflow', arguments: SUBMIT_ARGS } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const submitText = toolResultText(messages, 'comfy-smoke-submit')
    const jobId = /job ([^ .]+)/.exec(submitText)?.[1]
    if (jobId !== undefined && !messages.some(message => message.content.some(block => block.type === 'tool-call' && block.name === 'comfy_get_job'))) {
      const args = JSON.stringify({ jobId, wait: true })
      const id = CallId('comfy-smoke-get')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'comfy_get_job', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'comfy_get_job', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const url = /→ (\S+)/.exec(toolResultText(messages, 'comfy-smoke-get'))?.[1] ?? 'no-url'
    const reply = `COMFY_ROUND_TRIP ${url}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Concatenated text of the tool-result block for one tool call id. */
function toolResultText(messages: GenerateOptions['messages'], callId: string): string {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-result' && block.toolCallId === callId) {
        return block.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('')
      }
    }
  }
  return ''
}

/** Register the keyless `comfy-mock` adapter. */
export const name = 'comfy-mock-llm'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['comfy-mock'], new ComfyMockAdapter())
}
