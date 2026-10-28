/*
 * The assistant's conversation and settings. The conversation is kept in the Claude API's own
 * message shape whichever provider answers (it is what gets sent back each round); the panel
 * renders it. Every chat is saved in the browser's database under the project it belongs to,
 * so a reload or a switch to another project and back brings it up where it was, and older
 * chats of a project can be reopened. Settings (provider, models, effort, the user's own API
 * keys) live in this browser's localStorage.
 */
import { create } from 'zustand';
import type Anthropic from '@anthropic-ai/sdk';
import { ASSISTANT_MODELS, DEFAULT_MODEL, EFFORTS, EMPTY_USAGE, KEY_HEADER, PROVIDERS, addUsage, type Effort, type ModelOption, type Provider, type TokenUsage } from '../shared/assistant';
import { runTurn, type Message, type TurnEnd } from '../lib/assistant/loop';
import { sseTransport } from '../lib/assistant/transport';
import { applyEvent, type LiveBlock } from '../lib/assistant/stream';
import { assistantTools, editorState, executeAssistantTool } from '../lib/assistant/tools';
import { systemPrompt } from '../lib/assistant/prompt';
import { dbAll, dbDelete, dbGet, dbPut } from '../lib/db';
import { cancelOffloaded } from '../lib/pcb/offload';
import { newId } from '../lib/schematic/ops';
import { useEditor } from './editor';
import { apiUrl } from '../lib/api';

/** A saved chat: the conversation with what it needs to go on. */
export interface ChatRecord {
  id: string;
  projectId: string;
  /** The first thing the user asked, shortened. */
  title: string;
  provider: Provider;
  model: string;
  messages: Message[];
  usage: TokenUsage;
  createdAt: number;
  updatedAt: number;
}

export type ChatMeta = Omit<ChatRecord, 'messages'>;

const STATE_TAG = '<editor_state>';

/** A chat's title: the user's first words, on one line, cut short. */
export function chatTitle(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : (m.content as { type: string; text?: string }[] | undefined)?.filter((b) => b.type === 'text' && b.text && !b.text.startsWith(STATE_TAG)).map((b) => b.text).join(' ');
    const line = text?.replace(/\s+/g, ' ').trim();
    if (line) return line.length > 60 ? `${line.slice(0, 57)}…` : line;
  }
  return 'New chat';
}

export interface AssistantSettings {
  provider: Provider;
  /** The Claude model. */
  model: string;
  /** The Gemini model, chosen from the live list. */
  geminiModel: string;
  effort: Effort;
  /** The user's own keys; empty to use the server's. */
  apiKey: string;
  geminiKey: string;
}

const SETTINGS_KEY = 'schematics:assistant';
const DEFAULT_SETTINGS: AssistantSettings = { provider: 'anthropic', model: DEFAULT_MODEL, geminiModel: '', effort: 'medium', apiKey: '', geminiKey: '' };

function loadSettings(): AssistantSettings {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const s = JSON.parse(raw) as Partial<AssistantSettings>;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      provider: PROVIDERS.some((p) => p.id === s.provider) ? (s.provider as Provider) : DEFAULT_SETTINGS.provider,
      model: ASSISTANT_MODELS.some((m) => m.id === s.model) ? s.model! : DEFAULT_SETTINGS.model,
      geminiModel: str(s.geminiModel),
      effort: EFFORTS.includes(s.effort as Effort) ? (s.effort as Effort) : DEFAULT_SETTINGS.effort,
      apiKey: str(s.apiKey),
      geminiKey: str(s.geminiKey),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** The user's own key for a provider, if they entered one. */
export const keyFor = (s: AssistantSettings, provider: Provider = s.provider): string => (provider === 'gemini' ? s.geminiKey : s.apiKey);

/** The model the current provider will answer with. */
export const activeModel = (s: AssistantSettings): string => (s.provider === 'gemini' ? s.geminiModel : s.model);

/** A plain sentence for how a turn ended, or null when it simply finished. */
export function noticeFor(end: TurnEnd): string | null {
  switch (end.reason) {
    case 'done':
      return null;
    case 'refusal':
      return `The model declined to continue${end.detail ? `: ${end.detail}` : '.'}`;
    case 'max_tokens':
      return 'The reply hit the output limit. Ask it to continue.';
    case 'max_rounds':
      return `Paused after ${end.rounds} rounds of tool calls. Say "continue" to go on.`;
    case 'stopped':
      return 'Stopped.';
  }
}

/** The text block that opens each user message with the editor's state. */
export const stateBlock = (state: string) => `<editor_state>${state}</editor_state>`;

interface AssistantState {
  messages: Message[];
  /** The reply being streamed, while one is. */
  live: LiveBlock[] | null;
  running: boolean;
  /** Tool calls of the current turn, by tool_use id. */
  toolState: Record<string, 'running' | 'done'>;
  error: string | null;
  notice: string | null;
  usage: TokenUsage;
  settings: AssistantSettings;
  /** Which providers the server has its own key for (null until asked). */
  serverKeys: Record<Provider, boolean> | null;
  /** Gemini models the key can use, once listed. */
  geminiModels: ModelOption[] | null;
  geminiModelsError: string | null;
  /** The chat being shown (null before its first message is sent) and the project it belongs to. */
  chatId: string | null;
  projectId: string | null;
  /** The project's saved chats, newest first. */
  chats: ChatMeta[];
  send: (text: string) => Promise<void>;
  stop: () => void;
  /** Starts a new chat; the one before stays saved. */
  reset: () => void;
  setSettings: (patch: Partial<AssistantSettings>) => void;
  checkServer: () => Promise<void>;
  loadGeminiModels: () => Promise<void>;
  /** Lists a project's chats and shows its latest one. */
  loadChats: (projectId: string) => Promise<void>;
  openChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
}

let abort: AbortController | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

export const useAssistant = create<AssistantState>()((set, get) => {
  /** Writes the current chat to the database (soon; the last write of a burst wins). */
  const persist = (now = false) => {
    clearTimeout(persistTimer);
    const write = async () => {
      const { messages, chatId, projectId, settings, usage, chats } = get();
      if (!chatId || !projectId || messages.length === 0) return;
      const existing = chats.find((c) => c.id === chatId);
      const record: ChatRecord = {
        id: chatId,
        projectId,
        title: chatTitle(messages),
        provider: settings.provider,
        model: activeModel(settings),
        messages,
        usage,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      await dbPut('chats', record);
      const { messages: _m, ...meta } = record;
      set({ chats: [meta, ...get().chats.filter((c) => c.id !== chatId)] });
    };
    if (now) return write().catch(() => undefined);
    // A chat with many board pictures is megabytes; writing it after every tool round adds up.
    persistTimer = setTimeout(() => void write().catch(() => undefined), 2000);
    return undefined;
  };

  return {
    messages: [],
    live: null,
    running: false,
    toolState: {},
    error: null,
    notice: null,
    usage: EMPTY_USAGE,
    settings: loadSettings(),
    serverKeys: null,
    geminiModels: null,
    geminiModelsError: null,
    chatId: null,
    projectId: null,
    chats: [],

    send: async (text) => {
      const content = text.trim();
      if (get().running || !content) return;
      const { settings } = get();
      const model = activeModel(settings);
      if (!model) {
        set({ error: 'Choose a model in the assistant settings first.' });
        return;
      }
      const user: Message = {
        role: 'user',
        content: [
          { type: 'text', text: stateBlock(editorState()) },
          { type: 'text', text: content },
        ],
      };
      const controller = new AbortController();
      abort = controller;
      set({
        messages: [...get().messages, user],
        running: true,
        live: [],
        error: null,
        notice: null,
        toolState: {},
        chatId: get().chatId ?? newId('chat'),
        projectId: get().projectId ?? useEditor.getState().project.id,
      });
      persist();
      const system = systemPrompt();
      const tools = assistantTools();
      try {
        const { end } = await runTurn({
          messages: get().messages,
          request: (messages) => ({ provider: settings.provider, model, effort: settings.effort, system, messages, tools }),
          transport: sseTransport(keyFor(settings) || null),
          execute: executeAssistantTool,
          signal: controller.signal,
          onEvent: (e) => set({ live: applyEvent(get().live ?? [], e) }),
          onMessages: (messages) => {
            set({ messages, live: [] });
            persist();
          },
          onResponse: (m: Anthropic.Beta.BetaMessage) => set({ usage: addUsage(get().usage, m.usage) }),
          onTool: (id, state) => set({ toolState: { ...get().toolState, [id]: state } }),
        });
        set({ notice: noticeFor(end) });
      } catch (err) {
        if (controller.signal.aborted) set({ notice: 'Stopped.' });
        else set({ error: (err as Error).message });
      } finally {
        set({ running: false, live: null });
        if (abort === controller) abort = null;
        void persist(true);
      }
    },

    stop: () => {
      abort?.abort();
      // A route or check running in the PCB worker is thrown away too.
      cancelOffloaded('Stopped by the user');
    },

    reset: () => {
      abort?.abort();
      clearTimeout(persistTimer);
      set({ messages: [], live: null, toolState: {}, error: null, notice: null, usage: EMPTY_USAGE, chatId: null });
    },

    setSettings: (patch) => {
      const settings = { ...get().settings, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        /* private mode or storage full: the settings last for this page only */
      }
      // A conversation carries one provider's thinking and signatures, so another starts afresh.
      if (patch.provider && patch.provider !== get().settings.provider && get().messages.length) get().reset();
      if (patch.geminiKey !== undefined && patch.geminiKey !== get().settings.geminiKey) set({ geminiModels: null, geminiModelsError: null });
      set({ settings });
    },

    loadChats: async (projectId) => {
      if (get().projectId === projectId) return;
      // A turn still running belongs to the project before; what it had so far stays saved.
      abort?.abort();
      await persist(true);
      set({ projectId, chats: [], messages: [], live: null, toolState: {}, error: null, notice: null, usage: EMPTY_USAGE, chatId: null });
      let chats: ChatMeta[] = [];
      try {
        const records = await dbAll<ChatRecord>('chats', 'projectId', projectId);
        chats = records.map(({ messages: _m, ...meta }) => meta).sort((a, b) => b.updatedAt - a.updatedAt);
      } catch {
        /* no database: chats last for this page only */
      }
      if (get().projectId !== projectId) return;
      set({ chats });
      if (chats[0]) await get().openChat(chats[0].id);
    },

    openChat: async (id) => {
      if (get().running) get().stop();
      await persist(true);
      const record = await dbGet<ChatRecord>('chats', id).catch(() => undefined);
      if (!record) return;
      // The chat goes on with the provider (and model) that answered it, so its thinking and signatures stay valid.
      const { settings } = get();
      if (record.provider !== settings.provider) get().setSettings({ provider: record.provider });
      if (record.provider === 'gemini' && record.model !== settings.geminiModel) get().setSettings({ geminiModel: record.model });
      else if (record.provider === 'anthropic' && record.model !== settings.model && ASSISTANT_MODELS.some((m) => m.id === record.model)) get().setSettings({ model: record.model });
      set({ chatId: record.id, projectId: record.projectId, messages: record.messages, usage: record.usage, live: null, toolState: {}, error: null, notice: null });
    },

    checkServer: async () => {
      try {
        const res = await fetch(apiUrl('/api/assistant/status'));
        const body = (await res.json()) as { server_keys?: Partial<Record<Provider, boolean>> };
        set({ serverKeys: { anthropic: Boolean(body.server_keys?.anthropic), gemini: Boolean(body.server_keys?.gemini) } });
      } catch {
        set({ serverKeys: { anthropic: false, gemini: false } });
      }
    },

    loadGeminiModels: async () => {
      const key = get().settings.geminiKey;
      try {
        const res = await fetch(apiUrl('/api/assistant/models'), { headers: key ? { [KEY_HEADER]: key } : {} });
        const body = (await res.json()) as { models?: ModelOption[]; error?: string };
        if (!res.ok || !body.models) throw new Error(body.error ?? `Request failed (${res.status})`);
        const models = body.models;
        set({ geminiModels: models, geminiModelsError: null });
        // Keep the chosen model when the list still has it; otherwise take the best one.
        const { settings } = get();
        if (!models.some((m) => m.id === settings.geminiModel) && models.length) get().setSettings({ geminiModel: models[0].id });
      } catch (err) {
        set({ geminiModels: null, geminiModelsError: (err as Error).message });
      }
    },

    deleteChat: async (id) => {
      await dbDelete('chats', id).catch(() => undefined);
      set({ chats: get().chats.filter((c) => c.id !== id) });
      if (get().chatId === id) get().reset();
    },
  };
});

// Chats follow the project: when another one opens, its latest chat comes up.
useEditor.subscribe((state, prev) => {
  if (!state.booted) return;
  if (state.project.id !== prev.project.id || !prev.booted) void useAssistant.getState().loadChats(state.project.id);
});

