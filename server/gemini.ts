/*
 * Gemini as the assistant's model. The browser keeps the conversation in the Claude API's
 * shape, so this translates both ways: messages become Gemini contents (text, function calls
 * and responses, the board picture as a multimodal function response), and Gemini's streamed
 * chunks become the same stream events and final message the Claude route sends. Thought
 * signatures, which Gemini wants back with each function call, ride along inside the stored
 * blocks under a field of their own.
 */
import { ThinkingLevel, type Content, type FunctionDeclaration, type FunctionResponsePart, type GenerateContentResponse, type Model, type Part, type ThinkingConfig } from '@google/genai';
import type Anthropic from '@anthropic-ai/sdk';
import type { Effort, ModelOption } from '../src/shared/assistant';
import type { ServerEvent } from '../src/lib/assistant/stream';

type Message = Anthropic.Beta.BetaMessageParam;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type Block = Anthropic.Beta.BetaContentBlock;
type Usage = Anthropic.Beta.BetaUsage;

/** The field a Gemini thought signature is kept in on a stored text or tool_use block. */
export const SIGNATURE = 'gemini_thought_signature';

const signatureOf = (block: unknown): string | undefined => {
  const sig = (block as Record<string, unknown>)[SIGNATURE];
  return typeof sig === 'string' && sig ? sig : undefined;
};

/** The tools as Gemini function declarations; the JSON schemas go through as they are. */
export function toFunctionDeclarations(tools: Anthropic.Beta.BetaTool[]): FunctionDeclaration[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema }));
}

/** A tool result as a function response: JSON becomes the response object, pictures ride as parts. */
function functionResponsePart(block: Anthropic.Beta.BetaToolResultBlockParam, name: string): Part {
  let text = '';
  const parts: FunctionResponsePart[] = [];
  if (typeof block.content === 'string') text = block.content;
  else
    for (const c of block.content ?? []) {
      if (c.type === 'text') text += c.text;
      else if (c.type === 'image' && c.source.type === 'base64') parts.push({ inlineData: { mimeType: c.source.media_type, data: c.source.data } });
    }
  let response: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { result: parsed };
  } catch {
    response = block.is_error ? { error: text } : { result: text };
  }
  return { functionResponse: { name, response, ...(parts.length ? { parts } : {}) } };
}

/** The conversation as Gemini contents. Thinking blocks are left out: Gemini only wants the signatures. */
export function toContents(messages: Message[]): Content[] {
  const names = new Map<string, string>();
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const blocks: BlockParam[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : ((m.content ?? []) as BlockParam[]);
    const parts: Part[] = [];
    for (const b of blocks) {
      const sig = signatureOf(b);
      if (b.type === 'text') {
        if (b.text || sig) parts.push({ text: b.text, ...(sig ? { thoughtSignature: sig } : {}) });
      } else if (b.type === 'tool_use') {
        names.set(b.id, b.name);
        parts.push({ functionCall: { name: b.name, args: (b.input ?? {}) as Record<string, unknown> }, ...(sig ? { thoughtSignature: sig } : {}) });
      } else if (b.type === 'tool_result') {
        parts.push(functionResponsePart(b, names.get(b.tool_use_id) ?? 'unknown'));
      } else if (b.type === 'image' && b.source.type === 'base64') {
        parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
      }
    }
    if (parts.length) out.push({ role: m.role === 'user' ? 'user' : 'model', parts });
  }
  return out;
}

/** Thinking for the effort setting: Gemini 3 and later take a level, Gemini 2.5 a token budget. */
export function thinkingConfig(model: string, effort: Effort): ThinkingConfig {
  if (/gemini-[3-9]/.test(model)) {
    // Medium is the model's own default level; naming one that a model lacks is a 400.
    return { includeThoughts: true, ...(effort === 'low' ? { thinkingLevel: ThinkingLevel.LOW } : effort === 'high' ? { thinkingLevel: ThinkingLevel.HIGH } : {}) };
  }
  return { includeThoughts: true, thinkingBudget: effort === 'low' ? 2048 : -1 };
}

const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) as Usage;

/** A message in the Claude API's shape, with only the fields the browser reads. */
const message = (fields: Record<string, unknown>): Anthropic.Beta.BetaMessage =>
  ({ type: 'message', role: 'assistant', stop_sequence: null, stop_details: null, ...fields }) as unknown as Anthropic.Beta.BetaMessage;

/**
 * Turns Gemini's streamed chunks into the stream events the browser already understands, then
 * the final message. Text and thought parts that follow each other join into one block; every
 * function call is a block of its own.
 */
export async function* geminiEvents(stream: AsyncIterable<GenerateContentResponse>, model: string): AsyncGenerator<ServerEvent> {
  const blocks: Block[] = [];
  let open: { index: number; kind: 'text' | 'thinking' } | null = null;
  let usage = emptyUsage();
  let finish: string | undefined;
  let finishMessage: string | undefined;
  let calls = 0;
  let id = `gemini_${Date.now().toString(36)}`;
  const stop = (): ServerEvent | null => {
    if (!open) return null;
    const event: ServerEvent = { type: 'content_block_stop', index: open.index };
    open = null;
    return event;
  };

  yield { type: 'message_start', message: message({ id, model, content: [], stop_reason: null, usage }) };
  for await (const chunk of stream) {
    if (chunk.responseId && calls === 0 && blocks.length === 0) id = chunk.responseId;
    if (chunk.promptFeedback?.blockReason) {
      finish = 'SAFETY';
      finishMessage = `prompt blocked: ${chunk.promptFeedback.blockReason}`;
    }
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        const closing = stop();
        if (closing) yield closing;
        const index = blocks.length;
        const callId = `${id}_${calls++}`;
        const name = part.functionCall.name ?? '';
        const input = part.functionCall.args ?? {};
        blocks.push({ type: 'tool_use', id: callId, name, input, ...(part.thoughtSignature ? { [SIGNATURE]: part.thoughtSignature } : {}) } as Block);
        yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: callId, name, input: {} } };
        yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } };
        yield { type: 'content_block_stop', index };
        continue;
      }
      if (typeof part.text !== 'string') continue;
      const kind = part.thought ? 'thinking' : 'text';
      if (!open || open.kind !== kind) {
        const closing = stop();
        if (closing) yield closing;
        const index = blocks.length;
        const block: Block = kind === 'text' ? { type: 'text', text: '', citations: null } : { type: 'thinking', thinking: '', signature: '' };
        blocks.push(block);
        open = { index, kind };
        yield { type: 'content_block_start', index, content_block: block };
      }
      const block = blocks[open.index];
      if (block.type === 'text') {
        block.text += part.text;
        if (part.text) yield { type: 'content_block_delta', index: open.index, delta: { type: 'text_delta', text: part.text } };
      } else if (block.type === 'thinking') {
        block.thinking += part.text;
        if (part.text) yield { type: 'content_block_delta', index: open.index, delta: { type: 'thinking_delta', thinking: part.text, estimated_tokens: 0 } };
      }
      // A signature on a visible text part has to go back with that text.
      if (part.thoughtSignature && block.type === 'text') (block as unknown as Record<string, unknown>)[SIGNATURE] = part.thoughtSignature;
    }
    if (candidate?.finishReason) {
      finish = candidate.finishReason;
      finishMessage = candidate.finishMessage ?? finishMessage;
    }
    const u = chunk.usageMetadata;
    if (u) {
      const cached = u.cachedContentTokenCount ?? 0;
      usage = {
        input_tokens: Math.max(0, (u.promptTokenCount ?? 0) - cached),
        output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
      } as Usage;
    }
  }
  const closing = stop();
  if (closing) yield closing;

  const stop_reason: Anthropic.Beta.BetaStopReason = calls > 0 ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish && finish !== 'STOP' && finish !== 'FINISH_REASON_UNSPECIFIED' ? 'refusal' : 'end_turn';
  const stop_details =
    stop_reason === 'refusal' ? ({ type: 'refusal', category: null, explanation: `Gemini stopped with ${finish}${finishMessage ? ` (${finishMessage})` : ''}` } as Anthropic.Beta.BetaRefusalStopDetails) : null;
  yield { type: 'message_delta', delta: { stop_reason, stop_sequence: null, container: null }, usage: usage as unknown as Anthropic.Beta.BetaMessageDeltaUsage, context_management: null } as ServerEvent;
  yield { type: 'message_stop' };
  yield { type: 'final', message: message({ id, model, content: blocks, stop_reason, stop_details, usage }) };
}

const NOT_FOR_CHAT = /(image|tts|live|audio|embedding|robotics|computer-use|native|veo|imagen|exp$|-\d{2}-\d{2}$|latest$)/;

/** The Gemini models worth offering: chat models with function calling, Pro before Flash, newest first. */
export function geminiModelOptions(models: Model[]): ModelOption[] {
  const rank = (id: string) => {
    const version = Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
    const family = /flash-lite/.test(id) ? 2 : /flash/.test(id) ? 1 : 0;
    return { version, family, preview: /preview/.test(id) ? 1 : 0 };
  };
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const m of models) {
    const id = (m.name ?? '').replace(/^models\//, '');
    if (!/^gemini-\d/.test(id) || NOT_FOR_CHAT.test(id) || seen.has(id)) continue;
    if (m.supportedActions && !m.supportedActions.includes('generateContent')) continue;
    seen.add(id);
    out.push({ id, label: m.displayName || id });
  }
  return out.sort((a, b) => {
    const ra = rank(a.id);
    const rb = rank(b.id);
    return ra.family - rb.family || rb.version - ra.version || ra.preview - rb.preview || a.id.localeCompare(b.id);
  });
}
