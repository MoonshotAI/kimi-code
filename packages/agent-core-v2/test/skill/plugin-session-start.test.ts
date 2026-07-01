import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IContextInjector } from '#/contextInjector';
import { IContextMemory, type ContextMessage } from '#/contextMemory';
import type { LogContext, LogPayload } from '#/log';
import type { EnabledPluginSessionStart } from '#/plugin/types';
import { InMemorySkillCatalog as SessionSkillRegistry } from '#/skill/registry';
import type { SkillDefinition } from '#/skill/types';
import {
  createTestAgent,
  logServices,
  skillServices,
  type TestAgentContext,
} from '../harness';
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

function registerPluginSessionStartInjection(
  injector: IContextInjector,
  sessionStarts: readonly EnabledPluginSessionStart[],
  skills: SessionSkillRegistry,
  logger: RecordingLogger,
): void {
  injector.register('plugin_session_start', ({ lastInjectedAt }) => {
    if (lastInjectedAt !== null || sessionStarts.length === 0) return undefined;
    const blocks: string[] = [];
    for (const sessionStart of sessionStarts) {
      const registeredSkill = skills.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
      if (registeredSkill === undefined) {
        logger.warn('plugin sessionStart skill not found', {
          pluginId: sessionStart.pluginId,
          skillName: sessionStart.skillName,
        });
        continue;
      }
      blocks.push(
        renderSessionStartBlock(
          sessionStart,
          registeredSkill,
          skills.renderSkillPrompt(registeredSkill, ''),
        ),
      );
    }
    return blocks.length === 0 ? undefined : blocks.join('\n');
  });
}

function renderSessionStartBlock(
  sessionStart: EnabledPluginSessionStart,
  registeredSkill: SkillDefinition,
  skillContent: string,
): string {
  return (
    `<plugin_session_start plugin="${escapeXmlAttr(sessionStart.pluginId)}" ` +
    `skill="${escapeXmlAttr(registeredSkill.name)}">\n${skillContent}\n</plugin_session_start>`
  );
}

async function injectDynamic(injector: IContextInjector): Promise<void> {
  await (injector as unknown as InjectableDynamicInjector).inject();
}

function lastReminder(context: IContextMemory): string {
  const last = context.get().findLast((message) => message.role === 'user');
  return last?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

describe('plugin session-start dynamic injection', () => {
  let context: IContextMemory;
  let ctx: TestAgentContext | undefined;
  let injector: IContextInjector;
  let logger: RecordingLogger;
  let skills: SessionSkillRegistry;
  let warnings: CapturedWarn[];

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  describe('with plugin instructions', () => {
    beforeEach(() => {
      warnings = [];
      logger = recordingLogger(warnings);
      skills = new SessionSkillRegistry();
      skills.register(skill('using-superpowers', 'body of skill', {
        id: 'superpowers',
        instructions: 'Use AskUserQuestion and TodoList.',
      }));
      ctx = createTestAgent(skillServices(skills), logServices(logger));
      context = ctx.get(IContextMemory);
      injector = ctx.get(IContextInjector);
      registerPluginSessionStartInjection(
        injector,
        [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
        skills,
        logger,
      );
    });

    it('injects one <plugin_session_start> block per declared sessionStart on first call', async () => {
      await injectDynamic(injector);

      const text = lastReminder(context);
      expect(text).toContain('<plugin_session_start plugin="superpowers" skill="using-superpowers">');
      expect(text).toContain('<kimi-plugin-instructions plugin="superpowers">');
      expect(text).toContain('AskUserQuestion');
      expect(text).toContain('TodoList');
      expect(text).toContain('body of skill');
      expect(text).toContain('</plugin_session_start>');
      expect(context.get().at(-1)?.origin).toEqual({
        kind: 'injection',
        variant: 'plugin_session_start',
      });
    });
  });

  describe('without plugin instructions', () => {
    beforeEach(() => {
      warnings = [];
      logger = recordingLogger(warnings);
      skills = new SessionSkillRegistry();
      skills.register(skill('using-superpowers', 'body', { id: 'superpowers' }));
      ctx = createTestAgent(skillServices(skills), logServices(logger));
      context = ctx.get(IContextMemory);
      injector = ctx.get(IContextInjector);
      registerPluginSessionStartInjection(
        injector,
        [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
        skills,
        logger,
      );
    });

    it('does not hard-code Superpowers guidance when the skill has no plugin instructions', async () => {
      await injectDynamic(injector);

      const text = lastReminder(context);
      expect(text).toContain('<plugin_session_start plugin="superpowers" skill="using-superpowers">');
      expect(text).toContain('body');
      expect(text).not.toContain('<kimi-plugin-instructions plugin="superpowers">');
      expect(text).not.toContain('AskUserQuestion');
    });
  });

  describe('single-session idempotency', () => {
    beforeEach(() => {
      warnings = [];
      logger = recordingLogger(warnings);
      skills = new SessionSkillRegistry();
      skills.register(skill('using-superpowers', 'body', { id: 'superpowers' }));
      ctx = createTestAgent(skillServices(skills), logServices(logger));
      context = ctx.get(IContextMemory);
      injector = ctx.get(IContextInjector);
      registerPluginSessionStartInjection(
        injector,
        [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
        skills,
        logger,
      );
    });

    it('does not re-inject on subsequent calls within the same session', async () => {
      await injectDynamic(injector);
      await injectDynamic(injector);

      expect(context.get()).toHaveLength(1);
    });
  });

  describe('replayed session-start history', () => {
    beforeEach(() => {
      warnings = [];
      logger = recordingLogger(warnings);
      skills = new SessionSkillRegistry();
      skills.register(skill('using-superpowers', 'body', { id: 'superpowers' }));
      ctx = createTestAgent(skillServices(skills), logServices(logger));
      context = ctx.get(IContextMemory);
      injector = ctx.get(IContextInjector);
      context.splice(0, 0, [
        {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>old</system-reminder>' }],
          toolCalls: [],
          origin: { kind: 'injection', variant: 'plugin_session_start' },
        },
      ]);
      registerPluginSessionStartInjection(
        injector,
        [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
        skills,
        logger,
      );
    });

    it('does not re-inject when a replayed history already contains plugin sessionStart', async () => {
      await injectDynamic(injector);

      expect(context.get()).toHaveLength(1);
    });
  });

  describe('missing session-start skill', () => {
    beforeEach(() => {
      warnings = [];
      logger = recordingLogger(warnings);
      skills = new SessionSkillRegistry();
      skills.register(skill('using-superpowers', 'body', { id: 'superpowers' }));
      ctx = createTestAgent(skillServices(skills), logServices(logger));
      context = ctx.get(IContextMemory);
      injector = ctx.get(IContextInjector);
      registerPluginSessionStartInjection(
        injector,
        [
          { pluginId: 'demo', skillName: 'missing' },
          { pluginId: 'superpowers', skillName: 'using-superpowers' },
        ],
        skills,
        logger,
      );
    });

    it('skips a sessionStart whose skill is not registered and warns', async () => {
      await injectDynamic(injector);

      const text = lastReminder(context);
      expect(text).not.toContain('plugin="demo"');
      expect(text).toContain('plugin="superpowers"');
      expect(warnings).toContainEqual(
        expect.objectContaining({
          message: 'plugin sessionStart skill not found',
          payload: expect.objectContaining({ pluginId: 'demo', skillName: 'missing' }),
        }),
      );
    });
  });

  describe('empty declarations', () => {
    beforeEach(() => {
      warnings = [];
      logger = recordingLogger(warnings);
      skills = new SessionSkillRegistry();
      ctx = createTestAgent(skillServices(skills), logServices(logger));
      context = ctx.get(IContextMemory);
      injector = ctx.get(IContextInjector);
      registerPluginSessionStartInjection(injector, [], skills, logger);
    });

    it('emits nothing when no sessionStart declarations are present', async () => {
      await injectDynamic(injector);

      expect(context.get()).toEqual([]);
    });
  });

  describe('colliding skill names', () => {
    beforeEach(() => {
      warnings = [];
      logger = recordingLogger(warnings);
      skills = new SessionSkillRegistry();
      skills.register(skill('using-superpowers', 'project body'));
      skills.register(skill('using-superpowers', 'plugin body', { id: 'superpowers' }));
      ctx = createTestAgent(skillServices(skills), logServices(logger));
      context = ctx.get(IContextMemory);
      injector = ctx.get(IContextInjector);
      registerPluginSessionStartInjection(
        injector,
        [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
        skills,
        logger,
      );
    });

    it('resolves sessionStart skills by plugin identity when names collide', async () => {
      await injectDynamic(injector);

      const text = lastReminder(context);
      expect(text).toContain('plugin body');
      expect(text).not.toContain('project body');
    });
  });
});
