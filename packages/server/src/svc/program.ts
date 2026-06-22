import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

interface NodeSeaModule {
  isSea(): boolean;
}

const nodeRequire = createRequire(import.meta.url);
let cachedSea: NodeSeaModule | null | undefined;

function loadSeaModule(): NodeSeaModule | null {
  if (cachedSea !== undefined) return cachedSea;
  try {
    cachedSea = nodeRequire('node:sea') as NodeSeaModule;
  } catch {
    cachedSea = null;
  }
  return cachedSea;
}

/** True when running as a compiled single-executable (SEA / native) binary. */
function detectSea(): boolean {
  const sea = loadSeaModule();
  if (sea === null) return false;
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}

export function resolveSupervisorProgram(
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd(),
  execPath: string = process.execPath,
  isSea: boolean = detectSea(),
): string {
  // In a SEA binary `argv[1]` is the invoked command name (e.g. `kimi`) or the
  // first user argument — never a script path — so the re-exec target is always
  // the binary itself. Resolving it against `cwd` would produce a bogus path
  // (e.g. `<cwd>/kimi`) and crash the spawn with ENOENT.
  if (isSea) return execPath;
  const candidate = argv[1] === 'server' ? execPath : (argv[1] ?? execPath);
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}
