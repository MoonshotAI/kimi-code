import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import { PluginsBootstrapInjector } from '../../../src/agent/injection/plugins-bootstrap';
import type { EnabledBootstrap } from '../../../src/plugin/types';
import type { SkillDefinition } from '../../../src/skill/types';

interface StubBootstrapAgent {
  pluginBootstraps: readonly EnabledBootstrap[];
  skills: { registry: { getSkill: (name: string) => SkillDefinition | undefined } };
  context: { history: unknown[]; appendSystemReminder: (content: string) => void };
}

function skill(name: string, body: string): SkillDefinition {
  return {
    name,
    description: '',
    path: `/fake/${name}/SKILL.md`,
    dir: `/fake/${name}`,
    content: body,
    metadata: {},
    source: 'extra',
  };
}

function bootstrapAgent(input: {
  bootstraps: readonly EnabledBootstrap[];
  skills: readonly SkillDefinition[];
}): Agent {
  const byName = new Map(input.skills.map((s) => [s.name.toLowerCase(), s]));
  const history: unknown[] = [];
  const agent: StubBootstrapAgent = {
    pluginBootstraps: input.bootstraps,
    skills: {
      registry: {
        getSkill: (name) => byName.get(name.toLowerCase()),
      },
    },
    context: {
      history,
      appendSystemReminder: (content: string) => {
        history.push({ role: 'user', content: [{ type: 'text', text: content }] });
      },
    },
  };
  return agent as unknown as Agent;
}

function lastReminder(agent: Agent): string {
  const history = (agent.context as unknown as { history: Array<{ role: string; content?: ReadonlyArray<{ text?: string }> }> }).history;
  const last = history.findLast((message) => message.role === 'user');
  return last?.content?.map((part) => part.text ?? '').join('') ?? '';
}

describe('PluginsBootstrapInjector', () => {
  it('injects one <plugin_bootstrap> block per declared bootstrap on first call', async () => {
    const agent = bootstrapAgent({
      bootstraps: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body of skill')],
    });
    const injector = new PluginsBootstrapInjector(agent);
    await injector.inject();
    const text = lastReminder(agent);
    expect(text).toContain('<plugin_bootstrap plugin="superpowers" skill="using-superpowers">');
    expect(text).toContain('body of skill');
    expect(text).toContain('</plugin_bootstrap>');
  });

  it('does not re-inject on subsequent calls within the same session', async () => {
    const agent = bootstrapAgent({
      bootstraps: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body')],
    });
    const injector = new PluginsBootstrapInjector(agent);
    await injector.inject();
    await injector.inject();
    const history = (agent.context as unknown as { history: unknown[] }).history;
    expect(history).toHaveLength(1);
  });

  it('skips a bootstrap whose skill is not registered (with diagnostic emitted)', async () => {
    const agent = bootstrapAgent({
      bootstraps: [
        { pluginId: 'demo', skillName: 'missing' },
        { pluginId: 'superpowers', skillName: 'using-superpowers' },
      ],
      skills: [skill('using-superpowers', 'body')],
    });
    const injector = new PluginsBootstrapInjector(agent);
    await injector.inject();
    const text = lastReminder(agent);
    expect(text).not.toContain('plugin="demo"');
    expect(text).toContain('plugin="superpowers"');
  });

  it('emits nothing when no bootstraps are declared', async () => {
    const agent = bootstrapAgent({ bootstraps: [], skills: [] });
    const injector = new PluginsBootstrapInjector(agent);
    await injector.inject();
    const history = (agent.context as unknown as { history: unknown[] }).history;
    expect(history).toEqual([]);
  });
});
