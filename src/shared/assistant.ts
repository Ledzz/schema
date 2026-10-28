/*
 * What the in-app assistant and its server route agree on: the model providers, the Claude
 * models offered with their prices for the cost estimate, and the shape of a request from the
 * browser. Gemini models are listed live from Google's API, so they carry no prices.
 */
import type Anthropic from '@anthropic-ai/sdk';

export type Effort = 'low' | 'medium' | 'high';
export const EFFORTS: Effort[] = ['low', 'medium', 'high'];

export type Provider = 'anthropic' | 'gemini';

export interface ProviderInfo {
  id: Provider;
  label: string;
  /** The environment variable the server reads its key from. */
  keyEnv: string;
  /** Where a user gets a key. */
  console: string;
  keyHint: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)', keyEnv: 'ANTHROPIC_API_KEY', console: 'https://console.anthropic.com/', keyHint: 'sk-ant-…' },
  { id: 'gemini', label: 'Gemini (Google)', keyEnv: 'GEMINI_API_KEY', console: 'https://aistudio.google.com/apikey', keyHint: 'AIza…' },
];

export const providerById = (id: string): ProviderInfo | undefined => PROVIDERS.find((p) => p.id === id);

export interface AssistantModel {
  id: string;
  label: string;
  note: string;
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** Whether a refused request may be re-run on another model server-side. */
  fallback: boolean;
}

/** Claude models, with prices as published for the Claude API (first-party), October 2026. */
export const ASSISTANT_MODELS: AssistantModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'best at design work', input: 4, output: 20, cacheRead: 0.2, fallback: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'faster and cheaper', input: 2, output: 10, cacheRead: 0.2, fallback: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'cheapest; fine for small edits', input: 0.1, output: 0.5, cacheRead: 0.01, fallback: false },
];
export const DEFAULT_MODEL = ASSISTANT_MODELS[0].id;

export const modelById = (id: string): AssistantModel | undefined => ASSISTANT_MODELS.find((m) => m.id === id);

/** A model as offered in the settings; Gemini's come from the live list. */
export interface ModelOption {
  id: string;
  label: string;
}

/** The header the app sends the user's own API key in; absent, the server's key is used. */
export const KEY_HEADER = 'x-assistant-key';

/** What the browser sends to POST /api/assistant. */
export interface AssistantRequest {
  provider: Provider;
  model: string;
  effort: Effort;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

/** Token totals over a conversation. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Adds one response's usage to the running total. */
export function addUsage(total: TokenUsage, usage: Anthropic.Beta.BetaUsage): TokenUsage {
  return {
    input: total.input + usage.input_tokens,
    output: total.output + usage.output_tokens,
    cacheRead: total.cacheRead + (usage.cache_read_input_tokens ?? 0),
    cacheWrite: total.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
  };
}

/** Estimated cost in USD at the model's list prices (cache writes cost 1.25× input); null when unknown. */
export function estimateCost(usage: TokenUsage, modelId: string): number | null {
  const m = modelById(modelId);
  if (!m) return null;
  return (usage.input * m.input + usage.cacheWrite * m.input * 1.25 + usage.cacheRead * m.cacheRead + usage.output * m.output) / 1e6;
}
