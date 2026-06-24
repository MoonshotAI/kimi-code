export interface Violation {
  file: string;
  line: number;
  message: string;
}

export const SRC_ROOT: string;

export function checkSource(source: string, absFile: string): Violation[];
export function checkFile(absFile: string): Violation[];
