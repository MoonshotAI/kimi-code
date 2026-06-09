import { generateId } from "@/lib/id";
import { useSettingsStore } from "./settings.store";
import { isPreflightError, getUserMessage, isUserInterrupt } from "shared/errors";
import { cleanSystemTags } from "shared/utils";
import type { ChatMessage, UIStep, UIStepItem, ChatState } from "./chat.store";
import type {
  ContentPart,
  ToolCall,
  ToolCallPart,
  ToolResult,
  TurnBegin,
  SubagentEvent,
  RunResult,
  Plan,
  ConfigOptionUpdate,
} from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";
import type { UIStreamEvent, StreamError } from "shared/types";

type EventHandler = (draft: ChatState, payload: any) => void;

function cleanTurnBeginInput(input: TurnBegin["user_input"]): TurnBegin["user_input"] | null {
  if (typeof input === "string") {
    const text = cleanSystemTags(input);
    return text || null;
  }

  const parts = input
    .map((part) => {
      if (part.type !== "text") {
        return part;
      }

      const text = cleanSystemTags(part.text);
      return text ? { ...part, text } : null;
    })
    .filter((part): part is ContentPart => part !== null);

  return parts.length > 0 ? parts : null;
}

function getLastAssistant(draft: ChatState): ChatMessage | undefined {
  const last = draft.messages.at(-1);
  return last?.role === "assistant" ? last : undefined;
}

function hasContent(message: ChatMessage): boolean {
  if (typeof message.content === "string" && message.content.trim()) {
    return true;
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    return true;
  }

  return message.steps?.some((s) => s.items.length > 0) ?? false;
}

function findToolUseItem(steps: UIStep[], toolId: string): (UIStepItem & { type: "tool_use" }) | null {
  for (const step of steps) {
    for (const item of step.items) {
      if (item.type === "tool_use") {
        if (item.id === toolId) {
          return item;
        }

        if (item.subagent_steps) {
          const found = findToolUseItem(item.subagent_steps, toolId);

          if (found) {
            return found;
          }
        }
      }
    }
  }

  return null;
}

function resolveSubagentTarget(
  steps: UIStep[],
  payload: SubagentEvent,
): { steps: UIStep[]; event: { type: string; payload: any }; toolItem: UIStepItem & { type: "tool_use" } } | null {
  const { task_tool_call_id, event } = payload;

  // Nested SubagentEvent
  if (event.type === "SubagentEvent") {
    return resolveSubagentTarget(steps, event.payload as SubagentEvent);
  }

  const toolItem = findToolUseItem(steps, task_tool_call_id);

  if (!toolItem) {
    return null;
  }

  if (!toolItem.subagent_steps) {
    toolItem.subagent_steps = [];
  }

  return { steps: toolItem.subagent_steps, event, toolItem };
}

// Mark steps 中的 text/thinking 为 finished
function finishAllTextItems(steps: UIStep[]): void {
  for (const step of steps) {
    for (const item of step.items) {
      if (item.type === "text" || item.type === "thinking") {
        item.finished = true;
      }
      if (item.type === "tool_use" && item.subagent_steps) {
        finishAllTextItems(item.subagent_steps);
      }
    }
  }
}

function applyEventToSteps(steps: UIStep[], event: { type: string; payload: any }, onText?: (text: string) => void): void {
  const currentStep = steps.at(-1);

  const finishTextItems = (type: "text" | "thinking"): void => {
    if (!currentStep) {
      return;
    }
    for (const item of currentStep.items) {
      if (item.type === type) {
        item.finished = true;
      }
    }
  };

  const appendOrCreateText = (content: string): void => {
    if (!currentStep) {
      return;
    }

    // TUI flushes thinking into the transcript before assistant text starts.
    // Mirror that here so the thinking block is not shown as still active
    // once final answer text is streaming.
    finishTextItems("thinking");

    const last = currentStep.items.at(-1);

    if (last?.type === "text" && !last.finished) {
      last.content += content;
    } else {
      currentStep.items.push({ type: "text", content });
    }
  };

  const appendOrCreateThinking = (content: string): void => {
    if (!currentStep) {
      return;
    }

    const last = currentStep.items.at(-1);
    if (last?.type === "thinking" && !last.finished) {
      last.content += content;
      return;
    }

    currentStep.items.push({
      type: "thinking",
      content,
    });
  };

  const findLastToolUse = (): (UIStepItem & { type: "tool_use" }) | null => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const items = steps[i].items;

      for (let j = items.length - 1; j >= 0; j--) {
        if (items[j].type === "tool_use") {
          return items[j] as UIStepItem & { type: "tool_use" };
        }
      }
    }

    return null;
  };

  const updateToolResult = (targetSteps: UIStep[], toolCallId: string, returnValue: ToolResult["return_value"]): boolean => {
    for (const step of targetSteps) {
      for (const item of step.items) {
        if (item.type === "tool_use") {
          if (item.id === toolCallId) {
            item.result = returnValue;
            return true;
          }

          if (item.subagent_steps && updateToolResult(item.subagent_steps, toolCallId, returnValue)) {
            return true;
          }
        }
      }
    }

    return false;
  };

  const updateToolCall = (targetSteps: UIStep[], call: ToolCall): boolean => {
    for (const step of targetSteps) {
      for (const item of step.items) {
        if (item.type === "tool_use") {
          if (item.id === call.id) {
            item.call = {
              id: call.id,
              name: call.function.name,
              arguments: call.function.arguments ?? item.call.arguments ?? null,
            };
            return true;
          }

          if (item.subagent_steps && updateToolCall(item.subagent_steps, call)) {
            return true;
          }
        }
      }
    }

    return false;
  };

  switch (event.type) {
    case "StepBegin":
      finishAllTextItems(steps);
      steps.push({ n: event.payload.n, items: [] });
      break;

    case "ContentPart": {
      const part = event.payload as ContentPart;

      if (part.type === "text" && part.text) {
        appendOrCreateText(part.text);
        onText?.(part.text);
      } else if (part.type === "think" && part.think.trim()) {
        appendOrCreateThinking(part.think);
      }

      break;
    }

    case "ToolCall": {
      if (!currentStep) {
        break;
      }

      const call = event.payload as ToolCall;

      if (updateToolCall(steps, call)) {
        break;
      }

      finishAllTextItems(steps);
      currentStep.items.push({
        type: "tool_use",
        id: call.id,
        call: {
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments ?? null,
        },
      });

      break;
    }

    case "ToolCallPart": {
      const { tool_call_id, arguments_part } = event.payload as ToolCallPart;

      if (!arguments_part) {
        break;
      }

      const tool = tool_call_id ? findToolUseItem(steps, tool_call_id) : findLastToolUse();

      if (tool) {
        tool.call.arguments = (tool.call.arguments || "") + arguments_part;
      }

      break;
    }

    case "ToolResult": {
      const result = event.payload as ToolResult;
      updateToolResult(steps, result.tool_call_id, result.return_value);

      break;
    }

    case "Plan": {
      if (!currentStep) {
        break;
      }

      const plan = event.payload as Plan;
      const lastPlan = currentStep.items.findLast((item): item is UIStepItem & { type: "plan" } => item.type === "plan");

      if (lastPlan) {
        lastPlan.entries = plan.entries;
      } else {
        currentStep.items.push({ type: "plan", entries: plan.entries });
      }

      break;
    }
  }
}

function handlePreflightError(draft: ChatState, code: string, message: string): void {
  draft.pendingOptimisticTurn = null;

  // Pre-flight: 删除未发送成功的消息，恢复输入
  draft.isStreaming = false;
  draft.isCompacting = false;

  // 删除空的 assistant 消息
  const lastAssistant = getLastAssistant(draft);
  if (lastAssistant && !hasContent(lastAssistant)) {
    draft.messages.pop();
  }

  // 删除对应的 user 消息
  const lastUser = draft.messages.at(-1);
  if (lastUser?.role === "user") {
    const userContent = lastUser.content;
    draft.messages.pop();
    // 触发回滚（通过 pendingInput 保存）
    draft.pendingInput = { content: userContent, model: "", mode: useSettingsStore.getState().mode };
  }
}

function handleRuntimeError(draft: ChatState, code: string, message: string): void {
  draft.pendingOptimisticTurn = null;

  // Runtime: 保留现场，添加内嵌错误
  draft.isStreaming = false;
  draft.isCompacting = false;

  const lastAssistant = getLastAssistant(draft);
  if (lastAssistant) {
    // 如果完全没有内容，添加一个空的 step 以便显示错误
    if (!lastAssistant.steps) {
      lastAssistant.steps = [];
    }
    finishAllTextItems(lastAssistant.steps);
    // 设置内嵌错误
    lastAssistant.inlineError = { code, message };
  }
}

const eventHandlers: Record<string, EventHandler> = {
  // UI 事件 (Bridge 层)
  session_start: (draft, payload: { sessionId: string; model?: string }) => {
    if (payload.sessionId) {
      draft.sessionId = payload.sessionId;
    }
  },

  stream_complete: (draft, payload: { result: RunResult }) => {
    draft.isStreaming = false;
    draft.isCompacting = false;
    draft.pendingInput = null;
    draft.pendingOptimisticTurn = null;
    const lastAssistant = getLastAssistant(draft);
    if (lastAssistant?.steps) {
      finishAllTextItems(lastAssistant.steps);
    }
  },

  ConversationReset: (draft) => {
    draft.messages = [];
    draft.isStreaming = false;
    draft.isCompacting = false;
    draft.handshakeReceived = false;
    draft.draftMedia = [];
    draft.pendingInput = null;
    draft.queuedInputs = [];
    draft.pendingOptimisticTurn = null;
  },

  error: (draft, payload: StreamError) => {
    const code = payload.code || "UNKNOWN";
    const message = getUserMessage(code, payload.message);
    const phase = payload.phase || (isPreflightError(code) ? "preflight" : "runtime");

    if (phase === "preflight") {
      handlePreflightError(draft, code, message);
    } else {
      // 用户主动停止不显示错误
      if (isUserInterrupt(code)) {
        draft.isStreaming = false;
        draft.isCompacting = false;
        const lastAssistant = getLastAssistant(draft);
        if (lastAssistant?.steps) {
          finishAllTextItems(lastAssistant.steps);
        }
      } else {
        handleRuntimeError(draft, code, message);
      }
    }
  },

  // Wire 事件
  TurnBegin: (draft, payload: TurnBegin) => {
    const userInput = cleanTurnBeginInput(payload.user_input);
    if (!userInput) {
      return;
    }


    draft.messages.push({
      id: generateId(),
      role: "user",
      content: userInput,
      timestamp: Date.now(),
    });

    draft.messages.push({
      id: generateId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      steps: [],
    });

    draft.isStreaming = true;
  },

  CompactionBegin: (draft) => {
    draft.isCompacting = true;

    const last = getLastAssistant(draft);

    if (last) {
      if (!last.steps) {
        last.steps = [];
      }

      if (last.steps.length === 0) {
        last.steps.push({ n: 0, items: [] });
      }

      finishAllTextItems(last.steps);
      last.steps.at(-1)!.items.push({ type: "compaction" });
    }
  },

  CompactionEnd: (draft) => {
    draft.isCompacting = false;
  },

  StepBegin: (draft, payload) => {
    const last = getLastAssistant(draft);

    if (last) {
      if (!last.steps) {
        last.steps = [];
      }

      applyEventToSteps(last.steps, { type: "StepBegin", payload });
    }
  },

  StepInterrupted: (draft) => {
    draft.pendingOptimisticTurn = null;

    draft.isStreaming = false;
    const lastAssistant = getLastAssistant(draft);
    if (lastAssistant?.steps) {
      finishAllTextItems(lastAssistant.steps);
    }
  },

  ContentPart: (draft, payload: ContentPart) => {
    const last = getLastAssistant(draft);

    if (!last?.steps) {
      return;
    }

    applyEventToSteps(last.steps, { type: "ContentPart", payload }, (text) => {
      if (typeof last.content === "string") {
        last.content += text;
      }
    });
  },

  ToolCall: (draft, payload: ToolCall) => {
    const last = getLastAssistant(draft);

    if (!last?.steps) {
      return;
    }

    applyEventToSteps(last.steps, { type: "ToolCall", payload });
  },

  ToolCallPart: (draft, payload) => {
    const last = getLastAssistant(draft);

    if (!last?.steps) {
      return;
    }

    applyEventToSteps(last.steps, { type: "ToolCallPart", payload });
  },

  ToolResult: (draft, payload: ToolResult) => {
    const last = getLastAssistant(draft);

    if (!last?.steps) {
      return;
    }

    applyEventToSteps(last.steps, { type: "ToolResult", payload });
  },

  Plan: (draft, payload: Plan) => {
    const last = getLastAssistant(draft);

    if (!last) {
      return;
    }

    if (!last.steps) {
      last.steps = [];
    }

    if (last.steps.length === 0) {
      last.steps.push({ n: 1, items: [] });
    }

    applyEventToSteps(last.steps, { type: "Plan", payload });
  },

  ConfigOptionUpdate: (_, payload: ConfigOptionUpdate) => {
    useSettingsStore.getState().applyConfigOptionUpdate(payload);
  },

  SubagentEvent: (draft, payload: SubagentEvent) => {
    const last = getLastAssistant(draft);

    if (!last?.steps) {
      return;
    }

    const target = resolveSubagentTarget(last.steps, payload);

    if (!target) {
      return;
    }

    applyEventToSteps(target.steps, target.event);
  },

};

export function processEvent(draft: ChatState, event: UIStreamEvent): void {
  const handler = eventHandlers[event.type];

  if (handler) {
    const payload = "payload" in event ? event.payload : event;
    handler(draft, payload);
  }
}
