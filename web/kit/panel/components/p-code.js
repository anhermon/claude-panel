// <p-code lang="js" src="file.js">code or leave empty with src</p-code> - syntax-highlighted code block (highlight.js, theme-aware).
import { PanelElement, fetchSceneFile, el } from './base.js';
import { dedent } from './pure.js';

export class PCode extends PanelElement {
  static observedAttributes = ['lang', 'src'];

  async setup() {
    const src = this.getAttribute('src');
    const text = src ? await this.until(fetchSceneFile(src)) : dedent(this.source);
    const lang = (this.getAttribute('lang') || '').toLowerCase();
    const code = el('code', { className: 'hljs' });
    code.textContent = text; // plain text first: the block is readable even if the highlighter fails
    const hljs = (await this.until(import('highlight.js'))).default;
    if (lang && hljs.getLanguage(lang)) {
      code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; // hljs escapes its input
      code.classList.add(`language-${lang}`);
    } else if (!lang) {
      const auto = hljs.highlightAuto(text);
      code.innerHTML = auto.value;
    }
    const pre = el('pre', {}, code);
    if (lang) pre.dataset.lang = lang;
    this.append(pre);
  }
}
