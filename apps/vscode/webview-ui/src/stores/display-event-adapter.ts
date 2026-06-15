import {
  reduceDisplayEvent,
  type DisplayEffect,
  type DisplayEvent,
  type DisplayState,
  type DisplayMediaPart,
  type DisplayPart,
  type DisplayApprovalOption,
  type DisplayAvailableCommand,
  type DisplayPlanViewModel,
  type DisplayStatusViewModel,
  type DisplayTokenUsage,
} from "@moonshot-ai/kimi-code-vscode-display-model";
import type {
  ApprovalOption,
  AvailableCommandsUpdate,
  ContentPart,
  Plan,
  StatusUpdate,
  ToolCall,
  ToolResult,
} from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";
import { getUserMessage, isPreflightError, isUserInterrupt } from "shared/errors";
import { cleanSystemTags } from "shared/utils";
import type { UIStreamEvent } from "shared/types";
import { legacyDisplayBlocksToDisplay } from "@/lib/display-block-adapter";

export interface SharedDisplayReduction {
  state: DisplayState;
  effects: DisplayEffect[];
}

export function reduceUIStreamEventToDisplay(state: DisplayState, event: UIStreamEvent): SharedDisplayReduction {
  const displayEvent = toDisplayEvent(event);
  return displayEvent ? reduceDisplayEvent(state, displayEvent) : { state, effects: [] };
}

function toDisplayEvent(event: UIStreamEvent): DisplayEvent | null {
  switch (event.type) {
    case "TurnBegin": {
      const parts = userInputParts(event.payload.user_input);
      const text = userInputText(event.payload.user_input);
      return parts.length > 0 ? { type: "turn.begin", userText: text, parts } : null;
    }
    case "stream_complete":
      return { type: "turn.complete" };
    case "error":
      if (isUserInterrupt(event.code)) {
        return { type: "turn.interrupted", reason: event.code, message: getUserMessage(event.code, event.message) };
      }
      const details = { ...("details" in event ? (event.details ?? {}) : {}) };
      if ("raw" in event && typeof event.raw === "string") details.raw = event.raw;
      return {
        type: "turn.error",
        error: {
          code: event.code,
          message: getUserMessage(event.code, event.message),
          phase: "phase" in event && event.phase ? event.phase : (isPreflightError(event.code) ? "preflight" : "runtime"),
          ...(Object.keys(details).length > 0 ? { details } : {}),
        },
      };
    case "StepBegin":
      return { type: "step.begin", n: event.payload.n };
    case "ContentPart":
      return contentPartToDisplay(event.payload);
    case "ToolCall":
      return toolCallToDisplay(event.payload);
    case "ToolCallPart":
      return { type: "tool.call.delta", id: event.payload.tool_call_id, argumentsPart: event.payload.arguments_part ?? "" };
    case "ToolResult":
      return toolResultToDisplay(event.payload);
    case "Plan":
      return { type: "plan.replace", plan: planToDisplay(event.payload) };
    case "ApprovalRequest":
      return {
        type: "approval.request",
        request: {
          type: "approval",
          requestId: event.payload.id,
          toolCallId: event.payload.tool_call_id,
          sender: event.payload.sender,
          action: event.payload.action,
          description: event.payload.description,
          displayBlocks: legacyDisplayBlocksToDisplay(event.payload.display),
          options: approvalOptionsToDisplay(event.payload.options),
        },
      };
    case "ApprovalRequestResolved":
      return { type: "approval.resolved", requestId: event.payload.request_id };
    case "StatusUpdate":
      return { type: "status.update", status: statusToDisplay(event.payload) };
    case "CompactionBegin":
      return { type: "compaction.begin", trigger: event.payload.trigger, instruction: event.payload.instruction, message: event.payload.message };
    case "CompactionEnd":
      return {
        type: "compaction.end",
        status: event.payload.status ?? "completed",
        trigger: event.payload.trigger,
        instruction: event.payload.instruction,
        summary: event.payload.summary,
        compactedCount: event.payload.compactedCount,
        tokensBefore: event.payload.tokensBefore,
        tokensAfter: event.payload.tokensAfter,
        message: event.payload.message,
      };
    case "StepInterrupted":
      return { type: "turn.interrupted" };
    case "ConversationReset":
      return { type: "conversation.reset" };
    case "AvailableCommandsUpdate":
      return { type: "available_commands.update", commands: availableCommandsToDisplay(event.payload) };
    case "SubagentEvent":
      return {
        type: "subagent.event",
        parentToolCallId: event.payload.task_tool_call_id,
        event: toDisplayEvent(event.payload.event as UIStreamEvent) ?? { type: "step.interrupted" },
      };
    default:
      return null;
  }
}

export function userInputText(input: string | ContentPart[]): string {
  if (typeof input === "string") return cleanSystemTags(input).trim();
  return input
    .map((part) => {
      if (part.type === "text") return cleanSystemTags(part.text);
      if (part.type === "image_url") return `[image ${part.image_url.id ?? part.image_url.url}]`;
      if (part.type === "audio_url") return "[audio]";
      if (part.type === "video_url") return "[video]";
      return "";
    })
    .join("\n")
    .trim();
}

export function userInputParts(input: string | ContentPart[]): DisplayPart[] {
  if (typeof input === "string") {
    const text = cleanSystemTags(input);
    return text ? [{ type: "text", text }] : [];
  }

  const parts: DisplayPart[] = [];
  for (const part of input) {
    if (part.type === "text") {
      const text = cleanSystemTags(part.text);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    const media = mediaPartFromContent(part);
    if (media) parts.push(media);
  }
  return parts;
}

function contentPartToDisplay(part: ContentPart): DisplayEvent | null {
  if (part.type === "text") return { type: "content.append", kind: "text", text: part.text };
  if (part.type === "think") return { type: "content.append", kind: "thinking", text: part.think };
  const media = mediaPartFromContent(part);
  return media ? { type: "content.append", kind: "media", media } : null;
}

function mediaPartFromContent(part: ContentPart): DisplayMediaPart | null {
  if (part.type === "image_url") return { type: "media", kind: "image", url: part.image_url.url, id: part.image_url.id };
  if (part.type === "audio_url") return { type: "media", kind: "audio", url: part.audio_url.url, id: part.audio_url.id };
  if (part.type === "video_url") return { type: "media", kind: "video", url: part.video_url.url, id: part.video_url.id };
  return null;
}

function toolCallToDisplay(call: ToolCall): DisplayEvent {
  return {
    type: "tool.call",
    id: call.id,
    name: call.function.name,
    argumentsText: call.function.arguments ?? null,
  };
}

function toolResultToDisplay(result: ToolResult): DisplayEvent {
  return {
    type: "tool.result",
    id: result.tool_call_id,
    isError: result.return_value.is_error,
    output: outputText(result.return_value.output),
    message: result.return_value.message,
    displayBlocks: legacyDisplayBlocksToDisplay(result.return_value.display),
  };
}

function outputText(output: string | ContentPart[]): string {
  if (typeof output === "string") return output;
  return output
    .map((part) => (part.type === "text" ? part.text : part.type === "think" ? part.think : ""))
    .join("\n");
}

function approvalOptionsToDisplay(options: ApprovalOption[] | undefined): DisplayApprovalOption[] | undefined {
  return options?.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind }));
}

function planToDisplay(plan: Plan): DisplayPlanViewModel {
  return {
    entries: plan.entries.map((entry) => ({
      content: entry.content,
      status: entry.status,
      priority: entry.priority,
    })),
  };
}

function statusToDisplay(status: StatusUpdate): DisplayStatusViewModel {
  return {
    contextUsage: status.context_usage ?? null,
    contextTokens: status.context_tokens ?? null,
    maxContextTokens: status.max_context_tokens ?? null,
    tokenUsage: status.token_usage ? tokenUsageToDisplay(status.token_usage) : null,
    messageId: status.message_id ?? null,
  };
}

function tokenUsageToDisplay(usage: NonNullable<StatusUpdate["token_usage"]>): DisplayTokenUsage {
  return {
    inputOther: usage.input_other,
    output: usage.output,
    inputCacheRead: usage.input_cache_read,
    inputCacheCreation: usage.input_cache_creation,
  };
}

function availableCommandsToDisplay(update: AvailableCommandsUpdate): DisplayAvailableCommand[] {
  return update.availableCommands.map((command) => ({ name: command.name, description: command.description, group: command.group }));
}
