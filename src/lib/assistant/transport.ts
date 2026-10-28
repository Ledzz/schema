/*
 * Sends an assistant request to the app's server and reads the reply back as server-sent
 * events: stream events for the live view, then the complete message.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { KEY_HEADER } from '../../shared/assistant';
import type { Transport } from './loop';
import { parseSse, type ServerEvent } from './stream';
import { apiUrl } from '../api';

/** A transport through POST /api/assistant, sending the user's own API key when they gave one. */
export function sseTransport(apiKey: string | null): Transport {
  return async (request, onEvent, signal) => {
    const res = await fetch(apiUrl('/api/assistant'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { [KEY_HEADER]: apiKey } : {}) },
      body: JSON.stringify(request),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final: Anthropic.Beta.BetaMessage | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSse(buffer);
      buffer = parsed.rest;
      for (const text of parsed.events) {
        const event = JSON.parse(text) as ServerEvent;
        if (event.type === 'final') final = event.message;
        else if (event.type === 'error') throw new Error(event.message);
        else onEvent(event);
      }
    }
    if (!final) throw new Error('The connection closed before the reply was complete.');
    return final;
  };
}
