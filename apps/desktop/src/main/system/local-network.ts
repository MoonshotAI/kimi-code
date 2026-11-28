import { randomBytes } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app } from 'electron';
import { log } from '../diagnostics/log';

export type LocalNetworkProbeResult = 'granted' | 'denied' | 'unavailable';

interface LocalNetworkNativeModule {
  probe: (timeoutMs: number) => Promise<string>;
}

let nativeModule: LocalNetworkNativeModule | null | undefined;

function nativeDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'local-network')
    : join(app.getAppPath(), 'native', 'local-network', 'dist');
}

function loadNativeModule(): LocalNetworkNativeModule | null {
  if (process.platform !== 'darwin') return null;
  if (nativeModule === undefined) {
    try {
      const loaded = createRequire(import.meta.url)(join(nativeDirectory(), 'local-network.node')) as LocalNetworkNativeModule;
      nativeModule = typeof loaded?.probe === 'function' ? loaded : null;
    } catch (error) {
      nativeModule = null;
      log.warn(`[permissions] local-network native module unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return nativeModule;
}

export function isLocalNetworkProbeAvailable(): boolean {
  return loadNativeModule() !== null;
}

export async function probeLocalNetworkPermission(timeoutMs = 1_500): Promise<LocalNetworkProbeResult> {
  const native = loadNativeModule();
  if (native === null) return 'unavailable';
  try {
    const result = await native.probe(timeoutMs);
    return result === 'granted' || result === 'denied' ? result : 'unavailable';
  } catch (error) {
    log.warn(`[permissions] local-network probe failed: ${error instanceof Error ? error.message : String(error)}`);
    return 'unavailable';
  }
}

export function randomLinkLocalIpv6(bytes: Buffer = randomBytes(16)): string {
  const first = 0xfe80 | (bytes[0]! & 0x3f);
  const groups = [first];
  for (let offset = 2; offset < 16; offset += 2) {
    groups.push(bytes.readUInt16BE(offset));
  }
  return groups.map((group) => group.toString(16)).join(':');
}

export function triggerLocalNetworkPrompt(
  socketFactory: () => Pick<Socket, 'once' | 'connect' | 'close'> = () => createSocket('udp6'),
  settleMs = 200,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let socket: Pick<Socket, 'once' | 'connect' | 'close'>;
    try {
      socket = socketFactory();
    } catch {
      resolve();
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve();
    };
    socket.once('error', finish);
    try {
      socket.connect(9, randomLinkLocalIpv6(), () => {
        timer = setTimeout(finish, settleMs);
        timer.unref?.();
      });
    } catch {
      finish();
    }
  });
}
