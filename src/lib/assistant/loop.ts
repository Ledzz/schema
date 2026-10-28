/*
 * One turn of the assistant: send the conversation, append the reply, run the tools it asked
 * for, append their results, and go round again until the model stops asking for tools. The
 * transport and the tool runner are passed in, so the loop runs the same under test as in the
 * browser. The conversation is only ever appended to (never edited), which is what keeps the
 * model's thinking blocks valid from one request to the next.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { AssistantRequest } from '../../shared/assistant';
import type { StreamEvent } from './stream';

export type Message = Anthropic.Beta.BetaMessageParam;
export type ToolCall = Anthropic.Beta.BetaToolUseBlock;
export type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/** Sends one request and resolves with the complete reply, reporting stream events as they come. */
export type Transport = (request: AssistantRequest, onEvent: (event: StreamEvent) => void, signal: AbortSignal) => Promise<Anthropic.Beta.BetaMessage>;

export interface TurnOptions {
  /** The conversation so far, ending with the new user message. */
  messages: Message[];
  /** Builds the request for the conversation at this point (model, system prompt, tools). */
  request: (messages: Message[]) => AssistantRequest;
  transport: Transport;
  execute: (call: ToolCall) => Promise<ToolResult>;
  signal: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  /** Called with the whole conversation after every message appended to it. */
  onMessages?: (messages: Message[]) => void;
  onResponse?: (message: Anthropic.Beta.BetaMessage) => void;
  onTool?: (id: string, state: 'running' | 'done') => void;
  /** Rounds of tool calls before the turn gives up (the user can ask it to go on). */
  maxRounds?: number;
}

export type TurnEnd =
  | { reason: 'done' }
  | { reason: 'refusal'; detail: string | null }
  | { reason: 'max_tokens' }
  | { reason: 'max_rounds'; rounds: number }
  | { reason: 'stopped' };

const DEFAULT_ROUNDS = 80;

/** Runs the turn to its end and returns the conversation with everything it appended. */
export async function runTurn(o: TurnOptions): Promise<{ messages: Message[]; end: TurnEnd }> {
  const messages = o.messages.slice();
  const append = (m: Message) => {
    messages.push(m);
    o.onMessages?.(messages.slice());
  };
  const rounds = o.maxRounds ?? DEFAULT_ROUNDS;
  for (let round = 0; round < rounds; round++) {
    if (o.signal.aborted) return { messages, end: { reason: 'stopped' } };
    const reply = await o.transport(o.request(messages), o.onEvent ?? (() => {}), o.signal);
    o.onResponse?.(reply);
    // The whole content goes back, thinking blocks included: the API wants them unchanged.
    append({ role: 'assistant', content: reply.content });
    const calls = reply.content.filter((b): b is ToolCall => b.type === 'tool_use');
    if (reply.stop_reason === 'refusal') return { messages, end: { reason: 'refusal', detail: reply.stop_details?.explanation ?? null } };
    if (calls.length === 0) return { messages, end: reply.stop_reason === 'max_tokens' ? { reason: 'max_tokens' } : { reason: 'done' } };
    // A call cut off at the output limit must not run on a half-written input, but it still
    // needs a result, or the next request is rejected as malformed.
    const cutOff = reply.stop_reason === 'max_tokens';
    const results: ToolResult[] = [];
    for (const call of calls) {
      if (cutOff || o.signal.aborted) {
        const why = cutOff ? 'The reply was cut off before this call was complete; it did not run.' : 'Stopped by the user before this call ran.';
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: why });
        continue;
      }
      o.onTool?.(call.id, 'running');
      results.push(await o.execute(call));
      o.onTool?.(call.id, 'done');
    }
    append({ role: 'user', content: results });
    if (cutOff) return { messages, end: { reason: 'max_tokens' } };
    if (o.signal.aborted) return { messages, end: { reason: 'stopped' } };
  }
  return { messages, end: { reason: 'max_rounds', rounds } };
}
