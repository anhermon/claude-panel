// form.js - form: text, number, select, slider, toggle fields and buttons. Emits panel.emit('form', {id, values, on}) on change/submit.
import { h, build, addCss } from './core.js';
import { coerceField, defaultFieldValue, normalizeOptions, toArray, isObj } from './pure.js';

export const FORM_EVENT = 'form';
const DEFAULT_FORM_ID = 'form';
const FIELD_TYPES = Object.freeze(['text', 'number', 'select', 'slider', 'toggle']);

addCss(`
.ui-form { display: flex; flex-direction: column; gap: 14px; }
.ui-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.ui-field-label { font-size: var(--ui-fs-s); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ui-mut); display: flex; justify-content: space-between; gap: 8px; }
.ui-field-hint { font-size: var(--ui-fs-s); color: var(--ui-mut); }
.ui-field-readout { color: var(--ui-fg); font-variant-numeric: tabular-nums; letter-spacing: 0; text-transform: none; }
.ui-input { font: inherit; color: var(--ui-fg); background: var(--ui-bg); border: 1px solid var(--ui-line-hi); border-radius: var(--ui-r-s); padding: 8px 10px; min-height: 40px; width: 100%; min-width: 0; }
.ui-input:focus-visible, .ui-btn:focus-visible, .ui-switch input:focus-visible + span { outline: 2px solid var(--ui-acc); outline-offset: 2px; }
.ui-range { width: 100%; accent-color: var(--ui-acc); min-height: 28px; }
.ui-switch { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; min-height: 40px; }
.ui-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.ui-switch-track { width: 42px; height: 24px; border-radius: 99px; background: var(--ui-line-hi); position: relative; transition: background .2s; flex: none; }
.ui-switch-track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--ui-fg); transition: transform .2s var(--ui-ease); }
.ui-switch input:checked + .ui-switch-track { background: var(--ui-acc); }
.ui-switch input:checked + .ui-switch-track::after { transform: translateX(18px); background: var(--ui-on-acc); }
.ui-switch-text { color: var(--ui-fg); }
.ui-buttons { display: flex; gap: 10px; flex-wrap: wrap; }
.ui-btn { font: inherit; font-weight: 600; cursor: pointer; color: var(--ui-fg); background: var(--ui-card-hi); border: 1px solid var(--ui-line-hi); border-radius: var(--ui-r-s); padding: 8px 16px; min-height: 40px; }
.ui-btn[data-primary] { background: var(--ui-acc); border-color: var(--ui-acc); color: var(--ui-on-acc); }
.ui-btn:disabled { opacity: .5; cursor: default; }
`);

const sig = (f) => JSON.stringify([f.type, f.options, f.min, f.max, f.step, f.placeholder, f.multiline]);

// One field's DOM. `control` is what holds the value; get()/set() convert to and from the typed value.
function makeField(f, send) {
  const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
  const label = h('span.ui-field-label');
  const hint = h('span.ui-field-hint');
  const wrap = h('div.ui-field', { dataset: { id: f.id } });
  const field = { ...f, type };
  let control;
  let readout = null;
  if (type === 'select') {
    control = h('select.ui-input', null, normalizeOptions(f.options).map((o) => h('option', { value: String(o.value) }, o.label)));
  } else if (type === 'toggle') {
    const text = h('span.ui-switch-text');
    control = h('input', { type: 'checkbox', role: 'switch' });
    const sw = h('label.ui-switch', null, control, h('span.ui-switch-track'), text);
    wrap.append(sw, hint);
    field.setLabel = (t) => { text.textContent = t; };
  } else {
    control = h('input', { type: type === 'slider' ? 'range' : type === 'number' ? 'number' : 'text', class: type === 'slider' ? 'ui-range' : 'ui-input' });
    if (type === 'slider') readout = h('span.ui-field-readout');
    for (const k of ['min', 'max', 'step', 'placeholder']) if (f[k] !== undefined) control.setAttribute(k, String(f[k]));
    if (type === 'slider') { if (f.min === undefined) control.min = '0'; if (f.max === undefined) control.max = '100'; }
  }
  if (type !== 'toggle') { label.append(f.label ?? f.id ?? ''); if (readout) label.append(readout); wrap.append(label, control, hint); }
  const read = () => coerceField(field, type === 'toggle' ? control.checked : control.value);
  const show = () => { if (readout) readout.textContent = `${control.value}${field.unit ?? ''}`; };
  const write = (v) => {
    if (type === 'toggle') control.checked = Boolean(v); else control.value = v === undefined || v === null ? '' : String(v);
    show();
  };
  if (type === 'slider') control.addEventListener('input', show);
  control.addEventListener('change', () => { show(); send('change', f.id); });
  return { wrap, control, type, sig: sig(f), read, write, field, setLabel: (t) => { if (type === 'toggle') field.setLabel(t); else { label.firstChild.textContent = t; } }, hint, unit: (u) => { field.unit = u; show(); } };
}

/**
 * form({id, fields: [{id, type: 'text'|'number'|'select'|'slider'|'toggle', label, value, options, min, max, step, unit, hint}],
 *       buttons: [{id, label, primary}], onChange(values), onSubmit(values, buttonId)})
 * Each change/submit emits panel.emit('form', {id, values, on: 'change'|'submit', field?, button?}). el.values() reads them.
 * update({fields}) patches labels/values in place and never overwrites a field the user is editing.
 * e.g. form({id: 'deploy', fields: [{id: 'env', type: 'select', options: ['dev', 'prod']}], buttons: [{id: 'go', label: 'Deploy', primary: true}]})
 */
export function form(opts = {}) {
  const fieldsBox = h('div.ui-form');
  const buttonsBox = h('div.ui-buttons');
  // A div, not a <form>: scenes are sandboxed without allow-forms, so a native submit is blocked (and logs an error).
  const primary = () => (api.opts().buttons ?? []).find((b) => b?.primary)?.id;
  const el = h('div', { role: 'form', onkeydown: (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && primary()) { e.preventDefault(); e.target.dispatchEvent(new Event('change', { bubbles: true })); send('submit', null, primary()); } } }, fieldsBox, buttonsBox);
  const fields = new Map();
  let api = null;
  const values = () => Object.fromEntries([...fields].map(([id, f]) => [id, f.read()]));
  function send(on, fieldId, buttonId) {
    const o = api.opts();
    const vals = values();
    const payload = { id: o.id ?? DEFAULT_FORM_ID, values: vals, on, ...(fieldId ? { field: fieldId } : {}), ...(buttonId ? { button: buttonId } : {}) };
    try { (o.emit ?? globalThis.panel?.emit)?.(FORM_EVENT, payload); } catch (err) { console.error(err); }
    if (on === 'change') o.onChange?.(vals, fieldId); else o.onSubmit?.(vals, buttonId);
  }
  api = build(el, 'form', opts, (o, prev) => {
    const list = toArray(o.fields).filter(isObj).map((f, i) => ({ ...f, id: String(f.id ?? `field${i}`) }));
    const live = new Set(list.map((f) => f.id));
    for (const [id, f] of fields) if (!live.has(id)) { f.wrap.remove(); fields.delete(id); }
    list.forEach((f, i) => {
      let entry = fields.get(f.id);
      if (entry && entry.sig !== sig(f)) { const keep = entry.read(); entry.wrap.remove(); fields.delete(f.id); entry = null; f.value = f.value ?? keep; }
      if (!entry) { entry = makeField(f, send); entry.write(defaultFieldValue(f)); fields.set(f.id, entry); }
      else {
        const before = prev ? toArray(prev.fields).find((p) => p && String(p.id) === f.id) : null;
        if (f.value !== undefined && (!before || before.value !== f.value) && document.activeElement !== entry.control) entry.write(f.value);
        else if (o.values?.[f.id] !== undefined && o.values !== prev?.values && document.activeElement !== entry.control) entry.write(o.values[f.id]);
      }
      entry.field.unit = f.unit;
      entry.unit(f.unit);
      entry.setLabel(f.label ?? f.id);
      entry.hint.textContent = f.hint ?? '';
      entry.hint.hidden = !f.hint;
      entry.control.disabled = Boolean(f.disabled || o.disabled);
      if (fieldsBox.childNodes[i] !== entry.wrap) fieldsBox.insertBefore(entry.wrap, fieldsBox.childNodes[i] ?? null);
    });
    if (!prev || o.buttons !== prev.buttons) {
      buttonsBox.replaceChildren(...toArray(o.buttons).filter(isObj).map((b) => h('button.ui-btn', { type: 'button', dataset: { id: b.id }, ...(b.primary ? { 'data-primary': '' } : {}),
        onclick: () => send('submit', null, b.id) }, b.label ?? b.id)));
    }
    buttonsBox.hidden = !toArray(o.buttons).length;
  });
  api.values = values;
  return api;
}
