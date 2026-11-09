// The vendored kit: libraries and house files under a kit directory (default `<web>/kit`), served at
// `GET /<token>/kit/<relpath>` and exposed to scenes through the importmap that scene-doc.mjs injects.
//
// Layout (written by other tasks, see the spec's v4 section): `<kit>/manifest.json` =
//   { version: 1, libs: [{ id, imports: { "<bare specifier>": "<relpath under kit/>" }, prefixes?: { "<specifier prefix/>": "<dir relpath/>" }, ... }] }
// and house code in `<kit>/panel/` (panel.js classic SDK, panel.mjs module facade, deck.js, components.js, panel.css)
// and `<kit>/ui/` (the `panel/ui` component library: index.js re-exports one file per component).
//
// Serving rules are the scene-file rules (scene-files.mjs: dot segments, realpath containment, symlink escapes,
// extension allow-list, Range) with a smaller allow-list (KIT_FILE_TYPES), ACAO `*` (module scripts and fonts are
// cross-origin from the sandboxed frame's opaque origin), CORP cross-origin, no scene CSP, short public caching.
// Kit files are trusted vendored code, but a kit .html file still gets `CSP: sandbox` so opening one at top level
// cannot run with the panel page's origin.
import fs from 'node:fs';
import path from 'node:path';
import { SCENE_FILE_TYPES, decodeSegments, handleDirRequest } from './scene-files.mjs';

export const KIT_SEGMENT = 'kit';
export const MANIFEST_FILE = 'manifest.json';
const KIT_EXTENSIONS = ['html', 'css', 'js', 'mjs', 'json', 'woff2'];
export const KIT_FILE_TYPES = Object.freeze(Object.fromEntries(KIT_EXTENSIONS.map((e) => [e, SCENE_FILE_TYPES[e]])));
export const KIT_CACHE_CONTROL = 'public, max-age=3600';
const DOCUMENT_EXTENSIONS = new Set(['html', 'htm']);
const SANDBOX_CSP = 'sandbox allow-scripts';

/** House specifiers: server constants (a manifest can never redefine them). Values are relpaths under the kit dir. */
export const HOUSE_IMPORTS = Object.freeze({
  panel: 'panel/panel.mjs',
  'panel/deck': 'panel/deck.js',
  'panel/components': 'panel/components.js',
  'panel/ui': 'ui/index.js',
  'panel/diagrams': 'diagrams/diagram.js',
  'panel/assets': 'assets/index.js',
});
/** Prefix mappings used when no lib in the manifest declares the same prefix. */
export const DEFAULT_PREFIXES = Object.freeze({ 'three/addons/': 'three/examples/jsm/' });

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const warned = new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  process.stderr.write(`panel server: ${message}\n`);
}

// A relpath is usable when it is plain `a/b/c.js` (or `a/b/` for a prefix): no empty, dot or backslash segments.
function safeRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const segments = rel.replace(/\/$/, '').split('/');
  return segments.every((seg) => seg !== '' && !seg.startsWith('.') && !seg.includes('\\') && !seg.includes('\0'));
}

/** Specifier -> absolute URL map entries from one `imports`/`prefixes` object; unusable entries are dropped. */
function collect(into, source, urlBase, { prefix }) {
  if (!isObj(source)) return;
  for (const [specifier, rel] of Object.entries(source)) {
    if (specifier === '' || !safeRelPath(rel) || (prefix && !(specifier.endsWith('/') && rel.endsWith('/')))) continue;
    into[specifier] = urlBase + rel.split('/').map(encodeURIComponent).join('/');
  }
}

/**
 * The `imports` object of the kit importmap (absolute URLs under `kitUrl`, e.g. `/<token>/kit/`).
 * Manifest missing or invalid -> only the house specifiers, and ONE warning on stderr (per distinct problem).
 * Never throws. Read at call time so a kit that is vendored while the server runs is picked up.
 */
export async function loadKitImports(kitDir, kitUrl) {
  const imports = {};
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.promises.readFile(path.join(kitDir, MANIFEST_FILE), 'utf8'));
    if (!isObj(manifest) || !Array.isArray(manifest.libs)) throw new Error('"libs" is not an array');
  } catch (err) {
    manifest = null;
    warnOnce(`kit manifest ${path.join(kitDir, MANIFEST_FILE)} unusable (${err && err.code ? err.code : err.message}); injecting only the house import specifiers`);
  }
  if (manifest) {
    const libs = manifest.libs.filter(isObj);
    const declared = {};
    for (const lib of libs) {
      collect(imports, lib.imports, kitUrl, { prefix: false });
      collect(declared, lib.prefixes, kitUrl, { prefix: true });
    }
    collect(imports, DEFAULT_PREFIXES, kitUrl, { prefix: true });
    Object.assign(imports, declared); // the manifest's own prefix wins over the built-in fallback
  }
  collect(imports, HOUSE_IMPORTS, kitUrl, { prefix: false }); // last: house specifiers cannot be hijacked
  return imports;
}

/** `{ url, importMap(), handle(req, res, restSegments) }` for one kit directory and token. */
export function createKit({ dir, token }) {
  const url = `/${token}/${KIT_SEGMENT}/`;
  const baseHeaders = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': KIT_CACHE_CONTROL,
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
  };
  return {
    url,
    importMap: () => loadKitImports(dir, url),
    /** `restSegments`: raw segments after `/kit/`. */
    handle: (req, res, restSegments) => {
      const decoded = decodeSegments(restSegments) || []; // undecodable -> the request is a 404 anyway
      const ext = path.extname(decoded[decoded.length - 1] || '').slice(1).toLowerCase();
      const headers = DOCUMENT_EXTENSIONS.has(ext) ? { ...baseHeaders, 'content-security-policy': SANDBOX_CSP } : baseHeaders;
      return handleDirRequest(req, res, { dir, restSegments, roots: null, types: KIT_FILE_TYPES, headers });
    },
  };
}
