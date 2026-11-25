import { startServerForeground } from '#/cli/sub/web/run';
import { parseServerOptions } from '#/cli/sub/web/shared';

await startServerForeground(parseServerOptions({ port: '0' }), {
  onReady: (origin) => {
    process.stdout.write(`Local: ${origin}\n`);
  },
  onShutdown: () => {
    throw new Error('example cleanup hook failed');
  },
});
