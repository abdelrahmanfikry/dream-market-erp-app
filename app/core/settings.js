/* ==========================================================================
   ERP.settings — single settings document with defaults
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const DEFAULTS = {
    id: 'main',
    storeName: 'سوبر ماركت الأحلام',
    storeSlogan: 'كل ما تحتاجه في مكان واحد',
    phone: '', address: '', taxNumber: '', commercialReg: '', email: '', whatsapp: '',
    logo: '', brandColor: '#16a34a', logoBadge: 'none', logoText: '', // badge shown on invoices when no logo image
    bankName: '', bankAccount: '', bankIban: '',
    receiptShowContact: true, receiptShowBank: true, invoiceQR: true, quoteValidityDays: 7,
    currency: 'ج.م', currencyCode: 'EGP', decimals: 2,
    taxEnabled: false, taxRate: 14, taxInclusive: false,
    fiscalYearStart: 1,
    lowStockThreshold: 5, expiryAlertDays: 30, debtDueDays: 30,
    receiptThanks: 'شكراً لتسوقكم معنا — نتشرف بزيارتكم دائماً',
    receiptTerms: 'البضاعة المباعة لا تُرد ولا تُستبدل بعد 3 أيام',
    receiptFooterBarcode: true, receiptShowLogo: true, receiptWidth: 80,
    receiptAutoPrint: false, invoiceType: 'receipt', // receipt|a4
    posDefaultCustomer: 'عميل نقدي', posAllowNegativeStock: false, negativeStockMode: 'block', // block | permission | allow (posAllowNegativeStock=true is the legacy 'allow') posRequireShift: true,
    posDefaultWarehouse: null, posSoundEnabled: true, posQuickCashAmounts: [5, 10, 20, 50, 100, 200],
    scaleBarcodeEnabled: true, scaleBarcodePrefix: '2', scaleBarcodePluLength: 5, scaleBarcodeMode: 'weight', // weight (grams) | price (piasters)
    approvalDiscountLimitPct: 10, approvalRequireVoid: true, approvalRequireReturn: false, approvalRequirePriceBelowMin: true,
    reorderLeadDays: 7, reorderSafetyDays: 3,
    printerReceipt: '', printerA4: '', drawerTarget: '', drawerOnCashSale: false,
    priceGroups: ['جملة', 'VIP', 'مميز'],
    reminderTemplate: '', reminderMinBalance: 0, countryCode: '20',
    branchCode: 'MAIN', branchName: '',
    ownerPhone: '', defaultDeliveryFee: 0,
    loyaltyEnabled: true, loyaltyEarnRate: 1,   // points per 10 currency
    loyaltyRedeemValue: 0.1,                     // 1 point = 0.1 currency
    loyaltyMinRedeem: 100,
    autoBackup: true, autoBackupPeriod: 'daily', lastAutoBackup: null,
    cloudSync: false, firebaseConfig: null,
    theme: 'light', sidebarCollapsed: false, language: 'ar',
    lockAfterMinutes: 0,
    dashboardRefreshSeconds: 60,
    defaultPaymentMethod: 'cash',
    numbering: { sale: 'INV', purchase: 'PO', receipt: 'RCP', payment: 'PAY', expense: 'EXP', journal: 'JE', return: 'RET', transfer: 'TRF', stocktake: 'STK', quotation: 'QT' },
  };

  let cached = null;
  function col() { return ERP.db.collection('settings'); }

  ERP.settings = {
    DEFAULTS,
    /** feature files add their own defaults at load time: ERP.settings.extend({ key: value }) */
    extend(defs) { Object.entries(defs || {}).forEach(([k, v]) => { if (!(k in DEFAULTS)) DEFAULTS[k] = v; if (cached && cached[k] === undefined) cached[k] = v; }); },
    load() {
      const doc = col().get('main');
      cached = { ...DEFAULTS, ...(doc || {}) };
      cached.numbering = { ...DEFAULTS.numbering, ...(cached.numbering || {}) };
      if (!doc) col().insert(cached, { silent: true });
      return cached;
    },
    all() { return cached || ERP.settings.load(); },
    get(key, def) { const s = ERP.settings.all(); return s[key] === undefined ? def : s[key]; },
    set(patch) {
      const next = { ...ERP.settings.all(), ...patch };
      cached = next;
      col().upsert(next);
      ERP.bus.emit('settings:change', next);
      return next;
    },
    prefix(kind) { return (ERP.settings.get('numbering') || {})[kind] || DEFAULTS.numbering[kind] || kind.toUpperCase(); },
  };
})();
