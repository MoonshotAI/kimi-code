export function isOriginAllowed(origin: string, host: string | undefined, allowed: readonly string[]): boolean {
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const originStripped = stripPort(originHost);
  if (host !== undefined) {
    const hostStripped = stripPort(host);
    if (originStripped === hostStripped) {
      return true;
    }
    if (isLoopbackHost(originStripped) && isLoopbackHost(hostStripped)) {
      return true;
    }
  }
  return allowed.includes(origin);
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return (end === -1 ? host : host.slice(0, end + 1)).toLowerCase();
  }
  const firstColon = host.indexOf(':');
  if (firstColon === -1) {
    return host.toLowerCase();
  }
  const lastColon = host.lastIndexOf(':');
  if (firstColon === lastColon) {
    const after = host.slice(lastColon + 1);
    if (after.length > 0 && /^\d+$/.test(after)) {
      return host.slice(0, lastColon).toLowerCase();
    }
  }
  return host.toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.') ||
    host.endsWith('.localhost')
  );
}
