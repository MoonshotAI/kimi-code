import { describe, expect, it } from 'vitest';

import type { Logger, LogContext, LogPayload } from '../../../../src/logging';
import type { EnabledPluginSessionStart } from '../../../../src/plugin/types';
import {
  IDynamicInjector,
  type ContextMessage,
} from '../../../../src/services/agent';
import type { SkillCatalog, SkillDefinition } from '../../../../src/skill/types';
import { testAgent } from '../harness';

type InjectableDynamicInjector = {
  inject(): Promise<void>;
};

interface CapturedWarn {
  readonly message: string;
  readonly payload?: LogPayload;
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

function skillCatalog(skills: readonly SkillDefinition[]): SkillCatalog {
  const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
  const byPluginAndName = new Map(
    skills.flatMap((s) =>
      s.plugin === undefined ? [] : [[`${s.plugin.id}\0${s.name.toLowerCase()}`, s] as const],
    ),
  );

  return {
    getSkill: (name) => byName.get(name.toLowerCase()),
    getPluginSkill: (pluginId, name) =>
      byPluginAndName.get(`${pluginId}\0${name.toLowerCase()}`),
    renderSkillPrompt: (next) => {
      const plugin = next.plugin;
      if (plugin === undefined) return next.content;
      const instructions = plugin.instructions;
      if (instructions === undefined) return next.content;
      return `<kimi-plugin-instructions plugin="${plugin.id}">\n${instructions}\n</kimi-plugin-instructions>\n\n${next.content}`;
    },
    listInvocableSkills: () => skills,
    getSkillRoots: () => [],
    getModelSkillListing: () => '',
  };
}

function recordingLogger(warnings: CapturedWarn[]): Logger {
  return {
    warn: (message, payload) => {
      warnings.push({ message, payload });
    },
    info: () => {},
    debug: () => {},
    error: () => {},
    createChild: (_ctx: LogContext) => recordingLogger(warnings),
  };
}

function sessionStartRuntime(input: {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
  readonly skills: readonly SkillDefinition[];
  readonly history?: readonly ContextMessage[];
}): {
  readonly ctx: ReturnType<typeof testAgent>;
  readonly warnings: readonly CapturedWarn[];
} {
  const warnings: CapturedWarn[] = [];
  const ctx = testAgent({
    skills: skillCatalog(input.skills),
    pluginSessionStarts: input.sessionStarts,
    log: recordingLogger(warnings),
  });
  ctx.configure();
  if (input.history !== undefined) {
    ctx.context.spliceHistory(0, 0, input.history);
  }
  return { ctx, warnings };
}

async function injectDynamic(ctx: ReturnType<typeof testAgent>): Promise<void> {
  await (ctx.get(IDynamicInjector) as unknown as InjectableDynamicInjector).inject();
}

function lastReminder(ctx: ReturnType<typeof testAgent>): string {
  const last = ctx.context.getHistory().findLast((message) => message.role === 'user');
  return last?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

describe('plugin session-start dynamic injection', () => {
  it('injects one <plugin_session_start> block per declared sessionStart on first call', async () => {
    const { ctx } = sessionStartRuntime({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [
        skill('using-superpowers', 'body of skill', {
          id: 'superpowers',
          instructions: 'Use AskUserQuestion and TodoList.',
        }),
      ],
    });

    await injectDynamic(ctx);

    const text = lastReminder(ctx);
    expect(text).toContain('<plugin_session_start plugin="superpowers" skill="using-superpowers">');
    expect(text).toContain('<kimi-plugin-instructions plugin="superpowers">');
    expect(text).toContain('AskUserQuestion');
    expect(text).toContain('TodoList');
    expect(text).toContain('body of skill');
    expect(text).toContain('</plugin_session_start>');
    expect(ctx.context.getHistory().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'plugin_session_start',
    });
  });

  it('does not hard-code Superpowers guidance when the skill has no plugin instructions', async () => {
    const { ctx } = sessionStartRuntime({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body', { id: 'superpowers' })],
    });

    await injectDynamic(ctx);

    const text = lastReminder(ctx);
    expect(text).toContain('<plugin_session_start plugin="superpowers" skill="using-superpowers">');
    expect(text).toContain('body');
    expect(text).not.toContain('<kimi-plugin-instructions plugin="superpowers">');
    expect(text).not.toContain('AskUserQuestion');
  });

  it('does not re-inject on subsequent calls within the same session', async () => {
    const { ctx } = sessionStartRuntime({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body', { id: 'superpowers' })],
    });

    await injectDynamic(ctx);
    await injectDynamic(ctx);

    expect(ctx.context.getHistory()).toHaveLength(1);
  });

  it('does not re-inject when a replayed history already contains plugin sessionStart', async () => {
    const { ctx } = sessionStartRuntime({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body', { id: 'superpowers' })],
      history: [
        {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>old</system-reminder>' }],
          toolCalls: [],
          origin: { kind: 'injection', variant: 'plugin_session_start' },
        },
      ],
    });

    await injectDynamic(ctx);

    expect(ctx.context.getHistory()).toHaveLength(1);
  });

  it('skips a sessionStart whose skill is not registered and warns', async () => {
    const { ctx, warnings } = sessionStartRuntime({
      sessionStarts: [
        { pluginId: 'demo', skillName: 'missing' },
        { pluginId: 'superpowers', skillName: 'using-superpowers' },
      ],
      skills: [skill('using-superpowers', 'body', { id: 'superpowers' })],
    });

    await injectDynamic(ctx);

    const text = lastReminder(ctx);
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
    const { ctx } = sessionStartRuntime({ sessionStarts: [], skills: [] });

    await injectDynamic(ctx);

    expect(ctx.context.getHistory()).toEqual([]);
  });

  it('resolves sessionStart skills by plugin identity when names collide', async () => {
    const { ctx } = sessionStartRuntime({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [
        skill('using-superpowers', 'project body'),
        skill('using-superpowers', 'plugin body', { id: 'superpowers' }),
      ],
    });

    await injectDynamic(ctx);

    const text = lastReminder(ctx);
    expect(text).toContain('plugin body');
    expect(text).not.toContain('project body');
  });
});
