import {
  approveAccessRequestByUserCode,
  createPersistedAccessToken,
  listPersistedAccessPrincipals,
  revokePersistedAccessPrincipal,
  type ExternalAccessRole,
} from '@moonshot-ai/kap-server';
import { type Command, Option } from 'commander';

import { getDataDir } from '#/utils/paths';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface AccessCommandDeps {
  readonly homeDir: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

function resolveAccessDeps(overrides?: Partial<AccessCommandDeps>): AccessCommandDeps {
  return {
    homeDir: overrides?.homeDir ?? getDataDir,
    stdout: overrides?.stdout ?? process.stdout,
    stderr: overrides?.stderr ?? process.stderr,
    exit: overrides?.exit ?? ((code: number) => process.exit(code)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeTerminalText(value: string): string {
  return value.replaceAll(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').trim();
}

export async function handleAccessCreate(
  deps: AccessCommandDeps,
  opts: { readonly name: string; readonly role: ExternalAccessRole; readonly json: boolean },
): Promise<void> {
  const trimmedName = sanitizeTerminalText(opts.name);
  if (trimmedName.length === 0) {
    throw new Error('--name must not be empty.');
  }
  const created = await createPersistedAccessToken(deps.homeDir(), {
    name: trimmedName,
    role: opts.role,
  });
  if (opts.json) {
    deps.stdout.write(
      `${JSON.stringify({ token: created.token, principal: created.principal }, null, 2)}\n`,
    );
    return;
  }
  deps.stdout.write(`${created.token}\n`);
  deps.stderr.write(
    `Created ${created.principal.role} token "${sanitizeTerminalText(created.principal.name)}" (${created.principal.id}). Store this token securely; it will not be shown again.\n`,
  );
}

export async function handleAccessList(
  deps: AccessCommandDeps,
  opts: { readonly json: boolean },
): Promise<void> {
  const principals = await listPersistedAccessPrincipals(deps.homeDir());
  if (opts.json) {
    deps.stdout.write(`${JSON.stringify({ items: principals }, null, 2)}\n`);
    return;
  }
  if (principals.length === 0) {
    deps.stdout.write('No access tokens found.\n');
    return;
  }
  for (const p of principals) {
    const status = p.revoked_at !== null ? 'revoked' : 'active';
    const lastUsed = p.last_used_at ?? 'never';
    deps.stdout.write(
      `${p.id}  ${p.role.padEnd(8)}  ${status.padEnd(7)}  created=${p.created_at}  last_used=${lastUsed}  ${sanitizeTerminalText(p.name)}\n`,
    );
  }
}

export async function handleAccessRevoke(
  deps: AccessCommandDeps,
  principalId: string,
  opts: { readonly json: boolean },
): Promise<void> {
  const revoked = await revokePersistedAccessPrincipal(deps.homeDir(), principalId);
  if (revoked === undefined) {
    throw new Error(`Access token not found: ${principalId}`);
  }
  if (opts.json) {
    deps.stdout.write(`${JSON.stringify({ principal: revoked }, null, 2)}\n`);
    return;
  }
  deps.stdout.write(`Revoked access token ${revoked.id} (${sanitizeTerminalText(revoked.name)}).\n`);
}

export async function handleAccessApprove(
  deps: AccessCommandDeps,
  userCode: string,
  opts: { readonly json: boolean },
): Promise<void> {
  const outcome = await approveAccessRequestByUserCode(deps.homeDir(), userCode);
  if (!outcome.ok) {
    const safeCode = sanitizeTerminalText(userCode);
    if (outcome.reason === 'expired') {
      throw new Error(`Access request for code "${safeCode}" has expired.`);
    }
    if (outcome.reason === 'already_resolved') {
      throw new Error(`Access request for code "${safeCode}" has already been resolved.`);
    }
    throw new Error(`No pending access request found for code "${safeCode}".`);
  }
  if (opts.json) {
    deps.stdout.write(
      `${JSON.stringify({ request: outcome.request, principal: outcome.principal }, null, 2)}\n`,
    );
    return;
  }
  deps.stdout.write(
    `Approved ${outcome.principal.role} access for "${sanitizeTerminalText(outcome.principal.name)}" (${outcome.principal.id}).\n`,
  );
}

export function registerAccessCommand(
  parent: Command,
  deps?: Partial<AccessCommandDeps>,
): void {
  const access = parent
    .command('access')
    .description('Manage external KAP client access tokens and approve local connection requests.');

  access
    .command('create')
    .description('Issue a scoped external access token (printed once).')
    .requiredOption('--name <name>', 'Human-readable client name.')
    .addOption(
      new Option('--role <role>', 'Permission role for the token.')
        .choices(['operator', 'viewer'])
        .default('operator'),
    )
    .option('--json', 'Emit JSON output.', false)
    .action(async (options: { name: string; role: ExternalAccessRole; json?: boolean }) => {
      const resolved = resolveAccessDeps(deps);
      try {
        await handleAccessCreate(resolved, {
          name: options.name,
          role: options.role,
          json: options.json === true,
        });
      } catch (error) {
        resolved.stderr.write(`${errorMessage(error)}\n`);
        resolved.exit(1);
      }
    });

  access
    .command('list')
    .description('List issued external access tokens.')
    .option('--json', 'Emit JSON output.', false)
    .action(async (options: { json?: boolean }) => {
      const resolved = resolveAccessDeps(deps);
      try {
        await handleAccessList(resolved, { json: options.json === true });
      } catch (error) {
        resolved.stderr.write(`${errorMessage(error)}\n`);
        resolved.exit(1);
      }
    });

  access
    .command('revoke')
    .description('Revoke an external access token by principal ID.')
    .argument('<id>', 'Principal ID (e.g. tok_...).')
    .option('--json', 'Emit JSON output.', false)
    .action(async (id: string, options: { json?: boolean }) => {
      const resolved = resolveAccessDeps(deps);
      try {
        await handleAccessRevoke(resolved, id, { json: options.json === true });
      } catch (error) {
        resolved.stderr.write(`${errorMessage(error)}\n`);
        resolved.exit(1);
      }
    });

  access
    .command('approve')
    .description('Approve a pending local client access request by user verification code.')
    .argument('<user_code>', 'Verification code displayed by the client or server.')
    .option('--json', 'Emit JSON output.', false)
    .action(async (userCode: string, options: { json?: boolean }) => {
      const resolved = resolveAccessDeps(deps);
      try {
        await handleAccessApprove(resolved, userCode, { json: options.json === true });
      } catch (error) {
        resolved.stderr.write(`${errorMessage(error)}\n`);
        resolved.exit(1);
      }
    });
}
