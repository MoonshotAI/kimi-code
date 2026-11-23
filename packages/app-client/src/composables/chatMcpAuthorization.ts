import { reactive } from 'vue';
import { isMcpAuthorizationUrl, mcpAuthCardOf } from '@moonshot-ai/app-core/client';
import type { McpAuthRequest } from '@moonshot-ai/app-core/client/types';
import type { ConversationFrame, ConversationTurn } from '@moonshot-ai/app-core/conversation';
import { createDesktopOAuthAutoOpen } from '../lib/oauthAutoOpen';
import { isLocalPromptId } from '../client/promptId';

const failedWaits = reactive(new Set<string>());

export function chatMcpOpenBlocked(waitId: string): boolean {
  return failedWaits.has(waitId);
}

export function hasChatMcpDesktopOpener(): boolean {
  return typeof window !== 'undefined' && typeof (window as { kimiDesktop?: { openExternal?: unknown } }).kimiDesktop?.openExternal === 'function';
}

export async function openChatMcpAuthorization(request: McpAuthRequest): Promise<void> {
  if (request.expiresAt <= Date.now() || !isMcpAuthorizationUrl(request.authorizationUrl)) return;
  const driver = createDesktopOAuthAutoOpen(url => url);
  if (await driver.openUrl(request.authorizationUrl, request.waitId)) failedWaits.delete(request.waitId);
  else failedWaits.add(request.waitId);
}

export function createChatMcpAutoOpen() {
  const observed = new Set<string>();
  function observe(waitId: string): boolean {
    if (observed.has(waitId)) return false;
    observed.add(waitId);
    const first = observed.values().next();
    if (observed.size > 256 && !first.done) observed.delete(first.value);
    return true;
  }
  return (frame: ConversationFrame, turn: ConversationTurn | undefined, foreground: boolean): void => {
    if (!hasChatMcpDesktopOpener()) return;
    if (frame.type === 'turns') {
      for (const active of frame.turns) {
        if (active.status !== 'running') continue;
        for (const item of active.items) {
          const card = item.type === 'tool_call' ? mcpAuthCardOf(item) : undefined;
          if (card?.phase === 'waiting') observe(card.request.waitId);
        }
      }
      return;
    }
    if (frame.type !== 'item.updated' || !frame.set.fields || turn?.status !== 'running') return;
    const item = turn.items.find(candidate => candidate.item_id === frame.item_id);
    const card = item?.type === 'tool_call' ? mcpAuthCardOf(item) : undefined;
    if (card?.phase !== 'waiting' || !observe(card.request.waitId) || !foreground) return;
    const opener = turn.items.find(candidate => candidate.type === 'user_message' && candidate.placement === 'opener');
    if (opener?.type === 'user_message' && opener.prompt_ids.some(isLocalPromptId)) void openChatMcpAuthorization(card.request);
  };
}
