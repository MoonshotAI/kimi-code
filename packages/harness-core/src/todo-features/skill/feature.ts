import { createFeature, useAgent, useSession, useSystemPrompt, type Feature, useAgentTools } from '#/app/index';
import {
  createHistoryMessageBuilder,
  createUserEntry,
  type BundledSkillActivation,
  type PromptFileAttachment,
  type SkillPartMeta,
  type UserMeta,
} from '@moonshot-ai/agent-core/history/index';
import {
  computed,
  createFacadeToken,
  useCollection,
  useCleanup,
  useExpose,
  useFire,
  useInject,
  useReady,
  watch,
  type RuntimeEvent,
} from '#/composition-api/index';
import { currentUnit } from '#/composition-api/runtime';
import type { ContentPart, ContentPartMeta, UserMessage } from '@moonshot-ai/agent-core/llm/message';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { ConfigRef, useConfigSection } from '#/todo-features/config/index';
import type { OsFsPort } from '#/todo-features/os/host/index';

import { InMemorySkillCatalog } from './catalog/registry';
import {
  isUserActivatableSkillType,
  summarizeSkill,
  type SkillDefinition,
  type SkillSource,
  type SkillSummary,
  type SkippedSkill,
} from './catalog/types';
import { renderSkillsSection, renderUserSlashSkillPrompt, skillsChangeText, type SkillPromptTrigger } from './prompt';
import {
  BUILTIN_PRODUCT_SKILLS_SECTION,
  builtinProductSkillsSection,
  createBuiltinSkillSource,
} from './sources/builtin';
import {
  createExplicitSkillSource,
  createExtraSkillSource,
  createUserSkillSource,
  createWorkspaceSkillSource,
  EXTRA_SKILL_DIRS_SECTION,
  extraSkillDirsSection,
  EXTRA_SKILL_SOURCE_ID,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  mergeAllAvailableSkillsSection,
  USER_SKILL_SOURCE_ID,
  WORKSPACE_SKILL_SOURCE_ID,
  type SharedSkillSourceDeps,
} from './sources/files';
import {
  BUILTIN_SKILL_SOURCE_ID,
  SkillSources,
  useSkillSource,
  type SkillCatalogSource,
  type SkillContribution,
} from './sources/source';
import { createSkillTool, type SkillActivationOrigin } from './tool';

export interface SkillActivatedEvent extends RuntimeEvent {
  readonly type: 'skill.activated';
  readonly agentId: string;
  readonly activationId: string;
  readonly skillName: string;
  readonly trigger: SkillPromptTrigger;
  readonly skillArgs?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export interface SkillChangedEvent extends RuntimeEvent {
  readonly type: 'skill.changed';
  readonly sourceId: string;
}

export type SkillEvent = SkillActivatedEvent | SkillChangedEvent;

export interface SkillCatalogFace {
  readonly ready: Promise<void>;
  onDidChange(listener: () => void): () => void;
  list(): SkillSummary[];
  get(name: string): SkillDefinition | undefined;
  renderSkillPrompt(
    skill: SkillDefinition,
    rawArgs: string,
    context?: { readonly sessionId?: string },
  ): string;
  getModelSkillListing(): string;
  getKimiSkillsDescription(): string;
  listInvocableSkills(): SkillSummary[];
  roots(): readonly string[];
  skipped(): readonly SkippedSkill[];
  reload(): Promise<void>;
}

export const SkillCatalogRef = createFacadeToken<SkillCatalogFace>('skill');

export const SKILL_LISTING_CHANGE_REMIND_KEY = 'skill-listing-change';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
  readonly content?: ContentPart[];
}

export interface PromptSkillActivation {
  readonly name: string;
  readonly args?: string;
}

export interface PromptWithSkillsInput {
  readonly input: ContentPart[];
  readonly skills: readonly PromptSkillActivation[];
  readonly attachments?: readonly PromptFileAttachment[];
}

export interface SkillFace {
  activate(input: SkillActivationInput): Promise<{ turnId?: number }>;
  promptWithSkills(input: PromptWithSkillsInput): Promise<{ turnId?: number }>;
}

export const SkillRef = createFacadeToken<SkillFace>('skill.agent');

const _HOME: string | undefined = undefined;

const _EXPERIMENTAL_FLAG_ENABLED = (): boolean => false;

export interface CreateSkillProps {
  readonly workDir: string;
  readonly fs?: OsFsPort;
  readonly HOME?: string;
  readonly explicitDirs?: readonly string[];
  readonly sources?: readonly SkillCatalogSource[];
  readonly EXPERIMENTAL_FLAG_ENABLED?: (flag: string) => boolean;
}

interface PreparedActivation {
  readonly origin: SkillActivationOrigin;
  readonly part: ContentPart;
  readonly entry: BundledSkillActivation;
}

export interface BundledSkillPromptOrigin {
  readonly kind: 'user';
  readonly skillActivations: readonly BundledSkillActivation[];
  readonly attachments?: readonly PromptFileAttachment[];
}

type SkillPromptOrigin = SkillActivationOrigin | BundledSkillPromptOrigin;

export function createSkill(props: CreateSkillProps): Feature<void, { app: SkillChangedEvent; agent: SkillActivatedEvent }> {
  return createFeature<{ app: SkillChangedEvent; agent: SkillActivatedEvent }>('skill', {
    app() {
      const node = currentUnit();
      const fire = useFire();
      const listeners = new Set<() => void>();
      const changed = (sourceId: string): void => {
        fire({ type: 'skill.changed', sourceId });
        for (const listener of listeners) {
          try {
            listener();
          } catch {}
        }
      };
      useConfigSection(extraSkillDirsSection);
      useConfigSection(mergeAllAvailableSkillsSection);
      useConfigSection(builtinProductSkillsSection);

      const config = useInject(ConfigRef);
      const extraDirs = computed(
        () =>
          config.value?.section<string[]>(EXTRA_SKILL_DIRS_SECTION).value ??
          [],
      );
      const mergeAll = computed(
        () =>
          config.value?.section<boolean>(MERGE_ALL_AVAILABLE_SKILLS_SECTION)
            .value ?? true,
      );
      const builtinProduct = computed(
        () =>
          config.value?.section<boolean>(BUILTIN_PRODUCT_SKILLS_SECTION)
            .value ?? true,
      );

      useSkillSource(
        createBuiltinSkillSource({
          productSkillsEnabled: () => builtinProduct.value,
          experimentalFlagEnabled: props.EXPERIMENTAL_FLAG_ENABLED ?? _EXPERIMENTAL_FLAG_ENABLED,
        }),
      );
      const fs = props.fs;
      if (fs !== undefined) {
        const homeDir = props.HOME ?? _HOME;
        const deps: SharedSkillSourceDeps = {
          fs,
          workDir: props.workDir,
          osHomeDir: props.HOME ?? homeDir,
          mergeAllAvailableSkills: () => mergeAll.value,
          hasExplicitDirs: () => (props.explicitDirs?.length ?? 0) > 0,
          extraSkillDirs: () => extraDirs.value,
          explicitDirs: () => props.explicitDirs ?? [],
        };
        if (homeDir !== undefined) {
          useSkillSource(createUserSkillSource({ ...deps, homeDir }));
        }
        useSkillSource(createWorkspaceSkillSource(deps));
        useSkillSource(createExtraSkillSource(deps));
        useSkillSource(createExplicitSkillSource(deps));
      }
      for (const source of props.sources ?? []) {
        useSkillSource(source);
      }
      const sources = useCollection(SkillSources);

      const contributions = new Map<string, { c: SkillContribution; priority: number }>();
      let merged = new InMemorySkillCatalog();

      const remerge = (): void => {
        const next = new InMemorySkillCatalog();
        const ordered = [...contributions.values()].toSorted((a, b) => a.priority - b.priority);
        for (const { c } of ordered) {
          for (const skill of c.skills) next.register(skill, { replace: true });
          next.addRoots(c.scannedRoots ?? []);
          next.recordSkipped(c.skipped ?? []);
        }
        merged = next;
      };

      const loadTails = new Map<string, Promise<void>>();
      const loadSource = (source: SkillCatalogSource, fireChange = false): Promise<void> => {
        const previous = loadTails.get(source.id) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(async () => {
          const contribution = await source.load();
          contributions.set(source.id, { c: contribution, priority: source.priority });
          if (fireChange) {
            remerge();
            changed(source.id);
          }
        });
        loadTails.set(source.id, current);
        const clear = (): void => {
          if (loadTails.get(source.id) === current) loadTails.delete(source.id);
        };
        void current.then(clear, clear);
        return current;
      };

      const loadAll = async (): Promise<void> => {
        await config.value?.reload();
        const ordered = [...sources.value].toSorted((a, b) => a.priority - b.priority);
        for (const source of ordered) await loadSource(source);
        remerge();
      };

      const reloadSources = async (ids: readonly string[]): Promise<void> => {
        let loaded = false;
        for (const id of ids) {
          const source = sources.value.find((candidate) => candidate.id === id);
          if (source === undefined) continue;
          await loadSource(source);
          loaded = true;
        }
        if (!loaded) return;
        remerge();
        for (const id of ids) changed(id);
      };

      const subscribed = new Set<string>();
      const syncSubscriptions = (): void => {
        for (const source of sources.value) {
          if (subscribed.has(source.id) || source.onDidChange === undefined) continue;
          subscribed.add(source.id);
          useCleanup(
            source.onDidChange(() => {
              void loadSource(source, true).catch(() => {});
            }),
          );
        }
      };

      let chain = Promise.resolve();
      const enqueue = (op: () => Promise<void>): Promise<void> => {
        const run = chain.catch(() => {}).then(op);
        chain = run;
        node.track(run);
        return run;
      };

      syncSubscriptions();
      const initial = enqueue(loadAll);
      useReady(initial);

      watch(sources, () => {
        syncSubscriptions();
        void enqueue(async () => {
          await loadAll();
          changed('catalog');
        }).catch(() => {});
      });
      watch(mergeAll, () => {
        void enqueue(() =>
          reloadSources([USER_SKILL_SOURCE_ID, WORKSPACE_SKILL_SOURCE_ID]),
        ).catch(() => {});
      });
      watch(extraDirs, () => {
        void enqueue(() => reloadSources([EXTRA_SKILL_SOURCE_ID])).catch(() => {});
      });
      watch(builtinProduct, () => {
        void enqueue(() => reloadSources([BUILTIN_SKILL_SOURCE_ID])).catch(() => {});
      });

      useExpose(SkillCatalogRef, {
        ready: initial,
        onDidChange: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        list: () => merged.listSkills().map(summarizeSkill),
        get: (name) => merged.getSkill(name),
        renderSkillPrompt: (skill, rawArgs, context) =>
          merged.renderSkillPrompt(skill, rawArgs, context),
        getModelSkillListing: () => merged.getModelSkillListing(),
        getKimiSkillsDescription: () => merged.getKimiSkillsDescription(),
        listInvocableSkills: () => merged.listInvocableSkills().map(summarizeSkill),
        roots: () => merged.getSkillRoots(),
        skipped: () => merged.getSkippedByPolicy(),
        reload: () =>
          enqueue(async () => {
            await loadAll();
            changed('catalog');
          }),
      });
    },
    agent() {
      const catalog = useInject(SkillCatalogRef).value;
      if (catalog === undefined) {
        throw new Error('skill feature app slot is not installed');
      }
      const agent = useAgent();
      const session = useSession();
      const fire = useFire();

      const listing = catalog.getModelSkillListing();
      if (listing.length > 0) {
        useSystemPrompt({ id: 'skill-listing', text: renderSkillsSection(listing) });
      }

      if (agent.id === MAIN_AGENT_ID) {
        let baseline = listing;
        const check = (): void => {
          const current = catalog.getModelSkillListing();
          if (current === baseline) return;
          baseline = current;
          agent.loop.remind(
            createUserEntry(
              createHistoryMessageBuilder().systemReminder(skillsChangeText(current)).userMessage(),
              { source: 'reminder', key: SKILL_LISTING_CHANGE_REMIND_KEY },
            ),
          );
        };
        useCleanup(catalog.onDidChange(check));
        void catalog.ready.then(check);
      }

      useAgentTools(
        createSkillTool({
          catalog,
          agentId: agent.id,
          sessionId: session.id,
          fire,
          submit: (message, meta) =>
            agent.loop.submit(createUserEntry(message, { source: 'input', ...meta })),
        }),
      );

      const isBusy = (): boolean => agent.loop.state.status === 'running';

      const prepare = (requested: PromptSkillActivation): PreparedActivation => {
        const skill = catalog.get(requested.name);
        if (skill === undefined) {
          throw new Error(`Skill "${requested.name}" was not found`);
        }
        if (!isUserActivatableSkillType(skill.metadata.type)) {
          throw new Error(`Skill "${skill.name}" cannot be activated by the user`);
        }
        const skillArgs = requested.args ?? '';
        const activationId = crypto.randomUUID();
        const origin: SkillActivationOrigin = {
          kind: 'skill_activation',
          activationId,
          skillName: skill.name,
          trigger: 'user-slash',
          skillType: skill.metadata.type,
          skillPath: skill.path,
          skillSource: skill.source,
          skillArgs: requested.args,
        };
        const partMeta: SkillPartMeta & ContentPartMeta = {
          kind: 'skill',
          activationId,
          skillName: skill.name,
          skillArgs: requested.args,
          skillType: skill.metadata.type,
          skillPath: skill.path,
          skillSource: skill.source,
        };
        const entry: BundledSkillActivation = {
          activationId,
          skillName: skill.name,
          skillArgs: requested.args,
          skillType: skill.metadata.type,
          skillPath: skill.path,
          skillSource: skill.source,
        };
        const part = createHistoryMessageBuilder()
          .xml(
            renderUserSlashSkillPrompt({
              skillName: skill.name,
              skillArgs,
              skillContent: catalog.renderSkillPrompt(skill, skillArgs, {
                sessionId: session.id,
              }),
              skillSource: skill.source,
              skillDir: skill.dir,
            }),
            'text/xml',
            partMeta,
          )
          .parts()[0]!;
        return { origin, part, entry };
      };

      const fireActivation = (prepared: PreparedActivation): void => {
        fire({
          type: 'skill.activated',
          agentId: agent.id,
          activationId: prepared.origin.activationId,
          skillName: prepared.origin.skillName,
          trigger: prepared.origin.trigger,
          skillArgs: prepared.origin.skillArgs,
          skillPath: prepared.origin.skillPath,
          skillSource: prepared.origin.skillSource,
        });
      };

      const submitPrompt = (
        promptId: string,
        content: ContentPart[],
        origin: SkillPromptOrigin,
      ): void => {
        const message: UserMessage = { role: 'user', content };
        const meta: UserMeta = { source: 'input', promptId, origin };
        agent.loop.submit({ message, meta });
      };

      const waitTurnStarted = (promptId: string): Promise<number> =>
        agent.loop
          .wait('message.appended', {
            match: (event) =>
              event.source === 'normal' &&
              event.entry.message.role === 'user' &&
              (event.entry.meta as UserMeta | undefined)?.promptId === promptId,
          })
          .then((event) => event.turnId);

      useExpose(SkillRef, {
        activate: async (input: SkillActivationInput): Promise<{ turnId?: number }> => {
          await catalog.ready;
          const prepared = prepare(input);
          if (isBusy()) {
            throw new Error('Cannot activate skill while another turn is active');
          }
          const promptId = crypto.randomUUID();
          const started = waitTurnStarted(promptId);
          fireActivation(prepared);
          submitPrompt(promptId, [prepared.part, ...(input.content ?? [])], prepared.origin);
          return { turnId: await started };
        },
        promptWithSkills: async (input: PromptWithSkillsInput): Promise<{ turnId?: number }> => {
          if (input.input.length === 0) {
            throw new Error('promptWithSkills requires a non-empty prompt');
          }
          if (input.skills.length === 0) {
            throw new Error('promptWithSkills requires at least one skill');
          }
          await catalog.ready;
          const prepared = input.skills.map((requested) => prepare(requested));
          const busy = isBusy();
          const promptId = crypto.randomUUID();
          const started = busy ? undefined : waitTurnStarted(promptId);
          for (const activation of prepared) fireActivation(activation);
          submitPrompt(
            promptId,
            [...prepared.map((activation) => activation.part), ...input.input],
            {
              kind: 'user',
              skillActivations: prepared.map((activation) => activation.entry),
              attachments: input.attachments,
            },
          );
          if (started === undefined) return { turnId: undefined };
          return { turnId: await started };
        },
      });
    },
  });
}
