import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';
import {
  extractSegments,
  type CommandSegment,
} from '#/agent/execPolicy/segmentExtractor';

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

describe('extractSegments', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IBashParserService, BashParserService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  function segments(source: string): CommandSegment[] | undefined {
    return extractSegments(
      source,
      0,
      (s) => ix.get(IBashParserService).parse(s, PARSE_OPTIONS),
    );
  }

  it('splits `&&`, `||`, `;` and pipelines into per-command argv', () => {
    expect(segments('git status && rm -rf /')).toEqual([
      ['git', 'status'],
      ['rm', '-rf', '/'],
    ]);
    expect(segments('ls || echo hi')).toEqual([['ls'], ['echo', 'hi']]);
    expect(segments('ls; pwd')).toEqual([['ls'], ['pwd']]);
    expect(segments('cat f | grep x | wc -l')).toEqual([
      ['cat', 'f'],
      ['grep', 'x'],
      ['wc', '-l'],
    ]);
  });

  it('drops variable assignments and redirects', () => {
    expect(segments('FOO=bar ls /tmp')).toEqual([['ls', '/tmp']]);
    expect(segments('ls > out.txt')).toEqual([['ls']]);
    expect(segments('cat < in.txt 2>/dev/null')).toEqual([['cat']]);
  });

  it('does not treat heredoc bodies as commands', () => {
    expect(segments('cat <<EOF\nrm -rf /\nEOF')).toEqual([['cat']]);
  });

  it('literalizes quoted arguments', () => {
    expect(segments('echo "hello world"')).toEqual([['echo', 'hello world']]);
    expect(segments("git commit -m 'fix bug'")).toEqual([
      ['git', 'commit', '-m', 'fix bug'],
    ]);
  });

  it('marks expansion operands unanalyzable while still collecting inner commands', () => {
    const result = segments('echo $(rm -rf /)');
    expect(result).toEqual([null, ['rm', '-rf', '/']]);
    expect(segments('echo $HOME')).toEqual([null]);
    expect(segments('ls *.ts')).toEqual([null]);
  });

  it('recurses into subshell bodies', () => {
    expect(segments('(rm -rf /)')).toEqual([['rm', '-rf', '/']]);
  });

  it('unwraps nested shell -c payloads', () => {
    expect(segments('bash -c "rm -rf /"')).toEqual([['rm', '-rf', '/']]);
    expect(segments("sh -lc 'echo hi'")).toEqual([['echo', 'hi']]);
  });

  it('unwraps eval payloads', () => {
    expect(segments('eval "rm -rf /"')).toEqual([['rm', '-rf', '/']]);
  });

  it('marks unanalyzable nested payloads as null', () => {
    expect(segments('bash -c "$SCRIPT"')).toEqual([null]);
    expect(segments('eval $CMD')).toEqual([null]);
  });

  it('keeps wrapper argv verbatim so sudo/env rules can match', () => {
    expect(segments('sudo rm -rf /')).toEqual([['sudo', 'rm', '-rf', '/']]);
    expect(segments('env FOO=1 make test')).toEqual([['env', 'FOO=1', 'make', 'test']]);
  });

  it('collects commands inside control-flow bodies', () => {
    expect(segments('if true; then shutdown now; fi')).toEqual([
      ['true'],
      ['shutdown', 'now'],
    ]);
    expect(segments('for f in a b; do echo "$f"; done')).toEqual([null]);
  });

  it('caps nested shell recursion at max depth', () => {
    const result = extractSegments(
      'bash -c "rm -rf /"',
      4,
      (s) => ix.get(IBashParserService).parse(s, PARSE_OPTIONS),
    );
    expect(result).toEqual([null]);
  });

  it('returns undefined for unparsable input', () => {
    expect(segments('echo "unterminated')).toBeUndefined();
  });
});
