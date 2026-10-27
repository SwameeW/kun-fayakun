/**
 * The navigator's sections that are read only when opened, as one chunk loaded the first time any of
 * them opens (the navigator keeps each section and its summary, so they are there from the first
 * frame): About the world in view (./about, with the facts behind it in src/explore/about), the sky's
 * layers (./sky-panel) and saved views (./saved-views).
 */
export { createAbout } from './about';
export { createSkyPanel } from './sky-panel';
export { createSavedViews } from './saved-views';
