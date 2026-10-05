import type { JarvisApi } from '../shared/types';

declare global {
  interface Window { jarvis?: JarvisApi }
}

/** The preload bridge. Absent when the UI is opened in a plain browser. */
export const api = window.jarvis ?? null;
export const isMacApp = api?.platform === 'darwin';
