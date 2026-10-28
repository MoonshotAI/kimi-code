import { create } from "zustand";
import { produce } from "immer";
import { bridge } from "@/services";
import { Content } from "@/lib/content";
import { mergePendingDraftMedia } from "@/lib/media-utils";
import { isModelFreeHostCommand, parseHostSlashCommand } from "shared/host-commands";
import { useApprovalStore } from "./approval.store";
import { toast } from "@/components/ui/sonner";

import { resolveSendModel, resolveThinkingEffortForSend, useSettingsStore } from "./settings.store";
import { processEvent } from "./event-handlers";
import type { StatusUpdate, ContentPart, QuestionRequest, ToolResult } from "shared/legacy-sdk";
import type { UIStreamEvent } from "shared/types";

const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface UIToolCall {
  id: string;
  name: string;
  arguments: string | null;
}

export interface UIStep {
  n: number;
  items: UIStepItem[];
  planMode?: boolean;
}

export interface InlineError {
  code: string;
  message: string;
  detail?: string; // 服务器原始错误信息
}

export type UIStepItem =
  | { type: "thinking"; content: string; finished?: boolean }
  | { type: "text"; content: string; finished?: boolean }
  | { type: "compaction" }
  | { type: "steer"; content: string | ContentPart[] }
  | {
      type: "tool_use";
      id: string;
      call: UIToolCall;
      result?: ToolResult["return_value"];
      subagent_steps?: UIStep[];
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string | ContentPart[];
  timestamp: number;
  steps?: UIStep[];
  status?: StatusUpdate;
  inlineError?: InlineError;
  /** False for host-only commands that do not create a forkable core turn. */
  forkable?: boolean;
}

export interface TokenUsage {
  input_other: number;
  output: number;
  input_cache_read: number;
  input_cache_creation: number;
}

function createEmptyTokenUsage(): TokenUsage {
  return { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 };
}

export interface MediaInConversation {
  hasImage: boolean;
  hasVideo: boolean;
}

export interface DraftMediaItem {
  id: string;
  dataUri?: string;
}

export interface PendingInput {
  content: string | ContentPart[];
  model: string;
  /** Present only while the blocked item is still at the head of the queue. */
  queueId?: string;
}

export interface QueuedItem {
  id: string;
  content: string | ContentPart[];
  model: string;
}

export interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  isCompacting: boolean;
  handshakeReceived: boolean;
  draftMedia: DraftMediaItem[];
  lastStatus: StatusUpdate | null;
  tokenUsage: TokenUsage;
  activeTokenUsage: TokenUsage;
  pendingInput: PendingInput | null;
  queue: QueuedItem[];
  pendingQuestion: QuestionRequest | null;
  planMode: boolean;

  sendMessage: (text: string) => void;
  retryLastMessage: () => void;
  processEvent: (event: UIStreamEvent) => void;
  loadSession: (sessionId: string, events: UIStreamEvent[]) => Promise<void>;
  startNewConversation: () => Promise<void>;
  abort: () => void;
  addDraftMedia: (id: string, dataUri?: string) => void;
  updateDraftMedia: (id: string, dataUri: string) => void;
  removeDraftMedia: (id: string) => void;
  clearDraftMedia: () => void;
  getMediaInConversation: () => MediaInConversation;
  hasProcessingMedia: () => boolean;
  rollbackInput: (content: string | ContentPart[]) => void;
  respondQuestion: (answers: Record<string, string>) => Promise<void>;

  enqueue: (content: string | ContentPart[], model: string) => void;
  removeFromQueue: (id: string) => void;
  editQueueItem: (id: string, content: string | ContentPart[]) => void;
  moveQueueItemUp: (id: string) => void;
  sendNextQueued: () => void;
}

let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

function clearHandshakeTimer() {
  if (handshakeTimer) {
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }
}

function clearAllInlineErrors(draft: ChatState): void {
  for (const msg of draft.messages) {
    if (msg.inlineError) {
      msg.inlineError = undefined;
    }
  }
}

function noValidModelMessage(content: string | ContentPart[]): string {
  return Content.hasMedia(content)
    ? "The selected model does not support these attachments. Choose another model before sending."
    : "The selected model is no longer available. Choose another model before sending.";
}

function getSendMediaRequirements(
  state: ChatState,
  content: string | ContentPart[],
): { image: boolean; video: boolean } {
  let { image, video } = Content.getMediaRequirements(content);
  for (const message of state.messages) {
    image ||= Content.hasImages(message.content);
    video ||= Content.hasVideos(message.content);
    if (image && video) break;
  }
  return { image, video };
}

function normalizeSendContent(content: string | ContentPart[]): string | unknown[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "image_url") return { type: "image_url", image_url: { url: part.image_url.url } };
    if (part.type === "video_url") return { type: "video_url", video_url: { url: part.video_url.url } };
    return part;
  });
}

function isSameSendContent(left: string | ContentPart[], right: string | ContentPart[]): boolean {
  return left === right || JSON.stringify(normalizeSendContent(left)) === JSON.stringify(normalizeSendContent(right));
}

function requiresModelForSend(state: ChatState, content: string | ContentPart[]): boolean {
  const command = parseHostSlashCommand(content);
  return state.sessionId === null || command === undefined || !isModelFreeHostCommand(command);
}

function doSend(state: ChatState, content: string | ContentPart[], model: string) {
  const { sessionId, planMode } = state;
  const settings = useSettingsStore.getState();
  const mediaRequirements = getSendMediaRequirements(state, content);
  let sendModelId = model;
  let thinkingEffort = settings.thinkingEffort;
  if (requiresModelForSend(state, content)) {
    const sendModel = resolveSendModel(
      settings.models,
      model,
      settings.defaultModel,
      mediaRequirements,
    );
    if (sendModel === undefined) {
      const message = noValidModelMessage(content);
      toast.error(message);
      useChatStore.getState().processEvent({
        type: "error",
        code: "model.not_configured",
        message,
        phase: "preflight",
      });
      return;
    }
    sendModelId = sendModel.id;
    thinkingEffort = resolveThinkingEffortForSend(
      sendModel,
      settings.thinkingEffort,
      settings.defaultThinking,
      settings.defaultThinkingEffort,
    );
  }
  const pendingQueueId = state.pendingInput?.queueId;
  if (
    pendingQueueId !== undefined
    && state.pendingInput !== null
    && isSameSendContent(state.pendingInput.content, content)
    && state.queue[0]?.id === pendingQueueId
  ) {
    useChatStore.setState({ queue: state.queue.slice(1) });
  }

  clearHandshakeTimer();
  handshakeTimer = setTimeout(() => {
    const s = useChatStore.getState();
    if (s.isStreaming && !s.handshakeReceived) {
      void bridge.abortChat().catch(() => undefined);
      s.processEvent({
        type: "error",
        code: "HANDSHAKE_TIMEOUT",
        message: "Connection timed out.",
        phase: "runtime",
      });
    }
  }, HANDSHAKE_TIMEOUT_MS);

  void bridge
    .streamChat(content, sendModelId, thinkingEffort, planMode, sessionId ?? undefined, mediaRequirements)
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      useChatStore.getState().processEvent({
        type: "error",
        code: "internal",
        message: "Unable to send the message.",
        detail,
        phase: "preflight",
      });
    });
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessionId: null,
  messages: [],
  isStreaming: false,
  isCompacting: false,
  handshakeReceived: false,
  draftMedia: [],
  lastStatus: null,
  tokenUsage: createEmptyTokenUsage(),
  activeTokenUsage: createEmptyTokenUsage(),
  pendingInput: null,
  queue: [],
  pendingQuestion: null,
  planMode: false,

  sendMessage: (text) => {
    const { draftMedia, isStreaming, pendingInput: previousPendingInput } = get();
    const { currentModel } = useSettingsStore.getState();

    const readyMedia = draftMedia.filter((m) => m.dataUri).map((m) => ({ id: m.id, dataUri: m.dataUri! }));
    const content = readyMedia.length > 0 ? Content.build(text, readyMedia) : text;
    const pendingQueueId = previousPendingInput && isSameSendContent(previousPendingInput.content, content)
      ? previousPendingInput.queueId
      : undefined;

    if (Content.isEmpty(content)) {
      return;
    }

    // If streaming, enqueue instead of sending
    if (isStreaming) {
      get().enqueue(content, currentModel);
      set({ draftMedia: [] });
      return;
    }

    // Clear draft and set streaming state
    set(
      produce((draft: ChatState) => {
        clearAllInlineErrors(draft);
        draft.draftMedia = [];
        draft.isStreaming = true;
        draft.handshakeReceived = false;
        draft.pendingInput = {
          content,
          model: currentModel,
          ...(pendingQueueId === undefined ? {} : { queueId: pendingQueueId }),
        };
      }),
    );
    useApprovalStore.getState().clearRequests();

    doSend(get(), content, currentModel);
  },

  retryLastMessage: () => {
    const { pendingInput, isStreaming } = get();

    if (isStreaming || !pendingInput) {
      return;
    }

    // Remove failed assistant message and user message
    set(
      produce((draft: ChatState) => {
        clearAllInlineErrors(draft);
        draft.isStreaming = true;
        draft.handshakeReceived = false;
        const lastAssistant = draft.messages.at(-1);
        if (lastAssistant?.role === "assistant" && lastAssistant.inlineError) {
          draft.messages.pop();
          if (draft.messages.at(-1)?.role === "user") {
            draft.messages.pop();
          }
        }
      }),
    );
    useApprovalStore.getState().clearRequests();

    doSend(get(), pendingInput.content, pendingInput.model);
  },

  processEvent: (event) => {
    // Mid-turn warnings (terminal === false) leave the turn, the composer, and
    // the queued messages untouched — the engine is still streaming, so they
    // are surfaced as a transient toast only.
    if (event.type === "error" && "terminal" in event && event.terminal === false) {
      clearHandshakeTimer();
      toast.warning(event.message);
      return;
    }
    // Clear handshake timeout on receiving valid response
    if (event.type === "TurnBegin" || event.type === "StepBegin" || event.type === "ContentPart") {
      clearHandshakeTimer();
      set({ handshakeReceived: true });
    } else if (event.type === "stream_complete" || event.type === "error") {
      clearHandshakeTimer();
    }

    set(
      produce((draft: ChatState) => {
        processEvent(draft, event);
      }),
    );

    // Keep the failed input in pendingInput and the rest in the queue. Every
    // terminal preflight error means the send could not start; advancing now
    // would overwrite the failed prompt, matching the desktop queue behavior.
    if (event.type === "error" && "phase" in event && event.phase === "preflight") {
      return;
    }

    // Auto-send next queued item when streaming ends (complete or error)
    if (event.type === "stream_complete" || event.type === "error") {
      const { queue, isStreaming: stillStreaming } = get();
      if (!stillStreaming && queue.length > 0) {
        setTimeout(() => get().sendNextQueued(), 50);
      }
    }
  },

  loadSession: async (sessionId, events) => {
    clearHandshakeTimer();

    // Abort any ongoing stream when switching sessions
    const { isStreaming: wasStreaming } = get();
    if (wasStreaming) {
      await bridge.abortChat();
    }

    set({
      sessionId,
      messages: [],
      isStreaming: false,
      isCompacting: false,
      handshakeReceived: false,
      draftMedia: [],
      lastStatus: null,
      tokenUsage: createEmptyTokenUsage(),
      activeTokenUsage: createEmptyTokenUsage(),
      pendingInput: null,
      queue: [],
      pendingQuestion: null,
      planMode: false,
    });
    useApprovalStore.getState().clearRequests();

    for (const event of events) {
      get().processEvent(event);
    }

    // All steps are finished when loading from history
    set(
      produce((draft: ChatState) => {
        for (const msg of draft.messages) {
          if (msg.steps) {
            for (const step of msg.steps) {
              for (const item of step.items) {
                if (item.type === "text" || item.type === "thinking") {
                  item.finished = true;
                }
              }
            }
          }
        }
        draft.isStreaming = false;
        draft.isCompacting = false;
        draft.pendingQuestion = null;
      }),
    );
    useApprovalStore.getState().clearRequests();
  },

  startNewConversation: async () => {
    clearHandshakeTimer();

    // Abort any ongoing stream before starting new conversation
    const { isStreaming: wasStreaming } = get();
    if (wasStreaming) {
      await bridge.abortChat();
    }

    await bridge.resetSession();
    await bridge.clearTrackedFiles();
    set({
      sessionId: null,
      messages: [],
      isStreaming: false,
      isCompacting: false,
      handshakeReceived: false,
      draftMedia: [],
      lastStatus: null,
      tokenUsage: createEmptyTokenUsage(),
      activeTokenUsage: createEmptyTokenUsage(),
      pendingInput: null,
      queue: [],
      pendingQuestion: null,
      planMode: false,
    });
    useApprovalStore.getState().clearRequests();
  },

  abort: () => {
    clearHandshakeTimer();
    void bridge.abortChat().catch(() => undefined);
    set({ pendingQuestion: null });
    useApprovalStore.getState().clearRequests();
  },

  addDraftMedia: (id, dataUri) => {
    set((s) => ({ draftMedia: [...s.draftMedia, { id, dataUri }] }));
  },

  updateDraftMedia: (id, dataUri) => {
    set((s) => ({
      draftMedia: s.draftMedia.map((m) => (m.id === id ? { ...m, dataUri } : m)),
    }));
  },

  removeDraftMedia: (id) => {
    set((s) => ({ draftMedia: s.draftMedia.filter((m) => m.id !== id) }));
  },

  clearDraftMedia: () => {
    set({ draftMedia: [] });
  },

  getMediaInConversation: () => {
    const { messages, draftMedia } = get();

    let hasImage = false;
    let hasVideo = false;

    for (const item of draftMedia) {
      if (!item.dataUri) {
        continue;
      }
      if (item.dataUri.startsWith("data:image/")) {
        hasImage = true;
      } else if (item.dataUri.startsWith("data:video/")) {
        hasVideo = true;
      }
    }

    for (const msg of messages) {
      if (Content.hasImages(msg.content)) {
        hasImage = true;
      }
      if (Content.hasVideos(msg.content)) {
        hasVideo = true;
      }
      if (hasImage && hasVideo) {
        break;
      }
    }

    return { hasImage, hasVideo };
  },

  hasProcessingMedia: () => {
    return get().draftMedia.some((m) => !m.dataUri);
  },

  rollbackInput: (content) => {
    const { currentModel } = useSettingsStore.getState();
    set({ pendingInput: { content, model: currentModel } });
  },

  respondQuestion: async (answers) => {
    const { pendingQuestion } = get();
    if (!pendingQuestion) return;
    await bridge.respondQuestion(pendingQuestion.id, pendingQuestion.id, answers);
    set({ pendingQuestion: null });
  },

  enqueue: (content, model) => {
    set((s) => ({
      queue: [...s.queue, { id: crypto.randomUUID(), content, model }],
    }));
  },

  removeFromQueue: (id) => {
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
  },

  editQueueItem: (id, content) => {
    set((s) => ({
      queue: s.queue.map((q) => (q.id === id ? { ...q, content } : q)),
    }));
  },

  moveQueueItemUp: (id) => {
    set((s) => {
      const idx = s.queue.findIndex((q) => q.id === id);
      if (idx <= 0) {
        return s;
      }
      const next = [...s.queue];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return { queue: next };
    });
  },

  sendNextQueued: () => {
    const { queue, isStreaming } = get();
    if (isStreaming || queue.length === 0) {
      return;
    }

    const [next, ...rest] = queue;
    const settings = useSettingsStore.getState();
    if (
      requiresModelForSend(get(), next.content)
      && resolveSendModel(
        settings.models,
        next.model,
        settings.defaultModel,
        getSendMediaRequirements(get(), next.content),
      ) === undefined
    ) {
      toast.error(noValidModelMessage(next.content));
      set((state) => ({
        isStreaming: false,
        pendingInput: { content: next.content, model: next.model, queueId: next.id },
        draftMedia: mergePendingDraftMedia(state.draftMedia, next.content),
      }));
      return;
    }

    set(
      produce((draft: ChatState) => {
        clearAllInlineErrors(draft);
        draft.queue = rest;
        draft.isStreaming = true;
        draft.handshakeReceived = false;
        draft.pendingInput = { content: next.content, model: next.model };
        draft.draftMedia = [];
      }),
    );
    useApprovalStore.getState().clearRequests();

    doSend(get(), next.content, next.model);
  },
}));
