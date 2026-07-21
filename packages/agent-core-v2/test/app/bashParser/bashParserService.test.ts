import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { BashSyntaxNode } from '#/app/bashParser/bashParser';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';

describe('BashParserService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let service: IBashParserService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IBashParserService, BashParserService);
      },
    });
    service = ix.get(IBashParserService);
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('splits a compound command into per-command nodes', () => {
    const result = service.parse('git status && rm -rf /');
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.hasError).toBe(false);
    expect(result.root.type).toBe('program');
    const commands: string[] = [];
    const walk = (node: BashSyntaxNode): void => {
      if (node.type === 'command') {
        commands.push(node.text);
      }
      node.children.forEach(walk);
    };
    walk(result.root);
    expect(commands).toEqual(['git status', 'rm -rf /']);
  });

  it('flags malformed input with hasError instead of throwing', () => {
    const result = service.parse('echo "unterminated');
    if (!result.ok) {
      throw new Error('expected ok');
    }
    expect(result.hasError).toBe(true);
  });

  it('reports budget exhaustion as aborted', () => {
    const result = service.parse('ls; '.repeat(20000), { maxNodes: 100 });
    expect(result).toEqual({ ok: false, reason: 'aborted' });
  });

  it('returns a JSON-serializable tree with text/range fidelity', () => {
    const source = 'echo "你好 🎉" | grep 你';
    const result = service.parse(source);
    if (!result.ok) {
      throw new Error('expected ok');
    }
    const roundTripped = JSON.parse(JSON.stringify(result.root)) as BashSyntaxNode;
    const check = (node: BashSyntaxNode): void => {
      expect(node.text).toBe(source.slice(node.startIndex, node.endIndex));
      node.children.forEach(check);
    };
    check(roundTripped);
  });
});
