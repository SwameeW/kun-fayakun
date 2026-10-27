/**
 * "Model on this device" (docs/AI-INTELLIGENCE.md §1, §3 and §7): collapsed until the visitor opens
 * it, and nothing is downloaded until they press Download.
 * - What detection found, in plain words (WebGPU, the memory a model may use, the reasons).
 * - The suggested model, or a smaller one, or a larger one with a warning: its download size, the
 *   graphics memory it needs, its licence, where it comes from (Hugging Face sees the visitor's IP
 *   address), what it cannot do well, and that it stays stored in this browser.
 * - Download asks a second time on mobile data, with a data saver, or where the connection is
 *   unknown. Then a determinate progress bar (a status line spoken at most every tenth), preparing,
 *   ready; Cancel at any time; a failure in plain words with Try again.
 * - The browser's own model, only where detection says the browser has one.
 * - The models stored here with their sizes, each deletable; asking the browser to keep them.
 * - "Use the guide only".
 */
import type { App, I18n } from '../../core/types';
import { externalLink, h, uniqueId } from '../../ui/dom';
import { MODEL_TIERS } from '../engine/catalogue';
import type { AiOrchestrator } from '../index';
import type { CapabilityReport, EngineError, LoadProgress, ModelSpec } from '../types';
import { modelName } from './blocks';

export interface ModelSection {
  readonly element: HTMLDetailsElement;
}

/** The nodes that are there (replaceChildren takes no nulls). */
const present = (...nodes: Array<Node | null>): Node[] => nodes.filter((n): n is Node => n !== null);

/** Bytes for the visitor: gigabytes to one decimal, else megabytes. */
export function formatBytes(bytes: number, i18n: I18n): string {
  if (bytes >= 1e9) return i18n.t('ai.ui.bytes.gb', { value: i18n.number(bytes / 1e9, 1) });
  return i18n.t('ai.ui.bytes.mb', { value: i18n.number(Math.max(0, bytes) / 1e6, bytes >= 1e8 ? 0 : 1) });
}

const tierIndex = (m: ModelSpec): number => MODEL_TIERS.indexOf(m.tier);

export function createModelSection(app: App, ai: AiOrchestrator, announce: (text: string) => void): ModelSection {
  const { i18n } = app;
  const t = (key: string, values?: Record<string, string | number>): string => i18n.t(key, values);
  const button = (text: string, testId: string, primary = false): HTMLButtonElement =>
    h('button', { type: 'button', class: `kf-btn${primary ? ' kf-btn--primary' : ''}`, 'data-testid': testId }, text);

  const found = h('div', { class: 'kf-ai-found', 'data-testid': 'ai-found' }, h('p', { class: 'kf-muted' }, t('ai.ui.model.checking')));
  const choice = h('div', { class: 'kf-ai-choice', hidden: true });
  const loadArea = h('div', { class: 'kf-ai-load', hidden: true });
  const browserArea = h('div', { class: 'kf-ai-browser', hidden: true, 'data-testid': 'ai-browser-model' });
  const storedList = h('ul', { class: 'kf-ai-stored', 'data-testid': 'ai-stored' });
  const storedStatus = h('p', { class: 'kf-muted', 'data-testid': 'ai-stored-status' });
  const persistButton = button(t('ai.ui.model.persist'), 'ai-persist');
  const persistStatus = h('p', { class: 'kf-muted' });
  const guideButton = button(t('ai.ui.model.guide'), 'ai-use-guide');
  const engineStatus = h('p', { class: 'kf-ai-in-use', 'data-testid': 'ai-in-use' });
  const element = h(
    'details',
    { class: 'kf-ai-section', 'data-testid': 'ai-model' },
    h('summary', {}, t('ai.ui.model.title')),
    h(
      'div',
      { class: 'kf-ai-section-body' },
      h('p', {}, t('ai.ui.model.lead')),
      found,
      choice,
      loadArea,
      browserArea,
      h('h3', { class: 'kf-ai-subhead' }, t('ai.ui.model.stored')),
      storedList,
      storedStatus,
      h('div', { class: 'kf-ai-buttons' }, persistButton),
      persistStatus,
      engineStatus,
      h('div', { class: 'kf-ai-buttons' }, guideButton),
    ),
  );

  let report: CapabilityReport | null = null;
  let checking: Promise<void> | null = null;
  let suggested: ModelSpec | null = null;
  let candidates: readonly ModelSpec[] = [];
  /** Models whose every file is stored here: they load with no download. */
  let complete = new Set<string>();
  let loading: { controller: AbortController; name: string; decile: number; preparing: boolean } | null = null;
  /** The load under way now (read after an await: another may have replaced it meanwhile). */
  const current = (): typeof loading => loading;
  let lastError: EngineError | null = null;

  /* ---------------- what this device can run ---------------- */

  function showFound(r: CapabilityReport): void {
    const lines = [t(r.webgpu && !r.fallbackAdapter ? 'ai.ui.model.webgpuYes' : 'ai.ui.model.webgpuNo')];
    if (r.webgpu && r.budgetMB > 0) lines.push(t('ai.ui.model.budget', { size: formatBytes(r.budgetMB * 1e6, i18n) }));
    lines.push(r.deviceMemoryGB ? t('ai.ui.model.memory', { size: t('ai.ui.bytes.gb', { value: i18n.number(r.deviceMemoryGB, 1) }) }) : t('ai.ui.model.memoryUnknown'));
    for (const key of r.reasons) if (i18n.has(key)) lines.push(t(key));
    found.replaceChildren(h('p', { class: 'kf-ai-subhead' }, t('ai.ui.model.found')), h('ul', {}, ...lines.map((line) => h('li', {}, line))));
  }

  const select = h('select', { id: uniqueId('ai-model'), 'data-testid': 'ai-model-select' });
  const details = h('div', { class: 'kf-ai-model-details', 'data-testid': 'ai-model-details' });
  const download = button('', 'ai-download', true);
  const confirmArea = h('div', { class: 'kf-ai-confirm', role: 'group', hidden: true, 'data-testid': 'ai-metered' });

  const selected = (): ModelSpec | null => candidates.find((m) => m.id === select.value) ?? null;

  function showDetails(): void {
    const m = selected();
    confirmArea.hidden = true;
    if (!m) {
      details.replaceChildren();
      download.hidden = true;
      return;
    }
    const larger = suggested === null || tierIndex(m) > tierIndex(suggested);
    details.replaceChildren(
      ...present(larger ? h('p', { class: 'kf-ai-warning', 'data-testid': 'ai-larger' }, t('ai.ui.model.larger')) : null),
      h(
        'ul',
        { class: 'kf-ai-facts-list' },
        h('li', { 'data-testid': 'ai-model-size' }, t('ai.ui.model.size', { size: formatBytes(m.downloadBytes, i18n) })),
        h('li', {}, t('ai.ui.model.gpu', { size: formatBytes(m.vramMB * 1e6, i18n) })),
        h('li', { 'data-testid': 'ai-model-licence' }, t('ai.ui.model.licence'), ' ', externalLink(m.licence.url, m.licence.name)),
        h('li', { 'data-testid': 'ai-model-source' }, t('ai.ui.model.source')),
        h('li', {}, t('ai.ui.model.ip')),
        h('li', {}, t('ai.ui.model.stays')),
      ),
      h('p', { class: 'kf-ai-subhead' }, t('ai.ui.model.limits')),
      h('ul', { class: 'kf-ai-limits' }, ...m.limitKeys.map((key) => h('li', {}, t(key)))),
    );
    labelDownload();
  }

  /** "Use" for a model stored whole, else "Download and use". */
  function labelDownload(): void {
    const m = selected();
    download.hidden = m === null;
    if (m) download.textContent = t(complete.has(m.id) ? 'ai.ui.model.use' : 'ai.ui.model.download', { name: m.name });
  }

  function showChoice(r: CapabilityReport): void {
    const runs = r.webgpu && !r.fallbackAdapter;
    candidates = runs ? [...ai.host.catalogue()].filter((m) => m.needsF16 === r.f16).sort((a, b) => tierIndex(a) - tierIndex(b)) : [];
    suggested = r.recommended === 'none' ? null : (candidates.find((m) => m.tier === r.recommended) ?? null);
    if (candidates.length === 0) {
      choice.hidden = false;
      choice.replaceChildren(h('p', { 'data-testid': 'ai-suggested' }, t('ai.ui.model.none')));
      return;
    }
    select.replaceChildren(
      ...candidates.map((m) => h('option', { value: m.id }, t(m === suggested ? 'ai.ui.model.optionSuggested' : 'ai.ui.model.option', { name: m.name, size: formatBytes(m.downloadBytes, i18n) }))),
    );
    select.value = (suggested ?? candidates[0])?.id ?? '';
    choice.hidden = false;
    choice.replaceChildren(
      h('p', { class: 'kf-ai-suggested', 'data-testid': 'ai-suggested' }, suggested ? t('ai.ui.model.suggested', { name: suggested.name }) : t('ai.ui.model.none')),
      h('label', { class: 'kf-ai-field', for: select.id }, t('ai.ui.model.choose')),
      select,
      details,
      h('div', { class: 'kf-ai-buttons' }, download),
      confirmArea,
    );
    showDetails();
  }

  function showBrowser(r: CapabilityReport): void {
    const offered = r.browserModel === 'available' || r.browserModel === 'downloadable';
    browserArea.hidden = !offered;
    if (!offered) return;
    const use = button(t('ai.ui.model.browserUse'), 'ai-use-browser');
    use.addEventListener('click', () => {
      void start('browser', t('ai.engine.browser.name'));
    });
    browserArea.replaceChildren(
      ...present(
        h('h3', { class: 'kf-ai-subhead' }, t('ai.ui.model.browserTitle')),
        h('p', {}, t('ai.ui.model.browserNote')),
        r.browserModel === 'downloadable' ? h('p', { class: 'kf-ai-warning' }, t('ai.engine.browser.downloadable')) : null,
        h('div', { class: 'kf-ai-buttons' }, use),
      ),
    );
  }

  function check(): Promise<void> {
    checking ??= ai.host
      .detect()
      .then((r) => {
        report = r;
        showFound(r);
        showChoice(r);
        showBrowser(r);
      })
      .catch(() => {
        checking = null;
        found.replaceChildren(h('p', {}, t('ai.ui.model.webgpuNo')));
      });
    return checking;
  }

  select.addEventListener('change', showDetails);

  /* ---------------- download, progress, errors ---------------- */

  const fill = h('span', { class: 'kf-ai-progress-fill' });
  const bar = h('div', { class: 'kf-ai-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'data-testid': 'ai-progress' }, fill);
  const loadText = h('p', { class: 'kf-ai-load-text', 'data-testid': 'ai-load-status' });
  const cancel = button(t('ai.ui.model.cancel'), 'ai-download-cancel');
  const retry = button(t('ai.ui.model.retry'), 'ai-retry', true);
  let retryWith: (() => void) | null = null;

  function setBar(percent: number): void {
    bar.setAttribute('aria-valuenow', String(percent));
    fill.style.inlineSize = `${percent}%`;
  }

  function showLoading(name: string): void {
    loadArea.hidden = false;
    bar.setAttribute('aria-label', t('ai.ui.model.progressLabel', { name }));
    setBar(0);
    loadText.textContent = t('ai.ui.model.downloadingShort', { name, percent: 0 });
    loadArea.replaceChildren(bar, loadText, h('div', { class: 'kf-ai-buttons' }, cancel));
  }

  function showProgress(p: LoadProgress): void {
    if (!loading) return;
    const { name } = loading;
    if (p.phase === 'download') {
      const percent = Math.max(0, Math.min(100, Math.floor(p.fraction * 100)));
      setBar(percent);
      loadText.textContent = p.totalBytes > 0 ? t('ai.ui.model.downloading', { name, percent, loaded: formatBytes(p.loadedBytes, i18n), total: formatBytes(p.totalBytes, i18n) }) : t('ai.ui.model.downloadingShort', { name, percent });
      // Spoken at most once every tenth of the way, never with every byte.
      const decile = Math.floor(percent / 10);
      if (decile > loading.decile) {
        loading.decile = decile;
        announce(t('ai.ui.model.downloadingShort', { name, percent: decile * 10 }));
      }
    } else if (p.phase === 'compile' && !loading.preparing) {
      loading.preparing = true;
      setBar(100);
      loadText.textContent = t('ai.ui.model.preparing', { name });
      announce(loadText.textContent);
    }
  }

  function showEnd(text: string, testId: string, again: (() => void) | null): void {
    loadArea.hidden = false;
    retryWith = again;
    loadArea.replaceChildren(...present(h('p', { class: again ? 'kf-ai-error' : 'kf-ai-load-text', 'data-testid': testId }, text), again ? h('div', { class: 'kf-ai-buttons' }, retry) : null));
  }

  async function start(target: ModelSpec | 'browser', name: string): Promise<void> {
    loading?.controller.abort();
    const controller = new AbortController();
    loading = { controller, name, decile: 0, preparing: false };
    lastError = null;
    confirmArea.hidden = true;
    download.disabled = true;
    showLoading(name);
    try {
      await ai.use(target, controller.signal);
    } catch {
      // The engine's own event carries what went wrong.
    }
    if (current()?.controller !== controller) return;
    loading = null;
    download.disabled = false;
    const now = ai.engine();
    if (controller.signal.aborted) showEnd(t('ai.ui.model.cancelled'), 'ai-load-cancelled', null);
    else if (now.state === 'ready' && now.kind !== 'guide') {
      showEnd(t('ai.ui.model.ready', { name }), 'ai-load-ready', null);
      announce(t('ai.ui.model.ready', { name }));
    } else {
      // Set by the engine's event while the load ran.
      const error = lastError as EngineError | null;
      const message = error && i18n.has(error.messageKey) ? t(error.messageKey) : t('ai.engine.error.unknown');
      showEnd(message, 'ai-model-error', () => {
        void start(target, name);
      });
      announce(message);
    }
    showEngine();
    void refreshStored();
  }

  retry.addEventListener('click', () => {
    retryWith?.();
  });
  cancel.addEventListener('click', () => {
    loading?.controller.abort();
  });

  download.addEventListener('click', () => {
    const m = selected();
    if (!m || !report) return;
    // A second question before a large download on mobile data, with a data saver, or where the browser cannot say.
    if (!complete.has(m.id) && (report.metered !== false || report.saveData)) {
      const known = report.metered === true || report.saveData;
      const go = button(t('ai.ui.model.confirm'), 'ai-metered-confirm', true);
      const no = button(t('ai.ui.model.notNow'), 'ai-metered-cancel');
      go.addEventListener('click', () => {
        void start(m, m.name);
      });
      no.addEventListener('click', () => {
        confirmArea.hidden = true;
        download.focus();
      });
      const text = h('p', { id: uniqueId('ai-metered') }, t(known ? 'ai.ui.model.metered' : 'ai.ui.model.maybeMetered', { name: m.name, size: formatBytes(m.downloadBytes, i18n) }));
      confirmArea.setAttribute('aria-labelledby', text.id);
      confirmArea.replaceChildren(text, h('div', { class: 'kf-ai-buttons' }, go, no));
      confirmArea.hidden = false;
      go.focus();
      return;
    }
    void start(m, m.name);
  });

  ai.events.on('engine', (e) => {
    if (e.state === 'error') lastError = e.error ?? null;
    if (e.state === 'loading' && e.progress) showProgress(e.progress);
    if (e.state !== 'loading') showEngine();
  });

  /* ---------------- what is stored, and the guide ---------------- */

  function showEngine(): void {
    const e = ai.engine();
    engineStatus.textContent =
      e.kind === 'guide' || e.state === 'error' ? t('ai.ui.model.usingGuide') : t('ai.ui.model.inUse', { name: e.kind === 'browser' ? t('ai.engine.browser.name') : e.kind === 'scripted' ? t('ai.ui.engine.scripted') : modelName(e.model) });
  }

  async function refreshStored(): Promise<void> {
    const list = await ai.host.stored().catch(() => []);
    complete = new Set(list.filter((s) => (s as { complete?: boolean }).complete !== false).map((s) => s.id));
    storedStatus.textContent = list.length === 0 ? t('ai.ui.model.storedNone') : '';
    storedList.replaceChildren(
      ...list.map((s) => {
        const name = modelName(s.id);
        const remove = h('button', { type: 'button', class: 'kf-btn', 'aria-label': t('ai.ui.model.deleteLabel', { name }), 'data-testid': 'ai-delete' }, t('ai.ui.model.delete'));
        remove.addEventListener('click', () => {
          remove.disabled = true;
          void (async () => {
            if (ai.engine().model === s.id) await ai.use('guide');
            await ai.host.remove(s.id);
            storedStatus.textContent = t('ai.ui.model.deleted', { name });
            announce(storedStatus.textContent);
            await refreshStored();
            storedStatus.textContent = t('ai.ui.model.deleted', { name });
          })();
        });
        const partial = (s as { complete?: boolean }).complete === false;
        return h('li', { 'data-model': s.id }, h('span', {}, t(partial ? 'ai.ui.model.storedPartial' : 'ai.ui.model.storedItem', { name, size: formatBytes(s.bytes, i18n) })), remove);
      }),
    );
    labelDownload();
  }

  persistButton.addEventListener('click', () => {
    persistButton.disabled = true;
    void ai.host.persist().then((ok) => {
      persistStatus.textContent = t(ok ? 'ai.ui.model.persistYes' : 'ai.ui.model.persistNo');
      persistButton.disabled = false;
    });
  });

  guideButton.addEventListener('click', () => {
    loading?.controller.abort();
    void ai.use('guide').then(showEngine);
  });

  element.addEventListener('toggle', () => {
    if (!element.open) return;
    showEngine();
    void check();
    void refreshStored();
  });

  return { element };
}
