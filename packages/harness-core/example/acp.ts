import { mountExample } from './app';

const { harness, probe } = mountExample({ http: false, acp: true });
const onSignal = (): void => {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  void harness.close().then(() => process.exit(0));
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
await probe.root.ready();
