import { describe, expect, it } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { BUILTIN_SKILLS } from '#/app/skillCatalog/builtin/builtin';
import { BuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { BUILTIN_PRODUCT_SKILLS_SECTION } from '#/app/skillCatalog/configSection';

import { StubConfigService } from '../../kosong/stubs';

const PRODUCT_SKILLS = BUILTIN_SKILLS.filter((s) => s.productSpecific === true).map((s) => s.name);
const NEUTRAL_SKILLS = BUILTIN_SKILLS.filter((s) => s.productSpecific !== true).map((s) => s.name);

async function loadNames(configured?: boolean): Promise<readonly string[]> {
  const ix = new TestInstantiationService();
  ix.set(
    IConfigService,
    new StubConfigService(
      configured === undefined ? {} : { [BUILTIN_PRODUCT_SKILLS_SECTION]: configured },
    ),
  );
  const source = ix.createInstance(BuiltinSkillSource);
  return (await source.load()).skills.map((s) => s.name);
}

describe('BuiltinSkillSource product-skill switch', () => {
  it('has both product-specific and neutral builtin skills to distinguish', () => {
    expect(PRODUCT_SKILLS.length).toBeGreaterThan(0);
    expect(NEUTRAL_SKILLS.length).toBeGreaterThan(0);
  });

  it('offers every builtin skill when the section is unset', async () => {
    const names = await loadNames();
    expect(names).toEqual(BUILTIN_SKILLS.map((s) => s.name));
  });

  it('offers every builtin skill when explicitly enabled', async () => {
    const names = await loadNames(true);
    expect(names).toEqual(BUILTIN_SKILLS.map((s) => s.name));
  });

  it('drops product-documentation skills when explicitly disabled', async () => {
    const names = await loadNames(false);
    expect(names).toEqual(NEUTRAL_SKILLS);
    for (const name of PRODUCT_SKILLS) expect(names).not.toContain(name);
  });
});
