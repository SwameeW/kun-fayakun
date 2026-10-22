import { createApp } from './core/app';
import { readLaunchParams } from './core/params';
import { createI18n } from './i18n';
import { mountUI } from './ui';

/** Last-resort message when the UI itself cannot start. Plain text only, never scripture. */
function showFatal(root: HTMLElement | null, err: unknown): void {
  console.error('[main] Startup failed', err);
  const box = document.createElement('p');
  box.setAttribute('role', 'alert');
  box.dataset.testid = 'error';
  box.textContent = 'Kun Fayakun could not start in this browser. Please reload the page or try a current browser.';
  Object.assign(box.style, {
    position: 'fixed',
    insetInline: '16px',
    insetBlockStart: '40%',
    margin: '0',
    color: '#f2efe8',
    font: '16px/1.5 system-ui, sans-serif',
    textAlign: 'center',
  } satisfies Partial<CSSStyleDeclaration>);
  (root ?? document.body).replaceChildren(box);
}

async function main(): Promise<void> {
  const canvas = document.querySelector('#scene');
  const root = document.querySelector('#ui');
  if (!(canvas instanceof HTMLCanvasElement) || !(root instanceof HTMLElement)) {
    throw new Error('index.html must contain canvas#scene and #ui');
  }
  const params = readLaunchParams();
  const i18n = await createI18n('en');
  const app = createApp({ canvas, i18n, params });
  // UI first: the intro overlay is the first visual while the renderer and data initialise.
  mountUI(app, root);
  await app.start({ autoplay: params.autoplay });
}

main().catch((err: unknown) => {
  showFatal(document.querySelector<HTMLElement>('#ui'), err);
});
