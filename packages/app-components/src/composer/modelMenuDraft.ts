import type { ThinkingLevel } from '@moonshot-ai/app-core/api';

export interface ModelMenuDraft {
  readonly modelId: string;
  readonly effort?: ThinkingLevel;
}

interface ApplyModelMenuDraftOptions {
  readonly currentModelId: string | undefined;
  readonly currentSessionId: string | null | undefined;
  readonly getCurrentModelId: () => string | undefined;
  readonly getCurrentSessionId: () => string | null | undefined;
  readonly selectModel: (modelId: string) => Promise<void>;
  readonly setThinking: (effort: ThinkingLevel) => Promise<void>;
}

export async function applyModelMenuDraft(
  draft: ModelMenuDraft,
  options: ApplyModelMenuDraftOptions,
): Promise<void> {
  if (draft.modelId !== options.currentModelId) {
    await options.selectModel(draft.modelId);
    if (
      options.getCurrentSessionId() !== options.currentSessionId ||
      options.getCurrentModelId() !== draft.modelId
    ) {
      return;
    }
  }
  if (draft.effort !== undefined) await options.setThinking(draft.effort);
}
