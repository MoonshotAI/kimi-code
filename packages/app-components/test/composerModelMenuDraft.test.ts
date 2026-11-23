import { describe, expect, it } from 'vitest';
import composer from '../src/composer/Composer.vue?raw';
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

describe('Composer model menu drafts', () => {
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

  it('defers model and effort selections until outside dismissal in shared and native menus', () => {
    const selectBody = composer.match(/function selectModel\(modelId: string\): void \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const thinkingBody = composer.match(/function setThinkingSegment\(draft: string\): void \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const outsideClickBody = composer.match(/function onDocClick\(e: MouseEvent\): void \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const keyboardBody = composer.match(/function handleKeydown\(e: KeyboardEvent\): boolean \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const menuKeyboardBody = composer.match(/function onModelDropdownKeydown\(event: KeyboardEvent\): void \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(selectBody).not.toContain('client.selectModel');
    expect(selectBody).not.toContain('closeDropdown()');
    expect(selectBody.trim().endsWith('draftModelId.value = modelId;')).toBe(true);
    expect(thinkingBody).not.toContain('client.setThinking');
    expect(thinkingBody.trim().endsWith('draftEffortSegment.value = draft;')).toBe(true);
    expect(outsideClickBody).toContain('commitModelMenuDraft()');
    expect(keyboardBody).toContain('e.ctrlKey || e.metaKey');
    expect(keyboardBody).toContain('commitModelMenuDraft()');
    expect(keyboardBody).toContain('closeDropdown()');
    expect(menuKeyboardBody).toContain('event.ctrlKey || event.metaKey');
    expect(menuKeyboardBody).toContain('commitModelMenuDraft()');
    expect(menuKeyboardBody).toContain("event.key === 'Escape'");
    expect(composer).toContain('onDismiss: commitModelMenuDraft');
    expect(composer).toContain('submitOnCtrlEnter: true');
    expect(composer).toContain('keepOpen: true');
    expect(composer).toContain('entry.model.id === draftModelId');
    expect(composer).toContain('fallbackModelEntries');
  });

  it('renders recent models additively with occurrence-specific keys for shared and native menus', () => {
    expect(composer).toContain('recentModelsForMenu');
    expect(composer).toContain("t('status.recentModels')");
    expect(composer).toContain('key: `recent:${model.id}`');
    expect(composer).toContain('nativeModelItem(model, `recent:${model.id}`)');
    expect(composer).toContain('nativeModelActionIds');
    expect(composer).toContain('nativeModelByAction');
    expect(composer).toContain('if (opening) prepareModelMenu();');
    expect(composer).toContain('providerModels.value = selected');
    expect(composer).toContain('maxHeight: 400');
  });

  it('uses cloud effort descriptions instead of the static cache note', () => {
    expect(composer).not.toContain("t('status.cacheNote')");
    expect(composer).toContain('v-if="effortDescription"');
    expect(composer).toContain('class="md-effort-description"');
    expect(composer).toContain("id: 'effort-description'");
    expect(composer).toContain('resolveEffortDescription(effortSwitchStore().config');
  });
});
