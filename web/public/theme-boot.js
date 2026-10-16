// Runs before first paint (a classic script in <head>) so dark mode and the color theme never flash.
// theme.ts saves what this needs under mt.paint; this file only replays it. Kept external for the CSP.
(function () {
  try {
    var p = JSON.parse(localStorage.getItem('mt.paint') || 'null');
    var mode = localStorage.getItem('mt.theme');
    var dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#121417' : '#fdfdfe');
    if (!p) return;
    root.style.setProperty('--seed-accent', dark ? p.dark : p.light);
    root.style.setProperty('--seed-neutral-hue', String(p.hue));
    root.style.setProperty('--seed-neutral-chroma', String(p.chroma));
    root.style.setProperty('--accent-on', dark ? p.darkOn : p.lightOn);
  } catch (e) {
    // Storage blocked: theme.ts applies the theme once the app loads.
  }
})();
