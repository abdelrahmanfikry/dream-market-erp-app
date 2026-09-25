/* ==========================================================================
   ERP.native — desktop-only (Electron) file persistence
   Writes a rolling daily backup to Documents\Dream Market ERP Backups, on top
   of the Firebase cloud. Gives a plain on-disk file that survives anything
   browser-side (cleared storage, machine move), without needing the network.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;

  const native = {
    get available() { return !!(window.desktop && window.desktop.isDesktop); },
    async save(suffix) {
      if (!native.available) return false;
      const snap = ERP.db.export();
      const name = `dream-market-backup-${u.todayISO()}${suffix ? '-' + suffix : ''}.json`;
      const r = await window.desktop.saveBackup({ name, json: JSON.stringify(snap) });
      return !!(r && r.ok);
    },
    backups() { return native.available ? window.desktop.listBackups() : Promise.resolve([]); },
    openFolder() { if (native.available) window.desktop.openBackups(); },
    async autoBackupNow() {
      if (!native.available) return;
      try {
        const list = await native.backups();
        const today = u.todayISO();
        if (!list.some(b => b.name.includes(today))) await native.save(today);
      } catch (e) { console.warn('native autobackup', e); }
    },
  };

  let lastPulse = 0;
  ERP.bus.on('db:flushed', () => {
    if (!native.available) return;
    const now = Date.now();
    if (now - lastPulse > 5 * 60 * 1000) { lastPulse = now; native.save('pulse').catch(() => { }); }
  });

  ERP.native = native;
})();