
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import { isAbsoluteLocalPath, pathRelativeTo } from '@moonshot-ai/app-core/lib';
import { argFilePath, parseArgRecord } from './tool-calls/toolArgs';

export interface FilePathResolution {
  path: string;
  assumed: boolean;
}

function turnToolArgs(turn: ChatTurn): string[] {
  const args: string[] = [];
  for (const block of turn.blocks ?? []) {
    if (block.kind === 'tool' && block.tool.status !== 'error') args.push(block.tool.arg);
  }
  for (const tool of turn.tools ?? []) {
    if (tool.status !== 'error') args.push(tool.arg);
  }
  return args;
}

function normalizeLinkRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function trimBaseDir(cwd: string): string {
  return cwd.length > 1 ? cwd.replace(/[\\/]+$/, '') : cwd;
}

function joinBaseDir(base: string, rel: string): string {
  return `${base}${/[/\\]$/.test(base) ? '' : '/'}${rel}`;
}

function normalizeCandidateRel(path: string): string | null {
  const rel = normalizeLinkRelativePath(path);
  return rel.length === 0 || rel.split('/').includes('..') ? null : rel;
}

export function createCwdAssumedResolver(cwd: string): (path: string) => FilePathResolution | null {
  const base = trimBaseDir(cwd);
  if (base.length === 0) return () => null;
  return (path) => {
    const rel = normalizeCandidateRel(path);
    return rel === null ? null : { path: joinBaseDir(base, rel), assumed: true };
  };
}

export function createChatFilePathResolver(
  turn: ChatTurn,
  cwd: string,
): (path: string) => FilePathResolution | null {
  const absolutePaths = new Set<string>();
  for (const arg of turnToolArgs(turn)) {
    const path = argFilePath(parseArgRecord(arg));
    if (path !== undefined && isAbsoluteLocalPath(path)) absolutePaths.add(path);
  }
  const candidates = [...absolutePaths].map((original) => {
    const norm = original.replace(/\\/g, '/');
    return { original, norm, normLower: norm.toLowerCase() };
  });
  const base = trimBaseDir(cwd);
  const allowCaseFold = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\');
  const variantKey = (candidate: { norm: string; normLower: string }): string =>
    allowCaseFold ? candidate.normLower : candidate.norm;
  const toWorkspaceRelative = (absPath: string): string | null => {
    if (cwd.length === 0) return null;
    const rel = pathRelativeTo(absPath, cwd);
    return rel === null || rel.split('/').includes('..') ? null : rel;
  };
  const uniqueHit = (absPath: string): FilePathResolution => ({ path: toWorkspaceRelative(absPath) ?? absPath, assumed: false });
  return (path) => {
    const rel = normalizeCandidateRel(path);
    if (rel === null) return null;
    const relLower = allowCaseFold ? rel.toLowerCase() : '';
    const exactByNorm = new Map<string, string>();
    const foldedByNorm = new Map<string, string>();
    for (const candidate of candidates) {
      if (candidate.norm === rel || candidate.norm.endsWith(`/${rel}`)) {
        const key = variantKey(candidate);
        if (!exactByNorm.has(key)) exactByNorm.set(key, candidate.original);
      } else if (allowCaseFold && (candidate.normLower === relLower || candidate.normLower.endsWith(`/${relLower}`))) {
        if (!foldedByNorm.has(candidate.normLower)) foldedByNorm.set(candidate.normLower, candidate.original);
      }
    }
    if (exactByNorm.size === 1) return uniqueHit(exactByNorm.values().next().value!);
    if (exactByNorm.size === 0 && foldedByNorm.size === 1) return uniqueHit(foldedByNorm.values().next().value!);
    if (base.length === 0) return null;
    return { path: joinBaseDir(base, rel), assumed: true };
  };
}
