import { createCollection, useContribute, type CollectionToken } from '#/composition-api/index';

export interface SystemPromptSection {
  readonly id: string;
  readonly text: string;
  readonly priority?: number;
}

export const SystemPromptSections: CollectionToken<SystemPromptSection> = createCollection(
  'app.systemPrompt.sections',
);

export function useSystemPrompt(...sections: SystemPromptSection[]): void {
  for (const section of sections) {
    if (section.id === '') {
      throw new TypeError('system prompt section id must be a non-empty string');
    }
    useContribute(SystemPromptSections, section, section.priority ?? 0);
  }
}
