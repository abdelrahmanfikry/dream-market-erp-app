/* Dream Market ERP — service worker: offline-first shell + CDN cache */
const VERSION = 'dm-erp-v3.3.0';
const SHELL = [
  './', './index.html', './manifest.json',
  './assets/css/design-system.css', './assets/css/layout.css', './assets/css/print.css',
  './assets/lib/chart.umd.min.js', './assets/lib/xlsx.full.min.js', './assets/lib/JsBarcode.all.min.js', './assets/lib/qrcode.min.js',
  './assets/lib/fontawesome/css/all.min.css', './assets/lib/fontawesome/webfonts/fa-solid-900.woff2', './assets/lib/fontawesome/webfonts/fa-regular-400.woff2', './assets/lib/fontawesome/webfonts/fa-brands-400.woff2', './assets/lib/fontawesome/webfonts/fa-v4compatibility.woff2',
  './app/core/utils.js', './app/core/events.js', './app/core/db.js', './app/core/agg.js', './app/core/settings.js', './app/core/audit.js', './app/core/auth.js', './app/core/seed.js', './app/core/migrate.js', './app/core/cloud.js', './app/core/native.js',
  './app/ui/toast.js', './app/ui/modal.js', './app/ui/table.js', './app/ui/select.js', './app/ui/print.js', './app/ui/charts.js', './app/ui/router.js', './app/ui/cmdk.js',
  './app/services/accounting.js', './app/services/inventory.js', './app/services/shifts.js', './app/services/promotions.js', './app/services/crm.js', './app/services/purchasing.js', './app/services/sales.js', './app/services/hr.js', './app/services/notifications.js', './app/services/backup.js', './app/services/reports.js',
  './app/views/dashboard.js', './app/views/pos.js', './app/views/products.js', './app/views/inventory.js', './app/views/sales.js', './app/views/purchases.js', './app/views/suppliers.js', './app/views/customers.js', './app/views/expenses.js', './app/views/accounting.js', './app/views/shifts.js', './app/views/reports.js', './app/views/hr.js', './app/views/promotions.js', './app/views/users.js', './app/views/backup.js', './app/views/settings.js', './app/views/audit.js',
  './app/services/assets.js', './app/views/assets.js', './app/views/reminders.js', './display.html', './count.html', './app/services/branches.js', './app/views/branches.js', './app/services/orders.js', './app/views/orders.js', './app/services/giftcards.js', './app/views/giftcards.js', './app/views/quotations.js',
  './app/services/autobackup.js', './app/services/whatsapp.js', './app/services/dailyreport.js', './app/services/units.js', './app/services/pricechanges.js', './app/services/cashcount.js', './app/services/eta.js', './app/services/mobilecount.js', './app/services/openingimport.js', './app/services/importcenter.js', './app/services/importtypes.js', './app/views/imports.js',
  './app/tests/e2e.js', './app/tests/feat-backup.js', './app/tests/feat-units.js', './app/tests/feat-ops.js', './app/tests/feat-opening.js', './app/tests/feat-imports.js', './app/main.js',
];
// cache:'reload' bypasses the HTTP cache so a new version never installs stale files
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCDN = /cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|gstatic\.com\/firebasejs/.test(url.host + url.pathname);
  const isLib = isCDN || url.pathname.includes('/assets/lib/');
  if (url.origin === location.origin && !isLib) {
    // app code: network-first (revalidated with the server) so an update is live on the next load; cache only when offline
    e.respondWith(caches.open(VERSION).then(c => fetch(req, { cache: 'no-cache' }).then(async res => { if (res && res.ok) { c.put(req, res.clone()); return res; } return (await c.match(req)) || res; }).catch(() => c.match(req).then(r => r || c.match('./index.html')))));
    return;
  }
  if (isLib) {
    // bundled libraries / CDN: stale-while-revalidate (they rarely change)
    e.respondWith(caches.open(VERSION).then(async c => {
      const cached = await c.match(req);
      const net = fetch(req).then(res => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || net;
    }));
  }
});
