export interface GitignoreMatcher {
  ignores(path: string): boolean;
}

interface GitignorePattern {
  readonly negate: boolean;
  readonly dirOnly: boolean;
  readonly regex: RegExp;
}

export function createGitignore(contents: string): GitignoreMatcher {
  const patterns: GitignorePattern[] = [];
  for (const line of ['.git/', ...contents.split(/\r?\n/)]) {
    const pattern = parseGitignoreLine(line);
    if (pattern !== undefined) patterns.push(pattern);
  }
  return {
    ignores: (path) => {
      let ignored = false;
      for (const pattern of patterns) {
        if (matchesGitignorePattern(pattern, path)) ignored = !pattern.negate;
      }
      return ignored;
    },
  };
}

function parseGitignoreLine(rawLine: string): GitignorePattern | undefined {
  let line = rawLine.trimEnd();
  if (line === '' || line.startsWith('#')) return undefined;
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  }
  if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line === '') return undefined;
  let anchored = false;
  if (line.startsWith('/')) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes('/')) {
    anchored = true;
  }
  if (line === '') return undefined;
  const body = gitignoreBodyToRegExpSource(line);
  return {
    negate,
    dirOnly,
    regex: new RegExp(anchored ? `^${body}$` : `(^|/)${body}$`),
  };
}

function gitignoreBodyToRegExpSource(pattern: string): string {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close > i + 1) {
        const body = pattern.slice(i + 1, close);
        re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        i = close + 1;
      } else {
        re += '\\[';
        i++;
      }
    } else if (/[.+^${}()|\\]/.test(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return re;
}

function matchesGitignorePattern(pattern: GitignorePattern, path: string): boolean {
  const dirForm = path.endsWith('/');
  const target = dirForm ? path.slice(0, -1) : path;
  let current = target;
  let first = true;
  while (true) {
    if (pattern.regex.test(current)) {
      if (!pattern.dirOnly) return true;
      if (!first) return true;
      return dirForm;
    }
    const slash = current.lastIndexOf('/');
    if (slash < 0) return false;
    current = current.slice(0, slash);
    first = false;
  }
}
