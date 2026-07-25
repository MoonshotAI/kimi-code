export interface ExtensionHostSmokeOptions {
  version?: string;
  vsixPath?: string;
  cachePath?: string;
}

export interface ExtensionHostSmokeResult {
  version: string;
  vscodeVersion: string;
  vsixPath: string;
  cachePath: string;
}

export function runExtensionHostSmoke(
  options?: ExtensionHostSmokeOptions,
): Promise<ExtensionHostSmokeResult>;
