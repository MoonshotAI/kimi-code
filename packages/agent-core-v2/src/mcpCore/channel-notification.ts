/**
 * Wire contract for the MCP "push channel" — a proprietary notification an
 * MCP server sends to wake a running session, mirroring Claude Code's
 * `notifications/claude/channel`. See `client-shared.ts` for where the
 * client registers a handler for this schema.
 */

import { z } from 'zod';
import { NotificationSchema } from '@modelcontextprotocol/sdk/types.js';

export const KIMI_CHANNEL_NOTIFICATION_METHOD = 'notifications/kimi/channel' as const;

export const KimiChannelNotificationSchema = NotificationSchema.extend({
  method: z.literal(KIMI_CHANNEL_NOTIFICATION_METHOD),
  params: z.object({
    text: z.string(),
    chatId: z.string().optional(),
    serverName: z.string().optional(),
  }),
});

export interface MCPChannelMessage {
  readonly text: string;
  readonly chatId?: string;
}
