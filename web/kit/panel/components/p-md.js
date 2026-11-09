// <p-md>## Markdown inside the tag</p-md>  or  <p-md src="notes.md"> - Markdown (marked) through an allow-list sanitiser: no scripts, no on* attributes, no javascript: URLs.
import { PanelElement, fetchSceneFile } from './base.js';
import { dedent } from './pure.js';
import { sanitizeHtml } from './sanitize.js';

export class PMd extends PanelElement {
  static observedAttributes = ['src'];

  async setup() {
    const src = this.getAttribute('src');
    const text = src ? await this.until(fetchSceneFile(src)) : dedent(this.source);
    const { marked } = await this.until(import('marked'));
    const box = document.createElement('div');
    box.className = 'p-md-box';
    box.innerHTML = sanitizeHtml(marked.parse(text, { gfm: true, async: false }));
    this.append(box);
    this.#highlight(box);
  }

  /** Highlights fenced code blocks that name a language; silently skipped if highlight.js is unavailable. */
  async #highlight(box) {
    const blocks = [...box.querySelectorAll('pre > code[class*="language-"]')];
    if (!blocks.length) return;
    try {
      const hljs = (await this.until(import('highlight.js'))).default;
      for (const code of blocks) {
        const lang = /language-([\w-]+)/.exec(code.className)?.[1];
        if (lang && hljs.getLanguage(lang)) { code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value; code.classList.add('hljs'); }
      }
    } catch { /* plain code blocks are fine */ }
  }
}
