import {
  createCollection,
  useCollection,
  useContribute,
  useMounted,
  type CollectionToken,
} from '#/kernel/index';
import type { Agent } from '#/session/index';

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

export function useSystemPromptAssembly(agent: Agent): void {
  const sections = useCollection(SystemPromptSections);
  useMounted(() => {
    if (agent.loop.state.profile.systemPrompt !== undefined) return;
    const byId = new Map<string, SystemPromptSection>();
    for (const section of sections.value) byId.set(section.id, section);
    const text = [...byId.values()]
      .filter((section) => section.text.trim() !== '')
      .map((section) => section.text)
      .join('\n\n');
    if (text === '') return;
    agent.loop.setSystemPrompt(text);
  });
}
