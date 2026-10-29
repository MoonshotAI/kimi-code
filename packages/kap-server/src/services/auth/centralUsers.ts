import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { registerFlagDefinition } from '@moonshot-ai/agent-core-v2/app/flag/flagRegistry';
import { z } from 'zod';

import { readPrivateFile, writePrivateFile } from './privateFiles';
import type { AuthPrincipal } from './principal';

export const INTERNAL_CENTRAL_SERVER_FLAG_ID = 'internal_central_server';
export const INTERNAL_CENTRAL_SERVER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_INTERNAL_CENTRAL_SERVER';

registerFlagDefinition({
  id: INTERNAL_CENTRAL_SERVER_FLAG_ID,
  title: 'Internal central server',
  description: 'Enable independent user credentials and authenticated-user attribution for the internal central AgentLoop server experiment.',
  env: INTERNAL_CENTRAL_SERVER_FLAG_ENV,
  default: false,
  surface: 'core',
});

const centralUserSchema = z.object({
  user_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  display_name: z.string().trim().min(1).max(100),
  token_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const centralUsersFileSchema = z.object({
  version: z.literal(1),
  users: z.array(centralUserSchema),
});

type CentralUsersFile = z.infer<typeof centralUsersFileSchema>;
type CentralUserRecord = CentralUsersFile['users'][number];

export interface CentralUserRegistration {
  readonly principal: AuthPrincipal;
  readonly token: string;
  readonly usersFile: string;
}

export function centralUsersPath(homeDir: string): string {
  return join(homeDir, 'server', 'central-users.json');
}

export function createCentralUserAuthenticator(usersFile: string) {
  return async (candidate: string): Promise<AuthPrincipal | undefined> => {
    const { users } = await readCentralUsers(usersFile);
    const candidateHash = tokenHash(candidate);
    const user = users.find((entry) => timingSafeEqual(candidateHash, Buffer.from(entry.token_sha256, 'hex')));
    if (user === undefined) return undefined;
    return { userId: user.user_id, displayName: user.display_name };
  };
}

export async function registerCentralUser(input: {
  readonly homeDir: string;
  readonly userId: string;
  readonly displayName: string;
  readonly usersFile?: string;
  readonly token?: string;
}): Promise<CentralUserRegistration> {
  const usersFile = input.usersFile ?? centralUsersPath(input.homeDir);
  const userId = centralUserSchema.shape.user_id.parse(input.userId);
  if (userId === 'local-server') throw new Error('Central user id is reserved: local-server');
  const displayName = centralUserSchema.shape.display_name.parse(input.displayName);
  const token = input.token ?? randomBytes(32).toString('base64url');
  if (token.length < 32) throw new Error('Central user token must contain at least 32 characters');
  const { users } = await readCentralUsers(usersFile);
  if (users.some((entry) => entry.user_id === userId)) {
    throw new Error(`Central user already exists: ${userId}`);
  }
  const tokenSha256 = tokenHash(token).toString('hex');
  if (users.some((entry) => entry.token_sha256 === tokenSha256)) {
    throw new Error('Central user token is already registered');
  }
  const next: CentralUserRecord = { user_id: userId, display_name: displayName, token_sha256: tokenSha256 };
  const file: CentralUsersFile = { version: 1, users: [...users, next] };
  await writePrivateFile(usersFile, `${JSON.stringify(file, null, 2)}\n`);
  return { principal: { userId, displayName }, token, usersFile };
}

async function readCentralUsers(usersFile: string): Promise<CentralUsersFile> {
  let raw: Buffer;
  try {
    raw = await readPrivateFile(usersFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, users: [] };
    throw error;
  }
  return centralUsersFileSchema.parse(JSON.parse(raw.toString('utf8')));
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
