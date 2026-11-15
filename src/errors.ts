/**
 * Fixed-code errors. Messages never carry raw input, paths or payload
 * excerpts; the CLI prints only `code` (and an optional fixed-vocabulary
 * `layer`).
 */

/** Exit status 1: conflict or operational failure. Exit status 2: invalid input or invocation. */
export type ExitClass = 1 | 2;

export class ToolError extends Error {
  readonly code: string;
  readonly exit: ExitClass;
  readonly layer: string | undefined;

  constructor(code: string, exit: ExitClass = 2, layer?: string) {
    super(code);
    this.name = 'ToolError';
    this.code = code;
    this.exit = exit;
    this.layer = layer;
  }
}

/** Invalid input or invocation (exit 2). */
export function invalid(code: string, layer?: string): ToolError {
  return new ToolError(code, 2, layer);
}

/** Conflict or operational failure (exit 1). */
export function failure(code: string, layer?: string): ToolError {
  return new ToolError(code, 1, layer);
}
