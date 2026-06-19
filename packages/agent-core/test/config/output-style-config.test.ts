import { describe, expect, it } from 'vitest';
import { KimiConfigSchema, KimiConfigPatchSchema } from '../../src/config/schema';
describe('outputStyle config', () => {
  it('accepts an outputStyle name', () => { expect(KimiConfigSchema.parse({ outputStyle: 'concise' }).outputStyle).toBe('concise'); });
  it('is optional', () => { expect(KimiConfigSchema.parse({}).outputStyle).toBeUndefined(); });
  it('is patchable', () => { expect(KimiConfigPatchSchema.parse({ outputStyle: 'explanatory' }).outputStyle).toBe('explanatory'); });
});
