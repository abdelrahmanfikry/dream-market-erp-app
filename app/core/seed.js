/* ==========================================================================
   ERP.seed — reference data & chart of accounts created on first run
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const db = () => ERP.db;

  // Standard chart of accounts for a retail business (codes are stable IDs)
  const ACCOUNTS = [
    // Assets 1xxx
    { code: '1000', name: 'الأصول', type: 'asset', parent: null },
    { code: '1100', name: 'الأصول المتداولة', type: 'asset', parent: '1000' },
    { code: '1110', name: 'الخزينة (النقدية)', type: 'asset', parent: '1100', sys: 'cash' },
    { code: '1120', name: 'البنك', type: 'asset', parent: '1100', sys: 'bank' },
    { code: '1130', name: 'محافظ إلكترونية', type: 'asset', parent: '1100', sys: 'wallet' },
    { code: '1140', name: 'العملاء (مدينون)', type: 'asset', parent: '1100', sys: 'ar' },
    { code: '1150', name: 'المخزون', type: 'asset', parent: '1100', sys: 'inventory' },
    { code: '1160', name: 'سلف الموظفين', type: 'asset', parent: '1100', sys: 'advances' },
    { code: '1170', name: 'مصروفات مدفوعة مقدماً', type: 'asset', parent: '1100' },
    { code: '1180', name: 'جاري الفروع', type: 'asset', parent: '1100', sys: 'branch_current' },
    { code: '1200', name: 'الأصول الثابتة', type: 'asset', parent: '1000' },
    { code: '1210', name: 'أجهزة ومعدات', type: 'asset', parent: '1200', sys: 'fixed_assets' },
    { code: '1220', name: 'أثاث وتجهيزات', type: 'asset', parent: '1200' },
    { code: '1290', name: 'مجمع الإهلاك', type: 'asset', parent: '1200', sys: 'acc_dep' },
    // Liabilities 2xxx
    { code: '2000', name: 'الالتزامات', type: 'liability', parent: null },
    { code: '2100', name: 'الالتزامات المتداولة', type: 'liability', parent: '2000' },
    { code: '2110', name: 'الموردون (دائنون)', type: 'liability', parent: '2100', sys: 'ap' },
    { code: '2120', name: 'ضريبة القيمة المضافة مستحقة', type: 'liability', parent: '2100', sys: 'vat_out' },
    { code: '2130', name: 'رواتب مستحقة', type: 'liability', parent: '2100', sys: 'salaries_payable' },
    { code: '2140', name: 'مصروفات مستحقة', type: 'liability', parent: '2100' },
    { code: '2150', name: 'نقاط ولاء مستحقة', type: 'liability', parent: '2100', sys: 'loyalty' },
    { code: '2160', name: 'إيرادات مقدمة / بطاقات هدايا', type: 'liability', parent: '2100', sys: 'gift' },
    { code: '2200', name: 'قروض طويلة الأجل', type: 'liability', parent: '2000' },
    // Equity 3xxx
    { code: '3000', name: 'حقوق الملكية', type: 'equity', parent: null },
    { code: '3100', name: 'رأس المال', type: 'equity', parent: '3000', sys: 'capital' },
    { code: '3200', name: 'جاري المالك (مسحوبات)', type: 'equity', parent: '3000', sys: 'drawings' },
    { code: '3300', name: 'أرباح محتجزة', type: 'equity', parent: '3000', sys: 'retained' },
    { code: '3900', name: 'أرصدة افتتاحية', type: 'equity', parent: '3000', sys: 'opening' },
    // Revenue 4xxx
    { code: '4000', name: 'الإيرادات', type: 'revenue', parent: null },
    { code: '4100', name: 'إيرادات المبيعات', type: 'revenue', parent: '4000', sys: 'sales' },
    { code: '4110', name: 'مرتجعات المبيعات', type: 'revenue', parent: '4000', sys: 'sales_returns', contra: true },
    { code: '4120', name: 'خصومات مسموح بها', type: 'revenue', parent: '4000', sys: 'discounts', contra: true },
    { code: '4200', name: 'إيرادات أخرى', type: 'revenue', parent: '4000', sys: 'other_income' },
    { code: '4210', name: 'فروق جرد (زيادة)', type: 'revenue', parent: '4200', sys: 'inv_gain' },
    // Expenses 5xxx
    { code: '5000', name: 'المصروفات', type: 'expense', parent: null },
    { code: '5100', name: 'تكلفة البضاعة المباعة', type: 'expense', parent: '5000', sys: 'cogs' },
    { code: '5110', name: 'هالك وفروق جرد (نقص)', type: 'expense', parent: '5000', sys: 'inv_loss' },
    { code: '5200', name: 'مصروفات تشغيلية', type: 'expense', parent: '5000', sys: 'opex' },
    { code: '5210', name: 'إيجار', type: 'expense', parent: '5200' },
    { code: '5220', name: 'كهرباء ومياه', type: 'expense', parent: '5200' },
    { code: '5230', name: 'رواتب وأجور', type: 'expense', parent: '5200', sys: 'salaries' },
    { code: '5240', name: 'صيانة', type: 'expense', parent: '5200' },
    { code: '5250', name: 'نقل ومواصلات', type: 'expense', parent: '5200' },
    { code: '5260', name: 'اتصالات وإنترنت', type: 'expense', parent: '5200' },
    { code: '5270', name: 'تسويق وإعلان', type: 'expense', parent: '5200' },
    { code: '5280', name: 'مصروفات بنكية', type: 'expense', parent: '5200' },
    { code: '5290', name: 'مصروفات متنوعة', type: 'expense', parent: '5200', sys: 'misc' },
    { code: '5300', name: 'إهلاك الأصول', type: 'expense', parent: '5000', sys: 'depreciation' },
  ];

  const CATEGORIES = [
    { id: 'cat_food', name: 'أغذية', icon: 'bread-slice', color: '#f59e0b' },
    { id: 'cat_drinks', name: 'مشروبات', icon: 'bottle-water', color: '#0891b2' },
    { id: 'cat_dairy', name: 'ألبان وأجبان', icon: 'cheese', color: '#fbbf24' },
    { id: 'cat_clean', name: 'منظفات', icon: 'soap', color: '#16a34a' },
    { id: 'cat_care', name: 'عناية شخصية', icon: 'pump-soap', color: '#7c3aed' },
    { id: 'cat_snacks', name: 'حلويات وسناكس', icon: 'cookie-bite', color: '#ec4899' },
    { id: 'cat_frozen', name: 'مجمدات', icon: 'snowflake', color: '#3b82f6' },
    { id: 'cat_home', name: 'أدوات منزلية', icon: 'house', color: '#64748b' },
    { id: 'cat_other', name: 'أخرى', icon: 'box', color: '#94a3b8' },
  ];
  const UNITS = [
    { id: 'un_pc', name: 'قطعة', short: 'ق', decimal: false },
    { id: 'un_kg', name: 'كيلوجرام', short: 'كجم', decimal: true },
    { id: 'un_g', name: 'جرام', short: 'جم', decimal: true },
    { id: 'un_l', name: 'لتر', short: 'لتر', decimal: true },
    { id: 'un_box', name: 'كرتونة', short: 'كرتونة', decimal: false },
    { id: 'un_pack', name: 'عبوة', short: 'عبوة', decimal: false },
    { id: 'un_dz', name: 'دستة', short: 'دستة', decimal: false },
  ];
  const WAREHOUSES = [
    { id: 'wh_main', name: 'المخزن الرئيسي', code: 'MAIN', isDefault: true, address: '' },
    { id: 'wh_shop', name: 'أرفف المحل', code: 'SHOP', isDefault: false, address: '' },
  ];
  const PAYMENT_METHODS = [
    { id: 'cash', name: 'نقدي', icon: 'money-bill-wave', accountSys: 'cash', active: true, isDefault: true },
    { id: 'card', name: 'بطاقة بنكية', icon: 'credit-card', accountSys: 'bank', active: true },
    { id: 'wallet', name: 'محفظة إلكترونية', icon: 'mobile-screen', accountSys: 'wallet', active: true },
    { id: 'instapay', name: 'إنستاباي', icon: 'building-columns', accountSys: 'bank', active: true },
    { id: 'credit', name: 'آجل (على الحساب)', icon: 'hand-holding-dollar', accountSys: 'ar', active: true, isCredit: true },
  ];
  const EXPENSE_CATEGORIES = [
    { id: 'exc_rent', name: 'إيجار', accountCode: '5210', icon: 'building' },
    { id: 'exc_util', name: 'كهرباء ومياه', accountCode: '5220', icon: 'bolt' },
    { id: 'exc_sal', name: 'رواتب وأجور', accountCode: '5230', icon: 'users' },
    { id: 'exc_maint', name: 'صيانة', accountCode: '5240', icon: 'screwdriver-wrench' },
    { id: 'exc_trans', name: 'نقل ومواصلات', accountCode: '5250', icon: 'truck' },
    { id: 'exc_tel', name: 'اتصالات وإنترنت', accountCode: '5260', icon: 'wifi' },
    { id: 'exc_mkt', name: 'تسويق وإعلان', accountCode: '5270', icon: 'bullhorn' },
    { id: 'exc_bank', name: 'مصروفات بنكية', accountCode: '5280', icon: 'building-columns' },
    { id: 'exc_misc', name: 'متنوعة', accountCode: '5290', icon: 'ellipsis' },
  ];

  function seedRef(colName, items) {
    const col = db().collection(colName);
    if (col.count() > 0) return false;
    col.bulkInsert(items, { silent: true });
    return true;
  }

  ERP.seed = {
    ACCOUNTS, CATEGORIES, UNITS, WAREHOUSES, PAYMENT_METHODS, EXPENSE_CATEGORIES,

    ensureReferenceData() {
      seedRef('categories', CATEGORIES);
      seedRef('units', UNITS);
      seedRef('warehouses', WAREHOUSES);
      seedRef('paymentMethods', PAYMENT_METHODS);
      seedRef('expenseCategories', EXPENSE_CATEGORIES);
      ERP.seed.ensureAccounts();
      ERP.auth.ensureDefaults();
    },

    ensureAccounts() {
      const col = db().collection('accounts');
      const existing = u.keyBy(col.all(), 'code');
      const toAdd = ACCOUNTS.filter(a => !existing[a.code]).map(a => ({
        id: 'acc_' + a.code, code: a.code, name: a.name, type: a.type,
        parentId: a.parent ? 'acc_' + a.parent : null, sys: a.sys || null, contra: !!a.contra, isSystem: true, active: true,
      }));
      if (toAdd.length) col.bulkInsert(toAdd, { silent: true });
    },

    /** demo data for a fresh install (only when there is nothing at all) */
    demoProducts() {
      const S = (name, cat, cost, price, stock, unit = 'un_pc', extra = {}) => ({
        name, categoryId: cat, cost, price, stock, unitId: unit, minStock: 10, taxRate: 0, active: true, ...extra,
      });
      return [
        S('أرز مصري 1 كجم', 'cat_food', 28, 34, 120, 'un_pc', { barcode: '6221031490015' }),
        S('سكر 1 كجم', 'cat_food', 26, 30, 200, 'un_pc', { barcode: '6221031490022' }),
        S('زيت عباد الشمس 1 لتر', 'cat_food', 62, 72, 80, 'un_pc', { barcode: '6221031490039' }),
        S('مكرونة 400 جم', 'cat_food', 11, 14, 300, 'un_pc', { barcode: '6221031490046' }),
        S('شاي العروسة 250 جم', 'cat_drinks', 58, 66, 90, 'un_pc', { barcode: '6221031490053' }),
        S('قهوة تركي 200 جم', 'cat_drinks', 70, 85, 40, 'un_pc', { barcode: '6221031490060' }),
        S('مياه معدنية 1.5 لتر', 'cat_drinks', 6, 8, 240, 'un_pc', { barcode: '6221031490077' }),
        S('كولا 1 لتر', 'cat_drinks', 16, 20, 96, 'un_pc', { barcode: '6221031490084' }),
        S('لبن كامل الدسم 1 لتر', 'cat_dairy', 34, 39, 60, 'un_pc', { barcode: '6221031490091', trackExpiry: true }),
        S('جبنة بيضاء', 'cat_dairy', 95, 115, 25.5, 'un_kg', { trackExpiry: true }),
        S('زبادي 105 جم', 'cat_dairy', 5, 7, 8, 'un_pc', { trackExpiry: true }),
        S('صابون غسيل', 'cat_clean', 12, 15, 5, 'un_pc', { barcode: '6221031490107' }),
        S('كلور 1 لتر', 'cat_clean', 18, 23, 45, 'un_pc', { barcode: '6221031490114' }),
        S('منظف أطباق 750 مل', 'cat_clean', 24, 30, 38, 'un_pc', { barcode: '6221031490121' }),
        S('شامبو 400 مل', 'cat_care', 42, 55, 22, 'un_pc', { barcode: '6221031490138' }),
        S('معجون أسنان', 'cat_care', 19, 25, 0, 'un_pc', { barcode: '6221031490145' }),
        S('شيبسي كبير', 'cat_snacks', 8, 10, 150, 'un_pc', { barcode: '6221031490152' }),
        S('شوكولاتة', 'cat_snacks', 12, 15, 3, 'un_pc', { barcode: '6221031490169' }),
        S('بسكويت', 'cat_snacks', 5, 7, 180, 'un_pc', { barcode: '6221031490176' }),
        S('خضار مشكل مجمد 400 جم', 'cat_frozen', 30, 38, 26, 'un_pc', { trackExpiry: true }),
        S('أكياس قمامة', 'cat_home', 15, 20, 70, 'un_pack', { barcode: '6221031490183' }),
        S('ولاعة', 'cat_home', 4, 6, 100, 'un_pc'),
      ];
    },
  };
})();
