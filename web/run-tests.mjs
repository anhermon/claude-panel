// Entry point so that `node --test web/` works: Node 22 runs a directory argument as a program (via the "main" in
// web/package.json) instead of searching it for tests. This imports every *.test.mjs next to it, so a new test file
// is picked up without editing anything. `node --test web/*.test.mjs` runs the same tests, one process per file.
import { readdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const file of readdirSync(here).filter((f) => f.endsWith('.test.mjs') && f !== basename(import.meta.url)).sort()) {
  await import(pathToFileURL(`${here}/${file}`).href);
}
