"use strict";
(function () {
// Browser mirror of hooks/agent-names.ts. Keep in sync via web/plain-title.test.mjs.
const LEADING_TICKET = /^T\d+\b[\s·:.—–-]*/i
const SLUG_ID = /\b\d+[-_]([A-Za-z][\w-]*)/g
const SLUG_SEPARATORS = /[-_]+/g
const LOOSE_TICKET = /\bT\d+\b/gi
const TITLE_SEPARATORS = /^[\s·:,.—–-]+|[\s·:,.—–-]+$/g
const TRAILING_ROUTING = /\s*\(\s*[a-z0-9._-]+(?:\/[a-z0-9._-]+){1,2}\s*\)\s*$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

const capitalise = (s) => (s === '' ? s : s[0].toUpperCase() + s.slice(1))

/** Strip bookkeeping before any display cap. Slug titles are humanised; ordinary titles may keep their casing. */
function plainTitle(text, capitaliseTitle = true) {
  const flat = (typeof text === 'string' ? text : '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const hasSlug = flat.search(SLUG_ID) >= 0
  const body = flat.replace(TRAILING_ROUTING, '').replace(LEADING_TICKET, '').replace(LOOSE_TICKET, '')
    .replace(SLUG_ID, (_, words) => words.replace(SLUG_SEPARATORS, ' '))
    .replace(TITLE_SEPARATORS, '').replace(/\s+/g, ' ').trim()
  return capitaliseTitle || hasSlug ? capitalise(body) : body
}


  globalThis.PanelTitles = { plainTitle };
})();
