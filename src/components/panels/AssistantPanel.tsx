/*
 * The Assistant tab: a chat with the design assistant. User messages, the assistant's replies
 * (Markdown), its thinking summaries and every tool call with its result, streamed as they
 * happen; settings for the API key, model and effort; and the token count and cost so far.
 */
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronRight, CircleAlert, History, Loader2, Plus, Send, Settings2, Sparkles, Square, Trash2, Wrench } from 'lucide-react';
import type Anthropic from '@anthropic-ai/sdk';
import { activeModel, keyFor, useAssistant } from '../../store/assistant';
import { ASSISTANT_MODELS, EFFORTS, PROVIDERS, estimateCost, modelById, providerById, type Provider } from '../../shared/assistant';
import type { LiveBlock } from '../../lib/assistant/stream';
import type { Message } from '../../lib/assistant/loop';
import { Markdown } from '../Markdown';
import { ago } from '../StartScreen';
import { Field, IconButton, cx, inputClass } from '../ui';

type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type ContentParam = Anthropic.Beta.BetaContentBlockParam;
type Content = Message['content'];

/** What the panel draws for one content block, whether final or still streaming. */
type DisplayBlock = { type: 'text'; text: string } | { type: 'thinking'; thinking: string } | { type: 'tool_use'; id: string; name: string; inputText: string };

const STARTERS = [
  'Design a USB-C powered board with a 3.3 V regulator and a status LED',
  'Add decoupling capacitors to every IC in the schematic',
  'Check the design and explain any problems in plain words',
  'Make the PCB: place the parts, pour ground, route it and run the checks',
];

const STATE_PREFIX = '<editor_state>';

function displayBlocks(content: Content): DisplayBlock[] {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out: DisplayBlock[] = [];
  for (const b of content as ContentParam[]) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking') out.push({ type: 'thinking', thinking: b.thinking });
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, inputText: JSON.stringify(b.input) });
  }
  return out;
}

function liveBlocks(live: LiveBlock[]): DisplayBlock[] {
  const out: DisplayBlock[] = [];
  for (const b of live) {
    if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, inputText: b.json });
    else if (b.type !== 'other') out.push(b);
  }
  return out;
}

/** The user's own words of a user message (the editor state block is left out). */
function userText(content: Content): string | null {
  if (!content) return null;
  if (typeof content === 'string') return content;
  const texts = (content as ContentParam[]).filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === 'text' && !b.text.startsWith(STATE_PREFIX));
  return texts.length ? texts.map((b) => b.text).join('\n') : null;
}

/** Every tool result in the conversation, by the call it answers. */
function toolResults(messages: Message[]): Map<string, ToolResult> {
  const map = new Map<string, ToolResult>();
  for (const m of messages) {
    if (m.role !== 'user' || !m.content || typeof m.content === 'string') continue;
    for (const b of m.content as ContentParam[]) if (b.type === 'tool_result') map.set(b.tool_use_id, b);
  }
  return map;
}

const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

export function AssistantPanel() {
  const messages = useAssistant((s) => s.messages);
  const live = useAssistant((s) => s.live);
  const running = useAssistant((s) => s.running);
  const error = useAssistant((s) => s.error);
  const notice = useAssistant((s) => s.notice);
  const usage = useAssistant((s) => s.usage);
  const settings = useAssistant((s) => s.settings);
  const serverKeys = useAssistant((s) => s.serverKeys);
  const geminiModels = useAssistant((s) => s.geminiModels);
  const toolState = useAssistant((s) => s.toolState);
  const chats = useAssistant((s) => s.chats);
  const { send, stop, reset, checkServer } = useAssistant.getState();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (serverKeys === null) void checkServer();
  }, [serverKeys, checkServer]);

  // Follow the reply as it grows unless the user scrolled up to read something.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, live, error, notice]);

  const needsKey = serverKeys !== null && !serverKeys[settings.provider] && !keyFor(settings);
  // Gemini also needs a model picked from the live list.
  const needsSetup = needsKey || !activeModel(settings);
  const results = useMemo(() => toolResults(messages), [messages]);
  const modelLabel = settings.provider === 'gemini' ? (geminiModels?.find((m) => m.id === settings.geminiModel)?.label ?? settings.geminiModel) : modelById(settings.model)?.label;
  const cost = estimateCost(usage, activeModel(settings));
  const totalIn = usage.input + usage.cacheRead + usage.cacheWrite;

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
        <span className="font-semibold">Assistant</span>
        <span className="truncate text-[11px] text-muted">{modelLabel}</span>
        <div className="ml-auto flex items-center">
          <IconButton label="Assistant settings" active={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)} className="h-7 w-7">
            <Settings2 className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label={`Earlier chats about this project (${chats.length})`} active={historyOpen} disabled={chats.length === 0} onClick={() => setHistoryOpen(!historyOpen)} className="h-7 w-7">
            <History className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="New chat (this one stays in the history)" disabled={messages.length === 0} onClick={reset} className="h-7 w-7">
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      {(settingsOpen || needsSetup) && <Settings />}
      {historyOpen && chats.length > 0 && <ChatHistory onPick={() => setHistoryOpen(false)} />}

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3"
      >
        {messages.length === 0 && !live && <Starters disabled={needsSetup} onPick={(t) => void send(t)} />}
        {messages.map((m, i) => (
          <MessageView key={i} message={m} results={results} toolState={toolState} />
        ))}
        {live && <AssistantBlocks blocks={liveBlocks(live)} results={results} toolState={toolState} streaming />}
        {running && (!live || live.length === 0) && (
          <div className="flex items-center gap-1.5 text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
          </div>
        )}
        {error && (
          <div className="flex items-start gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/8 px-2 py-1.5 text-rose-600 dark:text-rose-300">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {notice && <div className="text-[11px] italic text-muted">{notice}</div>}
      </div>

      <Composer disabled={needsSetup} running={running} onSend={(t) => void send(t)} onStop={stop} />
      {usage.output > 0 && (
        <div className="border-t border-line px-3 py-1 text-[10px] text-muted">
          {fmtTokens(totalIn)} tokens in · {fmtTokens(usage.output)} out{cost !== null && ` · about $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`}
          {usage.cacheRead > 0 && ` · ${Math.round((usage.cacheRead / totalIn) * 100)}% from cache`}
        </div>
      )}
    </div>
  );
}

function Settings() {
  const settings = useAssistant((s) => s.settings);
  const setSettings = useAssistant((s) => s.setSettings);
  const serverKeys = useAssistant((s) => s.serverKeys);
  const geminiModels = useAssistant((s) => s.geminiModels);
  const geminiModelsError = useAssistant((s) => s.geminiModelsError);
  const loadGeminiModels = useAssistant((s) => s.loadGeminiModels);
  const provider = providerById(settings.provider)!;
  const gemini = settings.provider === 'gemini';
  const serverHasKey = serverKeys?.[settings.provider] ?? false;
  const key = keyFor(settings);
  const canList = gemini && (Boolean(key) || serverHasKey);

  // List Gemini's models once a key is there, after the user stops typing it.
  useEffect(() => {
    if (!canList || geminiModels) return;
    const timer = setTimeout(() => void loadGeminiModels(), key ? 600 : 0);
    return () => clearTimeout(timer);
  }, [canList, key, geminiModels, loadGeminiModels]);

  return (
    <div className="space-y-2 border-b border-line bg-panel-2 px-3 py-2">
      <Field label="Provider">
        <select value={settings.provider} onChange={(e) => setSettings({ provider: e.target.value as Provider })} className={inputClass}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="API key">
        <input
          type="password"
          value={key}
          onChange={(e) => setSettings(gemini ? { geminiKey: e.target.value.trim() } : { apiKey: e.target.value.trim() })}
          placeholder={serverHasKey ? 'Using the server’s key' : provider.keyHint}
          autoComplete="off"
          spellCheck={false}
          className={cx(inputClass, 'font-mono')}
        />
      </Field>
      <p className="text-[11px] leading-relaxed text-muted">
        {serverHasKey
          ? 'The server has its own key; a key entered here is used instead. '
          : 'Kept only in this browser and sent to the app’s own server, which calls the API with it. '}
        Keys come from{' '}
        <a href={provider.console} target="_blank" rel="noreferrer" className="underline">
          {new URL(provider.console).host}
        </a>
        . Changing the provider starts a new chat.
      </p>
      <Field label="Model">
        {gemini ? (
          <select value={settings.geminiModel} onChange={(e) => setSettings({ geminiModel: e.target.value })} disabled={!geminiModels?.length} className={inputClass}>
            {geminiModels?.length ? (
              geminiModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))
            ) : (
              <option value="">{!canList ? 'Enter a key to list the models' : geminiModelsError ? 'Could not list the models' : 'Listing models…'}</option>
            )}
          </select>
        ) : (
          <select value={settings.model} onChange={(e) => setSettings({ model: e.target.value })} className={inputClass}>
            {ASSISTANT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {gemini && geminiModelsError && (
        <p className="text-[11px] text-rose-600 dark:text-rose-300">
          {geminiModelsError}{' '}
          <button onClick={() => void loadGeminiModels()} className="underline">
            Try again
          </button>
        </p>
      )}
      <Field label="Effort">
        <select value={settings.effort} onChange={(e) => setSettings({ effort: e.target.value as (typeof EFFORTS)[number] })} className={inputClass}>
          {EFFORTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[11px] text-muted">
        {gemini ? 'Models come from Google’s own list; the Pro ones cope best with long chains of tool calls' : modelById(settings.model)?.note}. Higher effort thinks longer and costs more.
      </p>
    </div>
  );
}

/** The project's saved chats, newest first; the open one is marked. */
function ChatHistory({ onPick }: { onPick: () => void }) {
  const chats = useAssistant((s) => s.chats);
  const chatId = useAssistant((s) => s.chatId);
  const { openChat, deleteChat } = useAssistant.getState();
  return (
    <ul className="max-h-56 overflow-auto border-b border-line bg-panel-2 py-1" aria-label="Earlier chats">
      {chats.map((c) => (
        <li key={c.id} className={cx('group flex items-center gap-1 px-2', c.id === chatId && 'bg-indigo-500/10')}>
          <button
            onClick={() => {
              void openChat(c.id);
              onPick();
            }}
            className="min-w-0 flex-1 py-1 text-left"
          >
            <div className="truncate">{c.title}</div>
            <div className="text-[10px] text-muted">
              {ago(c.updatedAt)} · {c.provider === 'gemini' ? c.model : (modelById(c.model)?.label ?? c.model)}
            </div>
          </button>
          <IconButton label="Delete this chat" onClick={() => void deleteChat(c.id)} className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100">
            <Trash2 className="h-3 w-3" />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

function Starters({ disabled, onPick }: { disabled: boolean; onPick: (text: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="leading-relaxed text-muted">
        Describe a board and the assistant designs it with real JLCPCB parts, or ask it to change or check what is on the canvas. Every change it makes is an undo step.
      </p>
      <div className="space-y-1.5">
        {STARTERS.map((t) => (
          <button
            key={t}
            disabled={disabled}
            onClick={() => onPick(t)}
            className="block w-full rounded-md border border-line px-2.5 py-1.5 text-left leading-snug hover:border-indigo-500/50 hover:bg-indigo-500/5 disabled:opacity-50"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One message of the conversation. Memoised, so the stream of deltas while a reply is written
 * re-renders only the live blocks, not every earlier message's Markdown and pictures (a long
 * chat about a board carries dozens of them).
 */
const MessageView = memo(function MessageView({ message, results, toolState }: { message: Message; results: Map<string, ToolResult>; toolState: Record<string, 'running' | 'done'> }) {
  if (message.role === 'user') {
    const text = userText(message.content);
    return text === null ? null : <UserBubble text={text} />;
  }
  return <AssistantBlocks blocks={displayBlocks(message.content)} results={results} toolState={toolState} />;
});

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[90%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-indigo-600 px-3 py-1.5 leading-relaxed text-white [overflow-wrap:anywhere]">{text}</div>
    </div>
  );
}

function AssistantBlocks({
  blocks,
  results,
  toolState,
  streaming,
}: {
  blocks: DisplayBlock[];
  results: Map<string, ToolResult>;
  toolState: Record<string, 'running' | 'done'>;
  streaming?: boolean;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        const last = streaming && i === blocks.length - 1;
        if (b.type === 'text') return b.text.trim() ? <Markdown key={i} text={b.text} /> : null;
        if (b.type === 'thinking') return <Thinking key={i} text={b.thinking} live={last} />;
        return <ToolCallRow key={b.id} block={b} result={results.get(b.id)} state={last ? 'streaming' : toolState[b.id]} />;
      })}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim() && !live) return null;
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-[var(--text)]">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {live ? <span className="animate-pulse">Thinking…</span> : 'Thought'}
      </button>
      {open && text.trim() && <div className="mt-1 whitespace-pre-wrap border-l-2 border-line pl-2 text-[11px] italic leading-relaxed text-muted">{text}</div>}
    </div>
  );
}

function ToolCallRow({ block, result, state }: { block: Extract<DisplayBlock, { type: 'tool_use' }>; result?: ToolResult; state?: 'running' | 'done' | 'streaming' }) {
  const [open, setOpen] = useState(false);
  const failed = result?.is_error === true;
  const images = Array.isArray(result?.content) ? result.content.filter((c): c is Anthropic.Beta.BetaImageBlockParam => c.type === 'image') : [];
  const resultText = result ? (typeof result.content === 'string' ? result.content : result.content?.filter((c) => c.type === 'text').map((c) => (c as Anthropic.Beta.BetaTextBlockParam).text).join('\n')) : null;
  const summary = block.inputText.length > 72 ? `${block.inputText.slice(0, 72)}…` : block.inputText;
  return (
    <div className="rounded-md border border-line bg-panel-2/60">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-2 py-1 text-left">
        {state === 'running' || state === 'streaming' ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-indigo-500" />
        ) : failed ? (
          <CircleAlert className="h-3 w-3 shrink-0 text-rose-500" />
        ) : result ? (
          <Check className="h-3 w-3 shrink-0 text-emerald-500" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0 text-muted" />
        )}
        <span className="shrink-0 font-mono text-[11px]">{block.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">{summary === '{}' ? '' : summary}</span>
      </button>
      {images.map((img, i) => (
        <img key={i} src={`data:${img.source.type === 'base64' ? img.source.media_type : 'image/png'};base64,${img.source.type === 'base64' ? img.source.data : ''}`} alt={`${block.name} picture`} className="w-full border-t border-line" />
      ))}
      {open && (
        <div className="space-y-1 border-t border-line px-2 py-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Input</div>
          <pre className="max-h-40 overflow-auto font-mono text-[10px] leading-snug">{pretty(block.inputText)}</pre>
          {resultText !== null && resultText !== undefined && (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{failed ? 'Error' : 'Result'}</div>
              <pre className={cx('max-h-56 overflow-auto font-mono text-[10px] leading-snug', failed && 'text-rose-600 dark:text-rose-300')}>{pretty(resultText)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Composer({ disabled, running, onSend, onStop }: { disabled: boolean; running: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  useEffect(resize, [draft]);
  const submit = () => {
    if (running || disabled || !draft.trim()) return;
    onSend(draft);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="border-t border-line p-2">
      <div className="flex items-end gap-1.5">
        <textarea
          ref={box}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          disabled={disabled}
          placeholder={disabled ? 'Finish the settings above to start' : 'Describe what to build or change…'}
          aria-label="Message to the assistant"
          className={cx(inputClass, 'max-h-40 min-h-8 flex-1 resize-none py-1.5 leading-relaxed')}
        />
        {running ? (
          <IconButton label="Stop" onClick={onStop} className="shrink-0 text-rose-500">
            <Square className="h-3.5 w-3.5" />
          </IconButton>
        ) : (
          <IconButton label="Send" shortcut="↵" disabled={disabled || !draft.trim()} onClick={submit} className="shrink-0">
            <Send className="h-4 w-4" />
          </IconButton>
        )}
      </div>
    </div>
  );
}
