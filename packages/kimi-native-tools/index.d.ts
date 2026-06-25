export interface NativeReadOptions {
  lineOffset?: number;
  nLines?: number;
}

export interface NativeReadResult {
  content: string;
  lineCount: number;
  error?: string;
}

export interface NativeWriteOptions {
  mode?: 'overwrite' | 'append';
}

export interface NativeWriteResult {
  bytesWritten: number;
  error?: string;
}

export interface NativeEditOptions {
  replaceAll?: boolean;
}

export interface NativeEditResult {
  success: boolean;
  error?: string;
  replacements: number;
}

export interface NativeGrepOptions {
  path?: string;
  glob?: string;
  fileType?: string;
  outputMode?: 'content' | 'files_with_matches' | 'count_matches';
  caseInsensitive?: boolean;
  lineNumbers?: boolean;
  afterContext?: number;
  beforeContext?: number;
  context?: number;
  headLimit?: number;
  offset?: number;
  multiline?: boolean;
  includeIgnored?: boolean;
  timeoutMs?: number;
}

export interface NativeGrepResult {
  content: string;
  error?: string;
  matchCount: number;
  fileCount: number;
  filteredSensitive: string[];
  timedOut: boolean;
}

export interface NativeGlobOptions {
  path?: string;
  includeDirs?: boolean;
}

export interface NativeGlobResult {
  files: string[];
  error?: string;
  truncated: boolean;
}

export interface NativeListDirectoryOptions {
  path?: string;
  collapseHiddenDirs?: boolean;
}

export interface NativeListDirectoryResult {
  output: string;
  error?: string;
}

export interface NativeSniffImageDimensionsResult {
  width: number;
  height: number;
}

export interface NativeBashOptions {
  cwd?: string;
  timeout?: number;
  env?: Array<[string, string]>;
}

export interface NativeBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export declare function nativeRead(path: string, options?: NativeReadOptions): NativeReadResult;
export declare function nativeWrite(path: string, content: string, options?: NativeWriteOptions): NativeWriteResult;
export declare function nativeEdit(path: string, oldString: string, newString: string, options?: NativeEditOptions): NativeEditResult;
export declare function nativeGrep(pattern: string, options?: NativeGrepOptions): NativeGrepResult;
export declare function nativeGlob(pattern: string, options?: NativeGlobOptions): NativeGlobResult;
export declare function nativeListDirectory(options?: NativeListDirectoryOptions): NativeListDirectoryResult;
export declare function nativeSniffImageDimensions(data: Buffer | Uint8Array): NativeSniffImageDimensionsResult | null;
export declare function nativeBash(command: string, options?: NativeBashOptions): NativeBashResult;

export declare const READ_MAX_LINES: number;
export declare const READ_MAX_LINE_LENGTH: number;
export declare const READ_MAX_BYTES: number;
export declare const GLOB_MAX_MATCHES: number;
export declare const GREP_DEFAULT_HEAD_LIMIT: number;
export declare const BASH_DEFAULT_TIMEOUT: number;
export declare const BASH_MAX_TIMEOUT: number;
