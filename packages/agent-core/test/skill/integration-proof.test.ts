/**
 * Integration proof: capture what the LLM actually sees — system prompt,
 * tool definitions, and end-to-end skill search with real fixture skills.
 *
 * Uses a temporary fixture directory (not ~/.kimi/skills) so tests are
 * portable across CI and developer machines.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { SkillRegistry } from '../../src/skill';
import type { SkillRoot } from '../../src/skill';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

let FIXTURE_DIR: string;

beforeAll(() => {
  FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'kimi-skill-test-'));

  // Create 350 fixture skills (enough to trigger names-only tier at >300)
  for (let i = 0; i < 350; i++) {
    const name = `test-skill-${String(i).padStart(3, '0')}`;
    const dir = join(FIXTURE_DIR, name);
    mkdirSync(dir, { recursive: true });
    const domain = ['docker', 'react', 'security', 'database', 'api', 'playwright', 'testing', 'deploy'][i % 8];
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${domain} automation and best practices for skill ${String(i)}\nwhenToUse: When working on ${domain} tasks\n---\n\n# ${name}\n\nDetailed instructions for ${domain} skill ${String(i)}.\n\n\`\`\`bash\n# Example usage\necho "running ${name}"\n\`\`\`\n`,
    );
  }
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('INTEGRATION: what the LLM actually sees', () => {
  it('auto-detects names-only tier for 350 fixture skills', async () => {
    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: FIXTURE_DIR, source: 'user' }]);

    const listing = registry.getModelSkillListing();

    console.log('\n=== Auto-detected: names-only tier (350 skills) ===');
    console.log(`Listing size: ${listing.length.toLocaleString()} chars ≈ ${Math.round(listing.length / 4).toLocaleString()} tokens`);
    console.log(`Contains "registered skills": ${listing.includes('registered skills')}`);
    console.log(`Contains "search": ${listing.includes('search')}`);

    // 350 > 300 → names-only tier with search instructions
    expect(listing).toContain('registered skills');
    expect(listing).toContain('search');
    expect(listing).not.toContain('When to use:');
    expect(listing).not.toContain('SKILL.md');
  });

  it('Skill tool definition includes search action description', async () => {
    const fs = await import('node:fs');
    const REPO_ROOT = join(import.meta.dirname ?? __dirname, '..', '..', '..', '..');
    const toolMd = fs.readFileSync(
      join(REPO_ROOT, 'packages/agent-core/src/tools/builtin/collaboration/skill-tool.md'),
      'utf-8',
    );

    console.log('\n=== Skill Tool Definition ===');
    console.log(toolMd);

    expect(toolMd).toContain('search');
    expect(toolMd).toContain('load');
    expect(toolMd).toContain('action');
  });

  it('system.md instructs search-first workflow', async () => {
    const fs = await import('node:fs');
    const REPO_ROOT = join(import.meta.dirname ?? __dirname, '..', '..', '..', '..');
    const systemMd = fs.readFileSync(
      join(REPO_ROOT, 'packages/agent-core/src/profile/default/system.md'),
      'utf-8',
    );

    const skillsIdx = systemMd.indexOf('# Skills');
    const skillsSection = systemMd.slice(skillsIdx, skillsIdx + 1500);

    expect(skillsSection).toContain('search');
    expect(skillsSection).toContain('action: "search"');
    expect(skillsSection).toContain('action: "load"');
  });

  it('end-to-end: search finds the right skill for a real task', async () => {
    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: FIXTURE_DIR, source: 'user' }]);

    console.log('\n=== End-to-End Simulation ===');

    const userRequest = 'deploy docker containers';
    console.log(`User: "${userRequest}"`);

    const t0 = performance.now();
    const results = registry.searchSkills(userRequest, 5);
    const tSearch = performance.now() - t0;
    console.log(`\nSearch (${tSearch.toFixed(1)}ms):`);
    for (const r of results) {
      console.log(`  ${r.name} (score: ${r.score}) - ${r.description.slice(0, 60)}`);
    }

    const picked = results[0]!;
    console.log(`\nModel picks: "${picked.name}"`);
    expect(picked.description).toMatch(/deploy|docker/);

    // Verify lazy content load works
    const skill = registry.getSkill(picked.name);
    expect(skill).toBeDefined();

    const rendered = registry.renderSkillPrompt(skill!, '');
    console.log(`Rendered: ${rendered.length} chars`);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain('Detailed instructions');
  });
});
