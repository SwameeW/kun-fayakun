/**
 * The root tsconfig types tests as browser code and deliberately leaves out
 * @types/node, whose globals (setTimeout returning NodeJS.Timeout, process)
 * would leak into src/. This declares the few Node APIs the tests and playwright.config.ts use.
 */
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  /** Without an encoding Node returns a Buffer, which is a Uint8Array. */
  export function readFileSync(path: string | URL): Uint8Array;
  export function existsSync(path: string | URL): boolean;
  /** A directory's entries' names. */
  export function readdirSync(path: string | URL): string[];
  /** The real-model evaluation (tests/ai-eval) writes its raw results. */
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
}

declare module 'node:child_process' {
  /** git, for the main checkout's shared model store (scripts/ai-eval/store.ts). */
  export function execFileSync(file: string, args: readonly string[], options: { encoding: 'utf8'; cwd?: string }): string;
}

declare module 'node:os' {
  /** The evaluation records the machine's load beside every speed it measures. */
  export function loadavg(): number[];
  export function cpus(): { model: string }[];
  export function totalmem(): number;
  export function release(): string;
  export function arch(): string;
}

declare module 'node:crypto' {
  /** A hash of bytes (the REBOUND fixture's input is pinned by its SHA-256). */
  export function createHash(algorithm: 'sha256'): { update(data: Uint8Array | string): { digest(encoding: 'hex'): string } };
}

declare module 'node:zlib' {
  /** A zlib stream of bytes (the walk's PNG decoder is checked on files made with it). */
  export function deflateSync(data: Uint8Array): Uint8Array;
}

declare module 'node:buffer' {
  /** Node's Buffer, as route.fulfill takes a binary body (the walk's generated terrain tiles). */
  export const Buffer: { from(data: Uint8Array): Uint8Array };
}
