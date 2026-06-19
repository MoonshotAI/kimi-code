/**
 * Smoke test: exercises real code paths with actual skill files.
 * Proves the feature works end-to-end without LLM API calls.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SkillRegistry } from '../../src/skill';
import { LAZY_CONTENT_SENTINEL } from '../../src/skill/parser';
import { SkillSearchIndex } from '../../src/skill/search';
import { SkillTool, SkillToolInputSchema } from '../../src/tools/builtin/collaboration/skill-tool';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

let FIXTURE_DIR: string;
const SKILL_COUNT = 350;

beforeAll(() => {
  FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'smoke-'));
  for (let i = 0; i < SKILL_COUNT; i++) {
    const name = `skill-${String(i).padStart(3, '0')}`;
    const dir = join(FIXTURE_DIR, name);
    mkdirSync(dir, { recursive: true });
    const domain = ['docker', 'playwright', 'security', 'react', 'postgres', 'github-actions', 'rest-api', 'machine-learning'][i % 8];
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Best practices for ${domain} development and automation\nwhenToUse: When the user needs help with ${domain}\n---\n\n# ${name}\n\nFollow these steps for ${domain}:\n\n1. Analyze the current setup\n2. Apply best practices\n3. Verify the result\n\n\`\`\`bash\n# ${domain} example command\nnpm run ${domain}\n\`\`\`\n`,
    );
  }
});

describe('SMOKE: end-to-end skill search', () => {

  it('registry loads skills and auto-detects tier', async () => {
    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: FIXTURE_DIR, source: 'user' }]);

    const all = registry.listSkills();
    const invocable = registry.listInvocableSkills();
    expect(all.length).toBe(SKILL_COUNT);
    expect(invocable.length).toBe(SKILL_COUNT);

    // 350 > 300 → names-only tier
    const listing = registry.getModelSkillListing();
    expect(listing).toContain(`${SKILL_COUNT} registered skills`);
    expect(listing).toContain('search');
    expect(listing).not.toContain('SKILL.md');
    expect(listing).not.toContain('When to use:');

    console.log(`\n✅ Tier auto-detected: names-only (${SKILL_COUNT} skills)`);
    console.log(`   Listing: ${listing.length} chars ≈ ${Math.round(listing.length / 4)} tokens`);
  });

  it('lazy content: content is sentinel after load, loaded after renderSkillPrompt', async () => {
    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: FIXTURE_DIR, source: 'user' }]);

    const skill = registry.getSkill('skill-000');
    expect(skill).toBeDefined();
    expect(skill!.content).toBe(LAZY_CONTENT_SENTINEL);

    const rendered = registry.renderSkillPrompt(skill!, '');
    expect(rendered).toContain('Follow these steps');
    expect(rendered).toContain('npm run');

    console.log('✅ Lazy load: sentinel → readFileSync → content loaded');
    console.log(`   skill-000 content: "${skill!.content.slice(0, 30)}..." → rendered ${rendered.length} chars`);
  });

  it('BM25 search returns correct results', async () => {
    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: FIXTURE_DIR, source: 'user' }]);

    const queries = [
      ['docker container build', 'docker'],
      ['playwright browser test', 'playwright'],
      ['security vulnerability audit', 'security'],
      ['react hooks component', 'react'],
      ['postgres sql query', 'postgres'],
      ['github actions CI/CD pipeline', 'github-actions'],
      ['REST API endpoint design', 'rest-api'],
      ['machine learning model training', 'machine-learning'],
    ] as const;

    console.log('\n✅ BM25 search results:');
    let allCorrect = true;
    for (const [query, expectedDomain] of queries) {
      const results = registry.searchSkills(query, 3);
      const topDesc = results[0]?.description ?? '';
      const hit = topDesc.includes(expectedDomain);
      if (!hit) allCorrect = false;
      console.log(`   "${query}" → ${results[0]?.name} (${hit ? '✅' : '❌'} ${expectedDomain})`);
    }
    expect(allCorrect).toBe(true);
  });

  it('Skill tool schema accepts search without skill name', () => {
    // search-only: no skill required
    const r1 = SkillToolInputSchema.safeParse({ action: 'search', query: 'docker' });
    expect(r1.success).toBe(true);

    // load with skill: works
    const r2 = SkillToolInputSchema.safeParse({ skill: 'skill-000' });
    expect(r2.success).toBe(true);

    // empty: valid (skill optional)
    const r3 = SkillToolInputSchema.safeParse({});
    expect(r3.success).toBe(true);

    console.log('✅ Schema: search without skill name accepted');
  });

  it('CRLF frontmatter parsed correctly', async () => {
    const crlfDir = mkdtempSync(join(tmpdir(), 'crlf-'));
    const name = 'crlf-skill';
    const dir = join(crlfDir, name);
    mkdirSync(dir, { recursive: true });
    // Write with CRLF line endings
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\r\nname: ${name}\r\ndescription: CRLF test skill\r\n---\r\n\r\n# CRLF Skill\r\n\r\nBody content here.\r\n`,
    );

    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: crlfDir, source: 'user' }]);

    const skill = registry.getSkill(name);
    expect(skill).toBeDefined();
    expect(skill!.name).toBe(name);
    expect(skill!.description).toBe('CRLF test skill');

    // Lazy load should work
    const rendered = registry.renderSkillPrompt(skill!, '');
    expect(rendered).toContain('Body content here');

    rmSync(crlfDir, { recursive: true, force: true });
    console.log('✅ CRLF frontmatter: parsed + lazy loaded correctly');
  });

  it('model flow: search → pick → load → render', async () => {
    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: FIXTURE_DIR, source: 'user' }]);

    // Step 1: Model receives user request "set up postgres database"
    // Step 2: Model calls Skill tool with action:search
    const searchResults = registry.searchSkills('postgres database setup', 5);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0]!.description).toContain('postgres');

    // Step 3: Model picks top result
    const picked = searchResults[0]!;

    // Step 4: Model calls Skill tool with action:load
    const skill = registry.getSkill(picked.name);
    expect(skill).toBeDefined();

    // Step 5: renderSkillPrompt lazy-loads content
    const rendered = registry.renderSkillPrompt(skill!, '');
    // renderSkillPrompt returns raw content; the <kimi-skill-loaded> wrapper
    // is added by skill-tool.ts execution path, not here
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain('postgres');
    expect(rendered).toContain('Follow these steps');

    console.log('\n✅ Full model flow simulation:');
    console.log(`   1. User: "set up postgres database"`);
    console.log(`   2. Skill action:search → ${searchResults.length} results`);
    console.log(`   3. Model picks: ${picked.name} (score: ${picked.score})`);
    console.log(`   4. Skill action:load → ${rendered.length} chars rendered`);
    console.log(`   5. Content: "${rendered.slice(0, 60)}..."`);
  });
});
