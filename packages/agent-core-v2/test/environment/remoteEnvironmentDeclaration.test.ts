import { describe, expect, it } from 'vitest';

import {
  EnvironmentsSectionSchema,
  environmentIdProblem,
} from '#/environment/remoteEnvironmentDeclaration';

function parse(value: unknown) {
  return EnvironmentsSectionSchema.safeParse(value);
}

describe('EnvironmentsSectionSchema', () => {
  it('rejects reserved environment ids', () => {
    expect(parse({ local: { type: 'ssh', host: 'x' } }).success).toBe(false);
    expect(environmentIdProblem('local')).toContain('reserved');
    expect(environmentIdProblem('default')).toContain('reserved');
  });
});
