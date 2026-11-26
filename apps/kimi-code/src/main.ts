import { isSshAskpassEnvironment, runSshAskpass } from '@moonshot-ai/kimi-code-sdk/ssh-askpass';

import { isExecServerArgv, runExecServerCommand } from './cli/exec-server';

if (isSshAskpassEnvironment()) {
  delete process.env['OSC7577_TOKEN'];
  void runSshAskpass().then((code) => {
    process.exitCode = code;
  });
} else if (isExecServerArgv(process.argv)) {
  delete process.env['OSC7577_TOKEN'];
  void runExecServerCommand('stdio').then((code) => {
    process.exitCode = code;
  });
} else {
  void import('./cli/main').then(({ main }) => main());
}
