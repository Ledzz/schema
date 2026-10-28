import { beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { useEditor } from '../src/store/editor';
import { skillBody, systemPrompt } from '../src/lib/assistant/prompt';
import { applyEvent, parseSse, type LiveBlock, type StreamEvent } from '../src/lib/assistant/stream';
import { runTurn, type Message, type ToolCall, type Transport } from '../src/lib/assistant/loop';
import { assistantTools, editorState, executeAssistantTool } from '../src/lib/assistant/tools';
import { addUsage, EMPTY_USAGE, estimateCost } from '../src/shared/assistant';
import { checkRequest, describeError } from '../server/assistant';
import { SIGNATURE, geminiEvents, geminiModelOptions, thinkingConfig, toContents, toFunctionDeclarations } from '../server/gemini';
import type { ServerEvent } from '../src/lib/assistant/stream';
import { noticeFor } from '../src/store/assistant';
import { comp, project } from './fixtures';

const st = () => useEditor.getState();

describe('system prompt', () => {
  it('drops frontmatter, the title and the command-line Setup section from a skill', () => {
    const md = ['---', 'name: x', 'description: y', '---', '', '# Title', '', 'Intro.', '', '## Setup', '', 'cd somewhere', '```bash', 'pnpm -s schem', '```', '', '## Workflow', '', 'Do things.'].join('\n');
    expect(skillBody(md)).toBe('Intro.\n\n## Workflow\n\nDo things.');
  });

  it('carries the three manuals and no command-line setup', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('# Manual 1: Schematic design');
    expect(prompt).toContain('# Manual 2: Circuit recipes');
    expect(prompt).toContain('# Manual 3: PCB layout');
    expect(prompt).toContain('5.1 kΩ');
    expect(prompt).not.toContain('realpath');
    expect(prompt).not.toContain('## Setup');
    expect(prompt).not.toMatch(/^name: /m);
  });
});

describe('stream parsing', () => {
  it('splits complete events from a buffer and keeps the remainder', () => {
    const { events, rest } = parseSse('data: {"a":1}\n\ndata: {"b":\ndata: 2}\n\ndata: {"c"');
    expect(events).toEqual(['{"a":1}', '{"b":\n2}']);
    expect(rest).toBe('data: {"c"');
  });

  it('builds the live blocks from content events', () => {
    const events: StreamEvent[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan…', estimated_tokens: 0 } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'list_components', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'content_block_stop', index: 2 },
    ];
    let live: LiveBlock[] = [];
    for (const e of events) live = applyEvent(live, e);
    expect(live).toEqual([
      { type: 'thinking', thinking: 'Plan…' },
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 't1', name: 'list_components', json: '{"a":1}' },
    ]);
  });
});

/** A reply with the given blocks and stop reason, as the API would return it. */
const reply = (content: Anthropic.Beta.BetaContentBlock[], stop_reason: Anthropic.Beta.BetaStopReason = 'end_turn'): Anthropic.Beta.BetaMessage =>
  ({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }) as unknown as Anthropic.Beta.BetaMessage;
const text = (t: string): Anthropic.Beta.BetaTextBlock => ({ type: 'text', text: t, citations: null });
const call = (id: string, name: string, input: Record<string, unknown> = {}): ToolCall => ({ type: 'tool_use', id, name, input });
const scripted = (replies: Anthropic.Beta.BetaMessage[]): Transport => {
  let i = 0;
  return async () => replies[i++];
};
const request = (messages: Message[]) => ({ provider: 'anthropic' as const, model: 'claude-opus-5-5', effort: 'medium' as const, system: 's', messages, tools: [] });
const userMessage: Message = { role: 'user', content: 'hi' };

describe('turn loop', () => {
  it('runs the tools a reply asks for, answers them in one message and stops at end_turn', async () => {
    const ran: string[] = [];
    const { messages, end } = await runTurn({
      messages: [userMessage],
      request,
      transport: scripted([reply([text('Looking'), call('a', 'list_components'), call('b', 'check_design')], 'tool_use'), reply([text('Done')])]),
      execute: async (c) => {
        ran.push(c.name);
        return { type: 'tool_result', tool_use_id: c.id, content: `${c.name} ok` };
      },
      signal: new AbortController().signal,
    });
    expect(end).toEqual({ reason: 'done' });
    expect(ran).toEqual(['list_components', 'check_design']);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'list_components ok' },
      { type: 'tool_result', tool_use_id: 'b', content: 'check_design ok' },
    ]);
  });

  it('does not run a call cut off at the output limit but still answers it', async () => {
    const ran: string[] = [];
    const { messages, end } = await runTurn({
      messages: [userMessage],
      request,
      transport: scripted([reply([call('a', 'pcb_autoroute')], 'max_tokens')]),
      execute: async (c) => {
        ran.push(c.name);
        return { type: 'tool_result', tool_use_id: c.id, content: 'ok' };
      },
      signal: new AbortController().signal,
    });
    expect(end).toEqual({ reason: 'max_tokens' });
    expect(ran).toEqual([]);
    expect(messages[2].content).toMatchObject([{ type: 'tool_result', tool_use_id: 'a', is_error: true }]);
  });

  it('stops after the running tool when the user stops it, answering the rest as not run', async () => {
    const controller = new AbortController();
    const { messages, end } = await runTurn({
      messages: [userMessage],
      request,
      transport: scripted([reply([call('a', 'x'), call('b', 'y')], 'tool_use'), reply([text('never')])]),
      execute: async (c) => {
        controller.abort();
        return { type: 'tool_result', tool_use_id: c.id, content: `${c.name} ok` };
      },
      signal: controller.signal,
    });
    expect(end).toEqual({ reason: 'stopped' });
    expect(messages).toHaveLength(3);
    expect(messages[2].content).toMatchObject([
      { tool_use_id: 'a', content: 'x ok' },
      { tool_use_id: 'b', is_error: true },
    ]);
  });

  it('reports a refusal and a round limit', async () => {
    const refused = await runTurn({ messages: [userMessage], request, transport: scripted([reply([], 'refusal')]), execute: async () => ({ type: 'tool_result', tool_use_id: '' }), signal: new AbortController().signal });
    expect(refused.end).toEqual({ reason: 'refusal', detail: null });
    const endless: Transport = async () => reply([call('a', 'x')], 'tool_use');
    const looped = await runTurn({ messages: [userMessage], request, transport: endless, execute: async (c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'ok' }), signal: new AbortController().signal, maxRounds: 3 });
    expect(looped.end).toEqual({ reason: 'max_rounds', rounds: 3 });
    expect(looped.messages).toHaveLength(7);
    expect(noticeFor(looped.end)).toContain('3 rounds');
    expect(noticeFor({ reason: 'done' })).toBeNull();
  });
});

describe('tools for the assistant', () => {
  beforeEach(() => st().loadProject(project({ components: [comp('a', 'res', 'R1', 0, 0)] })));

  it('lists every editor tool in the API shape', () => {
    const tools = assistantTools();
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.find((t) => t.name === 'pcb_render')?.description).toContain('image');
    expect(tools.find((t) => t.name === 'place_passive')?.input_schema).toMatchObject({ type: 'object', required: ['kind', 'value'] });
  });

  it('runs a tool and turns errors into error results', async () => {
    const ok = await executeAssistantTool(call('1', 'list_components'));
    expect(ok.is_error).toBeUndefined();
    expect(JSON.parse(ok.content as string)).toMatchObject({ components: [{ designator: 'R1' }] });
    const bad = await executeAssistantTool(call('2', 'check_pin', { pin: 'R9.1' }));
    expect(bad.is_error).toBe(true);
    expect(JSON.parse(bad.content as string).error).toMatch(/R9/);
    const unknown = await executeAssistantTool(call('3', 'nope'));
    expect(unknown.is_error).toBe(true);
  });

  it('describes the editor state in one line', () => {
    st().setSelection(['a']);
    const state = editorState();
    expect(state).toContain('view: schematic');
    expect(state).toContain('parts in the schematic: 1');
    expect(state).toContain('no board yet');
    expect(state).toContain('selected by the user: R1');
  });
});

describe('usage and the server route', () => {
  it('adds usage and estimates the cost at list prices', () => {
    const usage = addUsage(EMPTY_USAGE, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 } as Anthropic.Beta.BetaUsage);
    expect(usage).toEqual({ input: 1000, output: 500, cacheRead: 10000, cacheWrite: 2000 });
    // 1000×4 + 2000×5 + 10000×0.2 + 500×20 = 26000 micro-dollars
    expect(estimateCost(usage, 'claude-opus-5-5')).toBeCloseTo(0.026, 6);
    expect(estimateCost(usage, 'nope')).toBeNull();
  });

  it('rejects malformed requests with a reason', () => {
    expect(() => checkRequest({})).toThrow(/provider/);
    expect(() => checkRequest({ provider: 'anthropic' })).toThrow(/model/);
    expect(() => checkRequest({ provider: 'gemini', model: 'gpt-5' })).toThrow(/gemini/);
    expect(() => checkRequest({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'extreme' })).toThrow(/effort/);
    expect(() => checkRequest({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low', system: 's', messages: [] })).toThrow(/messages/);
    expect(checkRequest({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low', system: 's', messages: [userMessage], tools: [] }).model).toBe('claude-opus-5-5');
    expect(checkRequest({ provider: 'gemini', model: 'gemini-2.5-pro', effort: 'low', system: 's', messages: [userMessage], tools: [] }).provider).toBe('gemini');
    expect(describeError(new Error('boom'))).toEqual({ message: 'boom' });
  });
});

describe('gemini translation', () => {
  it('turns the conversation into contents with function calls, responses and pictures', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '<editor_state>x</editor_state>' }, { type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: '' },
          { type: 'text', text: 'Looking', citations: null },
          { type: 'tool_use', id: 'c1', name: 'pcb_render', input: {}, [SIGNATURE]: 'sig1' } as never,
          { type: 'tool_use', id: 'c2', name: 'check_pin', input: { pin: 'R9.1' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: '{"width_px":10}' }] },
          { type: 'tool_result', tool_use_id: 'c2', is_error: true, content: '{"error":"No component R9"}' },
        ],
      },
    ];
    expect(toContents(messages)).toEqual([
      { role: 'user', parts: [{ text: '<editor_state>x</editor_state>' }, { text: 'hi' }] },
      { role: 'model', parts: [{ text: 'Looking' }, { functionCall: { name: 'pcb_render', args: {} }, thoughtSignature: 'sig1' }, { functionCall: { name: 'check_pin', args: { pin: 'R9.1' } } }] },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'pcb_render', response: { width_px: 10 }, parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } },
          { functionResponse: { name: 'check_pin', response: { error: 'No component R9' } } },
        ],
      },
    ]);
  });

  it('declares the tools with their JSON schemas and maps effort to thinking', () => {
    const decl = toFunctionDeclarations(assistantTools());
    expect(decl.find((d) => d.name === 'place_passive')?.parametersJsonSchema).toMatchObject({ type: 'object' });
    expect(thinkingConfig('gemini-2.5-pro', 'low')).toEqual({ includeThoughts: true, thinkingBudget: 2048 });
    expect(thinkingConfig('gemini-3.1-pro', 'medium')).toEqual({ includeThoughts: true });
    expect(thinkingConfig('gemini-3.1-pro', 'high')).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
  });

  it('streams Gemini chunks as the same events and final message', async () => {
    const chunks = [
      { responseId: 'r1', candidates: [{ content: { parts: [{ text: 'Plan…', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Let me ' }] } }] },
      {
        candidates: [{ content: { parts: [{ text: 'look.', thoughtSignature: 'tsig' }, { functionCall: { name: 'list_components', args: {} }, thoughtSignature: 'fsig' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 5 },
      },
    ];
    async function* gen() {
      for (const c of chunks) yield c as never;
    }
    const events: ServerEvent[] = [];
    for await (const e of geminiEvents(gen(), 'gemini-x')) events.push(e);
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop', 'final',
    ]);
    const final = events.at(-1) as { type: 'final'; message: Anthropic.Beta.BetaMessage };
    expect(final.message.stop_reason).toBe('tool_use');
    expect(final.message.usage).toMatchObject({ input_tokens: 60, output_tokens: 15, cache_read_input_tokens: 40 });
    expect(final.message.content).toEqual([
      { type: 'thinking', thinking: 'Plan…', signature: '' },
      { type: 'text', text: 'Let me look.', citations: null, [SIGNATURE]: 'tsig' },
      { type: 'tool_use', id: 'r1_0', name: 'list_components', input: {}, [SIGNATURE]: 'fsig' },
    ]);
    // What goes back carries the signatures and nothing of the thinking.
    expect(toContents([{ role: 'assistant', content: final.message.content }])[0].parts).toEqual([
      { text: 'Let me look.', thoughtSignature: 'tsig' },
      { functionCall: { name: 'list_components', args: {} }, thoughtSignature: 'fsig' },
    ]);
  });

  it('reports a refusal or the output limit as stop reasons', async () => {
    async function* gen(reason: string) {
      yield { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }] } as never;
    }
    const last = async (reason: string) => {
      let event: ServerEvent | undefined;
      for await (event of geminiEvents(gen(reason), 'g'));
      return (event as { message: Anthropic.Beta.BetaMessage }).message;
    };
    expect((await last('MAX_TOKENS')).stop_reason).toBe('max_tokens');
    const refused = await last('SAFETY');
    expect(refused.stop_reason).toBe('refusal');
    expect(refused.stop_details?.explanation).toContain('SAFETY');
    expect((await last('STOP')).stop_reason).toBe('end_turn');
  });

  it('offers chat models Pro first, newest first', () => {
    const models = [
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedActions: ['generateContent'] },
      { name: 'models/gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', supportedActions: ['generateContent'] },
      { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedActions: ['generateContent'] },
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedActions: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-image', supportedActions: ['generateContent'] },
      { name: 'models/gemini-embedding-001', supportedActions: ['embedContent'] },
      { name: 'models/gemini-2.5-flash-preview-05-20', supportedActions: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', supportedActions: ['generateContent'] },
      { name: 'models/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', supportedActions: ['generateContent'] },
    ];
    expect(geminiModelOptions(models as never).map((m) => m.id)).toEqual(['gemini-3.1-pro', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });
});
