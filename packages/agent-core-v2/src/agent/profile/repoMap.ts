import { basename, dirname, isAbsolute, join, normalize } from 'pathe';
import { parse as parseToml } from 'smol-toml';

import { hasGitWorkTreeMarker } from '#/app/git/workTree';
import type { HostDirEntry, HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { ProfileContextDeps } from './context';

export const REPO_MAP_MAX_LINES = 10;

export interface BuildRepoMapOptions {
  readonly budgetMs?: number;
}

const AGENTS_MD_NAMES = ['AGENTS.md', 'agents.md'] as const;
const REPO_MAP_MAX_SUMMARY_CHARS = 120;
const MAX_SCAN_DEPTH = 3;
const MAX_VISITED_DIRS = 128;
const MAX_ENTRIES_PER_DIR = 256;
const SCAN_BUDGET_MS = 500;
const METADATA_INLINE_MAX_BYTES = 16 * 1024;
const METADATA_HEAD_BYTES = 8 * 1024;
const METADATA_FALLBACK_MAX_BYTES = 256 * 1024;

const SKIPPED_CONTAINER_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '__pycache__',
  'bower_components',
  'Pods',
  'coverage',
  'proc',
  'sys',
  'dev',
]);

const HOME_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'Library',
  'Pictures',
  'Music',
  'Movies',
  'Public',
  'Trash',
  'Downloads',
]);

const README_CANDIDATES = [
  'README.md',
  'readme.md',
  'Readme.md',
  'README.zh-CN.md',
  'README',
] as const;

const PLACEHOLDER_DESCRIPTIONS: ReadonlySet<string> = new Set([
  'todo',
  'tbd',
  'add your description here',
  'description',
]);

const GENERIC_DOC_TITLES: ReadonlySet<string> = new Set([
  'readme',
  'readme.md',
  'agents',
  'agents.md',
  'claude',
  'claude.md',
  'agent guide',
  'repository-level agent guide',
  'project agent guide',
]);

const OVERVIEW_HEADING_RE =
  /^(?:project\s+overview|repository\s+overview|overview|about|summary|introduction|仓库定位.*|项目定位.*|项目概览.*|项目简介.*|仓库简介.*|简介)$/i;

const PURE_REPLY_LANGUAGE_DIRECTIVE_RE =
  /^(?:(?:always\s+)?reply in (?:the same language(?:\s+as\s+the\s+user)?|english|chinese)[^A-Za-z0-9]*|(?:请用|一律用)?中文回复(?:用户)?[。！!.\s]*)$/i;

class RepoMapDeadlineError extends Error {
  constructor() {
    super('Repository map scan budget exceeded');
  }
}

interface DiscoveredRepoDir {
  readonly relPath: string;
  readonly dirPath: string;
  readonly entries?: readonly HostDirEntry[];
}

interface ScanQueueItem {
  readonly relPath: string;
  readonly dirPath: string;
  readonly realPath: string;
}

export async function buildRepoMap(
  deps: ProfileContextDeps,
  workDir: string,
  options?: BuildRepoMapOptions,
): Promise<string> {
  const rootDir = normalize(workDir);
  if (rootDir.length === 0 || dirname(rootDir) === rootDir) return '';

  const budgetMs = options?.budgetMs ?? SCAN_BUDGET_MS;
  if (budgetMs <= 0) return '';
  const now = Date.now();
  const totalDeadline = now + budgetMs;
  const discoveryDeadline = now + Math.max(1, Math.floor(budgetMs * 0.75));
  const discoveryDeps: ProfileContextDeps = {
    fs: createDeadlineFs(deps.fs, discoveryDeadline),
    homeDir: deps.homeDir,
  };

  const discovered = await discoverSubRepos(discoveryDeps, rootDir, discoveryDeadline);
  if (discovered.length === 0) return '';

  const formatDeps: ProfileContextDeps = {
    fs: createDeadlineFs(deps.fs, totalDeadline),
    homeDir: deps.homeDir,
  };
  const sorted = discovered.toSorted((a, b) => a.relPath.localeCompare(b.relPath));
  const visible =
    sorted.length <= REPO_MAP_MAX_LINES ? sorted : sorted.slice(0, REPO_MAP_MAX_LINES - 1);
  const lines = await Promise.all(
    visible.map((repo) => formatRepoLine(formatDeps, repo, totalDeadline)),
  );
  const remaining = sorted.length - visible.length;
  if (remaining > 0) {
    lines.push(`- ... and ${String(remaining)} more sub-repositories`);
  }
  return lines.join('\n');
}

async function discoverSubRepos(
  deps: ProfileContextDeps,
  rootDir: string,
  deadline: number,
): Promise<DiscoveredRepoDir[]> {
  const foundByRelPath = new Map<string, DiscoveredRepoDir>();
  const rootReal = (await tryRealpath(deps.fs, rootDir)) ?? rootDir;
  const seenRealDirs = new Set<string>([rootDir, rootReal]);
  const isHomeRoot = rootDir === normalize(deps.homeDir);

  let visitedDirs = 0;
  let hasRootGitmodules = false;
  let currentLevel: ScanQueueItem[] = [{ relPath: '', dirPath: rootDir, realPath: rootReal }];

  for (let depth = 0; depth < MAX_SCAN_DEPTH && currentLevel.length > 0; depth += 1) {
    const skipHomeProtected = depth === 0 && isHomeRoot;
    const nextLevel: ScanQueueItem[] = [];
    for (const node of currentLevel) {
      if (visitedDirs >= MAX_VISITED_DIRS || Date.now() >= deadline) {
        currentLevel = [];
        break;
      }
      visitedDirs += 1;
      const entries = await safeReaddir(deps.fs, node.dirPath);
      if (entries === undefined) continue;

      if (node.relPath === '') {
        hasRootGitmodules = entries.some(
          (entry) =>
            entry.name === '.gitmodules' && (!entry.isDirectory || entry.isSymbolicLink === true),
        );
      } else {
        const dotGit = entries.find((entry) => entry.name === '.git');
        if (dotGit !== undefined && (await hasGitWorkTreeMarker(deps.fs, node.dirPath, dotGit))) {
          foundByRelPath.set(node.relPath, {
            relPath: node.relPath,
            dirPath: node.dirPath,
            entries,
          });
          continue;
        }
      }

      const candidates = selectTraversableEntries(entries, skipHomeProtected);

      for (const entry of candidates) {
        if (Date.now() >= deadline) break;
        const childDirPath = join(node.dirPath, entry.name);
        const childRelPath = node.relPath === '' ? entry.name : `${node.relPath}/${entry.name}`;
        let childRealPath = join(node.realPath, entry.name);
        if (entry.isSymbolicLink === true) {
          const stat = await safeStat(deps.fs, childDirPath);
          if (stat?.isDirectory !== true) continue;
          const resolved = await tryRealpath(deps.fs, childDirPath);
          if (resolved !== undefined) {
            if (seenRealDirs.has(resolved) || isSameOrAncestorPath(resolved, node.realPath)) {
              continue;
            }
            childRealPath = resolved;
          }
        } else if (seenRealDirs.has(childRealPath)) {
          continue;
        }
        seenRealDirs.add(childRealPath);
        nextLevel.push({ relPath: childRelPath, dirPath: childDirPath, realPath: childRealPath });
      }
    }
    currentLevel = nextLevel;
  }

  for (const leaf of currentLevel) {
    if (visitedDirs >= MAX_VISITED_DIRS || Date.now() >= deadline) break;
    if (foundByRelPath.has(leaf.relPath)) continue;
    visitedDirs += 1;
    if (await hasGitWorkTreeMarker(deps.fs, leaf.dirPath)) {
      foundByRelPath.set(leaf.relPath, { relPath: leaf.relPath, dirPath: leaf.dirPath });
    }
  }

  if (hasRootGitmodules && Date.now() < deadline) {
    const gitmodulesText = await readSmallText(deps.fs, join(rootDir, '.gitmodules'), deadline);
    if (gitmodulesText !== undefined) {
      for (const relPath of parseGitmodulesPaths(gitmodulesText)) {
        if (visitedDirs >= MAX_VISITED_DIRS || Date.now() >= deadline) break;
        if (foundByRelPath.has(relPath)) continue;
        visitedDirs += 1;
        const dirPath = join(rootDir, relPath);
        if (await hasGitWorkTreeMarker(deps.fs, dirPath)) {
          foundByRelPath.set(relPath, { relPath, dirPath });
        }
      }
    }
  }

  return [...foundByRelPath.values()];
}

function selectTraversableEntries(
  entries: readonly HostDirEntry[],
  skipHomeProtected: boolean,
): HostDirEntry[] {
  return entries
    .filter((entry) => shouldTraverseEntry(entry, skipHomeProtected))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES_PER_DIR);
}

function shouldTraverseEntry(entry: HostDirEntry, skipHomeProtected: boolean): boolean {
  if (entry.name.startsWith('.')) return false;
  if (!entry.isDirectory && entry.isSymbolicLink !== true) return false;
  if (SKIPPED_CONTAINER_DIRS.has(entry.name)) return false;
  if (skipHomeProtected && HOME_SKIPPED_DIRS.has(entry.name)) return false;
  return true;
}

function isSameOrAncestorPath(candidateAncestor: string, target: string): boolean {
  const a = normalize(candidateAncestor);
  const b = normalize(target);
  if (a === b) return true;
  const prefix = a.endsWith('/') ? a : `${a}/`;
  return b.startsWith(prefix);
}

export function parseGitmodulesPaths(content: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let inSubmodule = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch !== null) {
      inSubmodule = /^submodule(?:\s|$)/i.test(sectionMatch[1]!.trim());
      continue;
    }
    if (!inSubmodule) continue;
    const pathMatch = /^path\s*=\s*(.+)$/i.exec(trimmed);
    if (pathMatch === null) continue;
    const rawValue = parseIniValue(pathMatch[1]!);
    const rel = normalizeRelativeSubpath(rawValue);
    if (rel === undefined || seen.has(rel)) continue;
    seen.add(rel);
    result.push(rel);
  }

  return result;
}

function parseIniValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    const endQuote = trimmed.indexOf('"', 1);
    const body = endQuote >= 1 ? trimmed.slice(1, endQuote) : trimmed.slice(1);
    return body.replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return trimmed.replace(/\s+[#;].*$/, '').trim();
}

function normalizeRelativeSubpath(raw: string): string | undefined {
  const slashNormalized = raw.replaceAll('\\', '/').trim();
  if (slashNormalized.length === 0 || isAbsolute(slashNormalized)) return undefined;
  const rel = normalize(slashNormalized).replace(/^\.\//, '').replace(/\/+$/, '');
  if (rel.length === 0 || rel === '.' || rel === '..' || rel.startsWith('../')) return undefined;
  const segments = rel.split('/');
  if (segments.some((seg) => seg.length === 0 || seg === '.' || seg === '..' || seg === '.git')) {
    return undefined;
  }
  return rel;
}

async function formatRepoLine(
  deps: ProfileContextDeps,
  repo: DiscoveredRepoDir,
  deadline: number,
): Promise<string> {
  const safePath = sanitizePathDisplay(repo.relPath);
  if (Date.now() >= deadline) return `- ${safePath}`;

  const entries = repo.entries ?? (await safeReaddir(deps.fs, repo.dirPath)) ?? [];
  if (entries.length === 0 && Date.now() >= deadline) return `- ${safePath}`;

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const [agentsRelPaths, role] = await Promise.all([
    findSubrepoAgentsMdRelPaths(deps.fs, repo.dirPath, repo.relPath, byName, deadline),
    extractRepoRole(deps.fs, repo.dirPath, byName, deadline),
  ]);
  const suffix =
    agentsRelPaths.length > 0
      ? ` (${agentsRelPaths.map((p) => sanitizePathDisplay(p)).join(', ')})`
      : '';
  if (role !== undefined && role.length > 0) {
    return `- ${safePath} — ${quoteUntrustedSummary(role)}${suffix}`;
  }
  return `- ${safePath}${suffix}`;
}

function sanitizePathDisplay(path: string): string {
  return stripControlAndFenceBreakers(path).replaceAll('`', "'");
}

function quoteUntrustedSummary(summary: string): string {
  return JSON.stringify(stripControlAndFenceBreakers(summary));
}

function stripControlAndFenceBreakers(value: string): string {
  return value.replaceAll(/[\u0000-\u001F\u007F]+/g, ' ').replaceAll(/`{3,}/g, "'''").trim();
}

async function findSubrepoAgentsMdRelPaths(
  fs: IHostFileSystem,
  repoDir: string,
  repoRelPath: string,
  byName: ReadonlyMap<string, HostDirEntry>,
  deadline: number,
): Promise<string[]> {
  if (Date.now() >= deadline) return [];
  const found: string[] = [];
  const dotKimiEntry = byName.get('.kimi-code');
  if (
    dotKimiEntry !== undefined &&
    (dotKimiEntry.isDirectory || dotKimiEntry.isSymbolicLink === true)
  ) {
    const dotKimiAgents = await readSmallText(fs, join(repoDir, '.kimi-code', 'AGENTS.md'), deadline);
    if (dotKimiAgents !== undefined && dotKimiAgents.trim().length > 0) {
      found.push(`${repoRelPath}/.kimi-code/AGENTS.md`);
    }
  }
  for (const fileName of AGENTS_MD_NAMES) {
    if (Date.now() >= deadline) break;
    if (!hasFileCandidate(byName, fileName)) continue;
    const text = await readSmallText(fs, join(repoDir, fileName), deadline);
    if (text !== undefined && text.trim().length > 0) {
      found.push(`${repoRelPath}/${fileName}`);
      break;
    }
  }
  return found;
}

async function extractRepoRole(
  fs: IHostFileSystem,
  repoDir: string,
  byName: ReadonlyMap<string, HostDirEntry>,
  deadline: number,
): Promise<string | undefined> {
  if (Date.now() >= deadline) return undefined;
  const manifest = await readManifestInfo(fs, repoDir, byName, deadline);
  if (manifest.description !== undefined) return manifest.description;

  let readmeTitle: string | undefined;
  for (const candidate of README_CANDIDATES) {
    if (Date.now() >= deadline) return undefined;
    if (!hasFileCandidate(byName, candidate)) continue;
    const text = await readSmallText(fs, join(repoDir, candidate), deadline);
    if (text === undefined) continue;
    const lead = extractMarkdownLead(text, false);
    if (lead.prose !== undefined) return lead.prose;
    if (readmeTitle === undefined && lead.title !== undefined) readmeTitle = lead.title;
  }

  const agentsLead = await readAgentsMdLead(fs, repoDir, byName, deadline);
  if (agentsLead !== undefined) return agentsLead;

  const folderName = basename(repoDir);
  if (readmeTitle !== undefined && !isRedundantTitle(readmeTitle, folderName)) {
    return formatSummary(readmeTitle);
  }
  const moduleName = manifest.name ?? (await readGoModuleName(fs, repoDir, byName, deadline));
  if (moduleName !== undefined && !isRedundantTitle(moduleName, folderName)) {
    return formatSummary(moduleName);
  }
  return undefined;
}

async function readManifestInfo(
  fs: IHostFileSystem,
  repoDir: string,
  byName: ReadonlyMap<string, HostDirEntry>,
  deadline: number,
): Promise<{ description?: string; name?: string }> {
  let fallbackName: string | undefined;

  if (Date.now() < deadline && hasFileCandidate(byName, 'package.json')) {
    const raw = await readSmallText(fs, join(repoDir, 'package.json'), deadline);
    if (raw !== undefined) {
      const parsed = tryParseJsonRecord(raw);
      const description = cleanManifestDescription(parsed?.['description']);
      if (description !== undefined) return { description };
      fallbackName ??= nonEmptyString(parsed?.['name']);
    }
  }

  if (Date.now() < deadline && hasFileCandidate(byName, 'pyproject.toml')) {
    const raw = await readSmallText(fs, join(repoDir, 'pyproject.toml'), deadline);
    if (raw !== undefined) {
      const parsed = tryParseTomlRecord(raw);
      const project = asRecord(parsed?.['project']);
      const poetry = asRecord(asRecord(parsed?.['tool'])?.['poetry']);
      const description =
        cleanManifestDescription(project?.['description']) ??
        cleanManifestDescription(poetry?.['description']);
      if (description !== undefined) return { description };
      fallbackName ??= nonEmptyString(project?.['name']) ?? nonEmptyString(poetry?.['name']);
    }
  }

  if (Date.now() < deadline && hasFileCandidate(byName, 'Cargo.toml')) {
    const raw = await readSmallText(fs, join(repoDir, 'Cargo.toml'), deadline);
    if (raw !== undefined) {
      const parsed = tryParseTomlRecord(raw);
      const pkg = asRecord(parsed?.['package']);
      const wsPkg = asRecord(asRecord(parsed?.['workspace'])?.['package']);
      const description =
        cleanManifestDescription(pkg?.['description']) ??
        cleanManifestDescription(wsPkg?.['description']);
      if (description !== undefined) return { description };
      fallbackName ??= nonEmptyString(pkg?.['name']);
    }
  }

  return { name: fallbackName };
}

async function readGoModuleName(
  fs: IHostFileSystem,
  repoDir: string,
  byName: ReadonlyMap<string, HostDirEntry>,
  deadline: number,
): Promise<string | undefined> {
  if (Date.now() >= deadline || !hasFileCandidate(byName, 'go.mod')) return undefined;
  const raw = await readSmallText(fs, join(repoDir, 'go.mod'), deadline);
  if (raw === undefined) return undefined;
  for (const line of raw.split(/\r?\n/)) {
    const match = /^module\s+(\S+)/.exec(line.trim());
    if (match !== null) return match[1]!.replaceAll(/^"|"$/g, '');
  }
  return undefined;
}

async function readAgentsMdLead(
  fs: IHostFileSystem,
  repoDir: string,
  byName: ReadonlyMap<string, HostDirEntry>,
  deadline: number,
): Promise<string | undefined> {
  for (const fileName of AGENTS_MD_NAMES) {
    if (Date.now() >= deadline) return undefined;
    if (!hasFileCandidate(byName, fileName)) continue;
    const raw = await readSmallText(fs, join(repoDir, fileName), deadline);
    if (raw === undefined) continue;
    const lead = extractMarkdownLead(raw, true);
    if (lead.prose !== undefined) return lead.prose;
  }
  const dotKimiEntry = byName.get('.kimi-code');
  if (
    Date.now() < deadline &&
    dotKimiEntry !== undefined &&
    (dotKimiEntry.isDirectory || dotKimiEntry.isSymbolicLink === true)
  ) {
    const raw = await readSmallText(fs, join(repoDir, '.kimi-code', 'AGENTS.md'), deadline);
    if (raw !== undefined) {
      const lead = extractMarkdownLead(raw, true);
      if (lead.prose !== undefined) return lead.prose;
    }
  }
  return undefined;
}

function extractMarkdownLead(
  rawContent: string,
  preferOverviewSection: boolean,
): { prose?: string; title?: string } {
  const withoutFrontmatter = rawContent
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/g, '');

  const lines = withoutFrontmatter.split(/\r?\n/);
  let inFence = false;
  let title: string | undefined;
  let firstGeneralProse: string | undefined;
  let inOverviewSection = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || trimmed.length === 0) continue;

    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (headingMatch !== null) {
      const level = headingMatch[1]!.length;
      const headingText = cleanMarkdownInline(headingMatch[2]!);
      if (
        level === 1 &&
        title === undefined &&
        headingText.length > 0 &&
        !GENERIC_DOC_TITLES.has(headingText.toLowerCase())
      ) {
        title = headingText;
      }
      if (preferOverviewSection) {
        inOverviewSection = OVERVIEW_HEADING_RE.test(headingText);
      }
      continue;
    }

    const candidate = cleanProseCandidateLine(trimmed);
    if (candidate === undefined) continue;
    if (preferOverviewSection && PURE_REPLY_LANGUAGE_DIRECTIVE_RE.test(candidate)) continue;

    if (preferOverviewSection && inOverviewSection) {
      const formatted = formatSummary(candidate);
      if (formatted !== undefined) return { prose: formatted, title };
    }
    if (firstGeneralProse === undefined) {
      firstGeneralProse = formatSummary(candidate);
      if (!preferOverviewSection && firstGeneralProse !== undefined) {
        return { prose: firstGeneralProse, title };
      }
    }
  }

  return { prose: firstGeneralProse, title };
}

function cleanProseCandidateLine(trimmed: string): string | undefined {
  if (/^(?:[-*_]\s*){3,}$/.test(trimmed) || /^=+$/.test(trimmed)) return undefined;
  if (trimmed.startsWith('|') || trimmed.startsWith('![') || trimmed.startsWith('[![')) {
    return undefined;
  }
  if (/^>\s*\[!/.test(trimmed)) return undefined;

  const unquoted = trimmed.replace(/^>\s*/, '').replace(/^[-*+]\s+/, '');
  const withoutMediaAndHtml = unquoted
    .replaceAll(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replaceAll(/<[^>]+>/g, ' ')
    .trim();
  if (withoutMediaAndHtml.length === 0) return undefined;

  if (isPureLinkNavigationBar(withoutMediaAndHtml)) return undefined;

  const cleaned = cleanMarkdownInline(withoutMediaAndHtml);
  return cleaned.length > 0 ? cleaned : undefined;
}

function isPureLinkNavigationBar(line: string): boolean {
  const links = line.match(/\[[^\]]+\]\([^)]+\)/g);
  if (links === null || links.length === 0) return false;
  const remainder = line.replaceAll(/\[[^\]]+\]\([^)]+\)/g, '').trim();
  if (remainder.length === 0) return links.length >= 2;
  return /^[\s·•|/\\,\-–—[\]()]+$/.test(remainder);
}

function cleanMarkdownInline(text: string): string {
  return text
    .replaceAll(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replaceAll(/__([^_]+)__/g, '$1')
    .replaceAll(/`([^`]*)`/g, '$1')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function cleanManifestDescription(value: unknown): string | undefined {
  const raw = nonEmptyString(value);
  if (raw === undefined) return undefined;
  const normalized = raw.replaceAll(/\s+/g, ' ').trim();
  if (PLACEHOLDER_DESCRIPTIONS.has(normalized.toLowerCase())) return undefined;
  return formatSummary(normalized);
}

function formatSummary(raw: string): string | undefined {
  const collapsed = raw.replaceAll(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  const sentence = takeFirstSentence(collapsed);
  const chars = Array.from(sentence);
  if (chars.length <= REPO_MAP_MAX_SUMMARY_CHARS) return sentence;

  const prefix = chars.slice(0, REPO_MAP_MAX_SUMMARY_CHARS).join('');
  for (const sep of [' — ', ' -- ', '；', '; ']) {
    const idx = prefix.indexOf(sep);
    if (idx >= 20) {
      return prefix.slice(0, idx).trim();
    }
  }

  const lastSpace = prefix.lastIndexOf(' ');
  const clipped =
    lastSpace >= Math.floor(REPO_MAP_MAX_SUMMARY_CHARS * 0.6)
      ? prefix.slice(0, lastSpace)
      : prefix;
  return `${clipped.replace(/[,:;，、：\s]+$/, '')}…`;
}

function takeFirstSentence(text: string): string {
  const cjkEnd = /[。！？]/.exec(text);
  const latinEnd = /(?<!\b(?:e\.g|i\.e|vs|etc))\.\s+(?=[A-Z0-9`"'([])/i.exec(text);
  let cutIndex = text.length;
  if (cjkEnd !== null) cutIndex = Math.min(cutIndex, cjkEnd.index + 1);
  if (latinEnd !== null) cutIndex = Math.min(cutIndex, latinEnd.index + 1);
  return text.slice(0, cutIndex).trim();
}

function isRedundantTitle(candidate: string, folderName: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replaceAll(/[^a-z0-9\u4E00-\u9FFF]+/g, '');
  const a = norm(candidate);
  const b = norm(folderName);
  return a.length === 0 || a === b;
}

function hasFileCandidate(
  byName: ReadonlyMap<string, HostDirEntry>,
  name: string,
): boolean {
  const entry = byName.get(name);
  return entry !== undefined && (!entry.isDirectory || entry.isSymbolicLink === true);
}

async function readSmallText(
  fs: IHostFileSystem,
  path: string,
  deadline: number,
): Promise<string | undefined> {
  if (Date.now() >= deadline) return undefined;
  const stat = await safeStat(fs, path);
  if (stat === undefined || !stat.isFile || stat.size <= 0) return undefined;
  if (stat.size <= METADATA_INLINE_MAX_BYTES) {
    try {
      return await fs.readText(path, { errors: 'ignore' });
    } catch {
      return undefined;
    }
  }
  try {
    const head = await fs.readFileHead(path, METADATA_HEAD_BYTES);
    return Buffer.from(head.bytes).toString('utf8');
  } catch (error) {
    if (
      error instanceof RepoMapDeadlineError ||
      Date.now() >= deadline ||
      stat.size > METADATA_FALLBACK_MAX_BYTES
    ) {
      return undefined;
    }
    try {
      return (await fs.readText(path, { errors: 'ignore' })).slice(0, METADATA_HEAD_BYTES);
    } catch {
      return undefined;
    }
  }
}

async function safeReaddir(
  fs: IHostFileSystem,
  path: string,
): Promise<readonly HostDirEntry[] | undefined> {
  try {
    return await fs.readdir(path);
  } catch {
    return undefined;
  }
}

async function safeStat(fs: IHostFileSystem, path: string): Promise<HostFileStat | undefined> {
  try {
    return await fs.stat(path);
  } catch {
    return undefined;
  }
}

async function tryRealpath(fs: IHostFileSystem, path: string): Promise<string | undefined> {
  try {
    return normalize(await fs.realpath(path));
  } catch {
    return undefined;
  }
}

function createDeadlineFs(base: IHostFileSystem, deadline: number): IHostFileSystem {
  const call = <T>(fn: () => Promise<T>): Promise<T> => {
    if (Date.now() >= deadline) return Promise.reject(new RepoMapDeadlineError());
    try {
      return raceWithDeadline(fn(), deadline);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return Object.assign(Object.create(base) as IHostFileSystem, {
    readText: (path: string, options?: Parameters<IHostFileSystem['readText']>[1]) =>
      call(() => base.readText(path, options)),
    readFileHead: (path: string, maxBytes: number) =>
      call(() => base.readFileHead(path, maxBytes)),
    stat: (path: string) => call(() => base.stat(path)),
    lstat: (path: string) => call(() => base.lstat(path)),
    readdir: (path: string) => call(() => base.readdir(path)),
    realpath: (path: string) => call(() => base.realpath(path)),
  });
}

function raceWithDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    promise.then(
      () => undefined,
      () => undefined,
    );
    return Promise.reject(new RepoMapDeadlineError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new RepoMapDeadlineError());
    }, remainingMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function tryParseJsonRecord(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function tryParseTomlRecord(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(parseToml(raw));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
