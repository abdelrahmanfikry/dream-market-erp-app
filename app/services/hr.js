/* ==========================================================================
   ERP.hr — employees, attendance, advances, payroll
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const E = () => ERP.db.collection('employees');
  const AT = () => ERP.db.collection('attendance');
  const AD = () => ERP.db.collection('advances');
  const PR = () => ERP.db.collection('payroll');

  const hr = {
    JOBS: ['كاشير', 'أمين مخزن', 'مندوب مبيعات', 'محاسب', 'مدير', 'عامل', 'سائق', 'أمن', 'أخرى'],
    employees() { return E().all(); },
    active() { return E().all().filter(e => e.active !== false); },
    get(id) { return E().get(id); },
    create(data) {
      if (!data.name) throw new Error('اسم الموظف مطلوب');
      const e = E().insert({ code: ERP.db.nextSeq('EMP', 'EMP', 4), name: data.name.trim(), phone: data.phone || '', nationalId: data.nationalId || '', job: data.job || 'عامل', salary: u.num(data.salary), salaryType: data.salaryType || 'monthly', hireDate: data.hireDate || u.todayISO(), address: data.address || '', notes: data.notes || '', active: true, userId: data.userId || null, shiftStart: data.shiftStart || '09:00', shiftEnd: data.shiftEnd || '17:00', dailyHours: u.num(data.dailyHours, 8) });
      ERP.audit.log('hr.employee', `إضافة ${e.name}`, e.id);
      return e;
    },
    update(id, patch) { const e = E().update(id, patch); ERP.audit.log('hr.employee', `تعديل ${e.name}`, id); return e; },
    remove(id) { const e = E().get(id); if (!e) return; if (PR().where({ employeeId: id }).length || AD().where({ employeeId: id }).length) { E().update(id, { active: false }); return; } E().remove(id); ERP.audit.log('hr.employee', `حذف ${e.name}`); },

    /* ---- attendance ---- */
    attendance({ employeeId, from, to } = {}) { let l = AT().all(); if (employeeId) l = l.filter(a => a.employeeId === employeeId); if (from || to) l = l.filter(a => u.inRange(a.date, from, to)); return u.sortBy(l, 'date', 'desc'); },
    checkIn(employeeId, time = null) {
      const date = u.todayISO(); const e = E().get(employeeId);
      let rec = AT().first({ employeeId, date });
      const now = time || new Date().toTimeString().slice(0, 5);
      const late = now > (e.shiftStart || '09:00');
      if (rec) return AT().update(rec.id, { in: now, status: late ? 'late' : 'present' });
      rec = AT().insert({ employeeId, employeeName: e.name, date, in: now, out: null, status: late ? 'late' : 'present', hours: 0, notes: '' });
      ERP.audit.log('hr.attendance', `حضور ${e.name} ${now}`);
      return rec;
    },
    checkOut(employeeId, time = null) {
      const date = u.todayISO(); const rec = AT().first({ employeeId, date }); if (!rec) throw new Error('لم يتم تسجيل الحضور');
      const now = time || new Date().toTimeString().slice(0, 5);
      const [h1, m1] = rec.in.split(':').map(Number), [h2, m2] = now.split(':').map(Number);
      const hours = u.round(Math.max(0, (h2 * 60 + m2 - h1 * 60 - m1) / 60), 2);
      return AT().update(rec.id, { out: now, hours });
    },
    markStatus(employeeId, date, status, notes = '') {
      const e = E().get(employeeId); const rec = AT().first({ employeeId, date });
      if (rec) return AT().update(rec.id, { status, notes });
      return AT().insert({ employeeId, employeeName: e.name, date, in: null, out: null, status, hours: 0, notes });
    },
    monthSummary(employeeId, month) {
      const recs = AT().all().filter(a => a.employeeId === employeeId && a.date.startsWith(month));
      return { present: recs.filter(r => r.status === 'present').length, late: recs.filter(r => r.status === 'late').length, absent: recs.filter(r => r.status === 'absent').length, leave: recs.filter(r => r.status === 'leave').length, hours: u.sum(recs, 'hours') };
    },

    /* ---- advances ---- */
    advances(employeeId) { return employeeId ? AD().where({ employeeId }) : AD().all(); },
    giveAdvance({ employeeId, amount, method = 'cash', notes = '' }) {
      const e = E().get(employeeId); amount = u.round(u.num(amount)); if (amount <= 0) throw new Error('المبلغ غير صالح');
      const adv = AD().insert({ date: u.now(), employeeId, employeeName: e.name, amount, remaining: amount, method, notes, status: 'open', userId: ERP.auth.current()?.id });
      ERP.accounting.postAdvance(adv);
      if (method === 'cash') { const sh = ERP.shifts.current(); if (sh) ERP.db.collection('shifts').update(sh.id, { cashOut: u.round(sh.cashOut + amount) }, { silent: true }); }
      ERP.audit.log('hr.advance', `${e.name}: ${u.fmtMoney(amount)}`, adv.id);
      return adv;
    },
    openAdvances(employeeId) { return AD().all().filter(a => a.employeeId === employeeId && a.remaining > 0.009); },

    /* ---- payroll ---- */
    payroll({ month } = {}) { let l = PR().all(); if (month) l = l.filter(p => p.month === month); return u.sortBy(l, 'paidAt', 'desc'); },
    computeSalary(employeeId, month, { bonus = 0, deductions = 0, overtimeHours = 0, absentDays = null, deductAdvances = true } = {}) {
      const e = E().get(employeeId); const base = u.num(e.salary);
      const summ = hr.monthSummary(employeeId, month);
      const absent = absentDays ?? summ.absent;
      const dayRate = base / 30;
      const absentRaw = u.round(absent * dayRate);
      const hourRate = dayRate / u.num(e.dailyHours, 8);
      const overtime = u.round(u.num(overtimeHours) * hourRate * 1.5);
      const gross = u.round(base + u.num(bonus) + overtime);
      // deductions are capped so the net salary never goes below zero (absence → other → advances)
      const absentDeduction = u.round(u.clamp(absentRaw, 0, gross));
      const otherDed = u.round(u.clamp(u.num(deductions), 0, gross - absentDeduction));
      const openAdv = deductAdvances ? u.round(u.sum(hr.openAdvances(employeeId), 'remaining')) : 0;
      const advancesDeducted = u.round(Math.min(openAdv, Math.max(0, gross - absentDeduction - otherDed)));
      const net = u.round(Math.max(0, gross - absentDeduction - otherDed - advancesDeducted));
      return { employeeId, employeeName: e.name, month, base, bonus: u.num(bonus), overtime, overtimeHours: u.num(overtimeHours), gross, absentDays: absent, absentDeduction, deductions: u.round(otherDed + absentDeduction), otherDeductions: otherDed, advancesDeducted, net, capped: absentRaw > absentDeduction || u.num(deductions) > otherDed, attendance: summ };
    },
    paySalary(calc, { method = 'cash', notes = '' } = {}) {
      if (PR().first({ employeeId: calc.employeeId, month: calc.month })) throw new Error('تم صرف راتب هذا الشهر بالفعل');
      if (u.num(calc.net) < 0 || u.round(u.num(calc.absentDeduction) + u.num(calc.otherDeductions ?? calc.deductions - calc.absentDeduction) + u.num(calc.advancesDeducted)) > u.num(calc.gross) + 0.009) throw new Error('الخصومات أكبر من إجمالي الراتب — صافي الراتب لا يمكن أن يكون سالباً');
      const pr = PR().insert({ ...calc, method, notes, paidAt: u.now(), userId: ERP.auth.current()?.id });
      // settle advances FIFO
      let rem = calc.advancesDeducted;
      for (const a of u.sortBy(hr.openAdvances(calc.employeeId), 'date')) { if (rem <= 0) break; const take = Math.min(rem, a.remaining); AD().update(a.id, { remaining: u.round(a.remaining - take), status: a.remaining - take <= 0.009 ? 'settled' : 'open' }, { silent: true }); rem -= take; }
      ERP.accounting.postPayroll(pr);
      if (method === 'cash') { const sh = ERP.shifts.current(); if (sh) ERP.db.collection('shifts').update(sh.id, { cashOut: u.round(sh.cashOut + pr.net) }, { silent: true }); }
      ERP.audit.log('hr.payroll', `${pr.employeeName} — ${pr.month} — صافي ${u.fmtMoney(pr.net)}`, pr.id);
      return pr;
    },
    /** cashier performance from sales */
    performance(from, to) {
      const users = ERP.db.collection('users').map();
      const by = {};
      ERP.sales.range(from, to).forEach(s => { const k = s.userId || 'none'; by[k] = by[k] || { userId: k, name: s.userName || (users[k] ? users[k].name : 'غير محدد'), invoices: 0, total: 0, items: 0, discounts: 0, profit: 0 }; by[k].invoices++; by[k].total += s.total; by[k].items += s.items.length; by[k].discounts += s.discount; by[k].profit += u.num(s.profit); });
      return u.sortBy(Object.values(by), 'total', 'desc');
    },
  };
  ERP.hr = hr;
})();
