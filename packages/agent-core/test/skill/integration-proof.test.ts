/**
 * Integration proof: capture the ACTUAL system prompt and tool definitions
 * that would be sent to the LLM, proving the skill search feature works
 * end-to-end at the session level.
 */
import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../../src/skill';
import type { SkillRoot } from '../../src/skill';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const SKILLS_DIR = join(homedir(), '.kimi', 'skills');
const REPO_ROOT = join(import.meta.dirname ?? __dirname, '..', '..', '..', '..');

/**
 * Capture what the model actually sees:
 * 1. The system prompt (via getModelSkillListing)
 * 2. The Skill tool definition (check if search action exists)
 */
describe('INTEGRATION: what the LLM actually sees', () => {

  it('with real 1530 skills: auto-detects names-only tier + search', async () => {
    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: SKILLS_DIR, source: 'user' }]);

    const listing = registry.getModelSkillListing();

    console.log('\n=== Auto-detected: names-only tier (1530 skills) ===');
    console.log(`Listing size: ${listing.length.toLocaleString()} chars ≈ ${Math.round(listing.length / 4).toLocaleString()} tokens`);
    console.log(`Contains "registered skills": ${listing.includes('registered skills')}`);
    console.log(`Contains "search": ${listing.includes('search')}`);
    console.log(`Contains skill descriptions: ${listing.includes('When to use:')}`);
    console.log(`Contains paths: ${listing.includes('SKILL.md')}`);

    console.log('\n--- First 20 lines ---');
    const lines = listing.split('\n');
    for (const line of lines.slice(0, 20)) {
      console.log(`  ${line}`);
    }

    // 1530 > 300 → names-only tier with search instructions
    expect(listing).toContain('registered skills');
    expect(listing).toContain('search');
    expect(listing).not.toContain('When to use:');
    expect(listing).not.toContain('SKILL.md');
    expect(listing.length).toBeLessThan(50_000);
  });

  it('Skill tool definition includes search action description', async () => {
    const fs = await import('node:fs');
    const toolMd = fs.readFileSync(
      join(REPO_ROOT, 'packages/agent-core/src/tools/builtin/collaboration/skill-tool.md'),
      'utf-8',
    );

    console.log('\n=== Skill Tool Definition (what the model reads) ===');
    console.log(toolMd);

    expect(toolMd).toContain('search');
    expect(toolMd).toContain('load');
    expect(toolMd).toContain('action');
  });

  it('system.md tells model to search first', async () => {
    const fs = await import('node:fs');
    const systemMd = fs.readFileSync(
      join(REPO_ROOT, 'packages/agent-core/src/profile/default/system.md'),
      'utf-8',
    );

    // Find the Skills section
    const skillsIdx = systemMd.indexOf('# Skills');
    const skillsSection = systemMd.slice(skillsIdx, skillsIdx + 1500);

    console.log('\n=== System Prompt Skills Section ===');
    console.log(skillsSection);

    expect(skillsSection).toContain('search');
    expect(skillsSection).toContain('action: "search"');
    expect(skillsSection).toContain('action: "load"');
    expect(skillsSection).toContain('search');
  });

  it('end-to-end: search finds the right skill for a real task', async () => {
    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: SKILLS_DIR, source: 'user' }]);

    // Simulate what the model would do:
    // 1. User says "write playwright e2e tests"
    // 2. Model calls Skill tool with action:"search", query:"playwright e2e test"
    // 3. Model gets results, picks the best one
    // 4. Model calls Skill tool with action:"load", skill:"<name>"

    console.log('\n=== End-to-End Simulation ===');

    // Step 1: User request
    const userRequest = 'write playwright e2e tests';
    console.log(`User: "${userRequest}"`);

    // Step 2: Model searches
    const t0 = performance.now();
    const results = registry.searchSkills(userRequest, 5);
    const tSearch = performance.now() - t0;
    console.log(`\nSearch (${tSearch.toFixed(1)}ms):`);
    for (const r of results) {
      console.log(`  ${r.name} (score: ${r.score}) - ${r.description.slice(0, 80)}`);
    }

    // Step 3: Model picks top result
    const picked = results[0]!;
    console.log(`\nModel picks: "${picked.name}"`);
    expect(picked.name).toMatch(/test|e2e|playwright/i);

    // Step 4: Model loads the skill
    const skill = registry.getSkill(picked.name);
    expect(skill).toBeDefined();
    console.log(`Skill loaded: ${skill!.name}`);
    console.log(`Skill path: ${skill!.path}`);
    console.log(`Content preview: ${skill!.content.slice(0, 200)}...`);
  });
});
