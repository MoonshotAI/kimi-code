import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import {
  buildCatalogView,
  collectGitContext,
  configuredAgentRoots,
  createProfiles,
  discoverAgentFiles,
  getBuiltinDefaultProfile,
  loadSystemMdProfile,
  normalizeAgentProfile,
  parseAgentFileText,
  PRIORITY,
  ProfileCatalogRef,
  projectAgentRoots,
  renderAgentProfilePrompt,
  renderPromptTemplateResult,
  TASK_AGENT_ROLE_PREFIX,
  type AgentProfile,
  type CatalogEntry,
  type CreateProfilesProps,
  type ProfileCatalogFace,
  type ProfileFinder,
} from '#/features/profiles/index';
import { FrontmatterError, parseFrontmatter } from '#/frontmatter';
import { createHarness, memoryHarnessSpace } from '#/runtime/index';

let workDir: string;
let homeDir: string;
let host: OsHost;

beforeEach(async () => {
  host = createNodeOsHost();
  workDir = await host.fs.realpath(await mkdtemp(join(tmpdir(), 'profiles-feature-')));
  homeDir = await host.fs.realpath(await mkdtemp(join(tmpdir(), 'profiles-home-')));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

async function startProfilesApp(
  props: CreateProfilesProps,
): Promise<{ face: ProfileCatalogFace; close: () => Promise<void> }> {
  const harness = createHarness({ space: memoryHarnessSpace() });
  try {
    await harness.app.features.add(createProfiles(props));
    const capture: { face?: Readonly<ShallowRef<ProfileCatalogFace | undefined>> } = {};
    await harness.app.features.add(
      createFeature('profiles-probe', {
        app() {
          capture.face = useInject(ProfileCatalogRef);
        },
      }),
    );
    const face = capture.face?.value;
    if (face === undefined) throw new Error('ProfileCatalogRef was not exposed');
    await face.ready;
    return { face, close: () => harness.close() };
  } catch (error) {
    await harness.close();
    throw error;
  }
}

function makeProfile(
  name: string,
  opts?: {
    description?: string;
    override?: boolean;
    subagents?: readonly string[];
  },
): AgentProfile {
  return normalizeAgentProfile({
    name,
    description: opts?.description,
    override: opts?.override,
    subagents: opts?.subagents,
    systemPrompt: () => `prompt:${name}`,
  });
}

function entry(sourceId: string, priority: number, profiles: readonly AgentProfile[]): CatalogEntry {
  return { sourceId, priority, contribution: { profiles } };
}

describe('normalizeAgentProfile', () => {
  it('wraps a render-only profile with a text systemPrompt', () => {
    const profile = normalizeAgentProfile({
      name: 'x',
      renderSystemPrompt: (ctx) => ({ text: `rendered:${ctx.cwd ?? ''}`, environment: { cwd: '/env' } }),
    });
    expect(profile.systemPrompt({ cwd: '/a' })).toBe('rendered:/a');
    expect(profile.renderSystemPrompt({ cwd: '/a' }).environment.cwd).toBe('/env');
  });

  it('wraps a prompt-only profile with a cwd-only environment', () => {
    const profile = normalizeAgentProfile({
      name: 'x',
      systemPrompt: (ctx) => `plain:${ctx.cwd ?? ''}`,
    });
    const rendered = profile.renderSystemPrompt({ cwd: '/b' });
    expect(rendered.text).toBe('plain:/b');
    expect(rendered.environment).toEqual({ cwd: '/b' });
    expect(profile.renderSystemPrompt({}).environment.cwd).toBe('');
  });

  it('prefers renderSystemPrompt when both are given', () => {
    const profile = normalizeAgentProfile({
      name: 'x',
      systemPrompt: () => 'plain',
      renderSystemPrompt: () => ({ text: 'rendered', environment: { cwd: '' } }),
    });
    expect(profile.systemPrompt({})).toBe('rendered');
  });

  it('throws when neither renderer is defined', () => {
    expect(() => normalizeAgentProfile({ name: 'broken' } as never)).toThrow(
      'Agent profile "broken" must define systemPrompt or renderSystemPrompt.',
    );
  });
});

describe('buildCatalogView', () => {
  it('keeps the builtin profile when a same-name candidate lacks override', () => {
    const warnings: string[] = [];
    const builtin = makeProfile('agent', { description: 'Default agent', subagents: ['coder'] });
    const candidate = makeProfile('agent', { description: 'custom' });
    const view = buildCatalogView(
      [entry('builtin', PRIORITY.builtin, [builtin]), entry('user', PRIORITY.user, [candidate])],
      (message) => warnings.push(message),
    );
    expect(view.merged.get('agent')?.description).toBe('Default agent');
    expect(view.inspections.get('agent')?.suppressed).toEqual([
      { sourceId: 'user', priority: PRIORITY.user, reason: 'builtin-override-required' },
    ]);
    expect(warnings).toEqual([
      'agent file profile "agent" ignored: a same-name builtin profile exists; set "override: true" in the frontmatter to replace it',
    ]);
  });

  it('lets an override candidate replace the builtin profile', () => {
    const view = buildCatalogView([
      entry('builtin', PRIORITY.builtin, [makeProfile('agent', { description: 'Default agent' })]),
      entry('workspace', PRIORITY.workspace, [makeProfile('agent', { description: 'custom', override: true })]),
    ]);
    expect(view.merged.get('agent')?.description).toBe('custom');
    expect(view.inspections.get('agent')?.sourceId).toBe('workspace');
  });

  it('prefers higher priority candidates and records the suppressed rest', () => {
    const low = makeProfile('custom', { description: 'low' });
    const high = makeProfile('custom', { description: 'high' });
    const view = buildCatalogView([
      entry('user', PRIORITY.user, [low]),
      entry('workspace', PRIORITY.workspace, [high]),
    ]);
    expect(view.merged.get('custom')?.description).toBe('high');
    expect(view.inspections.get('custom')?.suppressed).toEqual([
      { sourceId: 'user', priority: PRIORITY.user, reason: 'priority' },
    ]);
  });

  it('inherits subagents from the replaced profile when the winner omits them', () => {
    const view = buildCatalogView([
      entry('builtin', PRIORITY.builtin, [makeProfile('agent', { subagents: ['coder', 'explore'] })]),
      entry('explicit', PRIORITY.explicit, [makeProfile('agent', { override: true })]),
    ]);
    expect(view.merged.get('agent')?.subagents).toEqual(['coder', 'explore']);
  });
});

describe('profiles feature', () => {
  it('exposes the builtin catalog through the facade', async () => {
    const { face, close } = await startProfilesApp({ workDir, host, home: homeDir });
    try {
      expect(face.list().map((profile) => profile.name)).toEqual([
        'agent',
        'coder',
        'explore',
        'plan',
      ]);
      expect(face.getDefault().name).toBe('agent');
      const agent = face.get('agent');
      expect(agent?.description).toBe('Default agent');
      expect(agent?.subagents).toEqual(['coder', 'explore', 'plan']);
      expect(agent?.tools).toContain('Bash');
      expect(agent?.tools).toContain('mcp__*');
      expect(face.get('coder')?.whenToUse).toContain('non-trivial software engineering work');
      expect(face.get('coder')?.tools).not.toContain('Agent');
      expect(face.get('explore')?.tools).toEqual([
        'NotifyUser',
        'Bash',
        'Read',
        'ReadMediaFile',
        'Glob',
        'Grep',
        'WebSearch',
        'FetchURL',
      ]);
      expect(face.get('plan')?.tools).toEqual([
        'NotifyUser',
        'Read',
        'ReadMediaFile',
        'Glob',
        'Grep',
        'WebSearch',
        'FetchURL',
      ]);
      expect(face.inspect('coder')?.sourceId).toBe('builtin');
      expect(face.get('explore')?.promptPrefix).toBeTypeOf('function');
    } finally {
      await close();
    }
  });

  it('merges props finders and survives a failing finder', async () => {
    const warnings: string[] = [];
    const customFinder: ProfileFinder = {
      sourceId: 'workspace',
      priority: PRIORITY.workspace,
      load: () => ({ profiles: [makeProfile('custom-x')] }),
    };
    const failingFinder: ProfileFinder = {
      sourceId: 'broken',
      load: () => {
        throw new Error('disk gone');
      },
    };
    const { face, close } = await startProfilesApp({
      workDir,
      host,
      home: homeDir,
      finders: [customFinder, failingFinder],
      onWarn: (message) => warnings.push(message),
    });
    try {
      expect(face.get('custom-x')).toBeDefined();
      expect(face.get('agent')).toBeDefined();
      expect(warnings).toEqual(['agent profile finder "broken" failed: disk gone']);
    } finally {
      await close();
    }
  });

  it('renders the coder system prompt with the shared skeleton and role text', async () => {
    const { face, close } = await startProfilesApp({ workDir, host, home: homeDir });
    try {
      const rendered = face.get('coder')!.renderSystemPrompt({
        cwd: workDir,
        osKind: 'macOS',
        shellName: 'bash',
        shellPath: '/bin/bash',
      });
      expect(rendered.text).toContain('# Communicating with the user');
      expect(rendered.text).toContain(TASK_AGENT_ROLE_PREFIX);
      expect(rendered.text).toContain('Your final message is the entire handoff');
      expect(rendered.text).toContain(`The current working directory is \`${workDir}\``);
      expect(rendered.environment).toEqual({ cwd: workDir });
    } finally {
      await close();
    }
  });
});

describe('renderPromptTemplateResult', () => {
  it('injects base_prompt only when the template references it', () => {
    let called = 0;
    const base = (): { text: string; environment: { cwd: string } } => {
      called += 1;
      return { text: 'BASE', environment: { cwd: '/base' } };
    };
    const untouched = renderPromptTemplateResult('no base here', {}, { skillActive: false }, base);
    expect(called).toBe(0);
    expect(untouched.text).toBe('no base here');
    const injected = renderPromptTemplateResult('head ${base_prompt} tail', {}, { skillActive: false }, base);
    expect(called).toBe(1);
    expect(injected.text).toBe('head BASE tail');
    expect(injected.environment.cwd).toBe('/base');
    const direct = renderPromptTemplateResult(
      '${base_prompt}',
      { cwd: '/direct' },
      { skillActive: false },
      base,
    );
    expect(direct.environment.cwd).toBe('/direct');
  });
});

describe('renderAgentProfilePrompt', () => {
  const profile = makeProfile('x');

  it('appends the notify guidance when active and not already present', () => {
    const once = renderAgentProfilePrompt(profile, { notifyUserActive: true });
    expect(once.text).toContain('When `NotifyUser` is available, use it proactively');
    const twice = renderAgentProfilePrompt(
      {
        ...profile,
        renderSystemPrompt: () => once,
        systemPrompt: () => once.text,
      },
      { notifyUserActive: true },
    );
    expect(twice.text).toBe(once.text);
  });

  it('leaves the prompt untouched when notify is inactive', () => {
    expect(renderAgentProfilePrompt(profile, {}).text).toBe('prompt:x');
  });
});

describe('collectGitContext', () => {
  it('reports unavailable outside a git repository', async () => {
    await host.environment.ready;
    const text = await collectGitContext(host.process, workDir);
    expect(text).toBe('<git-context status="unavailable" reason="not-a-repo"/>');
  });

  it('collects branch and recent commits inside a git repository', async () => {
    await host.environment.ready;
    execFileSync('git', ['init', '-q'], { cwd: workDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: workDir });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'initial commit'], { cwd: workDir });
    const text = await collectGitContext(host.process, workDir);
    expect(text).toContain('<git-context>');
    expect(text).toContain(`Working directory: ${workDir}`);
    expect(text).toContain('Branch: ');
    expect(text).toContain('Recent commits:');
    expect(text).toContain('initial commit');
  });
});

describe('frontmatter', () => {
  it('parses yaml data and the body', () => {
    const parsed = parseFrontmatter('---\nname: foo\noverride: true\n---\nbody line\n');
    expect(parsed.data).toEqual({ name: 'foo', override: true });
    expect(parsed.body).toBe('body line\n');
  });

  it('throws on a missing closing fence', () => {
    expect(() => parseFrontmatter('---\nname: foo\nbody\n')).toThrow(
      'Missing closing frontmatter fence',
    );
  });

  it('returns null data without a fence and wraps yaml errors', () => {
    const plain = parseFrontmatter('just text\n');
    expect(plain.data).toBeNull();
    expect(plain.body).toBe('just text\n');
    expect(() => parseFrontmatter('---\na: [\n---\nbody\n')).toThrow(FrontmatterError);
  });
});

describe('agent-file', () => {
  const parse = (text: string, path = '/agents/foo.md'): ReturnType<typeof parseAgentFileText> =>
    parseAgentFileText({ path, source: 'user', text });

  it('parses every key and derives the name from the file name', () => {
    const def = parse(
      '---\ndescription: Does things\nwhenToUse: when asked\noverride: true\ntools: Read, Grep\nsubagents:\n  - coder\n  - explore\n---\nBe helpful.\n',
    );
    expect(def).toMatchObject({
      name: 'foo',
      description: 'Does things',
      whenToUse: 'when asked',
      override: true,
      tools: ['Read', 'Grep'],
      subagents: ['coder', 'explore'],
      prompt: 'Be helpful.',
      source: 'user',
    });
    const named = parse('---\nname: code-reviewer\ndescription: d\n---\nbody\n');
    expect(named.name).toBe('code-reviewer');
  });

  it('requires description with the verbatim message', () => {
    expect(() => parse('---\nname: foo\n---\nbody\n')).toThrow(
      'Missing required frontmatter field "description" in /agents/foo.md',
    );
  });

  it('rejects non kebab-case names with the verbatim message', () => {
    expect(() => parse('---\nname: Bad_Name\ndescription: d\n---\nbody\n')).toThrow(
      'Invalid agent name "Bad_Name" in /agents/foo.md: expected kebab-case (e.g. "code-reviewer")',
    );
  });

  it('rejects a non-boolean override with the verbatim message', () => {
    expect(() => parse('---\ndescription: d\noverride: yes\n---\nbody\n')).toThrow(
      'Frontmatter field "override" in /agents/foo.md must be a boolean',
    );
  });

  it('normalizes tools forms', () => {
    expect(parse('---\ndescription: d\ntools: "*"\n---\nbody\n').tools).toBeUndefined();
    expect(parse('---\ndescription: d\ntools: Read, Grep ,Bash\n---\nbody\n').tools).toEqual([
      'Read',
      'Grep',
      'Bash',
    ]);
    expect(
      parse('---\ndescription: d\ndisallowedTools:\n  - Bash\n  - Write\n---\nbody\n')
        .disallowedTools,
    ).toEqual(['Bash', 'Write']);
  });

  it('rejects an empty body and a non-mapping frontmatter', () => {
    expect(() => parse('---\ndescription: d\n---\n\n')).toThrow(
      'Missing prompt body in /agents/foo.md',
    );
    expect(() => parse('---\n- a\n- b\n---\nbody\n')).toThrow(
      'Frontmatter in /agents/foo.md must be a mapping at the top level',
    );
  });
});

describe('discovery', () => {
  const writeAgent = async (rel: string, name: string, description = 'd'): Promise<void> => {
    const full = join(workDir, rel);
    await host.fs.mkdir(join(full, '..'), { recursive: true });
    await host.fs.writeText(full, `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  };

  const discover = (root: string) =>
    discoverAgentFiles(host.fs, [{ path: root, source: 'user' }], () => {});

  it('walks recursively, skips dot entries and node_modules, and sorts by name', async () => {
    await writeAgent('agents/b.md', 'b');
    await writeAgent('agents/a.md', 'a');
    await writeAgent('agents/sub/c.md', 'c');
    await writeAgent('agents/.hidden.md', 'hidden');
    await writeAgent('agents/.hdir/x.md', 'x');
    await writeAgent('agents/node_modules/n.md', 'n');
    await host.fs.writeText(join(workDir, 'agents', 'readme.txt'), 'not an agent');
    const deep8 = ['agents', ...Array.from({ length: 8 }, (_, i) => `d${i + 1}`)];
    await writeAgent([...deep8, 'shallow-ok.md'].join('/'), 'deep-ok');
    await writeAgent([...deep8, 'd9', 'too-deep.md'].join('/'), 'too-deep');
    const result = await discover(join(workDir, 'agents'));
    expect(result.agents.map((agent) => agent.name)).toEqual(['a', 'b', 'c', 'deep-ok']);
    expect(result.scannedRoots).toEqual([join(workDir, 'agents')]);
  });

  it('dedupes same-name files, first seen wins', async () => {
    await writeAgent('agents/a/dup.md', 'dup', 'from-a');
    await writeAgent('agents/b/dup.md', 'dup', 'from-b');
    const result = await discover(join(workDir, 'agents'));
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.description).toBe('from-a');
  });

  it('records skipped files and caps warnings with a summary', async () => {
    const warnings: string[] = [];
    for (const name of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']) {
      await writeAgent(`agents/${name}.md`, name);
      await host.fs.writeText(
        join(workDir, 'agents', `${name}.md`),
        `---\nname: ${name}\n---\nbody\n`,
      );
    }
    const result = await discoverAgentFiles(
      host.fs,
      [{ path: join(workDir, 'agents'), source: 'user' }],
      (message) => warnings.push(message),
    );
    expect(result.skipped).toHaveLength(7);
    expect(result.skipped[0]?.reason).toContain('Missing required frontmatter field "description"');
    expect(warnings.filter((m) => m.startsWith('Skipping invalid agent file at '))).toHaveLength(5);
    const summary = warnings.find((m) => m.startsWith('Suppressed '));
    expect(summary).toContain('Suppressed 2 further agent-discovery skip warnings');
    expect(summary).toContain('fix or remove the offending files/directories to silence them');
  });
});

describe('roots', () => {
  const writeAgent = async (rel: string, name: string): Promise<void> => {
    const full = join(workDir, rel);
    await host.fs.mkdir(join(full, '..'), { recursive: true });
    await host.fs.writeText(full, `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  };

  it('includes brand and generic roots independently and falls back to generic', async () => {
    await host.fs.mkdir(join(workDir, 'w1', '.git'), { recursive: true });
    await writeAgent('w1/.kimi-code/agents/brand.md', 'brand-x');
    await writeAgent('w1/.agents/agents/generic.md', 'generic-x');
    const brandRoots = await projectAgentRoots(host.fs, join(workDir, 'w1'));
    expect(brandRoots).toEqual([
      { path: join(workDir, 'w1', '.kimi-code', 'agents'), source: 'project' },
      { path: join(workDir, 'w1', '.agents', 'agents'), source: 'project' },
    ]);

    await host.fs.mkdir(join(workDir, 'w2', '.git'), { recursive: true });
    await writeAgent('w2/.agents/agents/generic.md', 'generic-x');
    const genericRoots = await projectAgentRoots(host.fs, join(workDir, 'w2'));
    expect(genericRoots).toEqual([
      { path: join(workDir, 'w2', '.agents', 'agents'), source: 'project' },
    ]);
  });

  it('uses workDir as projectRoot without .git and resolves extra dirs against the project root', async () => {
    await writeAgent('w3/.kimi-code/agents/foo.md', 'foo');
    const roots = await projectAgentRoots(host.fs, join(workDir, 'w3'));
    expect(roots).toEqual([
      { path: join(workDir, 'w3', '.kimi-code', 'agents'), source: 'project' },
    ]);

    await host.fs.mkdir(join(workDir, 'w4', '.git'), { recursive: true });
    await writeAgent('w4/my-agents/extra.md', 'extra-x');
    const extraRoots = await configuredAgentRoots(
      host.fs,
      ['my-agents'],
      join(workDir, 'w4'),
      homeDir,
      'extra',
    );
    expect(extraRoots).toEqual([{ path: join(workDir, 'w4', 'my-agents'), source: 'extra' }]);
  });
});

describe('SYSTEM.md', () => {
  it('replaces the default profile and renders base_prompt with the builtin base', async () => {
    await host.fs.writeText(join(homeDir, 'SYSTEM.md'), 'Custom system.\n\n${base_prompt}\n\ntail.');
    const profile = await loadSystemMdProfile(host.fs, homeDir, getBuiltinDefaultProfile());
    expect(profile).toBeDefined();
    expect(profile?.name).toBe('agent');
    expect(profile?.override).toBe(true);
    expect(profile?.description).toBe('Default agent');
    expect(profile?.subagents).toEqual(['coder', 'explore', 'plan']);
    expect(profile?.tools).toContain('Bash');
    const rendered = profile!.renderSystemPrompt({ cwd: workDir });
    expect(rendered.text).toContain('Custom system.');
    expect(rendered.text).toContain('# Communicating with the user');
    expect(rendered.text).toContain('tail.');
  });

  it('returns undefined when SYSTEM.md is missing or empty', async () => {
    expect(await loadSystemMdProfile(host.fs, homeDir, getBuiltinDefaultProfile())).toBeUndefined();
    await host.fs.writeText(join(homeDir, 'SYSTEM.md'), '   \n');
    expect(await loadSystemMdProfile(host.fs, homeDir, getBuiltinDefaultProfile())).toBeUndefined();
  });
});

describe('finders end-to-end', () => {
  const writeAgent = async (rel: string, frontmatter: string, body: string): Promise<void> => {
    const full = join(workDir, rel);
    await host.fs.mkdir(join(full, '..'), { recursive: true });
    await host.fs.writeText(full, `---\n${frontmatter}\n---\n${body}\n`);
  };

  it('lists workspace agent files and renders their prompt with context vars', async () => {
    await writeAgent('.kimi-code/agents/foo.md', 'name: foo\ndescription: Foo agent', 'You are foo running in ${cwd}.');
    const { face, close } = await startProfilesApp({ workDir, host, home: homeDir });
    try {
      const foo = face.get('foo');
      expect(foo?.description).toBe('Foo agent');
      expect(face.inspect('foo')?.sourceId).toBe('workspace');
      expect(face.inspect('foo')?.priority).toBe(PRIORITY.workspace);
      expect(foo!.renderSystemPrompt({ cwd: workDir }).text).toBe(
        `You are foo running in ${workDir}.`,
      );
    } finally {
      await close();
    }
  });

  it('rejects a same-name builtin without override and honors override: true', async () => {
    await writeAgent('.kimi-code/agents/coder.md', 'name: coder\ndescription: Custom coder', 'Custom body.');
    const first = await startProfilesApp({ workDir, host, home: homeDir });
    try {
      expect(first.face.get('coder')?.description).toContain('General software engineering agent');
      expect(first.face.inspect('coder')?.suppressed).toEqual([
        {
          sourceId: 'workspace',
          priority: PRIORITY.workspace,
          reason: 'builtin-override-required',
        },
      ]);
    } finally {
      await first.close();
    }

    await host.fs.writeText(
      join(workDir, '.kimi-code', 'agents', 'coder.md'),
      '---\nname: coder\ndescription: Custom coder\noverride: true\n---\nCustom body.\n',
    );
    const second = await startProfilesApp({ workDir, host, home: homeDir });
    try {
      expect(second.face.get('coder')?.description).toBe('Custom coder');
      expect(second.face.inspect('coder')?.sourceId).toBe('workspace');
    } finally {
      await second.close();
    }
  });

  it('feeds the user SYSTEM.md into workspace base_prompt rendering', async () => {
    await host.fs.writeText(join(homeDir, 'SYSTEM.md'), 'USER SYSTEM FILE');
    await writeAgent(
      '.kimi-code/agents/foo.md',
      'name: foo\ndescription: Foo agent',
      'prefix ${base_prompt} suffix',
    );
    const { face, close } = await startProfilesApp({ workDir, host, home: homeDir });
    try {
      expect(face.getDefault().renderSystemPrompt({}).text).toBe('USER SYSTEM FILE');
      expect(face.get('foo')!.renderSystemPrompt({}).text).toBe('prefix USER SYSTEM FILE suffix');
    } finally {
      await close();
    }
  });

  it('renders user-level files base_prompt from the SYSTEM.md-replaced default', async () => {
    await host.fs.writeText(join(homeDir, 'SYSTEM.md'), 'USER SYSTEM FILE');
    await host.fs.mkdir(join(homeDir, 'agents'), { recursive: true });
    await host.fs.writeText(
      join(homeDir, 'agents', 'helper.md'),
      '---\nname: helper\ndescription: Helper agent\n---\nprefix ${base_prompt} suffix\n',
    );
    const { face, close } = await startProfilesApp({ workDir, host, home: homeDir });
    try {
      expect(face.get('helper')!.renderSystemPrompt({}).text).toBe(
        'prefix USER SYSTEM FILE suffix',
      );
    } finally {
      await close();
    }
  });
});
