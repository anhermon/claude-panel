import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocument } from './fake-dom.mjs';
import { normalizeData } from './builtin/agents-info/agents-info-logic.mjs';
import { createList } from './builtin/agents-info/list-view.js';
import { createTicker } from './builtin/agents-info/ticker.js';
import { createDetail } from './builtin/agents-info/detail-view.js';
import { render as renderTickets } from './builtin/board/frames/tickets.js';

const RAW = 'T50: workflow-insight frame T65';
const SLUG = '01-slug-name';
const NOW = 1_767_000_000_000;
const TASK_WORDS = /workflow-insight frame/i;
const TICKET_TOKEN = /\bT\d+\b/i;
const SLUG_TOKEN = /^\d{2}-[a-z]/i;
const noop = () => {};

// Extend the existing fake DOM with the element APIs the scene renderers use. No layout or browser process.
function sceneDocument() {
  const doc = createDocument();
  const proto = Object.getPrototypeOf(doc.body);
  const nodeOf = (value) => {
    if (typeof value !== 'string') return value;
    const node = doc.createElement('span');
    node.textContent = value;
    return node;
  };
  proto.append = function (...values) { for (const value of values) this.appendChild(nodeOf(value)); };
  proto.prepend = function (...values) { for (const value of values.reverse()) this.insertBefore(nodeOf(value), this.firstChild); };
  proto.closest = function (tag) { for (let node = this; node; node = node.parentNode) if (node.tagName.toLowerCase() === tag) return node; return null; };
  proto.querySelector = function (selector) { return this.find((node) => selector.split(',').some((s) => (node.getAttribute('class') ?? node.className).split(/\s+/).includes(s.trim().slice(1)))); };
  Object.defineProperty(proto, 'nextElementSibling', { configurable: true, get() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; } });
  doc.byId.set('g-head', doc.createElement('div'));
  return doc;
}

const cleanDOM = (root) => {
  for (const node of root.walk()) {
    for (const text of [node.textContent, node.title ?? '', node.getAttribute('title') ?? '', node.getAttribute('aria-label') ?? '']) {
      assert.doesNotMatch(text, TICKET_TOKEN);
      assert.doesNotMatch(text, SLUG_TOKEN);
    }
  }
};

test('list, detail header, ticker and ticket rows render plain titles, including tooltips', () => {
  const saved = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver, matchMedia: globalThis.matchMedia };
  const doc = sceneDocument();
  globalThis.document = doc;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const data = normalizeData({ agents: [{ id: 'worker', name: RAW, title: RAW, state: 'working', startedAt: NOW, ticket: { id: 'T63', title: RAW, text: RAW } }] });
    const listRoot = doc.createElement('ol');
    const list = createList(listRoot, doc.createElement('div'), { onSelect: noop, onHover: noop });
    list.update(data.agents, NOW);
    assert.match(listRoot.textContent, TASK_WORDS);
    cleanDOM(listRoot);
    list.update([{ ...data.agents[0], name: SLUG, ticket: null }], NOW);
    cleanDOM(listRoot);

    const detailRoot = doc.createElement('div');
    const detail = createDetail(detailRoot, { emit: noop, onClose: noop });
    detail.open(data.agents[0]);
    cleanDOM(detailRoot);
    detail.close();

    const tickerRoot = doc.createElement('ol');
    const ticker = createTicker(tickerRoot, { colorOf: () => '' });
    ticker.push([{ agent: 'worker', kind: 'work', text: RAW }]);
    cleanDOM(tickerRoot);
    ticker.dispose();

    const ticketRoot = doc.createElement('div');
    renderTickets(ticketRoot, { items: [{ id: 'T63', title: RAW, dependsOn: [SLUG, 'T65'] }, { id: SLUG }] }, { onDispose: noop });
    assert.match(ticketRoot.textContent, TASK_WORDS);
    cleanDOM(ticketRoot);
  } finally {
    Object.assign(globalThis, saved);
  }
});
