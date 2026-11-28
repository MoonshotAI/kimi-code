export interface MachOUuidOptions {
  appId: string;
  arch?: string;
}

export interface MachOSliceUuid {
  arch: string;
  uuid: Buffer;
}

export interface MachOUuidRewriteResult {
  buffer: Buffer;
  changed: boolean;
  uuids: MachOSliceUuid[];
}

export interface MachOUuidFileResult {
  changed: boolean;
  uuids: MachOSliceUuid[];
}

export function deriveMachOUuid(appId: string, arch: string): Buffer;
export function formatUuid(uuid: Uint8Array): string;
export function rewriteMachOUuid(source: Uint8Array, options: MachOUuidOptions): MachOUuidRewriteResult;
export function rewriteMachOUuidFile(filePath: string, options: MachOUuidOptions): Promise<MachOUuidFileResult>;
