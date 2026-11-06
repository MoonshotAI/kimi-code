import { describe, expect, it } from 'vitest';

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
});
