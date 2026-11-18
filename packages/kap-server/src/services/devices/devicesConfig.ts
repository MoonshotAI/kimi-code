import {
  accountDeviceEntrySchema,
  sshDeviceEntrySchema,
  type DeviceEntry,
  type SshDeviceEntry,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

const sshDeviceWireObjectSchema = z
  .object({
    connection: sshDeviceEntrySchema.shape.connection,
    host: sshDeviceEntrySchema.shape.host,
    name: sshDeviceEntrySchema.shape.name,
    enabled: sshDeviceEntrySchema.shape.enabled,
    identity_file: sshDeviceEntrySchema.shape.identityFile,
    remote_bin: sshDeviceEntrySchema.shape.remoteBin,
  })
  .strict();

const deviceWireObjectSchema = z.discriminatedUnion('connection', [
  sshDeviceWireObjectSchema,
  accountDeviceEntrySchema,
]);

function toSshEntry(wire: z.output<typeof sshDeviceWireObjectSchema>): SshDeviceEntry {
  return {
    connection: wire.connection,
    host: wire.host,
    name: wire.name,
    enabled: wire.enabled,
    identityFile: wire.identity_file,
    remoteBin: wire.remote_bin,
  };
}

export const sshDeviceWireSchema: z.ZodType<SshDeviceEntry, z.input<typeof sshDeviceWireObjectSchema>> =
  sshDeviceWireObjectSchema.transform(toSshEntry);

export const deviceWireSchema: z.ZodType<DeviceEntry, z.input<typeof deviceWireObjectSchema>> =
  deviceWireObjectSchema.transform((wire) => (wire.connection === 'account' ? wire : toSshEntry(wire)));
