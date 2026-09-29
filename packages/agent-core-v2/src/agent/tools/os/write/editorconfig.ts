import picomatch from 'picomatch';
import { basename, dirname, join, normalize, relative } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ByteOrderMark } from '#/_base/text/encoding';

export type NewFileLineBreak = '\r\n' | '\n' | '\r';

export interface NewFileEditorStyle {
  readonly eol: NewFileLineBreak | undefined;
  readonly bom: ByteOrderMark | false | undefined;
}

interface EditorConfigSection {
  readonly pattern: string;
  readonly props: Record<string, string>;
}

interface EditorConfigFile {
  readonly root: boolean;
  readonly sections: readonly EditorConfigSection[];
}

const EMPTY_STYLE: NewFileEditorStyle = { eol: undefined, bom: undefined };

const SUPPORTED_VALUES: Record<string, readonly string[]> = {
  end_of_line: ['lf', 'crlf', 'cr', 'unset'],
  charset: ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'unset'],
};

export function parseEditorConfig(text: string): EditorConfigFile {
  const sections: EditorConfigSection[] = [];
  let current: EditorConfigSection | undefined;
  let root = false;
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']') && line.length > 2) {
      current = { pattern: line.slice(1, -1).trim(), props: {} };
      sections.push(current);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().toLowerCase();
    if (key === '') continue;
    if (current === undefined) {
      if (key === 'root' && value === 'true') root = true;
      continue;
    }
    current.props[key] = value;
  }
  return { root, sections };
}

function sectionMatches(pattern: string, relPath: string): boolean {
  if (pattern.startsWith('/')) {
    return picomatch.isMatch(relPath, pattern.slice(1), { dot: true });
  }
  const subject = pattern.includes('/') ? relPath : basename(relPath);
  return picomatch.isMatch(subject, pattern, { dot: true });
}

function fileLevelProps(file: EditorConfigFile, relPath: string): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const section of file.sections) {
    if (!sectionMatches(section.pattern, relPath)) continue;
    for (const [key, value] of Object.entries(section.props)) {
      const supported = SUPPORTED_VALUES[key];
      if (supported !== undefined && !supported.includes(value)) continue;
      picked[key] = value;
    }
  }
  return picked;
}

async function tryReadConfigText(fs: IHostFileSystem, path: string): Promise<string | undefined> {
  try {
    return await fs.readText(path);
  } catch {
    return undefined;
  }
}

export async function resolveNewFileEditorStyle(
  fs: IHostFileSystem,
  targetPath: string,
  stopDir: string,
): Promise<NewFileEditorStyle> {
  const stop = normalize(stopDir);
  let eol: NewFileLineBreak | undefined;
  let bom: ByteOrderMark | false | undefined;
  let eolDecided = false;
  let bomDecided = false;
  let dir = dirname(targetPath);
  for (;;) {
    const text = await tryReadConfigText(fs, join(dir, '.editorconfig'));
    if (text !== undefined) {
      const config = parseEditorConfig(text);
      const props = fileLevelProps(config, relative(dir, targetPath));
      if (!eolDecided && props['end_of_line'] !== undefined) {
        const value = props['end_of_line'];
        if (value === 'lf') eol = '\n';
        else if (value === 'crlf') eol = '\r\n';
        else if (value === 'cr') eol = '\r';
        eolDecided = value === 'lf' || value === 'crlf' || value === 'cr' || value === 'unset';
      }
      if (!bomDecided && props['charset'] !== undefined) {
        const value = props['charset'];
        if (value === 'utf-8-bom') bom = 'utf-8';
        else if (value === 'utf-8') bom = false;
        else if (value === 'utf-16le') bom = 'utf-16le';
        else if (value === 'utf-16be') bom = 'utf-16be';
        bomDecided =
          value === 'utf-8-bom' ||
          value === 'utf-8' ||
          value === 'utf-16le' ||
          value === 'utf-16be' ||
          value === 'unset';
      }
      if (config.root) break;
    }
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (eol === undefined && bom === undefined) return EMPTY_STYLE;
  return { eol, bom };
}
