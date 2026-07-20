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
});
