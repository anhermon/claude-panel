// <p-compare before="a.png" after="b.png" before-label="Before" after-label="After" value="50"> - image comparison slider (a real <input type=range>: keyboard and screen-reader friendly).
import { PanelElement, sceneUrl, el } from './base.js';
import { clamp } from './pure.js';

const DEFAULT_POSITION = 50;

export class PCompare extends PanelElement {
  static observedAttributes = ['before', 'after', 'before-label', 'after-label', 'value'];

  async setup() {
    const before = this.getAttribute('before');
    const after = this.getAttribute('after');
    if (!before || !after) throw new Error('give it before="a.png" and after="b.png" (files in the scene folder)');
    const labels = [this.getAttribute('before-label') || 'Before', this.getAttribute('after-label') || 'After'];
    const img = (name, alt, cls) => el('img', { src: sceneUrl(name), alt, className: cls, draggable: false });
    const imgBefore = img(before, labels[0], 'p-compare-before');
    const imgAfter = img(after, labels[1], 'p-compare-after');
    const slider = el('input', { type: 'range', min: 0, max: 100, step: 1, className: 'p-compare-range' });
    slider.setAttribute('aria-label', `Slider between ${labels[0]} and ${labels[1]}`);
    const box = el('div', { className: 'p-compare-box' }, imgBefore, imgAfter,
      el('span', { className: 'p-compare-tag p-compare-tag-before', textContent: labels[0] }),
      el('span', { className: 'p-compare-tag p-compare-tag-after', textContent: labels[1] }),
      el('span', { className: 'p-compare-handle' }), slider);
    const set = (value) => {
      const pos = clamp(Number(value), 0, 100);
      slider.value = String(pos);
      box.style.setProperty('--p-pos', `${pos}%`);
      slider.setAttribute('aria-valuetext', `${Math.round(pos)}% ${labels[1]}`);
    };
    slider.addEventListener('input', () => set(slider.value));
    const fromPointer = (e) => { const r = box.getBoundingClientRect(); set(((e.clientX - r.left) / r.width) * 100); };
    box.addEventListener('pointerdown', (e) => { box.setPointerCapture(e.pointerId); fromPointer(e); slider.focus({ preventScroll: true }); });
    box.addEventListener('pointermove', (e) => { if (box.hasPointerCapture(e.pointerId)) fromPointer(e); });
    slider.addEventListener('keydown', (e) => {
      if (e.key.startsWith('Arrow')) e.stopPropagation(); // arrows move the slider, not a deck
    });
    set(this.getAttribute('value') ?? DEFAULT_POSITION);
    this.append(box);
    await this.until(new Promise((resolve, reject) => {
      imgBefore.onload = resolve;
      imgBefore.onerror = () => reject(new Error(`could not load ${before}`));
    }));
    box.style.aspectRatio = `${imgBefore.naturalWidth} / ${imgBefore.naturalHeight}`;
  }
}
