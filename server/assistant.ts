/*
 * The in-app assistant's gateway to the model APIs. The browser sends the conversation (in the
 * Claude API's shape), the tool definitions and the system prompt; this adds the API key (the
 * server's, or one the user typed into the app), calls Claude or Gemini, and streams the
 * model's events back as server-sent events, ending with the complete message so the browser
 * has the exact content blocks to send back next round. Tools run in the browser, where the
 * design is; the server never sees the project.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ApiError as GeminiError, GoogleGenAI } from '@google/genai';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ASSISTANT_MODELS, EFFORTS, KEY_HEADER, PROVIDERS, modelById, providerById, type AssistantRequest, type Provider } from '../src/shared/assistant';
import type { ServerEvent } from '../src/lib/assistant/stream';
import { geminiEvents, geminiModelOptions, thinkingConfig, toContents, toFunctionDeclarations } from './gemini';

const MAX_OUTPUT_TOKENS = 32_000;

const serverKey = (provider: Provider) => process.env[providerById(provider)!.keyEnv];

/** Gemini's errors arrive as a JSON document in the message; the sentence inside is what matters. */
function geminiReason(message: string): string {
  try {
    const parsed = JSON.parse(message) as { error?: { message?: string } };
    return parsed.error?.message ?? message;
  } catch {
    return message;
  }
}

/** A short, actionable message for an API failure, most specific first. */
export function describeError(err: unknown): { message: string; status?: number } {
  if (err instanceof Anthropic.AuthenticationError) return { message: 'The API key was rejected. Check it in the assistant settings.', status: 401 };
  if (err instanceof Anthropic.PermissionDeniedError) return { message: `This key may not use the model: ${err.message}`, status: 403 };
  if (err instanceof Anthropic.RateLimitError) return { message: 'Rate limited by the API; wait a moment and send again.', status: 429 };
  if (err instanceof Anthropic.BadRequestError) return { message: `The API refused the request: ${err.message}`, status: 400 };
  if (err instanceof Anthropic.APIError) return { message: `API error ${err.status ?? ''}: ${err.message}`.trim(), status: err.status };
  if (err instanceof Anthropic.APIConnectionError) return { message: 'Could not reach the Claude API (network).' };
  if (err instanceof GeminiError) {
    const reason = geminiReason(err.message);
    if (err.status === 401 || err.status === 403 || /API key not valid/i.test(reason)) return { message: 'The Gemini API key was rejected. Check it in the assistant settings.', status: 401 };
    if (err.status === 429) return { message: 'Rate limited by the Gemini API; wait a moment and send again.', status: 429 };
    if (err.status === 400) return { message: `The Gemini API refused the request: ${reason}`, status: 400 };
    return { message: `Gemini API error ${err.status}: ${reason}`, status: err.status };
  }
  return { message: (err as Error).message ?? String(err) };
}

/** Checks the browser's request shape; anything odd is a 400 rather than a confusing API error. */
export function checkRequest(body: unknown): AssistantRequest {
  const r = body as Partial<AssistantRequest>;
  if (!r || typeof r !== 'object') throw new Error('Expected a JSON object');
  if (!providerById(String(r.provider))) throw new Error(`provider must be one of ${PROVIDERS.map((p) => p.id).join(', ')}`);
  if (r.provider === 'anthropic' && !modelById(String(r.model))) throw new Error(`model must be one of ${ASSISTANT_MODELS.map((m) => m.id).join(', ')}`);
  if (r.provider === 'gemini' && !/^gemini-[\w.-]+$/.test(String(r.model))) throw new Error('model must be a Gemini model id such as gemini-2.5-pro');
  if (!EFFORTS.includes(r.effort as never)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
  if (typeof r.system !== 'string' || !r.system) throw new Error('system must be a non-empty string');
  if (!Array.isArray(r.messages) || !r.messages.length) throw new Error('messages must be a non-empty array');
  if (!Array.isArray(r.tools)) throw new Error('tools must be an array');
  return r as AssistantRequest;
}

/** Claude's own stream events, then the complete message. */
async function* claudeEvents(key: string, request: AssistantRequest, signal: AbortSignal): AsyncGenerator<ServerEvent> {
  const model = modelById(request.model)!;
  const client = new Anthropic({ apiKey: key, maxRetries: 2 });
  const stream = client.beta.messages.stream(
    {
      model: model.id,
      max_tokens: MAX_OUTPUT_TOKENS,
      // The system prompt is the same for every request, so its breakpoint caches the tools
      // (rendered before it) and the prompt together; the top-level marker caches the growing
      // conversation behind it.
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral' },
      tools: request.tools,
      messages: request.messages,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: request.effort },
      // A request the model's safety classifiers decline is re-run on another model server-side
      // instead of ending the turn; Haiku has no such fallback.
      ...(model.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    },
    { signal },
  );
  for await (const event of stream) yield event;
  yield { type: 'final', message: await stream.finalMessage() };
}

/** Gemini's reply, translated into the same events. */
async function geminiStream(key: string, request: AssistantRequest, signal: AbortSignal): Promise<AsyncGenerator<ServerEvent>> {
  const ai = new GoogleGenAI({ apiKey: key });
  const stream = await ai.models.generateContentStream({
    model: request.model,
    contents: toContents(request.messages),
    config: {
      systemInstruction: request.system,
      tools: [{ functionDeclarations: toFunctionDeclarations(request.tools) }],
      thinkingConfig: thinkingConfig(request.model, request.effort),
      abortSignal: signal,
    },
  });
  return geminiEvents(stream, request.model);
}

export const assistant = new Hono();

assistant.get('/status', (c) => c.json({ server_keys: Object.fromEntries(PROVIDERS.map((p) => [p.id, Boolean(process.env[p.keyEnv])])) }));

/** The Gemini models the key can use, for the settings; needs a key like any other call. */
assistant.get('/models', async (c) => {
  const key = c.req.header(KEY_HEADER)?.trim() || serverKey('gemini');
  if (!key) return c.json({ error: 'No Gemini API key yet.' }, 401);
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const pager = await ai.models.list({ config: { pageSize: 200 } });
    const models = [];
    for await (const m of pager) models.push(m);
    return c.json({ models: geminiModelOptions(models) });
  } catch (err) {
    const { message, status } = describeError(err);
    return c.json({ error: message }, status === 401 || status === 403 || status === 429 ? status : 502);
  }
});

assistant.post('/', async (c) => {
  let request: AssistantRequest;
  try {
    request = checkRequest(await c.req.json());
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  const provider = providerById(request.provider)!;
  const key = c.req.header(KEY_HEADER)?.trim() || serverKey(provider.id);
  if (!key) return c.json({ error: `No ${provider.label} API key. Enter one in the assistant settings, or set ${provider.keyEnv} where the server runs.` }, 401);
  const controller = new AbortController();
  return streamSSE(c, async (sse) => {
    sse.onAbort(() => controller.abort());
    try {
      const events = provider.id === 'gemini' ? await geminiStream(key, request, controller.signal) : claudeEvents(key, request, controller.signal);
      for await (const event of events) await sse.writeSSE({ data: JSON.stringify(event) });
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('[assistant]', err);
      await sse.writeSSE({ data: JSON.stringify({ type: 'error', ...describeError(err) }) });
    }
  });
});
