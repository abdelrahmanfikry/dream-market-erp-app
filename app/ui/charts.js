/* ==========================================================================
   ERP.charts — Chart.js wrappers with theme-aware colors
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const instances = new Map();
  const PALETTE = ['#3178ff', '#16a34a', '#f59e0b', '#7c3aed', '#dc2626', '#0891b2', '#ec4899', '#84cc16', '#f97316', '#64748b'];

  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function theme() { return { fg: css('--fg-muted') || '#475569', grid: css('--border') || '#e2e8f0', bg: css('--bg-elevated') || '#fff' }; }
  function ready() { return typeof Chart !== 'undefined'; }

  function destroy(canvas) { const c = instances.get(canvas); if (c) { c.destroy(); instances.delete(canvas); } }

  function base(canvas, config) {
    const el = typeof canvas === 'string' ? document.querySelector(canvas) : canvas;
    if (!el) return null;
    destroy(el);
    if (!ready()) { el.parentElement.innerHTML = '<div class="empty-state"><i class="fas fa-chart-simple"></i><p class="text-sm">الرسوم البيانية تحتاج اتصالاً بالإنترنت أول مرة</p></div>'; return null; }
    const t = theme();
    Chart.defaults.font.family = css('--font') || 'Cairo, sans-serif';
    Chart.defaults.color = t.fg;
    config.options = config.options || {};
    config.options.responsive = true; config.options.maintainAspectRatio = false;
    config.options.plugins = { legend: { rtl: true, labels: { usePointStyle: true, boxWidth: 8, padding: 14 } }, tooltip: { rtl: true, backgroundColor: css('--fg'), titleColor: t.bg, bodyColor: t.bg, padding: 10, cornerRadius: 8, callbacks: { label: ctx => ` ${ctx.dataset.label || ''}: ${u.fmtNum(ctx.parsed.y ?? ctx.parsed, config._dec ?? 0)}` } }, ...(config.options.plugins || {}) };
    if (config.type !== 'doughnut' && config.type !== 'pie') {
      config.options.scales = { x: { grid: { display: false }, ticks: { color: t.fg } }, y: { grid: { color: t.grid }, border: { display: false }, ticks: { color: t.fg, callback: v => u.fmtMoneyShort(v) } }, ...(config.options.scales || {}) };
    }
    const chart = new Chart(el, config);
    instances.set(el, chart);
    return chart;
  }

  ERP.charts = {
    PALETTE, destroy, ready,
    line(canvas, { labels, series, fill = true, dec = 0 }) {
      return base(canvas, { _dec: dec, type: 'line', data: { labels, datasets: series.map((s, i) => ({ label: s.label, data: s.data, borderColor: s.color || PALETTE[i], backgroundColor: (s.color || PALETTE[i]) + (fill ? '22' : '00'), fill, tension: .35, pointRadius: 3, pointHoverRadius: 6, borderWidth: 2.5 })) }, options: { interaction: { mode: 'index', intersect: false } } });
    },
    bar(canvas, { labels, series, stacked = false, horizontal = false, dec = 0 }) {
      return base(canvas, { _dec: dec, type: 'bar', data: { labels, datasets: series.map((s, i) => ({ label: s.label, data: s.data, backgroundColor: s.color || PALETTE[i], borderRadius: 6, maxBarThickness: 42 })) }, options: { indexAxis: horizontal ? 'y' : 'x', scales: { x: { stacked, grid: { display: false } }, y: { stacked } } } });
    },
    doughnut(canvas, { labels, data, colors, dec = 0, cutout = '68%' }) {
      return base(canvas, { _dec: dec, type: 'doughnut', data: { labels, datasets: [{ data, backgroundColor: colors || PALETTE, borderWidth: 2, borderColor: theme().bg, hoverOffset: 6 }] }, options: { cutout, plugins: { legend: { position: 'bottom' } } } });
    },
    sparkline(canvas, data, color = PALETTE[0]) {
      return base(canvas, { type: 'line', data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: color, backgroundColor: color + '22', fill: true, tension: .4, pointRadius: 0, borderWidth: 2 }] }, options: { plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } } });
    },
    refreshTheme() { instances.forEach((c, el) => { try { c.update(); } catch { /* */ } }); },
  };
  ERP.bus && ERP.bus.on('theme:change', () => setTimeout(() => ERP.charts.refreshTheme(), 50));
})();
