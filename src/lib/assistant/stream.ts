/*
 * The assistant's stream: server-sent events from /api/assistant carry the Claude API's own
 * stream events, then a final event with the complete message (or an error). The live view of
 * the reply being written is built from the events; the final message is what goes into the
 * conversation.
 */
import type Anthropic from '@anthropic-ai/sdk';

export type StreamEvent = Anthropic.Beta.BetaRawMessageStreamEvent;
export type ServerEvent = StreamEvent | { type: 'final'; message: Anthropic.Beta.BetaMessage } | { type: 'error'; message: string; status?: number };

/** Splits buffered SSE text into the complete events' data and the unfinished remainder. */
export function parseSse(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf('\n\n');
    if (end < 0) break;
    const lines = rest.slice(0, end).split('\n');
    rest = rest.slice(end + 2);
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (data.length) events.push(data.join('\n'));
  }
  return { events, rest };
}

/** A content block of the reply as it is being streamed. */
export type LiveBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; json: string }
  | { type: 'other' };

/** The live blocks after one stream event (a new array when anything changed). */
export function applyEvent(blocks: LiveBlock[], event: StreamEvent): LiveBlock[] {
  if (event.type === 'content_block_start') {
    const b = event.content_block;
    const block: LiveBlock =
      b.type === 'text'
        ? { type: 'text', text: b.text }
        : b.type === 'thinking'
          ? { type: 'thinking', thinking: b.thinking }
          : b.type === 'tool_use'
            ? { type: 'tool_use', id: b.id, name: b.name, json: '' }
            : { type: 'other' };
    const next = blocks.slice();
    next[event.index] = block;
    return next;
  }
  if (event.type === 'content_block_delta') {
    const cur = blocks[event.index];
    const d = event.delta;
    let block: LiveBlock | null = null;
    if (cur?.type === 'text' && d.type === 'text_delta') block = { ...cur, text: cur.text + d.text };
    else if (cur?.type === 'thinking' && d.type === 'thinking_delta') block = { ...cur, thinking: cur.thinking + d.thinking };
    else if (cur?.type === 'tool_use' && d.type === 'input_json_delta') block = { ...cur, json: cur.json + d.partial_json };
    if (!block) return blocks;
    const next = blocks.slice();
    next[event.index] = block;
    return next;
  }
  return blocks;
}
