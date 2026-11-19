import { isAbsoluteLocalPath } from '@moonshot-ai/app-core/lib';

export interface FilePathLink {
  path: string;
  line?: number;
}

export interface FilePathLinkMatch extends FilePathLink {
  start: number;
  end: number;
  text: string;
}

export interface FindFilePathLinksOptions {
  aliases?: ReadonlyMap<string, string>;
}

const COMMON_FILE_EXTENSIONS = [
  'cjs',
  'css',
  'csv',
  'gif',
  'htm',
  'html',
  'jpeg',
  'jpg',
  'js',
  'json',
  'jsx',
  'log',
  'md',
  'mjs',
  'pdf',
  'png',
  'scss',
  'svg',
  'ts',
  'tsx',
  'txt',
  'vue',
  'webp',
  'xml',
  'yaml',
  'yml',
];

const COMMON_FILENAMES = new Set([
  'AGENTS.md',
  'CHANGELOG.md',
  'Dockerfile',
  'LICENSE',
  'Makefile',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
]);

const EXT_PATTERN = [...COMMON_FILE_EXTENSIONS]
  .sort((a, b) => b.length - a.length)
  .join('|');
const COMMON_FILENAME_PATTERN = [...COMMON_FILENAMES]
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const PATH_SEGMENT = String.raw`[A-Za-z0-9_.@+()[\]-]+`;
const PATH_SEGMENT_WITH_SPACES = String.raw`[A-Za-z0-9_.@+()[\] -]*[A-Za-z0-9_.@+()[\]-]`;
const PATH_PROSE_CONNECTOR_RE = / +(?:and|or) +/gi;

function findPathConnector(rawPath: string): RegExpExecArray | null {
  for (const connector of rawPath.matchAll(PATH_PROSE_CONNECTOR_RE)) {
    const prefix = rawPath.slice(0, connector.index);
    const suffix = rawPath.slice(connector.index + connector[0].length);
    if (/^(?:~|\.{1,2}\/|\/)/.test(suffix)) return connector;
    if (!suffix.includes('/') && COMMON_FILENAMES.has(suffix)) return connector;
    if (/\.[A-Za-z0-9]+$/.test(prefix)) return connector;
  }
  return null;
}

const SPACED_PATH_SCAN_LIMIT = 4096;
const PATH_RE = new RegExp(
  [
    String.raw`(?:^|[\s([{"'` + '`' + String.raw`])`,
    String.raw`(`,
    String.raw`(?=(?:~/?|\.{1,2}/|/|${PATH_SEGMENT}/))`,
    String.raw`(?=.{0,${SPACED_PATH_SCAN_LIMIT - 1}}(?:\.(?:${EXT_PATTERN})|${COMMON_FILENAME_PATTERN})(?:#L?\d+|:\d+)?(?:$|[\s)"'\]}>.,;!?，。；！？）]))`,
    String.raw`(?:(?:~/?|\.{1,2}/|/)(?:${PATH_SEGMENT_WITH_SPACES}/)+|${PATH_SEGMENT}/(?:${PATH_SEGMENT_WITH_SPACES}/)*)(?:${PATH_SEGMENT_WITH_SPACES}\.(?:${EXT_PATTERN})|${COMMON_FILENAME_PATTERN})`,
    String.raw`|`,
    String.raw`(?:~|\.{1,2}|/)?(?:${PATH_SEGMENT}/)+${PATH_SEGMENT}(?:\.(?:${EXT_PATTERN}))?`,
    String.raw`|`,
    String.raw`${PATH_SEGMENT}\.(?:${EXT_PATTERN})`,
    String.raw`)`,
    String.raw`(?!\.[A-Za-z0-9])`,
    String.raw`(?:#L?(\d+)|:(\d+))?`,
    String.raw`(?=$|[\s)"'\]}>.,;!?，。；！？）])`,
  ].join(''),
  'iy',
);

const TRAILING_PUNCTUATION_RE = /[),.;!?，。；！？）]+$/;

export interface FilePathResolution {
  path: string;
  assumed: boolean;
}

export function isRelativeLinkCandidate(path: string): boolean {
  if (path.startsWith('~')) return false;
  if (isAbsoluteLocalPath(path)) return false;
  return !path.replace(/\\/g, '/').split('/').includes('..');
}

function hasCommonFileExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return COMMON_FILE_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

export function collectFilePathAliases(text: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const attrPathRe = new RegExp(
    String.raw`\b(?:path|src)=["'](\/[^"']+\.(?:${EXT_PATTERN}))["']`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = attrPathRe.exec(text)) !== null) {
    const absolutePath = match[1];
    if (!absolutePath) continue;
    const basename = absolutePath.split('/').pop();
    if (basename) aliases.set(basename, absolutePath);
  }
  return aliases;
}

export function parseFilePathLinkCandidate(
  text: string,
  options: FindFilePathLinksOptions = {},
): FilePathLink | null {
  const trimmed = text.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;

  const match = trimmed.match(/^(.*?)(?:#L?(\d+)|:(\d+))?$/i);
  if (!match) return null;
  let path = (match[1] ?? '').replace(TRAILING_PUNCTUATION_RE, '');
  if (!path) return null;

  const basename = path.split('/').pop() ?? path;
  const hasSeparator = path.includes('/');
  const hasKnownName = COMMON_FILENAMES.has(basename);
  const hasKnownExtension = hasCommonFileExtension(basename);
  if (hasSeparator && !hasKnownName && !hasKnownExtension) return null;
  if (!hasSeparator && !hasKnownName) {
    const alias = options.aliases?.get(basename);
    if (!alias) return null;
    path = alias;
  }

  const lineRaw = match[2] ?? match[3];
  const line = lineRaw ? Number(lineRaw) : undefined;
  return {
    path,
    line: line !== undefined && Number.isFinite(line) && line > 0 ? line : undefined,
  };
}

export function findFilePathLinks(
  text: string,
  options: FindFilePathLinksOptions = {},
): FilePathLinkMatch[] {
  const out: FilePathLinkMatch[] = [];
  let scannedUntil = 0;
  for (const candidate of text.matchAll(/~?\/?[A-Za-z0-9_.@+()[\]-]+(?:\/[A-Za-z0-9_.@+()[\]-]+)*/g)) {
    const candidateStart = Math.max(candidate.index, scannedUntil);
    if (candidateStart >= candidate.index + candidate[0].length) continue;
    if (candidateStart === 0 || /[\s([{"'`]/.test(text[candidateStart - 1]!)) {
      PATH_RE.lastIndex = Math.max(0, candidateStart - 1);
    } else {
      const boundary = candidate[0].slice(candidateStart - candidate.index).search(/[([]/);
      if (boundary === -1) continue;
      PATH_RE.lastIndex = candidateStart + boundary;
    }
    const match = PATH_RE.exec(text);
    if (match === null) continue;
    scannedUntil = PATH_RE.lastIndex;
    const full = match[0] ?? '';
    const rawPath = match[1] ?? '';
    const prefixLength = full.indexOf(rawPath);
    if (prefixLength < 0) continue;

    const connector = findPathConnector(rawPath);
    const candidatePath = connector ? rawPath.slice(0, connector.index) : rawPath;
    if (connector) scannedUntil = match.index + prefixLength + connector.index;
    const lineSuffix = connector ? undefined : match[2] ?? match[3];
    let linkText = candidatePath + (lineSuffix ? full.slice(prefixLength + rawPath.length) : '');
    const stripped = linkText.replace(TRAILING_PUNCTUATION_RE, '');
    linkText = stripped;

    const parsed = parseFilePathLinkCandidate(linkText, options);
    if (!parsed) continue;

    const start = match.index + prefixLength;
    const end = start + linkText.length;
    out.push({
      ...parsed,
      start,
      end,
      text: linkText,
    });

  }
  return out;
}
