import { mountExample } from './app';

const { app } = mountExample({ http: false, acp: true });
const onSignal = (): void => {
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  void app.disposeAsync().then(() => process.exit(0));
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
await app.ready();
