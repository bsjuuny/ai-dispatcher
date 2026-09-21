import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(process.cwd(), 'src');
const ALLOWED_FILE = join('src', 'providers', 'http-client.ts');

/**
 * Source-level guard mirroring tests/security/dist-static-scan.test.ts's technique
 * (that one guards process spawning via the built dist/ output; this one guards
 * fetch() calls at the source level since fetch is a global, not an import ESLint's
 * no-restricted-imports can catch). Every .ts file under src/ except
 * providers/http-client.ts itself must not call the global fetch(). A bare `fetch(`
 * text match is intentionally broad (not just `= fetch(`) so a future refactor
 * can't quietly reintroduce a second HTTP call site by wrapping it differently.
 */
describe('source static scan: only providers/http-client.ts may call fetch()', () => {
  const files = listTsFiles(SRC_DIR);
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const relPath = file.slice(process.cwd().length + 1);
    if (relPath.replace(/\\/g, '/') === ALLOWED_FILE.replace(/\\/g, '/')) continue;

    it(`${relPath} does not call fetch()`, () => {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/\bfetch\s*\(/);
    });
  }
});

function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}
