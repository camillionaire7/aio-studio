'use strict';
// Themes (same set as OrderTrackr). Presentation only: a theme just sets data-theme on <html>, and the colors
// live in index.html as CSS variables. The choice is remembered in localStorage.
(function () {
  const KEY = 'aioStudio.theme';
  const THEMES = [
    { id: 'aco', name: 'PokeSluts ACO (Neon Glow)', sw: 'linear-gradient(135deg,#0b0d28,#f92fa7 60%,#2fd8c8)' },
    { id: 'royal', name: 'PokeSluts Royal Blue', sw: 'linear-gradient(135deg,#001a52,#1646d6 55%,#22d3ee)' },
    { id: 'zinc', name: 'Dark Mode (Deep Zinc)', sw: 'linear-gradient(135deg,#09090b,#3f3f46 60%,#a1a1aa)' },
    { id: 'daylight', name: 'Daylight (Clean Light)', sw: 'linear-gradient(135deg,#f1f5f9,#ffffff 45%,#0ea5e9)' },
    { id: 'glassdark', name: 'Liquid Glass (Dark)', sw: 'linear-gradient(135deg,#0a0f1f,#6366f1 55%,#ec4899)' },
    { id: 'glasslight', name: 'Liquid Glass (Light)', sw: 'linear-gradient(135deg,#eef3ff,#818cf8 50%,#38bdf8)' },
  ];
  const ids = THEMES.map((t) => t.id);
  let current = 'aco';
  try { const v = localStorage.getItem(KEY); if (ids.includes(v)) current = v; } catch (e) { /* storage unavailable: default theme */ }

  function apply(id) {
    current = ids.includes(id) ? id : 'aco';
    document.documentElement.setAttribute('data-theme', current);
    const sel = document.getElementById('themeSel');
    if (sel) sel.value = current;
  }
  function choose(id) {
    apply(id);
    try { localStorage.setItem(KEY, current); } catch (e) { /* ignore */ }
  }

  apply(current); // before the page paints
  document.addEventListener('DOMContentLoaded', () => {
    const sel = document.getElementById('themeSel');
    if (!sel) return;
    THEMES.forEach((t) => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.name;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => choose(sel.value));
    apply(current);
  });
  window.Theme = { apply: choose, get current() { return current; } };
})();
