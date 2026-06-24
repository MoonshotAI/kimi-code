import { describe, expect, it } from 'vitest';

import { ContextService } from '#/context/contextService';
import { MessageService } from '#/message/messageService';

describe('MessageService', () => {
  it('projects context messages with stable derived ids', () => {
    const ctx = new ContextService(undefined as never);
    ctx.appendMessage({ role: 'user', content: 'a' });
    ctx.appendMessage({ role: 'assistant', content: 'b' });
    const msg = new MessageService(ctx);
    const list = msg.list();
    expect(list).toEqual([
      { id: 'msg-0', role: 'user', content: 'a' },
      { id: 'msg-1', role: 'assistant', content: 'b' },
    ]);
    expect(msg.get('msg-1')).toEqual({ id: 'msg-1', role: 'assistant', content: 'b' });
    expect(msg.get('missing')).toBeUndefined();
  });
});
