import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { PromptOrigin } from '../../../src/agent/context';
import {
  PluginSessionStartInjector,
  renderPluginSessionStartReminder,
} from '../../../src/agent/injection/plugin-session-start';
import type { EnabledPluginSessionStart } from '../../../src/plugin/types';
import type { SkillDefinition } from '../../../src/skill/types';

interface StubSessionStartAgent {
  pluginSessionStarts: readonly EnabledPluginSessionStart[];
  skills: {
    registry: {
      getSkill: (name: string) => SkillDefinition | undefined;
      getPluginSkill: (pluginId: string, name: string) => SkillDefinition | undefined;
      renderSkillPrompt: (skill: SkillDefinition, args: string) => string;
    };
  };
  log: {
    warn: (message: string, payload?: unknown) => void;
    info: (message: string, payload?: unknown) => void;
    debug: (message: string, payload?: unknown) => void;
    error: (message: string, payload?: unknown) => void;
  };
  context: {
    history: unknown[];
    appendSystemReminder: (content: string, origin: PromptOrigin) => void;
  };
}

function skill(
  name: string,
  body: string,
  plugin?: SkillDefinition['plugin'],
): SkillDefinition {
  return {
    name,
    description: '',
    path: `/fake/${name}/SKILL.md`,
    dir: `/fake/${name}`,
    content: body,
    metadata: {},
    source: 'extra',
    plugin,
  };
}

interface CapturedWarn {
  readonly message: string;
  readonly payload?: unknown;
}

function sessionStartAgent(input: {
  sessionStarts: readonly EnabledPluginSessionStart[];
  skills: readonly SkillDefinition[];
  history?: unknown[];
}): { agent: Agent; warnings: readonly CapturedWarn[] } {
  const byName = new Map(input.skills.map((s) => [s.name.toLowerCase(), s]));
  const byPluginAndName = new Map(
    input.skills.flatMap((s) =>
      s.plugin === undefined ? [] : [[`${s.plugin.id}\0${s.name.toLowerCase()}`, s] as const],
    ),
  );
  const history: unknown[] = [...(input.history ?? [])];
  const warnings: CapturedWarn[] = [];
  const agent: StubSessionStartAgent = {
    pluginSessionStarts: input.sessionStarts,
    skills: {
      registry: {
        getSkill: (name) => byName.get(name.toLowerCase()),
        getPluginSkill: (pluginId, name) =>
          byPluginAndName.get(`${pluginId}\0${name.toLowerCase()}`),
        renderSkillPrompt: (skill) => {
          const plugin = skill.plugin;
          if (plugin === undefined) return skill.content;
          const instructions = plugin.instructions;
          if (instructions === undefined) return skill.content;
          return `<kimi-plugin-instructions plugin="${plugin.id}">\n${instructions}\n</kimi-plugin-instructions>\n\n${skill.content}`;
        },
      },
    },
    log: {
      warn: (message, payload) => warnings.push({ message, payload }),
      info: () => {},
      debug: () => {},
      error: () => {},
    },
    context: {
      history,
      appendSystemReminder: (content: string, origin: PromptOrigin) => {
        history.push({ role: 'user', content: [{ type: 'text', text: content }], origin });
      },
    },
  };
  return { agent: agent as unknown as Agent, warnings };
}

function lastReminder(agent: Agent): string {
  const history = (agent.context as unknown as { history: Array<{ role: string; content?: ReadonlyArray<{ text?: string }> }> }).history;
  const last = history.findLast((message) => message.role === 'user');
  return last?.content?.map((part) => part.text ?? '').join('') ?? '';
}

describe('PluginSessionStartInjector', () => {
  it('injects one <plugin_session_start> block per declared sessionStart on first call', async () => {
    const { agent } = sessionStartAgent({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [
        skill('using-superpowers', 'body of skill', {
          id: 'superpowers',
          instructions: 'Use AskUserQuestion and TodoList.',
        }),
      ],
    });
    const injector = new PluginSessionStartInjector(agent);
    await injector.inject();
    const text = lastReminder(agent);
    expect(text).toContain('<plugin_session_start plugin="superpowers" skill="using-superpowers">');
    expect(text).toContain('<kimi-plugin-instructions plugin="superpowers">');
    expect(text).toContain('AskUserQuestion');
    expect(text).toContain('TodoList');
    expect(text).toContain('body of skill');
    expect(text).toContain('</plugin_session_start>');
  });

  it('does not hard-code Superpowers guidance when the skill has no plugin instructions', async () => {
    const { agent } = sessionStartAgent({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body', { id: 'superpowers' })],
    });
    const injector = new PluginSessionStartInjector(agent);
    await injector.inject();
    const text = lastReminder(agent);
    expect(text).toContain('<plugin_session_start plugin="superpowers" skill="using-superpowers">');
    expect(text).toContain('body');
    expect(text).not.toContain('<kimi-plugin-instructions plugin="superpowers">');
    expect(text).not.toContain('AskUserQuestion');
  });

  it('does not re-inject on subsequent calls within the same session', async () => {
    const { agent } = sessionStartAgent({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body', { id: 'superpowers' })],
    });
    const injector = new PluginSessionStartInjector(agent);
    await injector.inject();
    await injector.inject();
    const history = (agent.context as unknown as { history: unknown[] }).history;
    expect(history).toHaveLength(1);
  });

  it('does not re-inject when a replayed history already contains plugin sessionStart', async () => {
    const { agent } = sessionStartAgent({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body', { id: 'superpowers' })],
      history: [
        {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>old</system-reminder>' }],
          origin: { kind: 'injection', variant: 'plugin_session_start' },
        },
      ],
    });
    const injector = new PluginSessionStartInjector(agent);
    await injector.inject();
    const history = (agent.context as unknown as { history: unknown[] }).history;
    expect(history).toHaveLength(1);
  });

  it('skips a sessionStart whose skill is not registered and warns', async () => {
    const { agent, warnings } = sessionStartAgent({
      sessionStarts: [
        { pluginId: 'demo', skillName: 'missing' },
        { pluginId: 'superpowers', skillName: 'using-superpowers' },
      ],
      skills: [skill('using-superpowers', 'body', { id: 'superpowers' })],
    });
    const injector = new PluginSessionStartInjector(agent);
    await injector.inject();
    const text = lastReminder(agent);
    expect(text).not.toContain('plugin="demo"');
    expect(text).toContain('plugin="superpowers"');
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: 'plugin sessionStart skill not found',
        payload: expect.objectContaining({ pluginId: 'demo', skillName: 'missing' }),
      }),
    );
  });

  it('emits nothing when no sessionStart declarations are present', async () => {
    const { agent } = sessionStartAgent({ sessionStarts: [], skills: [] });
    const injector = new PluginSessionStartInjector(agent);
    await injector.inject();
    const history = (agent.context as unknown as { history: unknown[] }).history;
    expect(history).toEqual([]);
  });

  it('resolves sessionStart skills by plugin identity when names collide', async () => {
    const { agent } = sessionStartAgent({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [
        skill('using-superpowers', 'project body'),
        skill('using-superpowers', 'plugin body', { id: 'superpowers' }),
      ],
    });
    const injector = new PluginSessionStartInjector(agent);
    await injector.inject();
    const text = lastReminder(agent);
    expect(text).toContain('plugin body');
    expect(text).not.toContain('project body');
  });
});

describe('renderPluginSessionStartReminder', () => {
  function registryFor(skills: readonly SkillDefinition[]) {
    const byPluginAndName = new Map(
      skills.flatMap((s) =>
        s.plugin === undefined ? [] : [[`${s.plugin.id}\0${s.name.toLowerCase()}`, s] as const],
      ),
    );
    return {
      getPluginSkill: (pluginId: string, name: string) =>
        byPluginAndName.get(`${pluginId}\0${name.toLowerCase()}`),
      renderSkillPrompt: (s: SkillDefinition) => s.content,
    };
  }

  it('renders a block per resolvable sessionStart', () => {
    const text = renderPluginSessionStartReminder({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      registry: registryFor([
        skill('using-superpowers', 'plugin body', { id: 'superpowers' }),
      ]),
    });
    expect(text).toContain(
      '<plugin_session_start plugin="superpowers" skill="using-superpowers">',
    );
    expect(text).toContain('plugin body');
  });

  it('returns undefined when there are no sessionStarts', () => {
    expect(
      renderPluginSessionStartReminder({ sessionStarts: [], registry: registryFor([]) }),
    ).toBeUndefined();
  });

  it('returns undefined when the registry is unavailable', () => {
    expect(
      renderPluginSessionStartReminder({
        sessionStarts: [{ pluginId: 'demo', skillName: 'x' }],
        registry: undefined,
      }),
    ).toBeUndefined();
  });

  it('returns undefined and warns when the skill cannot be resolved', () => {
    const warnings: Array<{ message: string; payload?: unknown }> = [];
    const text = renderPluginSessionStartReminder({
      sessionStarts: [{ pluginId: 'demo', skillName: 'missing' }],
      registry: registryFor([]),
      log: { warn: (message, payload) => warnings.push({ message, payload }) },
    });
    expect(text).toBeUndefined();
    expect(warnings).toContainEqual(
      expect.objectContaining({ message: 'plugin sessionStart skill not found' }),
    );
  });
});
