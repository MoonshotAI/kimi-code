import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BashParserService } from '#/app/bashParser/bashParserService';
import type {
  ArtexAssetInterceptRule,
  ArtexInterceptRule,
} from '#/features/artex/store/artexWorkStore';
import { FileArtexWorkStore } from '#/features/artex/store/fileArtexWorkStore';

import type { ArtexBashParse } from './argv';
import { argvRuleMatches } from './argv';
import { evaluateAssetGate, matchAssetInterceptRules } from './assetGate';
import { evaluateArtexGate } from './guard';
import { matchInterceptRules } from './interceptRules';
import { checkArtexTargets } from './targetGate';
import type { ArtexResolveResult, IArtexTargetResolver } from './targetResolver';
import { ArtexTargetGatePermissionPolicyService } from './artexTargetGatePolicy';
import { stubFlag } from '../../../../test/app/flag/stubs';
import type { IArtexModeService } from '#/features/artex/agent/artexMode';
import type { IAgentProfileService } from '#/agent/profile/profile';
import type { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import { ArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

const parser = new BashParserService();
const parse: ArtexBashParse = (source) => parser.parse(source, { timeoutMs: 500, maxNodes: 10_000 });

function fakeResolver(map: Record<string, readonly string[]>): IArtexTargetResolver {
  return {
    _serviceBrand: undefined,
    resolverName: 'test',
    lookup: async (host: string): Promise<ArtexResolveResult> => {
      const ips = map[host];
      if (ips === undefined || ips.length === 0) throw new Error(`no addresses for ${host}`);
      return { ips, resolvedAt: '2020-01-01T00:00:00.000Z' };
    },
  };
}

function interceptRule(overrides: Partial<ArtexInterceptRule>): ArtexInterceptRule {
  return {
    id: 1,
    name: 'test rule',
    enabled: true,
    priority: 100,
    matchTarget: 'tool_input',
    matchType: 'regex',
    pattern: '',
    action: 'deny',
    message: '',
    builtin: false,
    ...overrides,
  };
}

function assetRule(overrides: Partial<ArtexAssetInterceptRule>): ArtexAssetInterceptRule {
  return {
    id: 1,
    enabled: true,
    kind: 'exact_domain',
    pattern: '',
    note: '',
    builtin: false,
    ...overrides,
  };
}

describe('artex safety spine', () => {
  let dir: string;
  let store: FileArtexWorkStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artex-safety-'));
    store = new FileArtexWorkStore(dir);
    await store.ensureSeeded();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('no-silent-approve invariant', () => {
    it('asks, never silently approves, when no pin or exemption covers a resolved target', async () => {
      const resolver = fakeResolver({ 'target.example.com': ['203.0.113.5'] });
      const decision = await evaluateArtexGate({
        store,
        resolver,
        taskId: 1,
        toolName: 'WebFetch',
        args: { url: 'http://target.example.com' },
        parse,
      });
      expect(decision.kind).not.toBe('pass');
      expect(decision.kind).toBe('ask-target');
    });

    it('denies (TARGET_RESOLVE_FAILED), never approves, when a declared target does not resolve', async () => {
      const resolver = fakeResolver({});
      const decision = await evaluateArtexGate({
        store,
        resolver,
        taskId: 1,
        toolName: 'WebFetch',
        args: { url: 'http://unknown.example.com' },
        parse,
      });
      expect(decision.kind).toBe('deny');
      if (decision.kind === 'deny') {
        expect(decision.message).toContain('TARGET_RESOLVE_FAILED');
      }
    });

    it('denies outright when a built-in intercept rule matches', async () => {
      const resolver = fakeResolver({ 'target.example.com': ['203.0.113.5'] });
      const decision = await evaluateArtexGate({
        store,
        resolver,
        taskId: 1,
        toolName: 'Bash',
        args: { command: 'rm -rf /' },
        parse,
      });
      expect(decision.kind).toBe('deny');
    });
  });

  describe('target pin coverage', () => {
    it('passes when an active pin covers the resolved host', async () => {
      const resolver = fakeResolver({ 'pinned.example.com': ['198.51.100.9'] });
      await store.createTargetPin({
        taskId: 1,
        host: 'pinned.example.com',
        port: 80,
        pinnedIps: ['198.51.100.9'],
        resolver: 'test',
      });
      const result = await checkArtexTargets({
        store,
        resolver,
        taskId: 1,
        toolName: 'WebFetch',
        args: { url: 'http://pinned.example.com' },
      });
      expect(result.block).toBeUndefined();
      expect(result.unpinned).toHaveLength(0);
    });

    it('does not let a pin for a different IP cover an uncovered resolution', async () => {
      const resolver = fakeResolver({ 'pinned.example.com': ['198.51.100.9'] });
      await store.createTargetPin({
        taskId: 1,
        host: 'pinned.example.com',
        port: 80,
        pinnedIps: ['10.10.10.10'],
        resolver: 'test',
      });
      const result = await checkArtexTargets({
        store,
        resolver,
        taskId: 1,
        toolName: 'WebFetch',
        args: { url: 'http://pinned.example.com' },
      });
      expect(result.block).toBeUndefined();
      expect(result.unpinned).toHaveLength(1);
    });
  });
});

describe('asset-intercept matching', () => {
  it('matches an exact domain, a fuzzy suffix and a cidr', () => {
    expect(
      matchAssetInterceptRules(
        [assetRule({ kind: 'exact_domain', pattern: 'blocked.example.com' })],
        ['blocked.example.com'],
        [],
        [],
      )?.value,
    ).toBe('blocked.example.com');

    expect(
      matchAssetInterceptRules(
        [assetRule({ kind: 'fuzzy_domain', pattern: '.gov' })],
        ['agency.gov'],
        [],
        [],
      )?.value,
    ).toBe('agency.gov');

    expect(
      matchAssetInterceptRules(
        [assetRule({ kind: 'cidr', pattern: '10.0.0.0/8' })],
        [],
        ['10.1.2.3'],
        [],
      )?.value,
    ).toBe('10.1.2.3');
  });

  it('blocks via the gate, and a whitelist with no match also rejects', () => {
    const blocked = evaluateAssetGate(
      [assetRule({ kind: 'fuzzy_domain', pattern: '.gov' })],
      [],
      ['agency.gov'],
      [],
      [],
    );
    expect(blocked.allowed).toBe(false);

    const outOfScope = evaluateAssetGate(
      [],
      [assetRule({ kind: 'exact_domain', pattern: 'in-scope.example.com' })],
      ['other.example.com'],
      [],
      [],
    );
    expect(outOfScope.allowed).toBe(false);

    const allowed = evaluateAssetGate([], [], ['free.example.com'], [], []);
    expect(allowed.allowed).toBe(true);
  });
});

describe('argv intercept rules', () => {
  it('matches a bash command whose derived prefix equals the rule tokens', () => {
    expect(argvRuleMatches(['git', 'push'], 'Bash', 'git push origin main', parse)).toBe(true);
    expect(argvRuleMatches(['git', 'push'], 'Bash', 'git status', parse)).toBe(false);
  });

  it('routes an argv rule through matchInterceptRules', () => {
    const rules = [
      interceptRule({ matchType: 'argv', pattern: '["git","push"]', action: 'deny', name: 'no push' }),
    ];
    expect(matchInterceptRules(rules, 'Bash', '', 'git push origin main', parse)?.action).toBe('deny');
    expect(matchInterceptRules(rules, 'Bash', '', 'git status', parse)).toBeUndefined();
  });

  it('extracts FetchURL targets and applies intercept rules to FetchURL and WebSearch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artex-fetchurl-'));
    try {
      const workStore = new FileArtexWorkStore(dir);
      await workStore.ensureSeeded();
      const resolver = fakeResolver({ 'target.example.com': ['203.0.113.5'] });

      const decision = await evaluateArtexGate({
        store: workStore,
        resolver,
        taskId: 1,
        toolName: 'FetchURL',
        args: { url: 'https://target.example.com/admin' },
        parse,
      });
      expect(decision.kind).toBe('ask-target');

      const searchDecision = await evaluateArtexGate({
        store: workStore,
        resolver,
        taskId: 1,
        toolName: 'WebSearch',
        args: { query: 'target.example.com' },
        parse,
      });
      expect(searchDecision.kind).toBe('pass');

      const rules = [
        interceptRule({
          matchType: 'regex',
          pattern: 'secret\\.example\\.com',
          action: 'deny',
          name: 'block secret',
        }),
      ];
      expect(
        matchInterceptRules(rules, 'FetchURL', 'https://secret.example.com/a', undefined, parse)?.action,
      ).toBe('deny');
      expect(
        matchInterceptRules(rules, 'WebSearch', 'site:secret.example.com', undefined, parse)?.action,
      ).toBe('deny');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('approves internal ARTEX domain tools while strictly gating FetchURL via ArtexTargetGatePermissionPolicyService', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artex-policy-'));
    try {
      const provider = new ArtexWorkStoreProvider();
      const resolver = fakeResolver({ 'target.example.com': ['203.0.113.5'] });
      const mode: IArtexModeService = {
        _serviceBrand: undefined,
        isActive: true,
        enter: () => {},
        exit: () => {},
      };
      const profile = {
        data: () => ({ profileName: 'artex-worker' }),
      } as unknown as IAgentProfileService;
      const session: IArtexSessionContext = {
        _serviceBrand: undefined,
        workspaceRoot: dir,
        getActiveExplorationId: () => 1,
        setActiveExplorationId: () => {},
      };
      const policy = new ArtexTargetGatePermissionPolicyService(
        stubFlag(true),
        mode,
        profile,
        session,
        provider,
        resolver,
        parser,
      );

      const hookCtx = (toolName: string, args: Record<string, unknown>) =>
        ({
          turnId: 0,
          signal: new AbortController().signal,
          toolCall: { type: 'function', id: 'c1', name: toolName, arguments: JSON.stringify(args) },
          toolCalls: [],
          args,
          execution: {
            description: toolName,
            display: { kind: 'generic', summary: toolName, detail: args },
            accesses: [],
            approvalRule: toolName,
            execute: async () => ({ output: '' }),
          },
        }) as unknown as ResolvedToolExecutionHookContext;

      await expect(policy.evaluate(hookCtx('graph_overview', {}))).resolves.toEqual({
        kind: 'approve',
      });
      await expect(policy.evaluate(hookCtx('record_fact', { summary: 'x' }))).resolves.toEqual({
        kind: 'approve',
      });
      await expect(
        policy.evaluate(hookCtx('FetchURL', { url: 'http://target.example.com' })),
      ).resolves.toMatchObject({ kind: 'ask' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
