import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextService } from '#/context/context';
import { ContextService } from '#/context/contextService';
import { IAgentRecords } from '#/records/records';

import { MessageService } from '#/message/messageService';

const unusedRecords: IAgentRecords = {
  _serviceBrand: undefined,
  logRecord: () => Promise.resolve(),
  // eslint-disable-next-line @typescript-eslint/require-await
  replay: async function* () {
    /* no records in tests */
  },
  restore: () => Promise.resolve(),
};

describe('MessageService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentRecords, unusedRecords);
    ix.set(IContextService, new SyncDescriptor(ContextService));
  });
  afterEach(() => disposables.dispose());

  it('projects context messages with stable derived ids', () => {
    const ctx = ix.get(IContextService);
    ctx.appendMessage({ role: 'user', content: 'a' });
    ctx.appendMessage({ role: 'assistant', content: 'b' });
    const msg = ix.createInstance(MessageService);
    const list = msg.list();
    expect(list).toEqual([
      { id: 'msg-0', role: 'user', content: 'a' },
      { id: 'msg-1', role: 'assistant', content: 'b' },
    ]);
    expect(msg.get('msg-1')).toEqual({ id: 'msg-1', role: 'assistant', content: 'b' });
    expect(msg.get('missing')).toBeUndefined();
  });
});
