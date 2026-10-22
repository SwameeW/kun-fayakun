/**
 * Node's process, reached through globalThis so the browser-typed tsconfig
 * does not need @types/node (see node-fs.d.ts for why).
 */
interface NodeProcess {
  env: Record<string, string | undefined>;
  platform: string;
}

const nodeProcess = (globalThis as unknown as { process?: NodeProcess }).process;

export function env(name: string): string | undefined {
  return nodeProcess?.env[name];
}

/** True when the variable is set to "1". */
export function flag(name: string): boolean {
  return env(name) === '1';
}

export const platform: string = nodeProcess?.platform ?? 'unknown';
