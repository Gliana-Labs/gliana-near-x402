/**
 * The theme switch in the bar: system → light → dark. The choice is kept in localStorage; "system" follows the OS live.
 * The first paint is decided by the inline script in index.html, so this only handles changes after load.
 */
type Mode = 'system' | 'light' | 'dark';
const ORDER: Mode[] = ['system', 'light', 'dark'];
const ICON: Record<Mode, string> = {
  system: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3"/></svg>',
  dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z"/></svg>',
};
const media = matchMedia('(prefers-color-scheme: light)');

function apply(mode: Mode) {
  const dark = mode === 'dark' || (mode === 'system' && !media.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.themeMode = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0c0f' : '#f5f6f8');
  const button = document.getElementById('theme');
  if (button) {
    button.innerHTML = ICON[mode];
    button.setAttribute('aria-label', `Theme: ${mode}`);
    button.title = `Theme: ${mode}`;
  }
}

export function setupTheme() {
  let mode = (document.documentElement.dataset.themeMode as Mode) || 'system';
  apply(mode);
  document.getElementById('theme')?.addEventListener('click', () => {
    mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    try {
      localStorage.setItem('saku-theme', mode);
    } catch {
      /* private mode: the choice lasts this visit only */
    }
    apply(mode);
  });
  media.addEventListener('change', () => mode === 'system' && apply(mode));
}
