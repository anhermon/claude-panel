// Built-in scenes run in a sandboxed iframe (opaque origin): the server sends CORS headers only for scene files and the kit.
// An import that reaches a top-level page file (web/*.js) loads fine in node and silently blanks the scene in the browser.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const WEB = dirname(fileURLToPath(import.meta.url));
const SCENES = ['board', 'agents-info', 'pulse'];
const SOURCE = /\.(?:m?js)$/;
const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

const filesUnder = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? (name === 'fixtures' ? [] : filesUnder(path)) : SOURCE.test(name) && !name.endsWith('.test.mjs') ? [path] : [];
});
const inside = (path, root) => { const rel = relative(root, path); return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep); };

for (const scene of SCENES) test(`scene ${scene} imports only its own files and the kit`, () => {
  const root = join(WEB, 'builtin', scene);
  const kit = join(WEB, 'kit');
  for (const file of filesUnder(root)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(RELATIVE_IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const target = resolve(dirname(file), spec);
      assert.ok(inside(target, root) || inside(target, kit), `${relative(WEB, file)} imports ${spec}: outside the scene and the kit`);
    }
  }
});

test('kit modules import only kit files', () => {
  const kit = join(WEB, 'kit');
  for (const file of filesUnder(join(kit, 'panel'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      assert.ok(inside(resolve(dirname(file), spec), kit), `${relative(WEB, file)} imports ${spec}: outside the kit`);
    }
  }
});
