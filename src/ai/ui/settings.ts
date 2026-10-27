/**
 * The assistant's settings: how much a model's explanations assume (plain, standard, deeper: one
 * line of the answer prompt), opt-in memory (off by default; says what is kept and where, and turning
 * it off deletes it), and clearing the conversation.
 */
import type { App } from '../../core/types';
import { h, uniqueId } from '../../ui/dom';
import { readPreferenceString, writePreferenceString } from '../../ui/preferences';
import type { AiOrchestrator } from '../index';
import type { ExplanationLevel } from '../types';

const LEVELS: readonly ExplanationLevel[] = ['plain', 'standard', 'deeper'];
/** The remembered level (a per-viewer convenience in localStorage). */
const LEVEL_PREFERENCE = 'aiLevel';

export interface Settings {
  readonly element: HTMLDetailsElement;
}

export function createSettings(app: App, ai: AiOrchestrator, announce: (text: string) => void, cleared: () => void): Settings {
  const { i18n } = app;
  const stored = readPreferenceString(LEVEL_PREFERENCE);
  if (stored && (LEVELS as readonly string[]).includes(stored)) ai.setLevel(stored as ExplanationLevel);

  const name = uniqueId('ai-level');
  const legendNote = h('p', { id: uniqueId('ai-level-note'), class: 'kf-muted' }, i18n.t('ai.ui.settings.levelNote'));
  const levels = h(
    'fieldset',
    { class: 'kf-ai-levels', 'aria-describedby': legendNote.id, 'data-testid': 'ai-level' },
    h('legend', {}, i18n.t('ai.ui.settings.level')),
    ...LEVELS.map((level) => {
      const input = h('input', { type: 'radio', name, value: level, 'data-testid': `ai-level-${level}` });
      input.checked = ai.level() === level;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        ai.setLevel(level);
        writePreferenceString(LEVEL_PREFERENCE, level);
      });
      return h('label', { class: 'kf-ai-choice-label' }, input, i18n.t(`ai.ui.settings.${level}`));
    }),
  );

  const memoryNote = h('p', { id: uniqueId('ai-memory-note'), class: 'kf-muted' }, i18n.t('ai.ui.settings.memoryNote'));
  const memory = h('input', { type: 'checkbox', 'aria-describedby': memoryNote.id, 'data-testid': 'ai-memory' });
  memory.checked = ai.memory.enabled();
  memory.addEventListener('change', () => {
    if (memory.checked) ai.memory.setEnabled(true);
    // Off deletes what was kept, as the note says.
    else void ai.memory.clear();
  });

  const clear = h('button', { type: 'button', class: 'kf-btn', 'data-testid': 'ai-clear' }, i18n.t('ai.ui.settings.clear'));
  clear.addEventListener('click', () => {
    ai.clear();
    cleared();
    announce(i18n.t('ai.ui.settings.cleared'));
  });

  const element = h(
    'details',
    { class: 'kf-ai-section', 'data-testid': 'ai-settings' },
    h('summary', {}, i18n.t('ai.ui.settings.title')),
    h(
      'div',
      { class: 'kf-ai-section-body' },
      levels,
      legendNote,
      h('label', { class: 'kf-ai-choice-label' }, memory, i18n.t('ai.ui.settings.memory')),
      memoryNote,
      h('div', { class: 'kf-ai-buttons' }, clear),
    ),
  );
  return { element };
}
