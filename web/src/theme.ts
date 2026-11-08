/**
 * The theme switch in the bar flips light and dark on every press. Until it is pressed the page follows the system,
 * live; after that the choice is kept in localStorage. (It used to cycle system → light → dark, and the step into
 * "system" often changed nothing on screen, so the button looked broken: 2026-11-08.)
 * The first paint is decided by the inline script in index.html, so this only handles changes after load.
 */
type Theme = 'light' | 'dark';
const ICON: Record<Theme, string> = {
  // The icon shows where a press takes you: a moon in light, a sun in dark.
  light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z"/></svg>',
  dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3"/></svg>',
};
const media = matchMedia('(prefers-color-scheme: light)');

function apply(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0c0f' : '#f5f6f8');
  const button = document.getElementById('theme');
  if (button) {
    const to = theme === 'dark' ? 'light' : 'dark';
    button.innerHTML = ICON[theme];
    button.setAttribute('aria-label', `Switch to ${to} theme`);
    button.title = `Switch to ${to} theme`;
  }
}

export function setupTheme() {
  let chosen = false;
  try {
    chosen = localStorage.getItem('saku-theme') === 'light' || localStorage.getItem('saku-theme') === 'dark';
  } catch {
    /* storage blocked: follow the system */
  }
  apply(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  document.getElementById('theme')?.addEventListener('click', () => {
    const next: Theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    chosen = true;
    try {
      localStorage.setItem('saku-theme', next);
    } catch {
      /* private mode: the choice lasts this visit only */
    }
    apply(next);
  });
  media.addEventListener('change', () => !chosen && apply(media.matches ? 'light' : 'dark'));
}
