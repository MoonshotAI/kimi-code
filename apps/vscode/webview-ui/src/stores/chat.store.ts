import { create } from "zustand";
import { produce } from "immer";
import { bridge } from "@/services";
import { Content } from "@/lib/content";
import { generateId } from "@/lib/id";
import { useSettingsStore } from "./settings.store";
import { processEvent } from "./event-handlers";
import { reduceUIStreamEventToDisplay, userInputParts } from "./display-event-adapter";
import { runDisplayEffects } from "./display-effects";
import { createInitialDisplayState, finalizeDisplayStateForHistory, type DisplayPart, type DisplayState } from "@moonshot-ai/kimi-code-vscode-display-model";
import type { ContentPart, PlanEntry, ApprovalResult } from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";
import { cleanSystemTags } from "shared/utils";
import type { UIStreamEvent, InlineError, PendingInput } from "shared/types";

const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface UIToolCall {
  id: string;
  name: string;
  arguments: string | null;
}

export interface UIStep {
  n: number;
  items: UIStepItem[];
}

export type UIStepItem =
  | { type: "thinking"; content: string; finished?: boolean }
  | { type: "text"; content: string; finished?: boolean }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "compaction" }
  | {
      type: "tool_use";
      id: string;
      call: UIToolCall;
      result?: import("@moonshot-ai/kimi-code-vscode-agent-sdk/schema").ToolResult["return_value"];
      subagent_steps?: UIStep[];
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string | ContentPart[];
  timestamp: number;
  steps?: UIStep[];
  inlineError?: InlineError;
}

export interface DraftMediaItem {
  id: string;
  dataUri?: string;
}

export interface QueuedInputItem {
  id: string;
  text: string;
  createdAt: number;
  /** Optional media data URIs attached to this queued message. */
  media?: string[];
}

export type QueuedInputMoveDirection = "up" | "down";

interface PendingOptimisticTurn {
  id: string;
  content: string | ContentPart[];
  createdAt: number;
}

function createQueuedInput(text: string, media?: string[]): QueuedInputItem {
  return {
    id: generateId(),
    text: text.trim(),
    createdAt: Date.now(),
    media,
  };
}

function hasQueuedInputContent(content: string | ContentPart[]): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  return content.length > 0;
}

function removeQueuedInputsById(queuedInputs: QueuedInputItem[], ids: Set<string>): QueuedInputItem[] {
  return queuedInputs.filter((item) => !ids.has(item.id));
}

export interface ChatState {
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  isCompacting: boolean;
  handshakeReceived: boolean;
  draftMedia: DraftMediaItem[];
  pendingInput: PendingInput | null;
  /** Messages typed while a run is in progress. They auto-send FIFO when the run completes. */
  queuedInputs: QueuedInputItem[];
  /** Pure shared display-model projection used for cross-client reducer migration. */
  displayState: DisplayState;
  /** Local user/assistant placeholders waiting for the matching synthetic TurnBegin. */
  pendingOptimisticTurn: PendingOptimisticTurn | null;

  sendMessage: (text: string, media?: string[]) => void;
  clearQueuedInputs: () => void;
  respondApproval: (requestId: string | number, response: ApprovalResult) => Promise<void>;
  updateQueuedInput: (id: string, text: string) => void;
  removeQueuedInput: (id: string) => void;
  moveQueuedInput: (id: string, direction: QueuedInputMoveDirection) => void;
  /** Interrupt the current turn and send one queued message immediately. */
  steerQueuedInput: (id?: string) => void;
  /**
   * Interrupt the current turn and send every queued message as one follow-up.
   * When `currentText` is provided it is appended after the queued messages,
   * matching Kimi Code's Ctrl/Cmd+S queue-steer behavior.
   */
  steerAllQueuedInputs: (currentText?: string) => void;
  retryLastMessage: () => void;
  processEvent: (event: UIStreamEvent) => void;
  loadSession: (sessionId: string, events: UIStreamEvent[]) => void;
  startNewConversation: () => Promise<void>;
  abort: () => void;
  addDraftMedia: (id: string, dataUri?: string) => void;
  updateDraftMedia: (id: string, dataUri: string) => void;
  removeDraftMedia: (id: string) => void;
  clearDraftMedia: () => void;
  hasProcessingMedia: () => boolean;
  rollbackInput: (content: string | ContentPart[]) => void;
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

function finishDisplayParts(parts: DisplayPart[]): void {
  for (const part of parts) {
    if ((part.type === "text" || part.type === "thinking") && !part.finished) {
      part.finished = true;
    }

    if (part.type === "tool-call" && part.children) {
      for (const child of part.children) {
        finishDisplayParts(child.parts);
      }
    }
  }
}

function cleanOptimisticContent(content: string | ContentPart[]): string | ContentPart[] {
  if (typeof content === "string") {
    return cleanSystemTags(content);
  }

  return content
    .map((part) => {
      if (part.type !== "text") {
        return part;
      }

      const text = cleanSystemTags(part.text);
      return text ? { ...part, text } : null;
    })
    .filter((part): part is ContentPart => part !== null);
}

function optimisticTurnKey(content: string | ContentPart[]): string {
  return JSON.stringify(content);
}

function beginOptimisticTurn(draft: ChatState, content: string | ContentPart[], model: string, mode: PendingInput["mode"]): void {
  const timestamp = Date.now();
  const cleanedContent = cleanOptimisticContent(content);

  clearAllInlineErrors(draft);
  draft.draftMedia = [];
  draft.isStreaming = true;
  draft.handshakeReceived = false;
  draft.pendingInput = { content, model, mode };
  draft.pendingOptimisticTurn = {
    id: generateId(),
    content,
    createdAt: timestamp,
  };
  draft.messages.push({
    id: generateId(),
    role: "user",
    content: cleanedContent,
    timestamp,
  });
  draft.messages.push({
    id: generateId(),
    role: "assistant",
    content: "",
    timestamp,
    steps: [],
  });
  draft.displayState.messages.push({
    id: generateId(),
    role: "user",
    parts: userInputParts(cleanedContent),
    status: "completed",
    createdAt: timestamp,
  });
  draft.displayState.messages.push({
    id: generateId(),
    role: "assistant",
    parts: [],
    steps: [],
    status: "streaming",
    createdAt: timestamp,
  });
  draft.displayState.isStreaming = true;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessionId: null,
  messages: [],
  isStreaming: false,
  isCompacting: false,
  handshakeReceived: false,
  draftMedia: [],
  pendingInput: null,
  queuedInputs: [],
  displayState: createInitialDisplayState(),
  pendingOptimisticTurn: null,

  clearQueuedInputs: () => set({ queuedInputs: [] }),
  respondApproval: async (requestId, response) => {
    await bridge.respondApproval(requestId, response);
    set(
      produce((draft: ChatState) => {
        draft.displayState.pendingApprovals = draft.displayState.pendingApprovals.filter((request) => request.requestId !== requestId);
      }),
    );
  },

  updateQueuedInput: (id, text) => {
    const trimmed = text.trim();
    if (!trimmed) {
      get().removeQueuedInput(id);
      return;
    }

    set((s) => ({
      queuedInputs: s.queuedInputs.map((item) => (item.id === id ? { ...item, text: trimmed } : item)),
    }));
  },

  removeQueuedInput: (id) => {
    set((s) => ({ queuedInputs: s.queuedInputs.filter((item) => item.id !== id) }));
  },

  moveQueuedInput: (id, direction) => {
    set((s) => {
      const index = s.queuedInputs.findIndex((item) => item.id === id);
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (index === -1 || targetIndex < 0 || targetIndex >= s.queuedInputs.length) {
        return {};
      }

      const queuedInputs = [...s.queuedInputs];
      const [item] = queuedInputs.splice(index, 1);
      queuedInputs.splice(targetIndex, 0, item);
      return { queuedInputs };
    });
  },

  steerQueuedInput: (id) => {
    const { isStreaming, queuedInputs } = get();
    if (!isStreaming || queuedInputs.length === 0) {
      return;
    }

    const item = id ? queuedInputs.find((candidate) => candidate.id === id) : queuedInputs[0];
    if (!item || !hasQueuedInputContent(item.text)) {
      return;
    }

    bridge
      .steerChat(item.media && item.media.length > 0 ? Content.build(item.text, item.media) : item.text)
      .then((result) => {
        if (result.ok) {
          get().removeQueuedInput(item.id);
        }
      })
      .catch(() => undefined);
  },

  steerAllQueuedInputs: (currentText) => {
    const { isStreaming, queuedInputs } = get();
    if (!isStreaming) {
      return;
    }

    const queuedIds = new Set(queuedInputs.map((item) => item.id));
    const parts = queuedInputs.map((item) => item.text.trim()).filter(Boolean);
    const allMedia = queuedInputs.flatMap((item) => item.media ?? []);
    const trimmedCurrentText = currentText?.trim() ?? "";
    if (trimmedCurrentText) {
      parts.push(trimmedCurrentText);
    }

    if (parts.length === 0 && allMedia.length === 0) {
      return;
    }

    const content = allMedia.length > 0 ? Content.build(parts.join("\n\n") || " ", allMedia) : parts.join("\n\n");

    bridge
      .steerChat(content)
      .then((result) => {
        if (result.ok) {
          set((s) => ({ queuedInputs: removeQueuedInputsById(s.queuedInputs, queuedIds) }));
        }
      })
      .catch(() => undefined);
  },

  sendMessage: (text, media) => {
    const { draftMedia, sessionId, isStreaming } = get();
    const { currentModel, thinkingEnabled, mode } = useSettingsStore.getState();

    // While a run is in progress, queue the text. Queued messages auto-send FIFO
    // when the current run completes; Ctrl/Cmd+S can steer them immediately.
    if (isStreaming) {
      const queuedText = text.trim();
      const readyMedia = draftMedia.filter((m) => m.dataUri).map((m) => m.dataUri!);
      if (queuedText || readyMedia.length > 0) {
        set((s) => ({
          queuedInputs: [...s.queuedInputs, createQueuedInput(queuedText, readyMedia.length > 0 ? readyMedia : undefined)],
          draftMedia: [],
        }));
      }
      return;
    }

    const readyMedia = media && media.length > 0 ? media : draftMedia.filter((m) => m.dataUri).map((m) => m.dataUri!);
    const content = readyMedia.length > 0 ? Content.build(text, readyMedia) : text;

    if (Content.isEmpty(content)) {
      return;
    }

    set(
      produce((draft: ChatState) => {
        beginOptimisticTurn(draft, content, currentModel, mode);
      }),
    );

    // Set handshake timeout
    clearHandshakeTimer();
    handshakeTimer = setTimeout(() => {
      const state = get();
      if (state.isStreaming && !state.handshakeReceived) {
        bridge.abortChat();
        get().processEvent({
          type: "error",
          code: "HANDSHAKE_TIMEOUT",
          message: "Connection timed out.",
          phase: "runtime",
        });
      }
    }, HANDSHAKE_TIMEOUT_MS);

    bridge.streamChat(content, currentModel, thinkingEnabled, mode, sessionId ?? undefined).catch((err) => {
      clearHandshakeTimer();
      get().processEvent({
        type: "error",
        code: "BRIDGE_ERROR",
        message: err instanceof Error ? err.message : String(err),
        phase: "runtime",
      });
    });
  },

  retryLastMessage: () => {
    const { pendingInput, isStreaming, sessionId } = get();
    const { thinkingEnabled } = useSettingsStore.getState();

    if (isStreaming || !pendingInput) {
      return;
    }

    set(
      produce((draft: ChatState) => {
        const lastAssistant = draft.messages.at(-1);
        if (lastAssistant?.role === "assistant" && lastAssistant.inlineError) {
          draft.messages.pop();
          if (draft.messages.at(-1)?.role === "user") {
            draft.messages.pop();
          }
        }
        beginOptimisticTurn(draft, pendingInput.content, pendingInput.model, pendingInput.mode);
      }),
    );

    // Set handshake timeout
    clearHandshakeTimer();
    handshakeTimer = setTimeout(() => {
      const state = get();
      if (state.isStreaming && !state.handshakeReceived) {
        bridge.abortChat();
        get().processEvent({
          type: "error",
          code: "HANDSHAKE_TIMEOUT",
          message: "Connection timed out.",
          phase: "runtime",
        });
      }
    }, HANDSHAKE_TIMEOUT_MS);

    bridge.streamChat(pendingInput.content, pendingInput.model, thinkingEnabled, pendingInput.mode, sessionId ?? undefined).catch((err) => {
      clearHandshakeTimer();
      get().processEvent({
        type: "error",
        code: "BRIDGE_ERROR",
        message: err instanceof Error ? err.message : String(err),
        phase: "runtime",
      });
    });
  },

  processEvent: (event) => {
    const pendingOptimisticTurn = get().pendingOptimisticTurn;
    if (event.type === "TurnBegin" && pendingOptimisticTurn && optimisticTurnKey(event.payload.user_input) === optimisticTurnKey(pendingOptimisticTurn.content)) {
      clearHandshakeTimer();
      set({ pendingOptimisticTurn: null, handshakeReceived: true, isStreaming: true });
      return;
    }

    // Clear handshake timeout on receiving valid response
    if (event.type === "TurnBegin" || event.type === "StepBegin" || event.type === "ContentPart") {
      clearHandshakeTimer();
      set({ handshakeReceived: true });
    }

    if (event.type === "ConversationReset") {
      clearHandshakeTimer();
    }

    const sharedDisplayReduction = reduceUIStreamEventToDisplay(get().displayState, event);
    set(
      produce((draft: ChatState) => {
        processEvent(draft, event);
        draft.displayState = sharedDisplayReduction.state;
      }),
    );
    runDisplayEffects(sharedDisplayReduction.effects);

    // The run just ended: if the user queued follow-ups while it was streaming,
    // auto-send the next FIFO item now. Only trigger on explicit terminal events
    // to avoid re-entry from late errors or race conditions.
    if (event.type === "stream_complete" || event.type === "error" || event.type === "StepInterrupted") {
      const after = get();
      // sendMessage synchronously flips isStreaming back to true, so this branch
      // cannot re-enter for the same queued item even if a late event fires.
      if (!after.isStreaming && after.queuedInputs.length > 0) {
        const [next, ...rest] = after.queuedInputs;
        set({ queuedInputs: rest });
        after.sendMessage(next.text, next.media);
      }
    }
  },

  loadSession: (sessionId, events) => {
    clearHandshakeTimer();
    set({
      sessionId,
      messages: [],
      isStreaming: false,
      isCompacting: false,
      handshakeReceived: false,
      draftMedia: [],
      pendingInput: null,
      queuedInputs: [],
      displayState: createInitialDisplayState(),
      pendingOptimisticTurn: null,
    });
    bridge.clearTrackedFiles();

    for (const event of events) {
      get().processEvent(event);
    }

    const finalDisplayState = finalizeDisplayStateForHistory(get().displayState);

    // All steps are finished when loading from history
    set(
      produce((draft: ChatState) => {
        draft.displayState = finalDisplayState;

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
      }),
    );
    useSettingsStore.getState().resetYoloMode();
  },

  startNewConversation: async () => {
    clearHandshakeTimer();
    set({
      sessionId: null,
      messages: [],
      isStreaming: false,
      isCompacting: false,
      handshakeReceived: false,
      draftMedia: [],
      pendingInput: null,
      queuedInputs: [],
      displayState: createInitialDisplayState(),
      pendingOptimisticTurn: null,
    });
    useSettingsStore.getState().resetYoloMode();

    bridge.clearTrackedFiles().catch((err) => {
      console.warn("[chat] Failed to clear tracked files:", err);
    });
    bridge.resetSession().catch((err) => {
      console.warn("[chat] Failed to reset session:", err);
    });
  },

  abort: () => {
    clearHandshakeTimer();
    bridge.abortChat();
    // Aborting cancels any queued type-ahead messages too.
    set({ queuedInputs: [], pendingOptimisticTurn: null });
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

  hasProcessingMedia: () => {
    return get().draftMedia.some((m) => !m.dataUri);
  },

  rollbackInput: (content) => {
    const { currentModel, mode } = useSettingsStore.getState();
    set({ pendingInput: { content, model: currentModel, mode } });
  },
}));
