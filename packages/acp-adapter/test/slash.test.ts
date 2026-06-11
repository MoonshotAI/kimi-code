import { describe, expect, it } from 'vitest';

import {
  detectSlashIntent,
  parseSlashInput,
  resolveSkillCommand,
} from '../src/slash';

describe('slash', () => {
  describe('parseSlashInput', () => {
    it('returns null for non-slash input', () => {
      expect(parseSlashInput('hello')).toBeNull();
      expect(parseSlashInput('')).toBeNull();
    });

    it('returns null for "/" with no name', () => {
      expect(parseSlashInput('/')).toBeNull();
      expect(parseSlashInput('/   ')).toBeNull();
    });

    it('rejects names containing further slashes', () => {
      expect(parseSlashInput('/a/b')).toBeNull();
    });

    it('parses a bare command', () => {
      expect(parseSlashInput('/clear')).toEqual({ name: 'clear', args: '' });
    });

    it('parses command + args, trimming inner whitespace', () => {
      expect(parseSlashInput('/skill:foo bar baz')).toEqual({
        name: 'skill:foo',
        args: 'bar baz',
      });
      expect(parseSlashInput('/skill:foo    spaced   ')).toEqual({
        name: 'skill:foo',
        args: 'spaced',
      });
    });
  });

  describe('resolveSkillCommand', () => {
    const map = new Map<string, string>([
      ['skill:foo', 'foo'],
      ['skill:bar', 'bar'],
    ]);

    it('matches the full `skill:<name>` form directly', () => {
      expect(resolveSkillCommand(map, 'skill:foo')).toBe('foo');
    });

    it('also matches the bare `<name>` form (`skill:` prefix added)', () => {
      expect(resolveSkillCommand(map, 'foo')).toBe('foo');
    });

    it('returns undefined for unknown commands', () => {
      expect(resolveSkillCommand(map, 'clear')).toBeUndefined();
    });
  });

  describe('detectSlashIntent', () => {
    const map = new Map<string, string>([['skill:foo', 'foo']]);

    it('routes a known `/skill:<name>` form to a `skill` intent', () => {
      expect(detectSlashIntent('/skill:foo bar', map)).toEqual({
        kind: 'skill',
        skillName: 'foo',
        args: 'bar',
      });
    });

    it('routes a bare `/foo` form to `skill` when the map has it', () => {
      expect(detectSlashIntent('/foo bar', map)).toEqual({
        kind: 'skill',
        skillName: 'foo',
        args: 'bar',
      });
    });

    it('reports unknown slash commands instead of passing them to the model', () => {
      // TUI builtins like /clear are not ACP-executable. Report them as
      // unknown so the adapter can render a local error instead of sending
      // the literal command to the model.
      expect(detectSlashIntent('/clear', map)).toEqual({
        kind: 'unknown',
        name: 'clear',
        args: '',
      });
    });

    it('routes ACP built-in commands', () => {
      expect(detectSlashIntent('/compact summarize aggressively', map)).toEqual({
        kind: 'builtin',
        name: 'compact',
        args: 'summarize aggressively',
      });
      expect(detectSlashIntent('/status', map)).toEqual({ kind: 'builtin', name: 'status', args: '' });
    });

    it('falls back to passthrough for non-slash text', () => {
      expect(detectSlashIntent('hello', map)).toEqual({ kind: 'passthrough' });
    });

    it('returns empty-string args for a known skill with no arguments', () => {
      expect(detectSlashIntent('/skill:foo', map)).toEqual({
        kind: 'skill',
        skillName: 'foo',
        args: '',
      });
    });
  });
});
