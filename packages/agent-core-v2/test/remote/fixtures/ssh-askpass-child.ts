import { runSshAskpass } from '#/remote/askpass';

process.exitCode = await runSshAskpass();
