import { describe, expect, it } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { BUILTIN_SKILLS, visibleBuiltinSkills } from '#/app/skillCatalog/builtin/builtin';
import { BuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { BUILTIN_PRODUCT_SKILLS_SECTION } from '#/app/skillCatalog/configSection';

import { StubConfigService } from '../../kosong/stubs';

const PRODUCT_SKILLS = [
  'mcp-config',
  'import-from-cc-codex',
  'update-config',
  'custom-theme',
  'check-kimi-code-docs',
];
const NEUTRAL_SKILLS = BUILTIN_SKILLS.map((s) => s.name).filter(
  (name) => !PRODUCT_SKILLS.includes(name),
);

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
  it('marks exactly the product-documentation skills', () => {
    expect(BUILTIN_SKILLS.filter((s) => s.productSpecific === true).map((s) => s.name).toSorted())
      .toEqual([...PRODUCT_SKILLS].toSorted());
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

  it('exposes the same filter the session-less listings compose with', () => {
    expect(visibleBuiltinSkills(true).map((s) => s.name)).toEqual(
      BUILTIN_SKILLS.map((s) => s.name),
    );
    expect(visibleBuiltinSkills(false).map((s) => s.name)).toEqual(NEUTRAL_SKILLS);
  });

  it('signals a change when the switch is toggled', async () => {
    const config = new StubConfigService({ [BUILTIN_PRODUCT_SKILLS_SECTION]: true });
    const ix = new TestInstantiationService();
    ix.set(IConfigService, config);
    const source = ix.createInstance(BuiltinSkillSource);

    let fired = 0;
    source.onDidChange?.(() => {
      fired += 1;
    });

    await config.replace(BUILTIN_PRODUCT_SKILLS_SECTION, false);
    expect(fired).toBe(1);
    expect((await source.load()).skills.map((s) => s.name)).toEqual(NEUTRAL_SKILLS);

    await config.replace('unrelatedSection', 'x');
    expect(fired).toBe(1);
  });

  it('waits for config readiness before reading the switch', async () => {
    let release = (): void => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loaded = false;
    const config = {
      _serviceBrand: undefined,
      ready,
      get: () => (loaded ? false : undefined),
      onDidSectionChange: () => ({ dispose: () => {} }),
    } as unknown as IConfigService;

    const ix = new TestInstantiationService();
    ix.set(IConfigService, config);
    const source = ix.createInstance(BuiltinSkillSource);

    const loading = source.load();
    loaded = true;
    release();

    const names = (await loading).skills.map((s) => s.name);
    expect(names).toEqual(NEUTRAL_SKILLS);
  });
});
