import { describe, expect, it } from 'vitest';

import { environmentsFromToml } from '#/remote/declaration/configSection';
import {
  EnvironmentsSectionSchema,
  environmentIdProblem,
} from '#/remote/declaration/remoteEnvironmentDeclaration';

function parse(value: unknown) {
  return EnvironmentsSectionSchema.safeParse(value);
}

describe('EnvironmentsSectionSchema', () => {
  it('rejects reserved environment ids', () => {
    expect(parse({ local: { type: 'ssh', host: 'x' } }).success).toBe(false);
    expect(environmentIdProblem('local')).toContain('reserved');
    expect(environmentIdProblem('default')).toContain('reserved');
  });

  it('accepts an identity file only on ssh entries', () => {
    expect(parse({ dev: { type: 'ssh', host: 'x', identityFile: '~/.ssh/id' } }).success).toBe(true);
    expect(parse({ dev: { type: 'ssh', host: 'x', identityFile: '' } }).success).toBe(false);
    expect(parse({ box: { type: 'docker', container: 'c', identityFile: '~/.ssh/id' } }).success).toBe(false);
  });

  it('accepts a display name on every entry type', () => {
    expect(parse({ dev: { type: 'ssh', host: 'x', name: 'Build box' } }).success).toBe(true);
    expect(parse({ box: { type: 'docker', container: 'c', name: '开发容器' } }).success).toBe(true);
    expect(parse({ pod: { command: 'kubectl', name: 'Pod' } }).success).toBe(true);
    expect(parse({ dev: { type: 'ssh', host: 'x', name: '' } }).success).toBe(false);
    expect(parse({ dev: { type: 'ssh', host: 'x', name: 'n'.repeat(65) } }).success).toBe(false);
  });

  it('normalizes snake_case entry fields and legacy camelCase default references from TOML while keeping ids and env keys verbatim', () => {
    const raw = environmentsFromToml({
      default: 'myBox',
      my_box: {
        type: 'ssh',
        host: 'example.test',
        default_cwd: '/srv/app',
        remote_bin: '/usr/local/bin/kimi',
        identity_file: '~/.ssh/id_ed25519',
      },
      runner: {
        command: 'kubectl',
        env: { http_proxy: 'http://127.0.0.1:7890', KUBE_CONFIG: '/tmp/kube' },
      },
    });
    expect(parse(raw)).toEqual({
      success: true,
      data: {
        default: 'my_box',
        my_box: {
          type: 'ssh',
          host: 'example.test',
          defaultCwd: '/srv/app',
          remoteBin: '/usr/local/bin/kimi',
          identityFile: '~/.ssh/id_ed25519',
        },
        runner: {
          command: 'kubectl',
          env: { http_proxy: 'http://127.0.0.1:7890', KUBE_CONFIG: '/tmp/kube' },
        },
      },
    });
  });
});
