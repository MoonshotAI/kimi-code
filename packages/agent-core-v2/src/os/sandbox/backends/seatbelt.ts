

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { SandboxBackend } from '../backend';
import type { ResolvedSandboxProfile, SandboxSpawnPlan } from '../types';

const SEATBELT_PATH = '/usr/bin/sandbox-exec';

const BASE_POLICY = `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.sysv.semmns")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))
(allow mach-lookup (global-name "com.apple.PowerManagement.control"))
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
`;

const NETWORK_POLICY = `(allow system-socket
  (require-all
    (socket-domain AF_SYSTEM)
    (socket-protocol 2)))
(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))
(allow sysctl-read (sysctl-name-regex #"^net.routetable"))
`;

export class SeatbeltBackend implements SandboxBackend {
  readonly name = 'seatbelt' as const;
  readonly supported = true;

  wrap(
    command: string,
    args: readonly string[],
    profile: ResolvedSandboxProfile,
  ): SandboxSpawnPlan {
    const params: string[] = [];
    const sections: string[] = [BASE_POLICY];

    const addParam = (key: string, path: string): void => {
      params.push('-D', `${key}=${normalizePath(path)}`);
    };

    sections.push('(allow file-read-metadata)');
    sections.push('(allow file-read*)');

    profile.denyReadPaths.forEach((path, index) => {
      const key = `DENY_READ_${index}`;
      addParam(key, path);
      sections.push(
        `(deny file-read* file-write* (require-any (literal (param "${key}")) (subpath (param "${key}"))))`,
      );
    });

    if (profile.mode === 'read-only') {
      for (const [index, path] of profile.writableRoots.entries()) {
        const key = `WRITABLE_${index}`;
        addParam(key, path);
        sections.push(`(allow file-write* (subpath (param "${key}")))`);
      }
    } else {
      for (const [index, path] of profile.writableRoots.entries()) {
        const key = `WRITABLE_${index}`;
        addParam(key, path);
        const exclusions = profile.denyWritePaths
          .map((deny, denyIndex) => ({ deny, denyIndex }))
          .filter(({ deny }) => isWithin(deny, path));
        const exclusionClauses = exclusions.flatMap(({ denyIndex }) => {
          const denyKey = `WRITABLE_${index}_DENY_${denyIndex}`;
          addParam(denyKey, profile.denyWritePaths[denyIndex]!);
          return [
            `(require-not (literal (param "${denyKey}")))`,
            `(require-not (subpath (param "${denyKey}")))`,
          ];
        });
        sections.push(
          `(allow file-write* (subpath (param "${key}"))${exclusionClauses.length > 0 ? ` ${exclusionClauses.join(' ')}` : ''})`,
        );
        sections.push(
          `(deny file-write-unlink (require-all (literal (param "${key}")) (vnode-type DIRECTORY)))`,
        );
      }
      for (const [index, path] of profile.denyWritePaths.entries()) {
        const insideWritable = profile.writableRoots.some((root) => isWithin(path, root));
        if (insideWritable) continue;
        const key = `DENY_WRITE_${index}`;
        addParam(key, path);
        sections.push(
          `(deny file-write* (require-any (literal (param "${key}")) (subpath (param "${key}"))))`,
        );
      }
    }

    if (profile.network.mode === 'all') {
      sections.push(NETWORK_POLICY);
      sections.push('(allow network*)');
    } else if (profile.network.mode === 'allowlist' && profile.network.proxyPorts !== undefined) {
      sections.push(NETWORK_POLICY);
      const { http, socks } = profile.network.proxyPorts;
      const ports = [http, socks].filter((p): p is number => p !== undefined);
      for (const port of ports) {
        sections.push(
          `(allow network-outbound (remote tcp "localhost:${String(port)}"))`,
          `(allow network-outbound (remote tcp "127.0.0.1:${String(port)}"))`,
          `(allow network-outbound (remote tcp "::1:${String(port)}"))`,
        );
      }
      if (profile.network.allowLocalBinding) {
        sections.push('(allow network-bind (local tcp "localhost:*"))');
      }
      for (const [index, socketPath] of profile.network.allowUnixSockets.entries()) {
        const key = `UNIX_SOCK_${index}`;
        addParam(key, socketPath);
        sections.push(`(allow network-outbound (remote unix-socket (subpath (param "${key}"))))`);
      }
    }

    return {
      command: SEATBELT_PATH,
      args: [...params, '-p', sections.join('\n'), command, ...args],
      env: {},
    };
  }
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isWithin(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
