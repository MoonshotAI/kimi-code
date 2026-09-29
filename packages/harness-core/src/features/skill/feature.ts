import {
  ConfigRef,
  createFeature,
  createHistoryMessageBuilder,
  useAgent,
  useAgentTools,
  useConfigSection,
  useSession,
  useSystemPrompt,
  type BundledSkillActivation,
  type ContentPart,
  type ContentPartMeta,
  type FeatureSpec,
  type PromptFileAttachment,
  type SkillPartMeta,
  type UserMessage,
  type UserMeta,
} from '@moonshot-ai/agent-core';
import {
  computed,
  createToken,
  inject,
  pushCleanup,
  useCollection,
  useExpose,
  useFire,
  useNode,
  useReady,
  watch,
  type RuntimeEvent,
} from '@moonshot-ai/agent-core/kernel/index';

import type { OsFsPort } from '#/features/os/host/index';

import { InMemorySkillCatalog } from './catalog/registry';
import {
  isUserActivatableSkillType,
  summarizeSkill,
  type SkillDefinition,
  type SkillSource,
  type SkillSummary,
  type SkippedSkill,
} from './catalog/types';
import { renderSkillsSection, renderUserSlashSkillPrompt, type SkillPromptTrigger } from './prompt';
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

export const SkillCatalogRef = createToken<SkillCatalogFace>('skill');

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

export const SkillRef = createToken<SkillFace>('skill.agent');

export interface CreateSkillProps {
  readonly workDir: string;
  readonly fs?: OsFsPort;
  readonly home?: string;
  readonly explicitDirs?: readonly string[];
  readonly sources?: readonly SkillCatalogSource[];
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

export function createSkill(props: CreateSkillProps): FeatureSpec<SkillEvent> {
  return createFeature<SkillEvent>('skill', {
    app() {
      const node = useNode();
      const fire = useFire();
      useConfigSection(extraSkillDirsSection);
      useConfigSection(mergeAllAvailableSkillsSection);
      useConfigSection(builtinProductSkillsSection);

      const configEntries = node.providerRef(ConfigRef);
      const extraDirs = computed(
        () =>
          configEntries.value.at(-1)?.value.section<string[]>(EXTRA_SKILL_DIRS_SECTION).value ??
          [],
      );
      const mergeAll = computed(
        () =>
          configEntries.value.at(-1)?.value.section<boolean>(MERGE_ALL_AVAILABLE_SKILLS_SECTION)
            .value ?? true,
      );
      const builtinProduct = computed(
        () =>
          configEntries.value.at(-1)?.value.section<boolean>(BUILTIN_PRODUCT_SKILLS_SECTION)
            .value ?? true,
      );

      useSkillSource(createBuiltinSkillSource({ productSkillsEnabled: () => builtinProduct.value }));
      const fs = props.fs;
      if (fs !== undefined) {
        const homeDir = props.home ?? process.env['KIMI_CODE_HOME'];
        const deps: SharedSkillSourceDeps = {
          fs,
          workDir: props.workDir,
          osHomeDir: props.home ?? homeDir,
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
            fire({ type: 'skill.changed', sourceId: source.id });
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
        await configEntries.value.at(-1)?.value.reload();
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
        for (const id of ids) fire({ type: 'skill.changed', sourceId: id });
      };

      const subscribed = new Set<string>();
      const syncSubscriptions = (): void => {
        for (const source of sources.value) {
          if (subscribed.has(source.id) || source.onDidChange === undefined) continue;
          subscribed.add(source.id);
          pushCleanup(
            node,
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
        node.trackReady(run);
        return run;
      };

      syncSubscriptions();
      const initial = enqueue(loadAll);
      useReady(initial);

      watch(sources, () => {
        syncSubscriptions();
        void enqueue(async () => {
          await loadAll();
          fire({ type: 'skill.changed', sourceId: 'catalog' });
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
            fire({ type: 'skill.changed', sourceId: 'catalog' });
          }),
      });
    },
    agent() {
      const catalog = inject(SkillCatalogRef);
      const agent = useAgent();
      const session = useSession();
      const fire = useFire();

      const listing = catalog.getModelSkillListing();
      if (listing.length > 0) {
        useSystemPrompt({ id: 'skill-listing', text: renderSkillsSection(listing) });
      }

      useAgentTools(
        createSkillTool({
          catalog,
          agentId: agent.agentId,
          sessionId: session.sessionId,
          fire,
          submit: (message, meta) => agent.submit(message, meta),
        }),
      );

      const isBusy = (): boolean => {
        const snapshot = agent.snapshot.value;
        return snapshot !== undefined && snapshot.matches('running');
      };

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
                sessionId: session.sessionId,
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
          agentId: agent.agentId,
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
        const meta: UserMeta = { promptId, origin };
        agent.submit(message, meta);
      };

      const waitTurnStarted = (promptId: string): Promise<number> =>
        agent
          .wait('turn.started', { match: (event) => event.queueItemId === promptId })
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
