/**
 * The root tsconfig types tests as browser code and deliberately leaves out
 * @types/node, whose globals (setTimeout returning NodeJS.Timeout, process)
 * would leak into src/. This declares the few Node APIs the tests and playwright.config.ts use.
 */
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
  /** Without an encoding Node returns a Buffer, which is a Uint8Array. */
  export function readFileSync(path: URL): Uint8Array;
  export function existsSync(path: string | URL): boolean;
}

declare module 'node:crypto' {
  /** A hash of bytes (the REBOUND fixture's input is pinned by its SHA-256). */
  export function createHash(algorithm: 'sha256'): { update(data: Uint8Array | string): { digest(encoding: 'hex'): string } };
}
