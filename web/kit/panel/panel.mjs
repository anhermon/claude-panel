// panel.mjs - ES-module face of the scene SDK (importmap specifier `panel`).
// The implementation lives in panel.js (a classic script, auto-injected). If it has not run yet we load the very same
// file next to this one, so there is only ever one `window.panel`.
async function loadClassic() {
  if (typeof document === 'undefined') throw new Error('panel: no window.panel and no document to load panel.js into');
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./panel.js', import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => reject(new Error('panel: panel.js failed to load'));
    (document.head || document.documentElement).append(script);
  });
}

if (!globalThis.panel || !globalThis.panel.sdk) await loadClassic();

const sdk = globalThis.panel;
export const { fit, emit, on, ready, data, canEmit } = sdk;
export default sdk;
