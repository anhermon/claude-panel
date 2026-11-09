// <p-math display>E = mc^2</p-math>  or  <p-math tex="a &lt; b"> - KaTeX math; `display` makes it a centred block. Use tex="" for TeX that contains < or &.
import { PanelElement, ensureStylesheet, el } from './base.js';
import { dedent, flag } from './pure.js';

export class PMath extends PanelElement {
  static observedAttributes = ['tex', 'display'];

  async setup() {
    const tex = this.getAttribute('tex') ?? dedent(this.source);
    if (!tex.trim()) throw new Error('no TeX given (write it inside the tag or in tex="...")');
    const katex = (await this.until(import('katex'))).default;
    await this.until(ensureStylesheet(new URL('katex.min.css', import.meta.resolve('katex')).href));
    const host = el('span', { className: 'p-math-box' });
    const display = flag(this.getAttribute('display'));
    host.setAttribute('role', 'math');
    katex.render(tex, host, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', trust: false, strict: 'ignore' });
    this.dataset.display = display ? 'block' : 'inline';
    this.append(host);
  }
}
