import { describe, expect, it } from 'vitest';
import { applyModelMenuDraft, type ModelMenuDraft } from '../src/composer/modelMenuDraft';

function makeDraftHarness(applyModel = true, nextSessionId: string | null | undefined = 'sess') {
  let modelId = 'old';
  let sessionId: string | null | undefined = 'sess';
  const calls: string[] = [];
  const options = {
    currentModelId: 'old',
    currentSessionId: 'sess',
    getCurrentModelId: () => modelId,
    getCurrentSessionId: () => sessionId,
    selectModel: async (id: string) => {
      calls.push(`model:${id}`);
      if (applyModel) modelId = id;
      sessionId = nextSessionId;
    },
    setThinking: async (effort: string) => {
      calls.push(`effort:${effort}`);
    },
  };
  return { calls, options };
}

async function apply(draft: ModelMenuDraft, applyModel = true, nextSessionId: string | null | undefined = 'sess') {
  const harness = makeDraftHarness(applyModel, nextSessionId);
  await applyModelMenuDraft(draft, harness.options);
  return harness.calls;
}

describe('Composer model selection', () => {
  it('applies only fields that changed', async () => {
    expect(await apply({ modelId: 'old' })).toEqual([]);
    expect(await apply({ modelId: 'new' })).toEqual(['model:new']);
    expect(await apply({ modelId: 'old', effort: 'max' })).toEqual(['effort:max']);
  });

  it('applies model before effort when both change', async () => {
    expect(await apply({ modelId: 'new', effort: 'max' })).toEqual(['model:new', 'effort:max']);
  });

  it('does not apply effort when the model switch is cancelled', async () => {
    expect(await apply({ modelId: 'new', effort: 'max' }, false)).toEqual(['model:new']);
  });

  it('does not apply effort after the session changes during model confirmation', async () => {
    expect(await apply({ modelId: 'new', effort: 'max' }, true, 'other')).toEqual(['model:new']);
  });
});
