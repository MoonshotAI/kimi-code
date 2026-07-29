import { describe, expect, it } from 'vitest';

import {
  KIMI_CHANNEL_NOTIFICATION_METHOD,
  KimiChannelNotificationSchema,
} from '#/agent/mcp/channel-notification';

describe('KimiChannelNotificationSchema', () => {
  it('parses a valid notification with optional fields omitted', () => {
    const result = KimiChannelNotificationSchema.parse({
      method: KIMI_CHANNEL_NOTIFICATION_METHOD,
      params: { text: 'hello' },
    });
    expect(result.params.text).toBe('hello');
    expect(result.params.chatId).toBeUndefined();
  });

  it('parses a valid notification with all fields present', () => {
    const result = KimiChannelNotificationSchema.parse({
      method: KIMI_CHANNEL_NOTIFICATION_METHOD,
      params: { text: 'hello', chatId: 'chat-1', serverName: 'discord' },
    });
    expect(result.params).toEqual({ text: 'hello', chatId: 'chat-1', serverName: 'discord' });
  });

  it('rejects a mismatched method', () => {
    const result = KimiChannelNotificationSchema.safeParse({
      method: 'notifications/other',
      params: { text: 'hello' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects params missing text', () => {
    const result = KimiChannelNotificationSchema.safeParse({
      method: KIMI_CHANNEL_NOTIFICATION_METHOD,
      params: { chatId: 'chat-1' },
    });
    expect(result.success).toBe(false);
  });
});
