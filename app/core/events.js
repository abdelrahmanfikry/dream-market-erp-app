/* ==========================================================================
   ERP.bus — tiny pub/sub used for reactive UI updates
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const handlers = {};
  ERP.bus = {
    on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return () => ERP.bus.off(evt, fn); },
    once(evt, fn) { const off = ERP.bus.on(evt, (...a) => { off(); fn(...a); }); return off; },
    off(evt, fn) { if (!handlers[evt]) return; handlers[evt] = handlers[evt].filter(h => h !== fn); },
    emit(evt, payload) {
      (handlers[evt] || []).slice().forEach(h => { try { h(payload); } catch (e) { console.error(`[bus:${evt}]`, e); } });
      // wildcard listeners "db:*"
      const ns = evt.split(':')[0] + ':*';
      if (ns !== evt) (handlers[ns] || []).slice().forEach(h => { try { h(payload, evt); } catch (e) { console.error(`[bus:${ns}]`, e); } });
    },
  };
})();
