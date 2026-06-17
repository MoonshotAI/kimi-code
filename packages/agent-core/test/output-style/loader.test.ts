import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOutputStyles } from '../../src/output-style/loader';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'os-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function writeStyle(root: string, name: string, body: string) {
  const d = path.join(root, 'output-styles');
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, `${name}.md`), `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}\n`);
}
describe('loadOutputStyles', () => {
  it('includes built-ins when no files exist', async () => {
    const styles = await loadOutputStyles({ paths: { userHomeDir: dir, workDir: dir } });
    expect(styles.map((s) => s.name).toSorted()).toEqual(['concise', 'explanatory']);
  });
  it('project overrides user overrides built-in by name', async () => {
    const project = path.join(dir, 'proj'); const brand = path.join(dir, 'brand');
    await mkdir(path.join(project, '.git'), { recursive: true });
    await writeStyle(path.join(project, '.kimi-code'), 'concise', 'PROJECT body');
    await writeStyle(brand, 'concise', 'USER body');
    const styles = await loadOutputStyles({ paths: { userHomeDir: dir, brandHomeDir: brand, workDir: path.join(project, '.kimi-code') } });
    const c = styles.find((s) => s.name === 'concise');
    expect(c?.body).toBe('PROJECT body'); expect(c?.source).toBe('project');
  });
  it('skips invalid files but keeps the rest', async () => {
    const brand = path.join(dir, 'brand');
    await writeStyle(brand, 'good', 'ok body');
    await mkdir(path.join(brand, 'output-styles'), { recursive: true });
    await writeFile(path.join(brand, 'output-styles', 'bad.md'), '---\nname: "unterminated\n---\nx');
    const warnings: string[] = [];
    const styles = await loadOutputStyles({ paths: { userHomeDir: dir, brandHomeDir: brand, workDir: dir }, onWarning: (m) => warnings.push(m) });
    expect(styles.find((s) => s.name === 'good')).toBeDefined();
    expect(warnings.some((w) => w.includes('bad.md'))).toBe(true);
  });
});
