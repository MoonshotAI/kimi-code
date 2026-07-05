import { z } from 'zod';
import { readFileSync } from 'fs';
import { homedir } from 'os';

/**
 * Environment configuration for the kimigram sidecar.
 * Validates and exposes settings required to run the Telegram bot, connect to
 * the kimi-code REST API, and subscribe to the kimi-code WebSocket event
 * stream.
 */
const configSchema = z
  .object({
    telegramBotToken: z
      .string({ message: 'TELEGRAM_BOT_TOKEN is required' })
      .min(1, 'TELEGRAM_BOT_TOKEN is required'),
    databasePath: z.string().default('./data/kimigram.db'),
    pairingCodeTtlMinutes: z.preprocess(
      (val) => {
        if (val === undefined || val === '') return undefined;
        const parsed = Number(val);
        if (Number.isNaN(parsed) || !Number.isInteger(parsed)) {
          throw new Error('PAIRING_CODE_TTL_MINUTES must be a positive integer');
        }
        return parsed;
      },
      z
        .number()
        .int()
        .positive('PAIRING_CODE_TTL_MINUTES must be a positive integer')
        .default(10)
    ),
    logLevel: z
      .enum(['trace', 'debug', 'info', 'warn', 'error'], {
        message: 'LOG_LEVEL must be one of trace, debug, info, warn, error',
      })
      .default('info'),
    kimiServerUrl: z
      .string()
      .url('KIMI_SERVER_URL must be a valid URL')
      .default('http://127.0.0.1:58627')
      .transform((url) => url.replace(/\/$/, '')),
    kimiBearerToken: z.string().optional(),
    kimiTokenFile: z.string().default('~/.kimi-code/token'),
    kimiWsAuthMode: z
      .enum(['subprotocol', 'query'], {
        message: 'KIMI_WS_AUTH_MODE must be either "subprotocol" or "query"',
      })
      .default('subprotocol'),
  })
  .transform((cfg) => {
    const kimiWsUrl = cfg.kimiServerUrl
      .replace(/^http:\/\//, 'ws://')
      .replace(/^https:\/\//, 'wss://');

    let token = cfg.kimiBearerToken?.trim();
    if (!token) {
      const tokenPath = cfg.kimiTokenFile.replace(/^~(?=$|\/|\\)/, homedir());
      try {
        token = readFileSync(tokenPath, 'utf8').trim();
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(
          `KIMI bearer token is required. Set KIMI_BEARER_TOKEN or ensure ${cfg.kimiTokenFile} exists. ${cause}`
        );
      }
    }
    return { ...cfg, kimiBearerToken: token, kimiWsUrl };
  })
  .refine(
    (cfg) => cfg.kimiBearerToken && cfg.kimiBearerToken.length > 0,
    'KIMI bearer token is required'
  );

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    databasePath: process.env.DATABASE_PATH,
    pairingCodeTtlMinutes: process.env.PAIRING_CODE_TTL_MINUTES,
    logLevel: process.env.LOG_LEVEL,
    kimiServerUrl: process.env.KIMI_SERVER_URL,
    kimiBearerToken: process.env.KIMI_BEARER_TOKEN,
    kimiTokenFile: process.env.KIMI_TOKEN_FILE,
    kimiWsAuthMode: process.env.KIMI_WS_AUTH_MODE,
  });
}
