// apps/kimi-web/src/lib/mermaidDirectives.test.ts
import { describe, expect, it } from 'vitest';
import { injectMermaidHtmlLabelsOff } from './mermaidDirectives';

const DIRECTIVE = '%%{init: {"htmlLabels": false}}%%';

/** Extract the content of every ```mermaid fence from the injected text. */
function mermaidBodies(text: string): string[] {
  const bodies: string[] = [];
  const re = /(?:^|\n) {0,3}(?:`{3,}|~{3,})mermaid[ \t]*\r?\n([\s\S]*?)(?:\r?\n)? {0,3}(?:`{3,}|~{3,})(?=\r?\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) bodies.push(m[1] ?? '');
  return bodies;
}

describe('injectMermaidHtmlLabelsOff', () => {
  it('injects comment + directive right after the fence opening line', () => {
    const out = injectMermaidHtmlLabelsOff('```mermaid\nflowchart TD\n  A-->B\n```\n');
    expect(out).toBe(
      '```mermaid\n' +
        '%% kimi-web: htmlLabels=off (workaround for markstream flattening foreignObject soft-wraps)\n' +
        `${DIRECTIVE}\n` +
        'flowchart TD\n  A-->B\n```\n',
    );
  });

  it('leaves non-mermaid fences (js / diff / no language) untouched', () => {
    const text = '```js\nconst a = 1;\n```\n\n```diff\n- a\n+ b\n```\n\n```\nplain\n```\n';
    expect(injectMermaidHtmlLabelsOff(text)).toBe(text);
  });

  it('returns text without mermaid fences byte-for-byte unchanged', () => {
    const text = 'some prose\n\n- a list\n\n> a quote about mermaid diagrams\n';
    expect(injectMermaidHtmlLabelsOff(text)).toBe(text);
  });

  it('injects into every mermaid fence when there are several', () => {
    const out = injectMermaidHtmlLabelsOff(
      '```mermaid\nflowchart TD\n  A-->B\n```\nmiddle\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n',
    );
    expect(out.match(new RegExp(DIRECTIVE.replaceAll(/[{}[\]]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('supports ~~~ fences', () => {
    const out = injectMermaidHtmlLabelsOff('~~~mermaid\nflowchart TD\n  A-->B\n~~~\n');
    expect(out).toContain(`~~~mermaid\n%% kimi-web`);
    expect(out).toContain(DIRECTIVE);
  });

  it('supports fences indented by up to 3 spaces, keeping the indent', () => {
    const out = injectMermaidHtmlLabelsOff('  ```mermaid\n  flowchart TD\n    A-->B\n  ```\n');
    expect(out).toContain(`  \`\`\`mermaid\n  %% kimi-web`);
    expect(out).toContain(`  ${DIRECTIVE}\n`);
  });

  it('supports CRLF line endings and keeps them', () => {
    const out = injectMermaidHtmlLabelsOff('```mermaid\r\nflowchart TD\r\n  A-->B\r\n```\r\n');
    expect(out).toContain('```mermaid\r\n%% kimi-web');
    expect(out).toContain(`${DIRECTIVE}\r\n`);
    expect(out).not.toContain('%%\n'); // no bare-LF mixed into the injected lines
  });

  it('does not touch inline code or language names merely containing "mermaid"', () => {
    const text = '```mermaidx\nflowchart TD\n```\n\n`mermaid` inline\n';
    expect(injectMermaidHtmlLabelsOff(text)).toBe(text);
  });

  it('core invariant: injected diagram code does NOT start with "%%{"', () => {
    // markstream only prepends its theme directive when the code does not
    // already start with a directive (`trimStart().startsWith("%%{")`).
    // Breaking this invariant would drop dark/light theming.
    const out = injectMermaidHtmlLabelsOff('```mermaid\nflowchart TD\n  A-->B\n```\n');
    for (const body of mermaidBodies(out)) {
      expect(body.trimStart().startsWith('%%{')).toBe(false);
    }
  });

  it('injects before the graph declaration even for streaming partial input', () => {
    const out = injectMermaidHtmlLabelsOff('```mermaid\nflowchart TD\n  A--');
    const body = out.split('\n').slice(1, 3);
    expect(body[0]).toMatch(/^%% kimi-web/);
    expect(body[1]).toBe(DIRECTIVE);
  });

  it('keeps working when the model already opened its own init directive', () => {
    const out = injectMermaidHtmlLabelsOff(
      '```mermaid\n%%{init: {"theme": "forest"}}%%\nflowchart TD\n  A-->B\n```\n',
    );
    // Our comment + directive still lands first; the model's own directive
    // survives afterwards and may override htmlLabels (author intent wins).
    expect(out).toContain(`\`\`\`mermaid\n%% kimi-web`);
    expect(out.indexOf(DIRECTIVE)).toBeLessThan(out.indexOf('%%{init: {"theme": "forest"}}%%'));
  });
});
