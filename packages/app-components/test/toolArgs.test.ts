import { describe, expect, it } from 'vitest';
import { argFallbackText, parseArgRecord } from '../src/chat/tool-calls/toolArgs';

describe('argFallbackText', () => {
  it('hides empty and partial JSON arguments', () => {
    expect(argFallbackText('{}')).toBe('');
    expect(argFallbackText('  {"command": "ls')).toBe('');
    expect(argFallbackText('[]')).toBe('');
    expect(argFallbackText('{')).toBe('');
    expect(argFallbackText('[{"a": 1')).toBe('');
    expect(argFallbackText('null')).toBe('');
  });

  it('keeps shell commands that start with a bracket or brace', () => {
    expect(argFallbackText('[ -f file ] && echo yes')).toBe('[ -f file ] && echo yes');
    expect(argFallbackText('{ echo a; echo b; }')).toBe('{ echo a; echo b; }');
    expect(argFallbackText('[[ -n "$x" ]]')).toBe('[[ -n "$x" ]]');
  });

  it('keeps plain-text arguments without the bullet prefix', () => {
    expect(argFallbackText('· git status ')).toBe('git status');
    expect(argFallbackText('README.md')).toBe('README.md');
  });
});

describe('parseArgRecord', () => {
  it('reads completed fields while later content is still streaming', () => {
    expect(parseArgRecord('{"path":"/tmp/index.html","content":"unfinished')).toEqual({ path: '/tmp/index.html' });
    expect(parseArgRecord('{"url":"https://example.com/docs","note":"unfinished')).toEqual({ url: 'https://example.com/docs' });
  });

  it('omits a path or URL whose string has not closed', () => {
    expect(parseArgRecord('{"path":"/tmp/ind')).toBeNull();
    expect(parseArgRecord('{"url":"https://exam')).toBeNull();
  });

  it('returns null when no complete fields can be recovered', () => {
    expect(parseArgRecord('{broken')).toBeNull();
  });
});
