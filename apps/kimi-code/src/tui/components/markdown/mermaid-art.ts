import { diagramKind, render, type DiagramKind, type MermaidArt, type Role } from 'lovely-mermaid';

import { currentTheme } from '#/tui/theme';

export type MermaidDrawResult =
  | { status: 'ok'; art: MermaidArt | null }
  | { status: 'error' };

export function drawMermaid(source: string): MermaidDrawResult {
  try {
    return { status: 'ok', art: render(source) };
  } catch {
    return { status: 'error' };
  }
}

export const COULD_NOT_DRAW_MESSAGE = 'could not draw this mermaid diagram';

export function undrawnDiagramReason(source: string): string {
  if (safeDiagramKind(source) !== null) return COULD_NOT_DRAW_MESSAGE;
  const identifier = firstDiagramIdentifier(source);
  return identifier === undefined
    ? COULD_NOT_DRAW_MESSAGE
    : `${identifier} diagrams are not drawn in the terminal`;
}

function safeDiagramKind(source: string): DiagramKind | null {
  try {
    return diagramKind(source);
  } catch {
    return null;
  }
}

const DIAGRAM_IDENTIFIER = /[A-Za-z][A-Za-z0-9_-]*/;

function firstDiagramIdentifier(source: string): string | undefined {
  const lines = source.split('\n');
  let index = 0;
  const skippable = (): boolean => {
    const line = lines[index]?.trim() ?? '';
    return line === '' || line.startsWith('%%');
  };
  while (index < lines.length && skippable()) index++;
  if (lines[index]?.trim() === '---') {
    index++;
    while (index < lines.length && lines[index]?.trim() !== '---') index++;
    index++;
  }
  while (index < lines.length && skippable()) index++;
  return DIAGRAM_IDENTIFIER.exec(lines[index] ?? '')?.[0];
}

export function colorMermaidArt(art: MermaidArt): string[] {
  return art.styled.map((spans) => {
    const end = spans.findLastIndex((span) => span.role !== 'none') + 1;
    return spans
      .slice(0, end)
      .map((span) => colorMermaidSpan(span.text, span.role))
      .join('');
  });
}

function colorMermaidSpan(text: string, role: Role): string {
  switch (role) {
    case 'border':
      return currentTheme.fg('border', text);
    case 'text':
      return currentTheme.fg('text', text);
    case 'edge':
      return currentTheme.fg('accent', text);
    case 'edgeLabel':
      return currentTheme.fg('textMuted', text);
    case 'title':
      return currentTheme.boldFg('accent', text);
    case 'none':
      return text;
  }
}
