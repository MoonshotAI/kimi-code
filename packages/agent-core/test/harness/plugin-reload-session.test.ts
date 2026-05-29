import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRPC,
  KimiCore,
  type ApprovalResponse,
  type CoreAPI,
  type CoreRPC,
  type Event,
  type SDKAPI,
} from '../../src';

// A provider + model so a session created WITH a model has a real provider
// (and therefore initializes builtin tools, incl. the gated Skill tool). No
// default_model: sessions created without a model stay provider-less, so the
// other tests' behavior is unchanged.
const CONFIG = `
[providers."test-provider"]
type = "kimi"
api_key = "test-key"
base_url = "https://api.example/v1"

[models."test/model"]
provider = "test-provider"
model = "test-model"
max_context_size = 1000000
`;

describe('plugin reload hot-apply to a live session', () => {
  let tmp: string;
  let homeDir: string;
  let workDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-plugin-reload-'));
    homeDir = join(tmp, 'home');
    workDir = join(tmp, 'work');
    configPath = join(tmp, 'config.toml');
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, CONFIG);
    // Hermetic OS home so the developer's real ~/.kimi-code skills don't leak
    // into the session and pre-populate invocable skills (which would defeat
    // the "Skill tool appears only after hot-load" assertion).
    const osHome = join(tmp, 'os-home');
    await mkdir(osHome, { recursive: true });
    vi.stubEnv('HOME', osHome);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('makes a newly installed plugin skill available after reload', async () => {
    const { core, rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_reload_skill', workDir });

    // The skill does not exist before the plugin is installed.
    const before = await rpc.listSkills({ sessionId: created.id });
    expect(before.some((skill) => skill.name === 'hotpack-review')).toBe(false);

    const pluginRoot = await makePlugin('hotpack', { skillNames: ['hotpack-review'] });
    await rpc.installPlugin({ source: pluginRoot });

    // Installing alone does not touch the already-running session.
    const afterInstall = await rpc.listSkills({ sessionId: created.id });
    expect(afterInstall.some((skill) => skill.name === 'hotpack-review')).toBe(false);

    // Reload hot-applies the plugin to this session.
    const result = await rpc.reloadPlugins({ sessionId: created.id });
    expect(result.applied?.addedSkills).toContain('hotpack-review');

    // The skill is now listed...
    const afterReload = await rpc.listSkills({ sessionId: created.id });
    expect(afterReload.some((skill) => skill.name === 'hotpack-review')).toBe(true);

    // ...but the base system prompt is intentionally NOT rewritten — the model
    // learns the new skill via the SkillRefreshInjector on its next turn (see
    // skill-refresh.test.ts), which keeps the prompt-cache prefix stable.
    const main = core.sessions.get(created.id)?.agents.get('main');
    expect(main?.config.systemPrompt).not.toContain('hotpack-review');
  });

  it('exposes the Skill builtin tool to the model only after a skill is hot-loaded', async () => {
    const { rpc } = await createTestRpc();
    // A model gives the main agent a provider, so builtin tools initialize and
    // the gated Skill tool can appear once an invocable skill exists.
    const created = await rpc.createSession({ id: 'ses_reload_skilltool', workDir, model: 'test/model' });

    // With zero invocable skills, the Skill tool is gated out of the tool set.
    const before = await rpc.getTools({ sessionId: created.id, agentId: 'main' });
    expect(before.some((tool) => tool.name === 'Skill')).toBe(false);

    const pluginRoot = await makePlugin('toolpack', { skillNames: ['toolpack-do'] });
    await rpc.installPlugin({ source: pluginRoot });
    await rpc.reloadPlugins({ sessionId: created.id });

    // The hot-loaded skill makes the Skill tool available so the model can call it.
    const after = await rpc.getTools({ sessionId: created.id, agentId: 'main' });
    expect(after.some((tool) => tool.name === 'Skill')).toBe(true);
  });

  it('does not report a plugin MCP server that failed to connect as added/active', async () => {
    const { core, rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_reload_mcp', workDir });

    const pluginRoot = await makePlugin('datapack', {
      mcpServers: { data: { command: 'kimi-nonexistent-mcp-binary' } },
    });
    await rpc.installPlugin({ source: pluginRoot });

    const first = await rpc.reloadPlugins({ sessionId: created.id });
    // The bogus command fails fast: the server entry is registered on the
    // session but must NOT be reported as "now active".
    expect(first.applied?.addedMcpServers).toEqual([]);
    const entry = core.sessions.get(created.id)?.mcp.list().find((e) => e.name === 'plugin-datapack:data');
    expect(entry?.status).toBe('failed');
    expect(first.applied?.needsNewSession).toBe(false);
  });

  it('flags needsNewSession when a plugin MCP server is disabled but still registered', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_reload_mcp_disable', workDir });

    const pluginRoot = await makePlugin('datapack', {
      mcpServers: { data: { command: 'kimi-nonexistent-mcp-binary' } },
    });
    await rpc.installPlugin({ source: pluginRoot });
    await rpc.reloadPlugins({ sessionId: created.id });

    // Disabling the plugin and reloading leaves the registered server stale —
    // the live session can no longer be reconciled without a new session.
    await rpc.setPluginEnabled({ id: 'datapack', enabled: false });
    const second = await rpc.reloadPlugins({ sessionId: created.id });
    expect(second.applied?.addedMcpServers).toEqual([]);
    expect(second.applied?.needsNewSession).toBe(true);
  });

  it('flags needsNewSession when a skills-only plugin is disabled (skills stay loaded)', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_reload_skill_disable', workDir });

    const pluginRoot = await makePlugin('skillpack', { skillNames: ['skillpack-task'] });
    await rpc.installPlugin({ source: pluginRoot });

    const first = await rpc.reloadPlugins({ sessionId: created.id });
    expect(first.applied?.addedSkills).toContain('skillpack-task');
    expect(first.applied?.needsNewSession).toBe(false);

    // Disabling the plugin and reloading: loadRoots is additive so the skill
    // stays in the registry. The user must be told a new session is required.
    await rpc.setPluginEnabled({ id: 'skillpack', enabled: false });
    const second = await rpc.reloadPlugins({ sessionId: created.id });
    expect(second.applied?.needsNewSession).toBe(true);
    // The stale skill is still listed (not torn down) — exactly why /new is needed.
    const skills = await rpc.listSkills({ sessionId: created.id });
    expect(skills.some((s) => s.name === 'skillpack-task')).toBe(true);
  });

  it('flags needsNewSession when a plugin adds a sessionStart not active in this session', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_reload_sessionstart', workDir });

    const pluginRoot = await makePlugin('startpack', {
      skillNames: ['startpack-intro'],
      sessionStartSkill: 'startpack-intro',
    });
    await rpc.installPlugin({ source: pluginRoot });

    // The sessionStart was not present when this session's main agent was
    // created, so it cannot be injected mid-conversation — reload must flag it.
    const result = await rpc.reloadPlugins({ sessionId: created.id });
    expect(result.applied?.needsNewSession).toBe(true);
  });

  it('flags needsNewSession when a reinstalled plugin changes an existing MCP server config', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_mcp_cfg_change', workDir });

    await rpc.installPlugin({
      source: await makePlugin('cfgpack', { mcpServers: { data: { command: 'kimi-fake-mcp', args: ['v1'] } } }),
    });
    const first = await rpc.reloadPlugins({ sessionId: created.id });
    expect(first.applied?.needsNewSession).toBe(false);

    // Reinstall the same id with changed args for the same server name. Its
    // runtime name is unchanged, so the live session keeps the old process.
    await rpc.installPlugin({
      source: await makePlugin('cfgpack', { mcpServers: { data: { command: 'kimi-fake-mcp', args: ['v2'] } } }),
    });
    const second = await rpc.reloadPlugins({ sessionId: created.id });
    expect(second.applied?.needsNewSession).toBe(true);
  });

  it('flags needsNewSession when a reinstalled plugin renames a skill', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_skill_rename', workDir });

    await rpc.installPlugin({ source: await makePlugin('renamepack', { skillNames: ['old-skill'] }) });
    const first = await rpc.reloadPlugins({ sessionId: created.id });
    expect(first.applied?.needsNewSession).toBe(false);

    // Reinstall with the skill renamed: old-skill removed on disk, new-skill added.
    await rpc.installPlugin({ source: await makePlugin('renamepack', { skillNames: ['new-skill'] }) });
    const second = await rpc.reloadPlugins({ sessionId: created.id });
    expect(second.applied?.needsNewSession).toBe(true);

    // new-skill is hot-loaded; old-skill lingers in the additive registry — which
    // is exactly why a new session is required to drop it.
    const skills = await rpc.listSkills({ sessionId: created.id });
    expect(skills.some((s) => s.name === 'new-skill')).toBe(true);
    expect(skills.some((s) => s.name === 'old-skill')).toBe(true);
  });

  it('keeps needsNewSession false when a reinstalled plugin only ADDS a skill', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_skill_add', workDir });

    await rpc.installPlugin({ source: await makePlugin('addpack', { skillNames: ['skill-a'] }) });
    await rpc.reloadPlugins({ sessionId: created.id });

    await rpc.installPlugin({ source: await makePlugin('addpack', { skillNames: ['skill-a', 'skill-b'] }) });
    const second = await rpc.reloadPlugins({ sessionId: created.id });
    expect(second.applied?.addedSkills).toContain('skill-b');
    expect(second.applied?.needsNewSession).toBe(false);
  });

  it('captures the skill-listing baseline on resume so a later reload can still surface skills', async () => {
    const first = await createTestRpc();
    const created = await first.rpc.createSession({ id: 'ses_resume_base', workDir });
    await first.core.sessions.get(created.id)?.flushMetadata();

    // A fresh process resumes the session: useProfile is NOT called, but the
    // baseline must still be seeded (otherwise SkillRefreshInjector goes silent).
    const second = await createTestRpc();
    await second.rpc.resumeSession({ sessionId: created.id });
    const main = second.core.sessions.get(created.id)?.agents.get('main');
    expect(main?.systemPromptSkillListing).toBeDefined();
  });

  async function makePlugin(
    name: string,
    options: {
      readonly skillNames?: readonly string[];
      readonly mcpServers?: Record<string, unknown>;
      readonly sessionStartSkill?: string;
    } = {},
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `plugin-${name}-`));
    const manifest: Record<string, unknown> = { name };
    for (const skillName of options.skillNames ?? []) {
      manifest['skills'] = './skills/';
      await mkdir(join(root, 'skills', skillName), { recursive: true });
      await writeFile(
        join(root, 'skills', skillName, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: A hot-loaded skill\n---\nbody`,
        'utf8',
      );
    }
    if (options.mcpServers !== undefined) {
      manifest['mcpServers'] = options.mcpServers;
    }
    if (options.sessionStartSkill !== undefined) {
      manifest['sessionStart'] = { skill: options.sessionStartSkill };
    }
    await writeFile(join(root, 'kimi.plugin.json'), JSON.stringify(manifest), 'utf8');
    return realpath(root);
  }

  async function createTestRpc(): Promise<{ core: KimiCore; events: Event[]; rpc: CoreRPC }> {
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const events: Event[] = [];
    const core = new KimiCore(coreRpc, { homeDir, configPath });
    const rpc = await sdkRpc({
      emitEvent: (event) => {
        events.push(event);
      },
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
    return { core, events, rpc };
  }
});
