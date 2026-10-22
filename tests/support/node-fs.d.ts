/**
 * The root tsconfig types tests as browser code and deliberately leaves out
 * @types/node, whose globals (setTimeout returning NodeJS.Timeout, process)
 * would leak into src/. This declares the few Node APIs the tests and playwright.config.ts use.
 */
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
}
