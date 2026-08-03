/**
 * Scenario: plugin session-start rendering and restored-history deduplication.
 *
 * Exercises the real agent injection and wire replay path through the shared
 * test-agent harness, with plugin contributions supplied in memory.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/skillCatalog/plugin-session-start.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { LogContext, LogPayload } from '#/_base/log/log';
import type { EnabledPluginSessionStart } from '#/app/plugin/types';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillDefinition } from '#/app/skillCatalog/types';
import { testAgent } from '../../harness';
import { stubSkill } from './stubs';

type InjectableDynamicInjector = {
  inject(): Promise<void>;
};

interface CapturedWarn {
  readonly message: string;
  readonly payload?: LogPayload;
}

interface RecordingLogger {
  warn(message: string, payload?: LogPayload): void;
  info(message: string, payload?: LogPayload): void;
  debug(message: string, payload?: LogPayload): void;
  error(message: string, payload?: LogPayload): void;
  createChild(ctx: LogContext): RecordingLogger;
}

function skill(
  name: string,
  body: string,
  plugin?: SkillDefinition['plugin'],
): SkillDefinition {
  return stubSkill(name, {
    description: '',
    path: `/fake/${name}/SKILL.md`,
    dir: `/fake/${name}`,
    content: body,
    metadata: {},
    source: 'extra',
    plugin,
  });
}

function recordingLogger(warnings: CapturedWarn[]): RecordingLogger {
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
  const skills = new InMemorySkillCatalog();
  for (const skill of input.skills) {
    skills.register(skill);
  }
  const ctx = testAgent({
    skills,
    pluginSessionStarts: input.sessionStarts,
    log: recordingLogger(warnings),
  });
  ctx.configure();
  if (input.history !== undefined) {
    ctx.context.append(...input.history);
  }
  return { ctx, warnings };
}

async function injectDynamic(ctx: ReturnType<typeof testAgent>): Promise<void> {
  await (ctx.get(IAgentContextInjectorService) as unknown as InjectableDynamicInjector).inject();
}

function lastReminder(ctx: ReturnType<typeof testAgent>): string {
  const last = ctx.context.get().findLast((message) => message.role === 'user');
  return last?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

function pluginSessionStartMessages(ctx: ReturnType<typeof testAgent>) {
  return ctx.context.get().filter(
    (message) =>
      message.origin?.kind === 'injection' && message.origin.variant === 'plugin_session_start',
  );
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
    expect(ctx.context.get().at(-1)?.origin).toEqual({
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

    expect(pluginSessionStartMessages(ctx)).toHaveLength(1);
  });

  it('does not re-inject when a live-spliced history already contains plugin sessionStart', async () => {
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

    expect(pluginSessionStartMessages(ctx)).toHaveLength(1);
  });

  it('does not re-inject after a silent wire replay restored a plugin sessionStart (cold resume)', async () => {
    const { ctx } = sessionStartRuntime({
      sessionStarts: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body', { id: 'superpowers' })],
    });

    await ctx.restore([{
      type: 'context.append_message',
      time: 1,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>old</system-reminder>' }],
        toolCalls: [],
        origin: { kind: 'injection', variant: 'plugin_session_start' },
      },
    }]);

    await injectDynamic(ctx);

    expect(pluginSessionStartMessages(ctx)).toHaveLength(1);
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

    expect(ctx.context.get()).toEqual([]);
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
