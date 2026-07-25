/**
 * Scenario: agent-root resolution — user / project / configured roots,
 * .git walk-up, brand-vs-generic ordering, `~` and relative path expansion,
 * and canonical dedup. Exercises the path primitives against real temp dirs.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/agentFileCatalog/agentRoots.test.ts`.
 */

import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configuredAgentRoots,
  projectAgentRoots,
  userAgentRoots,
} from '#/app/agentFileCatalog/agentRoots';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

const hostFs = new HostFileSystem();

describe('agentRoots', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-roots-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function markGitRoot(dir: string = root): Promise<void> {
    await mkdir(join(dir, '.git'), { recursive: true });
  }

  describe('projectRoots', () => {
    it('resolves the brand .kimi-code/agents directory at the .git root', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kimi-code/agents'), { recursive: true });

      const roots = await projectAgentRoots(hostFs, root);

      expect(
        roots.some((r) => r.path.endsWith('.kimi-code/agents') && r.source === 'project'),
      ).toBe(true);
    });

    it('falls back to the generic .agents/agents directory', async () => {
      await markGitRoot();
      await mkdir(join(root, '.agents/agents'), { recursive: true });

      const roots = await projectAgentRoots(hostFs, root);

      expect(roots.some((r) => r.path.endsWith('.agents/agents') && r.source === 'project')).toBe(
        true,
      );
      expect(roots.some((r) => r.path.endsWith('.kimi-code/agents'))).toBe(false);
    });

    it('walks up from a child directory to the .git root', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kimi-code/agents'), { recursive: true });
      const child = join(root, 'src/pkg');
      await mkdir(child, { recursive: true });

      const roots = await projectAgentRoots(hostFs, child);

      expect(roots.some((r) => r.path.endsWith('.kimi-code/agents'))).toBe(true);
    });

    it('orders the brand directory before the generic directory', async () => {
      await markGitRoot();
      await mkdir(join(root, '.kimi-code/agents'), { recursive: true });
      await mkdir(join(root, '.agents/agents'), { recursive: true });

      const roots = await projectAgentRoots(hostFs, root);
      const brandIdx = roots.findIndex((r) => r.path.endsWith('.kimi-code/agents'));
      const genericIdx = roots.findIndex((r) => r.path.endsWith('.agents/agents'));

      expect(brandIdx).toBeGreaterThanOrEqual(0);
      expect(genericIdx).toBeGreaterThan(brandIdx);
    });
  });

  describe('userRoots', () => {
    it('resolves the brand agents directory under homeDir', async () => {
      await mkdir(join(root, 'agents'), { recursive: true });

      const roots = await userAgentRoots(hostFs, root, root);

      expect(roots.some((r) => r.path.endsWith('/agents') && r.source === 'user')).toBe(true);
    });

    it('falls back to the generic .agents/agents under osHomeDir', async () => {
      const homeDir = join(root, 'brand-home');
      const osHomeDir = join(root, 'os-home');
      await mkdir(homeDir, { recursive: true });
      await mkdir(join(osHomeDir, '.agents/agents'), { recursive: true });

      const roots = await userAgentRoots(hostFs, homeDir, osHomeDir);

      expect(roots.some((r) => r.path.endsWith('.agents/agents') && r.source === 'user')).toBe(
        true,
      );
    });
  });

  describe('configuredRoots', () => {
    it('resolves ~, ~/, absolute, and project-relative paths', async () => {
      await markGitRoot();
      const homeDir = join(root, 'home');
      const absDir = join(root, 'abs');
      await mkdir(homeDir, { recursive: true });
      await mkdir(join(homeDir, 'team'), { recursive: true });
      await mkdir(absDir, { recursive: true });
      await mkdir(join(root, 'relative'), { recursive: true });

      const roots = await configuredAgentRoots(
        hostFs,
        ['~', '~/team', absDir, 'relative'],
        root,
        homeDir,
        'extra',
      );
      const paths = roots.map((r) => r.path);

      expect(roots.every((r) => r.source === 'extra')).toBe(true);
      expect(paths).toContain(await realpath(homeDir));
      expect(paths).toContain(await realpath(join(homeDir, 'team')));
      expect(paths).toContain(await realpath(absDir));
      expect(paths).toContain(await realpath(join(root, 'relative')));
    });

    it('propagates filesystem-unavailable failures while probing a root', async () => {
      const unavailableFs = new Proxy(hostFs, {
        get(target, property, receiver) {
          if (property === 'realpath') {
            return () =>
              Promise.reject(
                new HostFsError(OsFsErrors.codes.OS_FS_UNAVAILABLE, 'filesystem unavailable'),
              );
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      await expect(
        configuredAgentRoots(unavailableFs, ['agents'], root, root, 'extra'),
      ).rejects.toMatchObject({ code: OsFsErrors.codes.OS_FS_UNAVAILABLE });
    });

    it('skips an unreadable configured root and keeps later roots', async () => {
      const blockedDir = join(root, 'blocked');
      const availableDir = join(root, 'available');
      await mkdir(availableDir, { recursive: true });
      const permissionFs = new Proxy(hostFs, {
        get(target, property, receiver) {
          if (property === 'realpath') {
            return (path: string) =>
              path === blockedDir
                ? Promise.reject(
                    new HostFsError(
                      OsFsErrors.codes.OS_FS_PERMISSION_DENIED,
                      'permission denied',
                    ),
                  )
                : target.realpath(path);
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const warnings: string[] = [];

      const roots = await configuredAgentRoots(
        permissionFs,
        [blockedDir, availableDir],
        root,
        root,
        'extra',
        (message) => warnings.push(message),
      );

      expect(roots.map((candidate) => candidate.path)).toEqual([await realpath(availableDir)]);
      expect(warnings.some((warning) => warning.includes(blockedDir))).toBe(true);
    });
  });
});
