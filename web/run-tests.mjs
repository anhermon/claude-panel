// Entry point so that `node --test web/` works: Node 22 runs a directory argument as a program (via the "main" in
// web/package.json) instead of searching it for tests. This re-runs `node --test` over every *.test.mjs next to it, one
// process per file (importing them all into one process lets assets.test.mjs's DOM patches break its neighbours), so a
// new test file is picked up without editing anything.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join(here, f));
const { NODE_TEST_CONTEXT, ...env } = process.env; // set by the outer runner; it would make the inner one a no-op child
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
process.exit(run.status ?? 1);
