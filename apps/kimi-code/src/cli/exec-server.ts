import { getVersion } from './version';

export const EXEC_SERVER_COMMAND = 'exec-server';

const EXEC_SERVER_ARGV_SHAPES: readonly (readonly string[])[] = [
  [EXEC_SERVER_COMMAND],
  [EXEC_SERVER_COMMAND, '--listen', 'stdio'],
];

export function isExecServerArgv(argv: readonly string[]): boolean {
  return hasExecServerShape(argv.slice(1)) || hasExecServerShape(argv.slice(2));
}

function hasExecServerShape(args: readonly string[]): boolean {
  return EXEC_SERVER_ARGV_SHAPES.some(
    (shape) => shape.length === args.length && shape.every((arg, index) => arg === args[index]),
  );
}

export async function runExecServerCommand(listen: string): Promise<number> {
  if (listen !== 'stdio') {
    process.stderr.write(`error: exec-server supports only "--listen stdio" (got "--listen ${listen}")\n`);
    return 2;
  }
  try {
    const { runExecServer } = await import('@moonshot-ai/kimi-code-sdk/exec-server');
    return await runExecServer({ version: getVersion() });
  } catch (error) {
    process.stderr.write(
      `error: exec-server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
