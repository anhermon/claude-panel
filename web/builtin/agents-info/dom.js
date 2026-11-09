// Tiny DOM helpers shared by the page modules (no framework): `h` makes an element with a class and text, `svg` an SVG element.
const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}
