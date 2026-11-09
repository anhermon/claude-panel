/* panel.js - the scene SDK. CLASSIC script (auto-injected by the panel server); defines window.panel.
 *   panel.fit(height?)      tell the host how tall this scene is (clamped 120..1200)
 *   panel.emit(name, data)  send a message to Claude/the host (name [a-z0-9._-]{1,40}, data JSON <= 2 KB)
 *   panel.on(name, fn)      listen to host messages {type:'panel-host', name, data}; returns an unsubscribe fn
 *   panel.ready()           Promise: DOM parsed + fonts loaded; also reports the height once
 *   panel.data(cb, opts)    poll live/data.json (written by the `scene` tool's `data`): cb(value) on the first read and
 *                           whenever the JSON changed; opts.every ms (250..10000, default 1000); returns stop();
 *                           panel.data.last() is the last value. Pauses while the document is hidden.
 *   panel.canEmit()         false once the host said it has no return channel (host message channel {emit:false}: the terminal
 *                           pane's workspace page only shows scenes); true by default and in the browser page
 * Host message names: key {key}, visible {visible}, theme {dark}, channel {emit}. No storage; the only network is live/data.json.
 * Safe to run twice. */
(function () {
  'use strict';
  if (window.panel && window.panel.sdk) return;

  var NAME_RE = /^[a-z0-9._-]{1,40}$/;
  var MAX_DATA_BYTES = 2048;
  var CLIP_STEP_CHARS = 64; // preview shrinks by this much per attempt when data is too large
  var FIT_MIN = 120;
  var FIT_MAX = 1200;
  var MSG_EMIT = 'panel-emit';
  var MSG_FIT = 'panel-fit';
  var MSG_HOST = 'panel-host';
  var THEME_EVENT = 'theme';
  var CHANNEL_EVENT = 'channel';
  var DATA_URL = 'live/data.json';
  var DATA_EVERY_DEFAULT = 1000;
  var DATA_EVERY_MIN = 250;
  var DATA_EVERY_MAX = 10000;

  function bytes(text) { return new TextEncoder().encode(text).length; }

  function post(message) {
    try { window.parent.postMessage(message, '*'); } catch (err) { console.error('panel: postMessage failed', err); }
  }

  // Returns {data} (a JSON-safe copy, <= MAX_DATA_BYTES) or {error}. Oversized data is replaced by a valid-JSON
  // preview {clipped:true, bytes, json:<prefix>} so Claude can see that something was cut.
  function pack(data) {
    var json;
    try { json = JSON.stringify(data === undefined ? null : data); } catch (err) { return { error: 'data is not JSON-serialisable' }; }
    if (json === undefined) json = 'null';
    var size = bytes(json);
    if (size <= MAX_DATA_BYTES) return { data: JSON.parse(json) };
    var keep = Math.floor(MAX_DATA_BYTES / 2);
    var out;
    do {
      out = { clipped: true, bytes: size, json: json.slice(0, keep) };
      keep -= CLIP_STEP_CHARS;
    } while (keep > 0 && bytes(JSON.stringify(out)) > MAX_DATA_BYTES);
    return { data: out };
  }

  function fit(height) {
    var el = document.documentElement;
    var body = document.body;
    var h = typeof height === 'number' ? height : Math.max(el.scrollHeight, body ? body.scrollHeight : 0);
    if (!isFinite(h)) h = FIT_MIN;
    post({ type: MSG_FIT, height: Math.min(FIT_MAX, Math.max(FIT_MIN, Math.ceil(h))) });
  }

  function emit(name, data) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      console.error('panel.emit: name must match ' + NAME_RE + ', got ' + JSON.stringify(name));
      return false;
    }
    var packed = pack(data);
    if (packed.error) { console.error('panel.emit: ' + packed.error); return false; }
    post({ type: MSG_EMIT, name: name, data: packed.data });
    return true;
  }

  function on(name, fn) {
    function handler(ev) {
      var msg = ev.data;
      if (ev.source !== window.parent || !msg || msg.type !== MSG_HOST || msg.name !== name) return;
      try { fn(msg.data); } catch (err) { console.error(err); }
    }
    window.addEventListener('message', handler);
    return function off() { window.removeEventListener('message', handler); };
  }

  function ready() {
    return new Promise(function (resolve) {
      function done() {
        var fonts = document.fonts && document.fonts.ready;
        Promise.resolve(fonts).then(function () { fit(); resolve(); });
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', done, { once: true });
      else done();
    });
  }

  var lastData;

  // Ms between polls: the default for anything that is not a finite number, else clamped.
  function clampEvery(ms) {
    var n = Number(ms);
    return isFinite(n) && ms !== null && ms !== '' ? Math.min(DATA_EVERY_MAX, Math.max(DATA_EVERY_MIN, n)) : DATA_EVERY_DEFAULT;
  }

  function data(cb, opts) {
    var every = clampEvery(opts && opts.every);
    var timer = null;
    var busy = false;
    var stopped = false;
    var seen = null; // the JSON text this subscription last delivered

    function schedule() {
      if (stopped || document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(tick, every);
    }
    function deliver(text) {
      var value;
      try { value = JSON.parse(text); } catch (err) { return; } // half-written or invalid: keep the last value
      if (text === seen) return;
      seen = text;
      lastData = value;
      try { cb(value); } catch (err) { console.error(err); }
    }
    function tick() {
      timer = null;
      if (stopped || document.hidden || busy) return;
      busy = true;
      Promise.resolve()
        .then(function () { return fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' }); })
        .then(function (res) { return res && res.ok ? res.text() : null; }) // 404: nothing written yet
        .then(function (text) { if (text !== null && !stopped) deliver(text); })
        .catch(function () {})
        .then(function () { busy = false; schedule(); });
    }
    function onVisibility() {
      if (document.hidden) { clearTimeout(timer); timer = null; } else if (!busy && !timer) tick();
    }

    document.addEventListener('visibilitychange', onVisibility);
    tick();
    return function stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }
  data.last = function () { return lastData; };

  var emitReaches = true; // a host that cannot receive events says so once, with the channel message

  window.panel = Object.freeze({ sdk: 1, fit: fit, emit: emit, on: on, ready: ready, data: data, canEmit: function () { return emitReaches; } });

  on(CHANNEL_EVENT, function (d) { emitReaches = !(d && d.emit === false); });

  // The host owns the theme: it may force light/dark (overrides prefers-color-scheme in panel.css).
  on(THEME_EVENT, function (d) { document.documentElement.setAttribute('data-theme', d && d.dark ? 'dark' : 'light'); });
})();
