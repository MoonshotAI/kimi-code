import { config as loadDotenv } from 'dotenv';
loadDotenv();

/**
 * kimigram service entrypoint.
 *
 * Loads configuration, opens the pairing store, starts the Telegram bot, and
 * connects to the kimi-code WebSocket event stream to dispatch Telegram
 * notifications.
 */

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { openStore } from './store.js';
import { createPairingService } from './pairing.js';
import { createBot } from './bot.js';
import { createKimiClient } from './kimi/client.js';
import { createKimiEventClient } from './kimi/ws.js';
import { createEventDispatcher } from './kimi/events.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const store = openStore(config.databasePath);
  const pairingService = createPairingService(store, { ttlMinutes: config.pairingCodeTtlMinutes });
  const kimiClient = createKimiClient(config);
  const bot = createBot(config, pairingService, store, kimiClient, logger);
  const eventDispatcher = createEventDispatcher(store, bot.api, { logger });
  const eventClient = createKimiEventClient(config, {
    onEvent: eventDispatcher,
    authMode: config.kimiWsAuthMode,
    logger,
  });

  logger.info({ databasePath: config.databasePath }, 'Starting kimigram');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    logger.info('Stopping kimigram');
    try {
      eventClient.stop();
    } catch (error) {
      logger.error({ error }, 'Error stopping event client');
    }
    try {
      await bot.stop();
    } catch (error) {
      logger.error({ error }, 'Error stopping bot');
    }
    try {
      store.close();
    } catch (error) {
      logger.error({ error }, 'Error closing store');
    }
    process.exit(0);
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  eventClient.start();
  await bot.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
