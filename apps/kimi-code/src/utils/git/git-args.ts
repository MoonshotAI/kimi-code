const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export const GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${NULL_DEVICE}`,
  '-c',
  'commit.gpgSign=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'merge.verifySignatures=false',
  '-c',
  'core.editor=',
  '-c',
  'gpg.program=',
  '-c',
  'submodule.recurse=false',
];

export const GIT_DIFF_ARGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];
