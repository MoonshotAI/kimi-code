import { describe, expect, it } from 'vitest';
import {
  deviceUrl,
  isRcLocation,
  readDeviceIdFromLocation,
  stripRcDevicePrefix,
  withRcQuery,
} from '../src/lib/rcDevices';

describe('readDeviceIdFromLocation', () => {
  it('parses the id with or without a trailing slash', () => {
    expect(readDeviceIdFromLocation({ pathname: '/devices/dev-1/' })).toBe('dev-1');
    expect(readDeviceIdFromLocation({ pathname: '/devices/dev-1' })).toBe('dev-1');
  });

  it('decodes encoded ids', () => {
    expect(readDeviceIdFromLocation({ pathname: '/devices/a%20b/' })).toBe('a b');
  });

  it('rejects non-device and bare paths', () => {
    expect(readDeviceIdFromLocation({ pathname: '/' })).toBeUndefined();
    expect(readDeviceIdFromLocation({ pathname: '/sessions/abc' })).toBeUndefined();
    expect(readDeviceIdFromLocation({ pathname: '/devices/' })).toBeUndefined();
    expect(readDeviceIdFromLocation({ pathname: '/devices' })).toBeUndefined();
    expect(readDeviceIdFromLocation({ pathname: '/devices//sessions/abc' })).toBeUndefined();
  });

  it('takes the first segment on relay-prefixed deep links', () => {
    expect(readDeviceIdFromLocation({ pathname: '/devices/dev-1/sessions/sess_9/' })).toBe(
      'dev-1',
    );
    expect(readDeviceIdFromLocation({ pathname: '/devices/a/b' })).toBe('a');
  });

  it('rejects undecodable ids without throwing', () => {
    expect(readDeviceIdFromLocation({ pathname: '/devices/%E0%A4%A/' })).toBeUndefined();
  });
});

describe('stripRcDevicePrefix', () => {
  it('strips the device segment and keeps the route', () => {
    expect(stripRcDevicePrefix('/devices/dev-1/sessions/sess_9')).toBe('/sessions/sess_9');
    expect(stripRcDevicePrefix('/devices/dev-1/sessions/sess_9/')).toBe('/sessions/sess_9/');
    expect(stripRcDevicePrefix('/devices/dev-1/admin/sessions')).toBe('/admin/sessions');
  });

  it('maps the bare device page to root', () => {
    expect(stripRcDevicePrefix('/devices/dev-1/')).toBe('/');
    expect(stripRcDevicePrefix('/devices/dev-1')).toBe('/');
  });

  it('leaves non-device paths untouched', () => {
    expect(stripRcDevicePrefix('/')).toBe('/');
    expect(stripRcDevicePrefix('/sessions/abc')).toBe('/sessions/abc');
    expect(stripRcDevicePrefix('/devices/')).toBe('/devices/');
    expect(stripRcDevicePrefix('/devices//sessions/abc')).toBe('/devices//sessions/abc');
  });
});

describe('deviceUrl', () => {
  it('builds the canonical path with a trailing slash', () => {
    expect(deviceUrl('dev-1')).toBe('/devices/dev-1/');
  });

  it('encodes special characters', () => {
    expect(deviceUrl('a b')).toBe('/devices/a%20b/');
  });
});

describe('isRcLocation', () => {
  it('is true only for rc=1', () => {
    expect(isRcLocation({ search: '?rc=1' })).toBe(true);
    expect(isRcLocation({ search: '?from=x&rc=1' })).toBe(true);
    expect(isRcLocation({ search: '?rc=0' })).toBe(false);
    expect(isRcLocation({ search: '' })).toBe(false);
  });
});

describe('withRcQuery', () => {
  it('returns the path unchanged without rc params', () => {
    expect(withRcQuery('/sessions/abc', '')).toBe('/sessions/abc');
    expect(withRcQuery('/sessions/abc', '?foo=1&bar=2')).toBe('/sessions/abc');
  });

  it('carries rc and from, ignoring other params', () => {
    expect(withRcQuery('/sessions/abc', '?rc=1&from=kimi_code_cli&debug=1')).toBe(
      '/sessions/abc?rc=1&from=kimi_code_cli',
    );
  });

  it('carries each param independently and in stable order', () => {
    expect(withRcQuery('/', '?rc=1')).toBe('/?rc=1');
    expect(withRcQuery('/', '?from=kimi_code_cli')).toBe('/?from=kimi_code_cli');
    expect(withRcQuery('/', '?from=kimi_code_cli&rc=1')).toBe('/?rc=1&from=kimi_code_cli');
  });
});
