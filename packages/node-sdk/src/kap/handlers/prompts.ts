import type { ContentPart } from '@moonshot-ai/kosong';
import type { MessageContent } from '@moonshot-ai/protocol';

import type { CoreApiHandlerMap } from '../types';

interface TurnPayload {
  readonly sessionId: string;
  readonly agentId: string;
  readonly input?: readonly ContentPart[];
}

function toMessageContent(parts: readonly ContentPart[]): MessageContent[] {
  const out: MessageContent[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      out.push({ type: 'image', source: { kind: 'url', url: part.imageUrl.url } });
    } else if (part.type === 'video_url') {
      out.push({ type: 'video', source: { kind: 'url', url: part.videoUrl.url } });
    }
  }
  return out;
}

export const promptHandlers: CoreApiHandlerMap = {
  prompt: async (payload, ctx) => {
    const { sessionId, agentId, input } = payload as TurnPayload;
    await ctx.http.post(`/sessions/${sessionId}/prompts`, {
      content: toMessageContent(input ?? []),
      agent_id: agentId,
    });
  },

  steer: async (payload, ctx) => {
    const { sessionId, agentId, input } = payload as TurnPayload;
    // Submit the steer content as a prompt, then steer it into the current turn.
    // NOTE: verify whether POST /prompts auto-steers when a turn is active; if it
    // does, the second call is redundant and can be removed.
    const submitted = await ctx.http.post<{ prompt_id: string }>(`/sessions/${sessionId}/prompts`, {
      content: toMessageContent(input ?? []),
      agent_id: agentId,
    });
    await ctx.http.post(`/sessions/${sessionId}/prompts::steer`, { prompt_ids: [submitted.prompt_id] });
  },

  cancel: async (payload, ctx) => {
    const { sessionId } = payload as TurnPayload;
    await ctx.http.post(`/sessions/${sessionId}:abort`, {});
  },

  startBtw: async (payload, ctx) => {
    const { sessionId } = payload as TurnPayload;
    const result = await ctx.http.post<{ agent_id: string }>(`/sessions/${sessionId}:btw`, {});
    return result.agent_id;
  },

  activateSkill: async (payload, ctx) => {
    const { sessionId, name, args } = payload as { sessionId: string; name: string; args?: string };
    await ctx.http.post(`/sessions/${sessionId}/skills/${encodeURIComponent(name)}:activate`, {
      ...(args !== undefined ? { args } : {}),
    });
  },
};
