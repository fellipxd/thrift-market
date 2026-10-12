import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Minimal .env loader for CLIs and workers (Next.js loads env files itself). Does not override set vars. */
export function loadEnvFile(startDir: string = process.cwd()): void {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const file = path.join(dir, '.env');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!m || line.trimStart().startsWith('#')) continue;
        const key = m[1]!;
        let value = m[2] ?? '';
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Repository root (directory containing pnpm-workspace.yaml), so relative paths mean the same thing in every process. */
export function repoRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}
