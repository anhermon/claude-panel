// <p-audio src="clip.m4a" title="..." wave> - audio player for a file in the scene folder: Play button, canvas with live
// level bars (default) or the file's waveform with a seekable playhead (wave). Never autoplays: it says "Press play" and waits.
import { PanelElement, cssVar, sceneUrl, fetchSceneFile, el } from './base.js';
import { flag, formatTime, peaks, clamp, WAVE_BUCKETS } from './pure.js';

const MAX_WAVE_BYTES = 24 * 1024 * 1024; // do not decode bigger files just to draw a waveform
const FFT_SIZE = 128;
const LEVEL_BARS = 32;
const SEEK_STEP_SECONDS = 5;
const CANVAS_HEIGHT = 72;
const BAR_GAP = 3;
const MIN_BAR = 3;
const STATUS = { idle: 'Press play', playing: 'Playing', paused: 'Paused', ended: 'Finished - press play to replay', error: 'This file cannot be played' };

export class PAudio extends PanelElement {
  static observedAttributes = ['src', 'title', 'wave'];

  async setup() {
    const src = this.getAttribute('src');
    if (!src) throw new Error('give it src="file.m4a" (a file in the scene folder)');
    const wave = flag(this.getAttribute('wave'));
    const title = this.getAttribute('title') || '';

    const audio = new Audio();
    audio.preload = 'metadata';
    audio.crossOrigin = 'anonymous'; // the scene is an opaque origin: without CORS the analyser would read silence
    audio.src = sceneUrl(src);

    const button = el('button', { type: 'button', className: 'p-btn p-audio-play', textContent: '▶' });
    const canvas = el('canvas', { className: 'p-audio-canvas', height: CANVAS_HEIGHT });
    const status = el('span', { className: 'p-audio-status', textContent: STATUS.idle });
    const time = el('span', { className: 'p-audio-time', textContent: '0:00' });
    status.setAttribute('aria-live', 'polite');
    const label = title || 'audio';
    button.setAttribute('aria-label', `Play ${label}`);
    if (wave) { // keyboard + pointer seeking
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'slider');
      canvas.setAttribute('aria-label', `Seek ${label}`);
    }
    const main = el('div', { className: 'p-audio-main' },
      title ? el('div', { className: 'p-audio-title', textContent: title }) : '', canvas, el('div', { className: 'p-audio-meta' }, status, time));
    const box = el('div', { className: 'p-audio-box', role: 'group' }, button, main);
    box.setAttribute('aria-label', label);
    this.append(box);

    const g = canvas.getContext('2d');
    let width = 0;
    let ratio = 1;
    let bars = new Array(WAVE_BUCKETS).fill(0.08);
    let analyser = null;
    let ctx = null;
    let frame = 0;
    let state = 'idle';

    const setState = (next) => {
      state = next;
      status.textContent = STATUS[next];
      const playing = next === 'playing';
      button.textContent = playing ? '❚❚' : '▶';
      button.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${label}`);
      cancelAnimationFrame(frame);
      if (playing) loop();
      else draw();
    };
    const progress = () => (audio.duration ? audio.currentTime / audio.duration : 0);

    function draw() {
      const fg = cssVar('--panel-fg', '#ecebe8');
      const accent = cssVar('--panel-accent', '#7aa2ff');
      const line = cssVar('--panel-line', '#2f2d2a');
      g.clearRect(0, 0, canvas.width, canvas.height);
      let heights = bars;
      if (!wave) {
        heights = new Array(LEVEL_BARS).fill(0);
        if (analyser && state === 'playing') {
          const data = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(data);
          heights = heights.map((_, i) => data[Math.floor((i / LEVEL_BARS) * data.length * 0.75)] / 255);
        }
      }
      const n = heights.length;
      const slot = canvas.width / n;
      const done = wave ? progress() : 1;
      heights.forEach((h, i) => {
        const bh = Math.max(MIN_BAR * ratio, h * canvas.height * 0.92);
        g.fillStyle = wave ? (i / n < done ? accent : line) : state === 'playing' ? accent : line;
        g.beginPath();
        g.roundRect(i * slot + (BAR_GAP * ratio) / 2, (canvas.height - bh) / 2, Math.max(1, slot - BAR_GAP * ratio), bh, 3 * ratio);
        g.fill();
      });
      if (wave && state !== 'idle') { g.fillStyle = fg; g.fillRect(Math.round(done * canvas.width) - ratio, 0, 2 * ratio, canvas.height); }
    }
    function loop() { draw(); frame = requestAnimationFrame(loop); }

    const resize = () => {
      ratio = devicePixelRatio || 1;
      width = Math.max(120, canvas.parentElement.clientWidth);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(CANVAS_HEIGHT * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${CANVAS_HEIGHT}px`;
      draw();
    };

    const connectAnalyser = () => {
      if (ctx) return;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        ctx.createMediaElementSource(audio).connect(analyser);
        analyser.connect(ctx.destination);
      } catch { analyser = null; } // no levels, but the sound still plays
    };
    const toggle = async () => {
      if (!audio.paused) { audio.pause(); return; }
      connectAnalyser();
      try { await ctx?.resume(); await audio.play(); } catch (err) {
        console.error('<p-audio> play() failed', err);
        setState('error');
      }
    };
    const seek = (to) => { if (audio.duration) { audio.currentTime = clamp(to, 0, audio.duration); draw(); } };

    button.addEventListener('click', toggle);
    audio.addEventListener('play', () => setState('playing'));
    audio.addEventListener('pause', () => { if (!audio.ended) setState(audio.currentTime > 0 ? 'paused' : 'idle'); });
    audio.addEventListener('ended', () => setState('ended'));
    audio.addEventListener('error', () => setState('error'));
    const updateTime = () => { time.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`; };
    audio.addEventListener('timeupdate', updateTime);
    audio.addEventListener('loadedmetadata', updateTime);
    if (wave) {
      canvas.addEventListener('pointerdown', (e) => { const r = canvas.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * audio.duration); });
      canvas.addEventListener('keydown', (e) => {
        const by = { ArrowRight: SEEK_STEP_SECONDS, ArrowLeft: -SEEK_STEP_SECONDS }[e.key];
        if (by === undefined) return;
        e.preventDefault();
        e.stopPropagation(); // arrows seek here, they must not also turn a deck page
        seek(audio.currentTime + by);
      });
      this.#decodeWave(src).then((p) => { bars = p; draw(); }, (err) => console.warn('<p-audio> no waveform:', err.message));
    }

    this.watchSize(resize);
    this.watchActive((active) => { if (!active) audio.pause(); }); // leaving the slide / hiding the frame stops the sound
    this.own(() => {
      cancelAnimationFrame(frame);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      ctx?.close().catch(() => {});
    });
    resize();
  }

  async #decodeWave(src) {
    const buffer = await fetchSceneFile(src, 'buffer');
    if (buffer.byteLength > MAX_WAVE_BYTES) throw new Error('file too large to draw a waveform');
    const offline = new OfflineAudioContext(1, 1, 44100); // decodes without a user gesture (a normal AudioContext would need one)
    const decoded = await offline.decodeAudioData(buffer);
    return peaks(decoded.getChannelData(0), WAVE_BUCKETS);
  }
}
