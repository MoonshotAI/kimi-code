#!/usr/bin/env node

/**
 * CLI helper to generate a one-time Telegram pairing code for a kimi-code session.
 *
 * Usage:
 *   npm run pair -- <session-id>
 *   npx tsx scripts/generate-pairing-code.ts <session-id>
 */

import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { openStore } from '../src/store.js';
import { createPairingService } from '../src/pairing.js';

function main() {
  const sessionId = process.argv[2];
  if (!sessionId || sessionId.trim().length === 0) {
    console.error('Usage: npm run pair -- <session-id>');
    process.exit(1);
  }

  const config = loadConfig();
  const logger = createLogger(config);
  const store = openStore(config.databasePath);

  try {
    const pairingService = createPairingService(store, {
      ttlMinutes: config.pairingCodeTtlMinutes,
    });
    const code = pairingService.generatePairingCode(sessionId);
    console.log(code);
  } catch (error) {
    logger.error({ error }, 'Failed to generate pairing code');
    process.exit(1);
  } finally {
    store.close();
  }
}

main();
