// css.js - load a frame module's own stylesheet once (the module's top level awaits it, so the first fit measures styled nodes).
import { h } from './dom.js';

const CSS_WAIT_MS = 1500; // a stylesheet that never reports is not waited for

/** Adds <link rel=stylesheet href=url> once per `name`; resolves when it loaded, failed, or CSS_WAIT_MS passed. */
export async function loadCssOnce(url, name) {
  if (typeof document === 'undefined' || document.querySelector(`link[data-css="${name}"]`)) return;
  const link = h('link', { rel: 'stylesheet', href: url, 'data-css': name });
  const loaded = new Promise((done) => { link.onload = done; link.onerror = done; });
  document.head.append(link);
  await Promise.race([loaded, new Promise((done) => setTimeout(done, CSS_WAIT_MS))]);
}
