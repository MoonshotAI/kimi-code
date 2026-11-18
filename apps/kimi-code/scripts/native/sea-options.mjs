export const SEA_EXEC_ARGV = Object.freeze(['--max-semi-space-size=16']);

export function seaCodeCacheEnabled(target, host = `${process.platform}-${process.arch}`) {
  return target === host;
}
