import { describe, expect, it } from 'vitest';

import { rendererFor } from '../src/components/wire/renderers';

describe('wire renderers', () => {
  it('renders both states of deferred turn bookkeeping', () => {
    const deferred = rendererFor('turn.defer');
    const consumed = rendererFor('turn.defer.consume');

    expect(deferred).toMatchObject({ tone: 'warning', label: 'defer' });
    expect(consumed).toMatchObject({
      tone: 'lifecycle',
      label: 'defer·consume',
    });
    expect(
      deferred?.headline({
        type: 'turn.defer',
        id: 'deferred-1',
        input: [{ type: 'text', text: 'pending' }],
        origin: { kind: 'cron' },
      }).main,
    ).toBeDefined();
    expect(
      consumed?.headline({
        type: 'turn.defer.consume',
        id: 'deferred-1',
      }).main,
    ).toBeDefined();
  });
});
