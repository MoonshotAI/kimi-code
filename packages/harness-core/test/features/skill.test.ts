import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigRef,
  createConfig,
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  useAgent,
  type AgentHandle,
  type AppHandle,
  type ConfigPersist,
  type FeatureSpec,
  type AgentLlmRequester,
  type Message,
  type SessionHandle,
  type SessionStores,
  type ToolDescription,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import {
  BUILTIN_PRODUCT_SKILLS_SECTION,
  createSkill,
  discoverSkills,
  EXTRA_SKILL_DIRS_SECTION,
  InMemorySkillCatalog,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  parseSkillText,
  projectRoots,
  SkillCatalogRef,
  SkillParseError,
  SkillRef,
  UnsupportedSkillTypeError,
  useSkillSource,
  userRoots,
  configuredRoots,
  type CreateSkillProps,
  type SkillActivatedEvent,
  type SkillCatalogFace,
  type SkillChangedEvent,
  type SkillDefinition,
  type SkillEvent,
  type SkillFace,
} from '#/features/skill/index';

import { fakeRequester, testModel, textOutcome } from '../fake-llm';

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

interface ScriptOut {
  readonly text?: string;
  readonly toolCall?: { name: string; arguments: string };
  readonly gate?: Promise<void>;
}

type LlmScript = (call: LlmCall) => ScriptOut;

function createMockRequester(script: LlmScript): { requester: AgentLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: fakeRequester(async (rest, onEvent) => {
      const call: LlmCall = {
        systemPrompt: rest.profile?.systemPrompt,
        messages: rest.content?.messages ?? [],
        tools: rest.profile?.tools ?? [],
      };
      calls.push(call);
      const out = script(call);
      if (out.gate !== undefined) await out.gate;
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      return textOutcome(
        out.text ?? '',
        out.toolCall === undefined
          ? []
          : [{ type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments }],
      );
    }),
  };
}

const singleCallScript: LlmScript = (call) => {
  const last = call.messages.at(-1);
  if (last !== undefined && last.role === 'tool') return { text: 'done' };
  const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
  if (text.startsWith('CALL:')) {
    return { toolCall: JSON.parse(text.slice('CALL:'.length)) as { name: string; arguments: string } };
  }
  return { text: `echo:${text}` };
};

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

function fakePersist(initial?: string): { saved: string[]; persist: ConfigPersist } {
  const saved: string[] = [];
  let text = initial;
  return {
    saved,
    persist: {
      load: () => Promise.resolve(text),
      save: (value) => {
        saved.push(value);
        text = value;
        return Promise.resolve();
      },
    },
  };
}

function stubSkill(
  name: string,
  overrides: Partial<Omit<SkillDefinition, 'name'>> = {},
): SkillDefinition {
  const dir = overrides.dir ?? `/skills/${name}`;
  return {
    name,
    description: overrides.description ?? `desc for ${name}`,
    path: overrides.path ?? `${dir}/SKILL.md`,
    dir,
    content: overrides.content ?? `body of ${name}`,
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? 'user',
    plugin: overrides.plugin,
    mermaid: overrides.mermaid,
    d2: overrides.d2,
  };
}

let host: OsHost;
let workDir: string;
let brandHome: string;
let osHome: string;

const tempDirs: string[] = [];

beforeEach(async () => {
  host = createNodeOsHost();
  workDir = await host.fs.realpath(await mkdtemp(join(tmpdir(), 'skill-work-')));
  brandHome = await host.fs.realpath(await mkdtemp(join(tmpdir(), 'skill-brand-')));
  osHome = await host.fs.realpath(await mkdtemp(join(tmpdir(), 'skill-oshome-')));
  tempDirs.push(workDir, brandHome, osHome);
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function writeFileUnder(base: string, rel: string, text: string): Promise<string> {
  const p = join(base, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
  return p;
}

const fm = (fields: string, body = 'body text'): string => `---\n${fields}\n---\n\n${body}\n`;

interface SkillTestEnv {
  readonly app: AppHandle;
  readonly session: SessionHandle;
  readonly stores: SessionStores;
  readonly main: AgentHandle;
  readonly calls: readonly LlmCall[];
  readonly skillFeature: FeatureSpec<SkillEvent>;
  readonly catalog: () => SkillCatalogFace;
  readonly skill: () => SkillFace;
  readonly runTurn: (text: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

async function startSkillApp(options?: {
  readonly toml?: string;
  readonly env?: Record<string, string | undefined>;
  readonly withConfig?: boolean;
  readonly noFs?: boolean;
  readonly skillProps?: Partial<CreateSkillProps>;
  readonly script?: LlmScript;
  readonly extraFeatures?: readonly FeatureSpec[];
}): Promise<SkillTestEnv> {
  const env = await testStores();
  const { requester, calls } = createMockRequester(options?.script ?? singleCallScript);
  const skillFeature = createSkill({
    workDir,
    ...(options?.noFs === true ? {} : { fs: host.fs, home: brandHome }),
    ...options?.skillProps,
  });
  const features: FeatureSpec[] = [
    ...(options?.withConfig === false
      ? []
      : [createConfig({ persist: fakePersist(options?.toml).persist, env: options?.env ?? {} })]),
    skillFeature,
    bindTestLlm(requester),
    ...(options?.extraFeatures ?? []),
  ];
  const app = createHarness({ features });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores: env.stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  await main.ready();
  const runTurn = async (text: string): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      main.on('turn.done', () => {
        resolve();
      });
    });
    main.submit(createUserMessage(text));
    await done;
    await env.stores.flush();
  };
  return {
    app,
    session,
    stores: env.stores,
    main,
    calls,
    skillFeature,
    catalog: () => app.resolve(SkillCatalogRef),
    skill: () => main.resolve(SkillRef),
    runTurn,
    dispose: async () => {
      await app.disposeAsync();
      await env.stores.dispose();
    },
  };
}

function historyEntries(stores: SessionStores) {
  return stores.get(MAIN_AGENT_ID)?.getState().history ?? [];
}

function toolResultTexts(stores: SessionStores): string[] {
  return historyEntries(stores)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(stores: SessionStores): boolean[] {
  return historyEntries(stores)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function waitTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise<void>((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

describe('parseSkillText', () => {
  it('normalizes metadata aliases and trims fields', () => {
    const skill = parseSkillText({
      skillMdPath: '/x/commit/SKILL.md',
      skillDirName: 'commit',
      source: 'project',
      text: fm(
        'name: commit\ndescription: Create commits\nwhen-to-use: When committing\ndisable_model_invocation: true',
      ),
    });
    expect(skill.metadata.whenToUse).toBe('When committing');
    expect(skill.metadata.disableModelInvocation).toBe(true);
    expect(skill.name).toBe('commit');
    expect(skill.source).toBe('project');
    expect(skill.content).toBe('body text');
  });

  it('rejects a directory skill without frontmatter', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/x/commit/SKILL.md',
        skillDirName: 'commit',
        source: 'user',
        text: 'no fence here\n',
      }),
    ).toThrowError(new SkillParseError('Missing frontmatter in /x/commit/SKILL.md').message);
  });

  it('rejects invalid frontmatter yaml and non-mapping frontmatter', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/x/a/SKILL.md',
        skillDirName: 'a',
        source: 'user',
        text: '---\n: bad: [yaml\n---\nbody\n',
      }),
    ).toThrowError(/^Invalid frontmatter in \/x\/a\/SKILL\.md: /);
    expect(() =>
      parseSkillText({
        skillMdPath: '/x/a/SKILL.md',
        skillDirName: 'a',
        source: 'user',
        text: '---\n- just\n- a\n- list\n---\nbody\n',
      }),
    ).toThrowError('Frontmatter in /x/a/SKILL.md must be a mapping at the top level');
  });

  it('rejects a directory skill missing name or description', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/x/a/SKILL.md',
        skillDirName: 'a',
        source: 'user',
        text: fm('description: only desc'),
      }),
    ).toThrowError('Missing required frontmatter field "name" in /x/a/SKILL.md');
    expect(() =>
      parseSkillText({
        skillMdPath: '/x/a/SKILL.md',
        skillDirName: 'a',
        source: 'user',
        text: fm('name: a'),
      }),
    ).toThrowError('Missing required frontmatter field "description" in /x/a/SKILL.md');
  });

  it('rejects unsupported skill types with the verbatim message', () => {
    const error = catchError(() =>
      parseSkillText({
        skillMdPath: '/x/a/SKILL.md',
        skillDirName: 'a',
        source: 'user',
        text: fm('name: a\ndescription: d\ntype: agent'),
      }),
    );
    expect(error).toBeInstanceOf(UnsupportedSkillTypeError);
    expect((error as Error).message).toBe(
      'Skill type "agent" is not supported; only "prompt", "inline", and "flow" are supported.',
    );
  });

  it('extracts mermaid and d2 flowcharts from the body', () => {
    const skill = parseSkillText({
      skillMdPath: '/x/flow/SKILL.md',
      skillDirName: 'flow',
      source: 'user',
      text: fm('name: flow\ndescription: d', 'intro\n```mermaid\ngraph TD; A-->B\n```\nmiddle\n```d2\na -> b\n```\n'),
    });
    expect(skill.mermaid).toBe('graph TD; A-->B');
    expect(skill.d2).toBe('a -> b');
  });

  it('derives name and description for file skills without frontmatter', () => {
    const skill = parseSkillText({
      skillMdPath: '/x/plain.md',
      skillDirName: 'plain',
      source: 'extra',
      text: 'First line is the description.\n\nrest of the body\n',
    });
    expect(skill.name).toBe('plain');
    expect(skill.description).toBe('First line is the description.');
    expect(skill.content).toBe('First line is the description.\n\nrest of the body');
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

describe('InMemorySkillCatalog', () => {
  it('keeps the first registration unless replace is requested, case-insensitively', () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(stubSkill('Commit', { description: 'first' }));
    catalog.register(stubSkill('commit', { description: 'second' }));
    expect(catalog.getSkill('COMMIT')?.description).toBe('first');
    catalog.register(stubSkill('commit', { description: 'second' }), { replace: true });
    expect(catalog.getSkill('commit')?.description).toBe('second');
  });

  it('expands the full argument placeholder family with quote-aware tokenization', () => {
    const catalog = new InMemorySkillCatalog();
    const skill = stubSkill('args', {
      content: 'named=$name zero=$0 one=$1 indexed=$ARGUMENTS[1] all=$ARGUMENTS',
      metadata: { arguments: 'name' },
    });
    const rendered = catalog.renderSkillPrompt(skill, 'one "two three"');
    expect(rendered).toBe('named=one zero=one one=two three indexed=two three all=one "two three"');
  });

  it('appends a trailing ARGUMENTS line when the body has no placeholder', () => {
    const catalog = new InMemorySkillCatalog();
    const rendered = catalog.renderSkillPrompt(stubSkill('plain', { content: 'static body' }), 'a b');
    expect(rendered).toBe('static body\n\nARGUMENTS: a b');
  });

  it('escapes xml tags in substituted arguments', () => {
    const catalog = new InMemorySkillCatalog();
    const rendered = catalog.renderSkillPrompt(stubSkill('xml', { content: 'got $ARGUMENTS' }), '<b>&ok</b>');
    expect(rendered).toBe('got &lt;b&gt;&ok&lt;/b&gt;');
  });

  it('expands KIMI_SKILL_DIR and KIMI_SESSION_ID', () => {
    const catalog = new InMemorySkillCatalog();
    const skill = stubSkill('dirs', {
      content: 'dir=${KIMI_SKILL_DIR} sess=${KIMI_SESSION_ID}',
      dir: '/skills/dirs',
    });
    expect(catalog.renderSkillPrompt(skill, '', { sessionId: 'sess-1' })).toBe(
      'dir=/skills/dirs sess=sess-1',
    );
    expect(catalog.renderSkillPrompt(skill, '')).toBe('dir=/skills/dirs sess=');
  });

  it('wraps plugin instructions around the rendered content', () => {
    const catalog = new InMemorySkillCatalog();
    const skill = stubSkill('plug', {
      plugin: { id: 'p"id', instructions: 'follow plugin rules' },
    });
    expect(catalog.renderSkillPrompt(skill, '')).toBe(
      '<plugin-instructions plugin="p&quot;id">\nfollow plugin rules\n</plugin-instructions>\n\nbody of plug',
    );
  });

  it('renders the model listing grouped by source with the DISREGARD header', () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(stubSkill('alpha', { source: 'project', metadata: { whenToUse: 'When alpha' } }));
    catalog.register(stubSkill('beta', { source: 'user' }));
    catalog.register(stubSkill('gamma', { source: 'extra' }));
    catalog.register(stubSkill('delta', { source: 'builtin' }));
    catalog.register(stubSkill('hidden', { metadata: { disableModelInvocation: true } }));
    catalog.register(stubSkill('sub', { metadata: { isSubSkill: true } }));
    catalog.register(stubSkill('flowy', { metadata: { type: 'flow' } }));
    const listing = catalog.getModelSkillListing();
    const lines = listing.split('\n');
    expect(lines[0]).toBe('DISREGARD any earlier skill listings. Current available skills:');
    const headers = lines.filter((line) => line.startsWith('### '));
    expect(headers).toEqual(['### Project', '### User', '### Extra', '### Built-in']);
    expect(listing).toContain('- alpha: desc for alpha');
    expect(listing).toContain('  When to use: When alpha');
    expect(listing).toContain('  Path: /skills/alpha/SKILL.md');
    expect(listing).not.toContain('hidden');
    expect(listing).not.toContain('- sub:');
    expect(listing).not.toContain('flowy');
    expect(new InMemorySkillCatalog().getModelSkillListing()).toBe('');
  });

  it('truncates listing descriptions at 250 graphemes', () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(stubSkill('long', { description: 'x'.repeat(300) }));
    const line = catalog
      .getModelSkillListing()
      .split('\n')
      .find((entry) => entry.startsWith('- long:'))!;
    const desc = line.slice('- long:'.length + 1);
    expect(desc.endsWith('...')).toBe(true);
    expect(desc.length).toBe(250);
  });

  it('renders the full kimi skills description and the empty fallback', () => {
    const catalog = new InMemorySkillCatalog();
    expect(catalog.getKimiSkillsDescription()).toBe('No skills');
    catalog.register(stubSkill('alpha', { source: 'project' }));
    const rendered = catalog.getKimiSkillsDescription();
    expect(rendered).toContain('### Project');
    expect(rendered).toContain('- alpha');
    expect(rendered).toContain('  - Path: /skills/alpha/SKILL.md');
    expect(rendered).toContain('  - Description: desc for alpha');
  });
});

describe('skill roots', () => {
  it('merges brand and generic user roots with the brand root ordered first', async () => {
    await mkdir(join(brandHome, 'skills'), { recursive: true });
    await mkdir(join(osHome, '.agents', 'skills'), { recursive: true });
    const merged = await userRoots(host.fs, brandHome, osHome);
    expect(merged.map((root) => root.path)).toEqual([
      join(brandHome, 'skills'),
      join(osHome, '.agents', 'skills'),
    ]);
    const firstExistingBrand = await userRoots(host.fs, brandHome, osHome, {
      mergeAllAvailableSkills: false,
    });
    expect(firstExistingBrand.map((root) => root.path)).toEqual([
      join(brandHome, 'skills'),
      join(osHome, '.agents', 'skills'),
    ]);
    expect(merged.every((root) => root.source === 'user')).toBe(true);
  });

  it('falls back to the generic user root when the brand root is missing', async () => {
    await mkdir(join(osHome, '.agents', 'skills'), { recursive: true });
    const roots = await userRoots(host.fs, brandHome, osHome, { mergeAllAvailableSkills: false });
    expect(roots.map((root) => root.path)).toEqual([join(osHome, '.agents', 'skills')]);
  });

  it('finds project roots by walking up to the .git marker', async () => {
    const projectRoot = join(workDir, 'repo');
    const nested = join(projectRoot, 'packages', 'app');
    await mkdir(join(projectRoot, '.git'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(join(projectRoot, '.kimi-code', 'skills'), { recursive: true });
    await mkdir(join(projectRoot, '.agents', 'skills'), { recursive: true });
    const roots = await projectRoots(host.fs, nested);
    expect(roots.map((root) => root.path)).toEqual([
      join(projectRoot, '.kimi-code', 'skills'),
      join(projectRoot, '.agents', 'skills'),
    ]);
    expect(roots.every((root) => root.source === 'project')).toBe(true);
  });

  it('resolves configured roots with ~ expansion and relative resolution', async () => {
    const projectRoot = join(workDir, 'repo');
    await mkdir(join(projectRoot, '.git'), { recursive: true });
    await mkdir(join(projectRoot, 'rel-skills'), { recursive: true });
    await mkdir(join(osHome, 'home-skills'), { recursive: true });
    await mkdir(join(workDir, 'abs-skills'), { recursive: true });
    const roots = await configuredRoots(
      host.fs,
      ['~', '~/home-skills', 'rel-skills', join(workDir, 'abs-skills'), join(workDir, 'missing')],
      projectRoot,
      osHome,
      'extra',
    );
    expect(roots.map((root) => root.path)).toEqual([
      osHome,
      join(osHome, 'home-skills'),
      join(projectRoot, 'rel-skills'),
      join(workDir, 'abs-skills'),
    ]);
    expect(roots.every((root) => root.source === 'extra')).toBe(true);
  });
});

describe('discoverSkills', () => {
  it('walks nested roots with exclusions, depth cap, and directory-skill precedence', async () => {
    const root = join(workDir, 'scan');
    await writeFileUnder(root, 'alpha/SKILL.md', fm('name: alpha\ndescription: A'));
    await writeFileUnder(root, 'beta.md', 'Beta description line.\n');
    await writeFileUnder(root, 'gamma.md', fm('name: gamma\ndescription: file gamma'));
    await writeFileUnder(root, 'gamma/SKILL.md', fm('name: gamma\ndescription: dir gamma'));
    await writeFileUnder(root, 'node_modules/hidden/SKILL.md', fm('name: hidden\ndescription: H'));
    await writeFileUnder(root, '.dot/hidden/SKILL.md', fm('name: dot\ndescription: D'));
    await writeFileUnder(root, 'nested/inner.md', 'Inner never discovered.\n');
    let depthPath = root;
    for (const level of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']) {
      depthPath = join(depthPath, level);
    }
    await writeFileUnder(depthPath, 'deep/SKILL.md', fm('name: deep\ndescription: too deep'));

    const result = await discoverSkills(host.fs, [{ path: root, source: 'project' }]);
    const byName = new Map(result.skills.map((skill) => [skill.name, skill]));
    expect([...byName.keys()].toSorted()).toEqual(['alpha', 'beta', 'gamma']);
    expect(byName.get('gamma')?.description).toBe('dir gamma');
    expect(byName.get('beta')?.description).toBe('Beta description line.');
    expect(result.scannedRoots).toEqual([root]);
  });

  it('qualifies sub-skill names under has-sub-skill bundles and marks them', async () => {
    const root = join(workDir, 'bundles');
    await writeFileUnder(
      root,
      'parent/SKILL.md',
      fm('name: parent\ndescription: P\nhas-sub-skill: true'),
    );
    await writeFileUnder(root, 'parent/review/SKILL.md', fm('name: review\ndescription: R'));
    await writeFileUnder(root, 'plain/SKILL.md', fm('name: plain\ndescription: PL'));
    await writeFileUnder(root, 'plain/inner/SKILL.md', fm('name: inner\ndescription: I'));

    const result = await discoverSkills(host.fs, [{ path: root, source: 'user' }]);
    const byName = new Map(result.skills.map((skill) => [skill.name, skill]));
    expect([...byName.keys()].toSorted()).toEqual(['parent', 'parent.review', 'plain']);
    expect(byName.get('parent.review')?.metadata.isSubSkill).toBe(true);
  });

  it('collects unsupported types into skipped and keeps the first same-name skill', async () => {
    const root = join(workDir, 'mixed');
    await writeFileUnder(root, 'agentic/SKILL.md', fm('name: agentic\ndescription: A\ntype: agent'));
    await writeFileUnder(root, 'dup/SKILL.md', fm('name: dup\ndescription: first'));
    await writeFileUnder(root, 'more/dup/SKILL.md', fm('name: dup\ndescription: second'));

    const result = await discoverSkills(host.fs, [{ path: root, source: 'extra' }]);
    expect(result.skills.map((skill) => [skill.name, skill.description])).toEqual([
      ['dup', 'first'],
    ]);
    expect(result.skipped).toEqual([
      {
        path: join(root, 'agentic', 'SKILL.md'),
        type: 'agent',
        reason: 'unsupported skill type "agent"',
      },
    ]);
  });

  it('honors root-skill-only scan mode', async () => {
    const root = join(workDir, 'single');
    await writeFileUnder(root, 'SKILL.md', fm('name: single\ndescription: S'));
    await writeFileUnder(root, 'child/SKILL.md', fm('name: child\ndescription: C'));
    const result = await discoverSkills(host.fs, [
      { path: root, source: 'extra', plugin: { id: 'p1' }, scanMode: 'root-skill-only' },
    ]);
    expect(result.skills.map((skill) => skill.name)).toEqual(['single']);
    expect(result.skills[0]?.plugin?.id).toBe('p1');
  });
});

const BUILTIN_SKILL_NAMES = [
  'check-kimi-code-docs',
  'custom-theme',
  'import-from-cc-codex',
  'mcp-config',
  'sub-skill',
  'sub-skill.consolidate',
  'sub-skill.review',
  'update-config',
  'write-goal',
];

async function makeProjectSkill(): Promise<void> {
  await mkdir(join(workDir, '.git'), { recursive: true });
  await writeFileUnder(
    workDir,
    '.kimi-code/skills/commit/SKILL.md',
    fm('name: commit\ndescription: Create a git commit\nwhen-to-use: When committing', 'Commit with message: $ARGUMENTS'),
  );
}

describe('createSkill app slot', () => {
  it('loads only builtin skills when no fs is provided', async () => {
    const env = await startSkillApp({ noFs: true });
    expect(env.catalog().list().map((skill) => skill.name).toSorted()).toEqual(BUILTIN_SKILL_NAMES);
    expect(env.catalog().roots()).toEqual([]);
    await env.dispose();
  });

  it('gates app readiness on the initial catalog load and exposes the facade', async () => {
    await makeProjectSkill();
    const env = await startSkillApp();
    const catalog = env.catalog();
    await catalog.ready;
    expect(catalog.list().map((skill) => skill.name).toSorted()).toEqual(
      [...BUILTIN_SKILL_NAMES, 'commit'].toSorted(),
    );
    const commit = catalog.get('commit')!;
    expect(commit.source).toBe('project');
    expect(catalog.roots()).toEqual([join(workDir, '.kimi-code', 'skills')]);
    expect(catalog.renderSkillPrompt(commit, 'fix bug', { sessionId: 'sess' })).toBe(
      'Commit with message: fix bug',
    );
    expect(catalog.listInvocableSkills().map((skill) => skill.name)).toEqual([
      'check-kimi-code-docs',
      'commit',
      'update-config',
      'write-goal',
    ]);
    expect(catalog.getModelSkillListing()).toContain('- commit: Create a git commit');
    expect(catalog.getModelSkillListing()).toContain('- check-kimi-code-docs:');
    expect(catalog.getKimiSkillsDescription()).toContain('### Project');
    await env.dispose();
  });

  it('registers the three config sections with defaults and the env binding', async () => {
    const env = await startSkillApp();
    const config = env.app.resolve(ConfigRef);
    expect(config.get(EXTRA_SKILL_DIRS_SECTION)).toEqual([]);
    expect(config.get(MERGE_ALL_AVAILABLE_SKILLS_SECTION)).toBe(true);
    expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(true);
    await env.dispose();

    const bound = await startSkillApp({ env: { KIMI_CODE_BUILTIN_PRODUCT_SKILLS: '0' } });
    const names = bound.catalog().list().map((skill) => skill.name).toSorted();
    expect(names).not.toContain('update-config');
    expect(names).not.toContain('mcp-config');
    expect(names).not.toContain('import-from-cc-codex');
    expect(names).not.toContain('custom-theme');
    expect(names).not.toContain('check-kimi-code-docs');
    expect(names).toContain('write-goal');
    await bound.dispose();

    const tomlOff = await startSkillApp({ toml: 'builtin_product_skills = false\n' });
    const tomlNames = tomlOff.catalog().list().map((skill) => skill.name).toSorted();
    expect(tomlNames).not.toContain('update-config');
    expect(tomlNames).not.toContain('check-kimi-code-docs');
    await tomlOff.dispose();
  });

  it('reloads user and workspace sources when mergeAllAvailableSkills changes', async () => {
    await writeFileUnder(brandHome, 'skills/brand-one/SKILL.md', fm('name: brand-one\ndescription: B'));
    await writeFileUnder(brandHome, '.agents/skills/generic-one/SKILL.md', fm('name: generic-one\ndescription: G'));
    const env = await startSkillApp();
    expect(env.catalog().list().map((skill) => skill.name)).toEqual(
      expect.arrayContaining(['brand-one', 'generic-one']),
    );
    const changed: string[] = [];
    env.app.on(env.skillFeature, 'skill.changed', (event) => {
      changed.push(event.sourceId);
    });
    await env.app.resolve(ConfigRef).set(MERGE_ALL_AVAILABLE_SKILLS_SECTION, false, 'memory');
    await vi.waitFor(() => {
      expect(changed).toContain('user');
      expect(changed).toContain('workspace');
    });
    const names = env.catalog().list().map((skill) => skill.name);
    expect(names).toContain('brand-one');
    expect(names).toContain('generic-one');
    await env.dispose();
  });

  it('replaces user and workspace roots with explicitDirs', async () => {
    await makeProjectSkill();
    await writeFileUnder(brandHome, 'skills/brand-one/SKILL.md', fm('name: brand-one\ndescription: B'));
    const explicitDir = join(workDir, 'explicit');
    await writeFileUnder(explicitDir, 'chosen/SKILL.md', fm('name: chosen\ndescription: C'));
    const env = await startSkillApp({ skillProps: { explicitDirs: [explicitDir] } });
    const catalog = env.catalog();
    const names = catalog.list().map((skill) => skill.name);
    expect(names).toContain('chosen');
    expect(names).not.toContain('brand-one');
    expect(names).not.toContain('commit');
    expect(catalog.get('chosen')?.source).toBe('user');
    await env.dispose();
  });

  it('reloads affected sources on config change and fires skill.changed', async () => {
    const env = await startSkillApp();
    const changed: SkillChangedEvent[] = [];
    env.app.on(env.skillFeature, 'skill.changed', (event) => {
      changed.push(event);
    });
    const extraDir = join(workDir, 'extra');
    await writeFileUnder(extraDir, 'bonus/SKILL.md', fm('name: bonus\ndescription: B'));
    await env.app.resolve(ConfigRef).set(EXTRA_SKILL_DIRS_SECTION, [extraDir], 'memory');
    await vi.waitFor(() => {
      expect(changed.map((event) => event.sourceId)).toContain('extra');
    });
    expect(env.catalog().list().map((skill) => skill.name)).toContain('bonus');
    expect(env.catalog().get('bonus')?.source).toBe('extra');
    await env.dispose();
  });

  it('merges late-registered sources via useSkillSource and reload picks up disk changes', async () => {
    const env = await startSkillApp();
    const changed: string[] = [];
    env.app.on(env.skillFeature, 'skill.changed', (event) => {
      changed.push(event.sourceId);
    });
    env.app.installFeature(
      createFeature('late-skill-source', {
        app() {
          useSkillSource({
            id: 'late',
            priority: 15,
            load: () => Promise.resolve({ skills: [stubSkill('late-one', { source: 'extra' })] }),
          });
        },
      }),
    );
    await vi.waitFor(() => {
      expect(changed).toContain('catalog');
    });
    expect(env.catalog().list().map((skill) => skill.name)).toContain('late-one');

    await makeProjectSkill();
    await env.catalog().reload();
    expect(env.catalog().list().map((skill) => skill.name)).toContain('commit');
    await env.dispose();
  });
});

describe('createSkill agent slot', () => {
  it('injects the frozen skills section into every agent system prompt', async () => {
    await makeProjectSkill();
    const env = await startSkillApp();
    await env.runTurn('hello');
    const systemPrompt = env.calls[0]?.systemPrompt ?? '';
    expect(systemPrompt).toContain('\n\n# Skills\n\n');
    expect(systemPrompt).toContain('Skills are reusable, composable capabilities');
    expect(systemPrompt).toContain('Identify the skills relevant to your current task');
    expect(systemPrompt).toContain('## Available skills');
    expect(systemPrompt).toContain('**Project overrides User overrides Extra overrides Built-in**');
    expect(systemPrompt).toContain('DISREGARD any earlier skill listings. Current available skills:');
    expect(systemPrompt).toContain('### Project');
    expect(systemPrompt).toContain('- commit: Create a git commit');
    expect(systemPrompt).toContain('  When to use: When committing');
    expect(systemPrompt).toContain('- write-goal:');
    expect(systemPrompt).toContain('- check-kimi-code-docs:');
    expect(systemPrompt).not.toContain('sub-skill.review');
    expect(systemPrompt).not.toContain('- mcp-config');
    const listing = env.catalog().getModelSkillListing();
    expect(systemPrompt).toContain(`${listing}\n\n`);

    const sub = await env.session.create({ agentId: 'sub-1', systemPrompt: 'sub-host' });
    await sub.ready();
    const subDone = waitTurnDone(sub);
    sub.submit(createUserMessage('hello'));
    await subDone;
    const subPrompt = env.calls.at(-1)?.systemPrompt ?? '';
    expect(subPrompt).toContain('# Skills');
    expect(subPrompt).toContain('DISREGARD any earlier skill listings. Current available skills:');
    await env.dispose();
  });

  it('exposes the Skill tool with the verbatim description and schema', async () => {
    const env = await startSkillApp();
    await env.runTurn('hello');
    const tool = env.calls[0]?.tools.find((candidate) => candidate.name === 'Skill');
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('Invoke a registered skill from the current skill listing.');
    expect(tool?.parameters).toEqual({
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description:
            'The exact name of the skill to invoke, spelled as it appears in the current skill listing (e.g. "commit", "pdf").',
        },
        args: {
          type: 'string',
          description:
            'Optional argument string for the skill, written like a command line (e.g. `-m "fix bug"`, `123`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill\'s placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing `ARGUMENTS:` line. Omit it only when there is nothing to pass.',
        },
      },
      required: ['skill'],
      additionalProperties: false,
    });
    await env.dispose();
  });

  it('runs the model-tool activation end to end', async () => {
    await makeProjectSkill();
    const env = await startSkillApp();
    const activated: SkillActivatedEvent[] = [];
    env.session.on(env.skillFeature, 'skill.activated', (event) => {
      activated.push(event);
    });
    await env.runTurn(`CALL:${JSON.stringify({ name: 'Skill', arguments: JSON.stringify({ skill: 'commit', args: '-m "fix bug"' }) })}`);

    expect(toolResultTexts(env.stores)).toEqual([
      'Skill "commit" loaded inline. Follow its instructions.',
    ]);

    const activationEntries = () =>
      historyEntries(env.stores).filter((entry) => entry.meta?.origin?.kind === 'skill_activation');
    await vi.waitFor(async () => {
      await env.stores.flush();
      expect(activationEntries()).toHaveLength(1);
    });
    const entry = activationEntries()[0]!;
    expect(entry.meta?.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
      trigger: 'model-tool',
      skillArgs: '-m "fix bug"',
      skillSource: 'project',
    });
    const part = entry.message.content[0]!;
    expect(part.type).toBe('text');
    expect(part.meta).toMatchObject({
      kind: 'skill',
      skillName: 'commit',
      skillArgs: '-m "fix bug"',
      skillSource: 'project',
    });
    const text = part.type === 'text' ? part.text : '';
    expect(text).toContain('Skill tool loaded instructions for this request. Follow them.');
    expect(text).toContain('<skill-loaded name="commit" trigger="model-tool" source="project"');
    expect(text).toContain('args="-m &quot;fix bug&quot;"');
    expect(text).toContain('Commit with message: -m "fix bug"');

    expect(activated).toHaveLength(1);
    expect(activated[0]).toMatchObject({
      skillName: 'commit',
      trigger: 'model-tool',
      skillArgs: '-m "fix bug"',
      agentId: MAIN_AGENT_ID,
      sessionId: 'sess',
    });
    await env.dispose();
  });

  it('answers the three tool guards as plain-text results without activating', async () => {
    await makeProjectSkill();
    await writeFileUnder(
      workDir,
      '.kimi-code/skills/flowy/SKILL.md',
      fm('name: flowy\ndescription: F\ntype: flow'),
    );
    const env = await startSkillApp();
    const activated: SkillActivatedEvent[] = [];
    env.session.on(env.skillFeature, 'skill.activated', (event) => {
      activated.push(event);
    });
    const call = (skill: string): string =>
      `CALL:${JSON.stringify({ name: 'Skill', arguments: JSON.stringify({ skill }) })}`;
    await env.runTurn(call('nope'));
    await env.runTurn(call('sub-skill'));
    await env.runTurn(call('flowy'));

    expect(toolResultTexts(env.stores)).toEqual([
      'Skill "nope" not found in the current skill listing.',
      'Skill "sub-skill" can only be triggered by the user (model invocation is disabled).',
      'Skill "flowy" is not an inline skill and cannot be invoked by the model in v1.',
    ]);
    expect(toolResultIsErrors(env.stores)).toEqual([true, true, true]);
    expect(activated).toHaveLength(0);
    expect(
      historyEntries(env.stores).filter((entry) => entry.meta?.origin?.kind === 'skill_activation'),
    ).toHaveLength(0);
    await env.dispose();
  });

  it('answers invalid tool arguments as plain-text results without activating', async () => {
    const env = await startSkillApp();
    const activated: SkillActivatedEvent[] = [];
    env.session.on(env.skillFeature, 'skill.activated', (event) => {
      activated.push(event);
    });
    const call = (rawArguments: string): string =>
      `CALL:${JSON.stringify({ name: 'Skill', arguments: rawArguments })}`;
    await env.runTurn(call('{not json'));
    await env.runTurn(call('{"args":"x"}'));

    expect(toolResultTexts(env.stores)).toEqual([
      'invalid Skill arguments: {not json',
      'invalid Skill arguments: {"args":"x"}',
    ]);
    expect(toolResultIsErrors(env.stores)).toEqual([true, true]);
    expect(activated).toHaveLength(0);
    await env.dispose();
  });

  it('activates a skill through the SkillRef facade with the user-slash wrapper', async () => {
    await makeProjectSkill();
    const env = await startSkillApp();
    const activated: SkillActivatedEvent[] = [];
    env.session.on(env.skillFeature, 'skill.activated', (event) => {
      activated.push(event);
    });
    const startedIds: number[] = [];
    env.main.on('turn.started', (event) => {
      startedIds.push(event.turnId);
    });
    const done = waitTurnDone(env.main);
    const { turnId } = await env.skill().activate({
      name: 'commit',
      args: 'x y',
      content: [{ type: 'text', text: 'extra attachment' }],
    });
    await done;
    await env.stores.flush();

    expect(startedIds).toContain(turnId);
    const entries = historyEntries(env.stores).filter(
      (entry) => entry.meta?.origin?.kind === 'skill_activation',
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.meta?.origin).toMatchObject({ trigger: 'user-slash', skillName: 'commit' });
    expect(entry.message.content).toHaveLength(2);
    const part = entry.message.content[0]!;
    expect(part.meta).toMatchObject({ kind: 'skill', skillName: 'commit', skillArgs: 'x y' });
    const text = part.type === 'text' ? part.text : '';
    expect(text).toContain('User activated the skill "commit". Follow the loaded skill instructions.');
    expect(text).toContain('<skill-loaded name="commit" trigger="user-slash"');
    expect(entry.message.content[1]).toMatchObject({ type: 'text', text: 'extra attachment' });
    expect(activated).toHaveLength(1);
    expect(activated[0]).toMatchObject({
      trigger: 'user-slash',
      skillName: 'commit',
      skillArgs: 'x y',
      agentId: MAIN_AGENT_ID,
    });
    await env.dispose();
  });

  it('rejects invalid activations with the verbatim errors', async () => {
    await makeProjectSkill();
    await writeFileUnder(
      workDir,
      '.kimi-code/skills/ref/SKILL.md',
      fm('name: ref\ndescription: R\ntype: reference'),
    );
    const env = await startSkillApp();
    await expect(env.skill().activate({ name: 'nope' })).rejects.toThrowError(
      'Skill "nope" was not found',
    );
    await expect(env.skill().activate({ name: 'ref' })).rejects.toThrowError(
      'Skill "ref" cannot be activated by the user',
    );
    await expect(
      env.skill().promptWithSkills({ input: [], skills: [{ name: 'commit' }] }),
    ).rejects.toThrowError('promptWithSkills requires a non-empty prompt');
    await expect(
      env.skill().promptWithSkills({ input: [{ type: 'text', text: 'hi' }], skills: [] }),
    ).rejects.toThrowError('promptWithSkills requires at least one skill');
    await env.dispose();
  });

  it('bundles skills with the prompt through promptWithSkills', async () => {
    await makeProjectSkill();
    const env = await startSkillApp();
    const activated: SkillActivatedEvent[] = [];
    env.session.on(env.skillFeature, 'skill.activated', (event) => {
      activated.push(event);
    });
    const done = waitTurnDone(env.main);
    const { turnId } = await env.skill().promptWithSkills({
      input: [{ type: 'text', text: 'do it' }],
      skills: [{ name: 'commit', args: 'a' }, { name: 'write-goal' }],
    });
    await done;
    await env.stores.flush();

    expect(typeof turnId).toBe('number');
    const entries = historyEntries(env.stores).filter(
      (entry) => entry.meta?.origin?.kind === 'user',
    );
    const bundled = entries.find(
      (entry) => (entry.meta?.origin as { skillActivations?: unknown }).skillActivations !== undefined,
    )!;
    expect(bundled.meta?.origin).toMatchObject({
      kind: 'user',
      skillActivations: [
        { skillName: 'commit', skillArgs: 'a', skillSource: 'project' },
        { skillName: 'write-goal', skillSource: 'builtin' },
      ],
    });
    expect(bundled.message.content).toHaveLength(3);
    expect(bundled.message.content[0]?.meta).toMatchObject({ kind: 'skill', skillName: 'commit' });
    expect(bundled.message.content[1]?.meta).toMatchObject({ kind: 'skill', skillName: 'write-goal' });
    expect(bundled.message.content[2]).toMatchObject({ type: 'text', text: 'do it' });
    expect(activated.map((event) => event.skillName)).toEqual(['commit', 'write-goal']);
    await env.dispose();
  });

  it('rejects activate while a turn is running and queues promptWithSkills instead', async () => {
    await makeProjectSkill();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gatedCalls = 0;
    const gatingScript: LlmScript = (call) => {
      const last = call.messages.at(-1);
      if (last !== undefined && last.role === 'tool') return { text: 'done' };
      gatedCalls += 1;
      if (gatedCalls === 1) return { gate, text: 'first' };
      return { text: 'next' };
    };
    const env = await startSkillApp({ script: gatingScript });
    let turnCount = 0;
    env.main.on('turn.done', () => {
      turnCount += 1;
    });
    env.main.submit(createUserMessage('hold'));
    await vi.waitFor(() => {
      expect(env.calls.length).toBe(1);
    });

    await expect(env.skill().activate({ name: 'commit' })).rejects.toThrowError(
      'Cannot activate skill while another turn is active',
    );

    const queued = await env.skill().promptWithSkills({
      input: [{ type: 'text', text: 'queued prompt' }],
      skills: [{ name: 'commit' }],
    });
    expect(queued.turnId).toBeUndefined();

    release();
    await vi.waitFor(() => {
      expect(turnCount).toBe(2);
    });
    await env.stores.flush();
    const origins = historyEntries(env.stores)
      .map((entry) => entry.meta?.origin)
      .filter((origin) => origin?.kind === 'user');
    expect(
      origins.some(
        (origin) =>
          (origin as { skillActivations?: readonly { skillName: string }[] }).skillActivations?.[0]
            ?.skillName === 'commit',
      ),
    ).toBe(true);
    await env.dispose();
  });
});
