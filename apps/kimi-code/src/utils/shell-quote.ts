export function quoteShellArg(value: string): string {
  return process.platform === 'win32' ? quoteCmdArg(value) : quotePosixArg(value);
}

function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteCmdArg(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
