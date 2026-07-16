import { describe, expect, it } from 'vitest';

import { readQueryParams } from '../../scripts/dep-graph/web/src/query-params';

describe('readQueryParams', () => {
  it('returns an empty object for an empty search string', () => {
    expect(readQueryParams('')).toEqual({});
    expect(readQueryParams('?')).toEqual({});
  });

  it('parses a comma-separated domain list, trimming and deduping', () => {
    expect(readQueryParams('?domain=session, sessionMetadata ,session')).toEqual({
      domains: ['session', 'sessionMetadata'],
    });
  });

  it('drops empty entries from a domain list', () => {
    expect(readQueryParams('?domain=,session,')).toEqual({ domains: ['session'] });
  });

  it('omits the field when a list has no valid entries', () => {
    expect(readQueryParams('?domain=')).toEqual({});
    expect(readQueryParams('?domain=,,')).toEqual({});
  });

  it('filters scopes to the known vocabulary', () => {
    expect(readQueryParams('?scope=Session,bogus,Agent')).toEqual({
      scopes: ['Session', 'Agent'],
    });
  });

  it('omits scopes when none are valid', () => {
    expect(readQueryParams('?scope=bogus')).toEqual({});
  });

  it('filters edge kinds to the known vocabulary', () => {
    expect(readQueryParams('?kind=ctor,nope,publish')).toEqual({
      kinds: ['ctor', 'publish'],
    });
  });

  it('passes through the search string', () => {
    expect(readQueryParams('?search=SystemReminder')).toEqual({
      search: 'SystemReminder',
    });
  });

  it('treats a bare hideOrphans flag as true', () => {
    expect(readQueryParams('?hideOrphans')).toEqual({ hideOrphans: true });
    expect(readQueryParams('?hideOrphans=')).toEqual({ hideOrphans: true });
  });

  it('honors explicit false-ish hideOrphans values', () => {
    expect(readQueryParams('?hideOrphans=false')).toEqual({ hideOrphans: false });
    expect(readQueryParams('?hideOrphans=0')).toEqual({ hideOrphans: false });
    expect(readQueryParams('?hideOrphans=no')).toEqual({ hideOrphans: false });
  });

  it('parses groupByScope as a boolean flag', () => {
    expect(readQueryParams('?groupByScope=true')).toEqual({ groupByScope: true });
  });

  it('passes through the focus node id verbatim', () => {
    expect(readQueryParams('?focus=Session::IMyService')).toEqual({
      focus: 'Session::IMyService',
    });
  });

  it('combines several params into one overrides object', () => {
    expect(
      readQueryParams(
        '?domain=session,sessionMetadata&scope=Session&kind=ctor&search=meta&hideOrphans&groupByScope=1&focus=Session::ISessionMetadata',
      ),
    ).toEqual({
      domains: ['session', 'sessionMetadata'],
      scopes: ['Session'],
      kinds: ['ctor'],
      search: 'meta',
      hideOrphans: true,
      groupByScope: true,
      focus: 'Session::ISessionMetadata',
    });
  });

  it('ignores unknown query parameters', () => {
    expect(readQueryParams('?unknown=value&another=test')).toEqual({});
  });

  it('handles URL-encoded characters in search', () => {
    expect(readQueryParams('?search=hello%20world%21')).toEqual({
      search: 'hello world!',
    });
  });

  it('handles URL-encoded characters in focus', () => {
    expect(readQueryParams('?focus=Session%3A%3AIMyService')).toEqual({
      focus: 'Session::IMyService',
    });
  });

  it('handles groupByScope with true, 1, yes values', () => {
    expect(readQueryParams('?groupByScope=true')).toEqual({ groupByScope: true });
    expect(readQueryParams('?groupByScope=1')).toEqual({ groupByScope: true });
    expect(readQueryParams('?groupByScope=yes')).toEqual({ groupByScope: true });
  });

  it('handles groupByScope with false, 0, no, off values', () => {
    expect(readQueryParams('?groupByScope=false')).toEqual({ groupByScope: false });
    expect(readQueryParams('?groupByScope=0')).toEqual({ groupByScope: false });
    expect(readQueryParams('?groupByScope=no')).toEqual({ groupByScope: false });
    expect(readQueryParams('?groupByScope=off')).toEqual({ groupByScope: false });
  });

  it('handles hideOrphans with explicit true value', () => {
    expect(readQueryParams('?hideOrphans=true')).toEqual({ hideOrphans: true });
  });

  it('handles unicode characters in search', () => {
    expect(readQueryParams('?search=中文测试')).toEqual({
      search: '中文测试',
    });
  });

  it('handles unicode characters in focus', () => {
    expect(readQueryParams('?focus=Session::测试Service')).toEqual({
      focus: 'Session::测试Service',
    });
  });

  it('handles a search string with just a question mark', () => {
    expect(readQueryParams('?')).toEqual({});
  });

  it('handles multiple values for the same parameter by taking the first', () => {
    // URLSearchParams keeps the first value when duplicate keys exist
    expect(readQueryParams('?domain=a&domain=b')).toEqual({ domains: ['a'] });
  });

  it('handles scope with mixed case, only exact matches are kept', () => {
    // The vocabulary check is case-sensitive; "agent" ≠ "Agent"
    expect(readQueryParams('?scope=  Session  ,  agent  ')).toEqual({
      scopes: ['Session'],
    });
  });

  it('handles kind with mixed case, only exact matches are kept', () => {
    // The vocabulary check is case-sensitive; "Publish" ≠ "publish"
    expect(readQueryParams('?kind=ctor,UNKNOWN')).toEqual({
      kinds: ['ctor'],
    });
  });

  it('drops a focus value that is an empty string', () => {
    expect(readQueryParams('?focus=')).toEqual({});
  });

  it('drops a search value that is an empty string', () => {
    expect(readQueryParams('?search=')).toEqual({});
  });

  it('handles a very long domain value', () => {
    const longDomain = 'a'.repeat(5000);
    expect(readQueryParams(`?domain=${longDomain}`)).toEqual({
      domains: [longDomain],
    });
  });

  it('handles fragment in the search string', () => {
    expect(readQueryParams('?search=test#fragment')).toEqual({
      search: 'test#fragment',
    });
  });

  it('empty scope list after filtering returns empty object', () => {
    expect(readQueryParams('?scope=bogus1,bogus2')).toEqual({});
  });

  it('empty kind list after filtering returns empty object', () => {
    expect(readQueryParams('?kind=bogus1,bogus2')).toEqual({});
  });
});
