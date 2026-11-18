import { describe, it, expect } from 'vitest';

import { installPermissionHandler, isTrustedPermissionOrigin } from '../../../src/main/app/permissions';

type PermissionHandler = (
  webContents: { getURL: () => string },
  permission: string,
  callback: (granted: boolean) => void,
  details: { isMainFrame: boolean; requestingUrl: string },
) => void;

function captureHandler(): PermissionHandler {
  let handler: PermissionHandler | null = null;
  const session = {
    setPermissionRequestHandler(h: PermissionHandler) {
      handler = h;
    },
  };
  installPermissionHandler(session as never);
  if (handler === null) throw new Error('handler not installed');
  return handler;
}

const TRUSTED = { getURL: () => 'app://renderer/index.html' };
const MAIN = { isMainFrame: true, requestingUrl: 'app://renderer/index.html' };

describe('isTrustedPermissionOrigin', () => {
  it('trusts the packaged renderer scheme', () => {
    expect(isTrustedPermissionOrigin('app://renderer/index.html')).toBe(true);
    expect(isTrustedPermissionOrigin('app://renderer/pet.html')).toBe(true);
  });

  it('trusts loopback dev servers on any port', () => {
    expect(isTrustedPermissionOrigin('http://127.0.0.1:5174/')).toBe(true);
    expect(isTrustedPermissionOrigin('http://localhost:5175/')).toBe(true);
    expect(isTrustedPermissionOrigin('http://[::1]:5174/')).toBe(true);
  });

  it('denies foreign and malformed origins', () => {
    expect(isTrustedPermissionOrigin('https://example.com/')).toBe(false);
    expect(isTrustedPermissionOrigin('http://127.0.0.1.evil.com/')).toBe(false);
    expect(isTrustedPermissionOrigin('file:///etc/passwd')).toBe(false);
    expect(isTrustedPermissionOrigin('app://evil/')).toBe(false);
    expect(isTrustedPermissionOrigin('')).toBe(false);
    expect(isTrustedPermissionOrigin('not a url')).toBe(false);
  });
});

describe('installPermissionHandler', () => {
  it('grants the permissions the renderer needs from a trusted origin', () => {
    const handler = captureHandler();
    for (const permission of ['notifications', 'clipboard-sanitized-write', 'local-fonts']) {
      handler(TRUSTED, permission, (granted) => expect(granted).toBe(true), MAIN);
    }
  });

  it('denies unrelated permission types even from a trusted origin', () => {
    const handler = captureHandler();
    for (const permission of ['media', 'geolocation', 'clipboard-read', 'midi', 'midiSysex', 'display-capture', 'idle-detection', 'unknown']) {
      handler(TRUSTED, permission, (granted) => expect(granted).toBe(false), MAIN);
    }
  });

  it('denies every permission from a foreign origin', () => {
    const handler = captureHandler();
    const foreign = { getURL: () => 'https://example.com/' };
    handler(foreign, 'notifications', (granted) => expect(granted).toBe(false), MAIN);
    handler(foreign, 'local-fonts', (granted) => expect(granted).toBe(false), MAIN);
  });

  it('denies subframe requests from an untrusted requesting URL', () => {
    const handler = captureHandler();
    const subframe = { isMainFrame: false, requestingUrl: 'https://example.com/frame' };
    handler(TRUSTED, 'local-fonts', (granted) => expect(granted).toBe(false), subframe);
    const trustedSubframe = { isMainFrame: false, requestingUrl: 'app://renderer/index.html' };
    handler(TRUSTED, 'local-fonts', (granted) => expect(granted).toBe(true), trustedSubframe);
  });
});
