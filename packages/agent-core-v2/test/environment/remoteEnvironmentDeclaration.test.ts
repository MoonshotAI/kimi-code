import { describe, expect, it } from 'vitest';

import {
  describeEnvironmentEntry,
  mergeEnvironmentDeclarations,
  EnvironmentsSectionSchema,
  sectionEntries,
  environmentIdProblem,
  type RemoteEnvironmentDeclaration,
} from '#/environment/remoteEnvironmentDeclaration';

function parse(value: unknown) {
  return EnvironmentsSectionSchema.safeParse(value);
}

describe('EnvironmentsSectionSchema', () => {
  it('parses ssh, docker, and command entries with an optional default', () => {
    const result = parse({
      default: 'dev-box',
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me/projects' },
      container: { type: 'docker', container: 'myapp-dev', context: 'orbstack' },
      sandbox: { command: 'sandbox', args: ['ssh', 'i-1'], env: { SANDBOX_TOKEN: 'x' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects entries that set both type and command', () => {
    const result = parse({
      bad: { type: 'ssh', host: 'dev-box', command: 'sandbox' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys on entries', () => {
    const result = parse({
      bad: { type: 'ssh', host: 'dev-box', cwd: '/tmp' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects reserved environment ids', () => {
    expect(parse({ local: { type: 'ssh', host: 'x' } }).success).toBe(false);
    expect(environmentIdProblem('local')).toContain('reserved');
    expect(environmentIdProblem('default')).toContain('reserved');
  });

  it('rejects ids with leading or trailing whitespace and ids over 64 characters', () => {
    expect(parse({ ' dev-box': { type: 'ssh', host: 'x' } }).success).toBe(false);
    expect(parse({ 'dev-box ': { type: 'ssh', host: 'x' } }).success).toBe(false);
    expect(parse({ ['x'.repeat(65)]: { type: 'ssh', host: 'x' } }).success).toBe(false);
    expect(parse({ ['x'.repeat(64)]: { type: 'ssh', host: 'x' } }).success).toBe(true);
  });

  it('rejects a default referencing an unconfigured id', () => {
    const result = parse({ default: 'missing', 'dev-box': { type: 'ssh', host: 'x', defaultCwd: '/x' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain('unconfigured environment "missing"');
    }
  });

  it('rejects a default whose entry has no defaultCwd', () => {
    const result = parse({ default: 'dev-box', 'dev-box': { type: 'ssh', host: 'x' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain('does not set defaultCwd');
    }
  });
});

describe('declaration merge and defaults', () => {
  const user: readonly RemoteEnvironmentDeclaration[] = [
    { id: 'dev-box', entry: { type: 'ssh', host: 'user-box', defaultCwd: '/user' }, source: 'user' },
    { id: 'other', entry: { type: 'ssh', host: 'other', defaultCwd: '/other' }, source: 'user' },
  ];
  const project: readonly RemoteEnvironmentDeclaration[] = [
    { id: 'dev-box', entry: { type: 'ssh', host: 'project-box', defaultCwd: '/project' }, source: 'project' },
  ];

  it('lets project declarations override user declarations with the same id', () => {
    const merged = mergeEnvironmentDeclarations(user, project);
    expect(merged).toHaveLength(2);
    const devBox = merged.find((declaration) => declaration.id === 'dev-box');
    expect(devBox).toMatchObject({ source: 'project', entry: { host: 'project-box' } });
  });

  it('lists section entries with their source, skipping the default key', () => {
    const section = parse({
      default: 'dev-box',
      'dev-box': { type: 'ssh', host: 'x', defaultCwd: '/home/me' },
    });
    expect(section.success).toBe(true);
    if (section.success) {
      expect(sectionEntries(section.data, 'user')).toEqual([
        { id: 'dev-box', entry: { type: 'ssh', host: 'x', defaultCwd: '/home/me' }, source: 'user' },
      ]);
    }
  });
});

describe('describeEnvironmentEntry', () => {
  it('renders ssh and docker entries as full command lines', () => {
    expect(describeEnvironmentEntry({ type: 'ssh', host: 'dev-box' })).toBe(
      'ssh dev-box ~/.kimi-code/bin/kimi exec-server --listen stdio',
    );
    expect(describeEnvironmentEntry({ type: 'docker', container: 'myapp-dev', context: 'orbstack' })).toBe(
      'docker --context orbstack exec myapp-dev ~/.kimi-code/bin/kimi exec-server --listen stdio',
    );
  });

  it('renders command entries with the resolved program path', () => {
    const line = describeEnvironmentEntry({ command: process.execPath, args: ['--version'] });
    expect(line).toBe(`${process.execPath} --version`);
  });

  it('throws for command entries that do not resolve', () => {
    expect(() => describeEnvironmentEntry({ command: 'definitely-not-a-real-binary-xyz' })).toThrow(
      /was not found on PATH/,
    );
  });
});
