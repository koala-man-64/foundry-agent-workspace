// Applies the stored theme before the first paint. It is a classic script in <head>, so it runs before the module
// bundle; the CSP allows same-origin script files but no inline script. theme.ts re-applies the choice once the app
// starts and follows the Windows app mode for System. The key and the Light fallback mirror theme.ts.
(() => {
  let theme = 'light';
  try {
    const stored = window.localStorage.getItem('foundry.theme');
    if (stored === 'dark') theme = 'dark';
    else if (stored === 'system') theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    theme = 'light';
  }
  document.documentElement.dataset.theme = theme;
})();
