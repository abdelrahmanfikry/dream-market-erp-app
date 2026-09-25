/* ==========================================================================
   ERP.ui.table — data table with search, sort, pagination, export
   columns: [{ key, label, render(row), sortable, num, width, class, sortValue(row), footer(rows) }]
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.ui = ERP.ui || {};
(function () {
  const u = ERP.utils;

  // one delegated listener closes any open export dropdown (instead of one document listener per table)
  document.addEventListener('click', e => { document.querySelectorAll('.tbl-export.open').forEach(d => { if (!d.contains(e.target)) d.classList.remove('open'); }); });

  ERP.ui.table = function (opts) {
    const {
      el, columns, pageSize = 25, searchable = true, exportable = true, selectable = false,
      emptyText = 'لا توجد بيانات', emptyIcon = 'inbox', title = '', toolbarExtra = '',
      rowClass = null, onRowClick = null, searchKeys = null, defaultSort = null, compact = false, footer = true, showCount = true,
      stickyToolbar = false, exportPerm = null,
    } = opts;
    const canExport = exportable && (!exportPerm || ERP.auth.can(exportPerm));
    let rows = opts.rows || [];
    let filtered = rows;
    let page = 1, term = '', sortKey = defaultSort ? defaultSort.key : null, sortDir = defaultSort ? defaultSort.dir : 'asc';
    let selected = new Set();
    let size = pageSize;

    const root = typeof el === 'string' ? document.querySelector(el) : el;
    root.innerHTML = `
      <div class="table-toolbar ${stickyToolbar ? 'sticky' : ''}">
        <div class="flex items-center gap-3 flex-wrap flex-1">
          ${title ? `<h3 class="text-md">${title}</h3>` : ''}
          ${searchable ? `<div class="input-icon" style="min-width:240px"><i class="fas fa-magnifying-glass"></i><input type="search" class="tbl-search" placeholder="بحث..."></div>` : ''}
          <div class="tbl-extra flex items-center gap-2 flex-wrap">${toolbarExtra}</div>
        </div>
        <div class="flex items-center gap-2">
          ${showCount ? '<span class="badge badge-neutral tbl-count"></span>' : ''}
          ${canExport ? `<div class="dropdown tbl-export"><button class="btn btn-sm btn-outline"><i class="fas fa-download"></i> تصدير</button>
            <div class="dropdown-menu"><button class="dropdown-item" data-exp="xlsx"><i class="fas fa-file-excel"></i> Excel</button><button class="dropdown-item" data-exp="csv"><i class="fas fa-file-csv"></i> CSV</button><button class="dropdown-item" data-exp="print"><i class="fas fa-print"></i> طباعة</button></div></div>` : ''}
        </div>
      </div>
      <div class="table-wrap"><table class="table ${compact ? 'table-compact' : ''}"><thead></thead><tbody></tbody><tfoot></tfoot></table></div>
      ${footer ? '<div class="table-footer"><div class="tbl-info"></div><div class="flex items-center gap-2"><select class="tbl-size" style="width:auto;min-height:32px;padding:.2rem 2rem .2rem .5rem"><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="0">الكل</option></select><div class="pagination"></div></div></div>' : ''}
    `;
    const thead = root.querySelector('thead'), tbody = root.querySelector('tbody'), tfoot = root.querySelector('tfoot');
    const sizeSel = root.querySelector('.tbl-size'); if (sizeSel) sizeSel.value = String(pageSize);

    function cellVal(row, c) { return c.sortValue ? c.sortValue(row) : (c.value ? c.value(row) : row[c.key]); }
    function textVal(row, c) { const v = c.text ? c.text(row) : cellVal(row, c); return v == null ? '' : String(v); }

    function applyFilter() {
      const keys = searchKeys || columns.filter(c => c.key).map(c => c.key);
      filtered = term ? rows.filter(r => keys.some(k => u.match(typeof k === 'function' ? k(r) : r[k], term)) || columns.some(c => c.text && u.match(c.text(r), term))) : rows.slice();
      if (sortKey) {
        const c = columns.find(x => (x.key || x.id) === sortKey);
        if (c) filtered = u.sortBy(filtered, r => cellVal(r, c), sortDir);
      }
      const pages = size ? Math.max(1, Math.ceil(filtered.length / size)) : 1;
      if (page > pages) page = pages;
    }

    function renderHead() {
      thead.innerHTML = `<tr>${selectable ? '<th style="width:36px"><input type="checkbox" class="tbl-check-all"></th>' : ''}${columns.map(c => {
        const k = c.key || c.id;
        const sortable = c.sortable !== false && k;
        const cls = [c.num ? 'num' : '', sortable ? 'sortable' : '', sortKey === k ? (sortDir === 'asc' ? 'sort-asc' : 'sort-desc') : '', c.headClass || ''].join(' ');
        return `<th class="${cls}" data-key="${k || ''}" ${c.width ? `style="width:${c.width}"` : ''}>${c.label}</th>`;
      }).join('')}</tr>`;
    }

    function renderBody() {
      applyFilter();
      const start = size ? (page - 1) * size : 0;
      const pageRows = size ? filtered.slice(start, start + size) : filtered;
      if (!pageRows.length) {
        tbody.innerHTML = `<tr><td colspan="${columns.length + (selectable ? 1 : 0)}"><div class="empty-state"><i class="fas fa-${emptyIcon}"></i><h4>${emptyText}</h4>${term ? '<p class="text-sm">لا توجد نتائج مطابقة لبحثك</p>' : ''}</div></td></tr>`;
      } else {
        tbody.innerHTML = pageRows.map((r, i) => {
          const rc = rowClass ? rowClass(r) : '';
          return `<tr data-idx="${start + i}" class="${rc} ${selected.has(r.id) ? 'row-selected' : ''} ${onRowClick ? 'cursor-pointer' : ''}">${selectable ? `<td><input type="checkbox" class="tbl-check" data-id="${r.id}" ${selected.has(r.id) ? 'checked' : ''}></td>` : ''}${columns.map(c => {
            let v = c.render ? c.render(r, term) : (c.value ? c.value(r) : r[c.key]);
            if (v == null) v = '—';
            else if (!c.render) v = term && typeof v === 'string' && !c.num ? u.highlight(v, term) : u.escapeHtml(v); // plain columns are always escaped
            return `<td class="${c.num ? 'num' : ''} ${c.class || ''}">${v}</td>`;
          }).join('')}</tr>`;
        }).join('');
      }
      // footer totals
      const hasFooter = columns.some(c => c.footer);
      tfoot.innerHTML = hasFooter && filtered.length ? `<tr>${selectable ? '<td></td>' : ''}${columns.map(c => `<td class="${c.num ? 'num' : ''}">${c.footer ? c.footer(filtered) : ''}</td>`).join('')}</tr>` : '';
      // info & pagination
      const cnt = root.querySelector('.tbl-count'); if (cnt) cnt.textContent = `${filtered.length} سجل`;
      const info = root.querySelector('.tbl-info');
      if (info) info.textContent = filtered.length ? `عرض ${start + 1} – ${Math.min(start + (size || filtered.length), filtered.length)} من ${filtered.length}` : '';
      const pg = root.querySelector('.pagination');
      if (pg) {
        const pages = size ? Math.max(1, Math.ceil(filtered.length / size)) : 1;
        if (pages <= 1) pg.innerHTML = '';
        else {
          let btns = [];
          const add = p => btns.push(`<button class="btn btn-sm ${p === page ? 'btn-primary' : 'btn-ghost'}" data-page="${p}">${p}</button>`);
          btns.push(`<button class="btn btn-sm btn-ghost" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`);
          const win = 2; let last = 0;
          for (let p = 1; p <= pages; p++) {
            if (p === 1 || p === pages || Math.abs(p - page) <= win) { if (last && p - last > 1) btns.push('<span class="px-1">…</span>'); add(p); last = p; }
          }
          btns.push(`<button class="btn btn-sm btn-ghost" data-page="${page + 1}" ${page === pages ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>`);
          pg.innerHTML = btns.join('');
        }
      }
      const ca = root.querySelector('.tbl-check-all'); if (ca) ca.checked = pageRows.length > 0 && pageRows.every(r => selected.has(r.id));
    }

    /* ---- events ---- */
    const searchInp = root.querySelector('.tbl-search');
    if (searchInp) searchInp.addEventListener('input', u.debounce(() => { term = searchInp.value.trim(); page = 1; renderBody(); }, 180));
    thead.addEventListener('click', e => {
      const th = e.target.closest('th.sortable'); if (!th) return;
      const k = th.dataset.key;
      if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc'; else { sortKey = k; sortDir = 'asc'; }
      renderHead(); renderBody();
    });
    root.addEventListener('click', e => {
      const pb = e.target.closest('[data-page]'); if (pb && !pb.disabled) { page = +pb.dataset.page; renderBody(); return; }
      const ex = e.target.closest('[data-exp]'); if (ex) { doExport(ex.dataset.exp); ex.closest('.dropdown').classList.remove('open'); return; }
      const dd = e.target.closest('.tbl-export > button'); if (dd) { dd.parentElement.classList.toggle('open'); return; }
      const chk = e.target.closest('.tbl-check'); if (chk) { chk.checked ? selected.add(chk.dataset.id) : selected.delete(chk.dataset.id); chk.closest('tr').classList.toggle('row-selected', chk.checked); opts.onSelect && opts.onSelect([...selected]); return; }
      const ca = e.target.closest('.tbl-check-all'); if (ca) { const start = size ? (page - 1) * size : 0; (size ? filtered.slice(start, start + size) : filtered).forEach(r => ca.checked ? selected.add(r.id) : selected.delete(r.id)); renderBody(); opts.onSelect && opts.onSelect([...selected]); return; }
      const tr = e.target.closest('tbody tr[data-idx]');
      if (tr && onRowClick && !e.target.closest('button,a,input,select,.dropdown')) onRowClick(filtered[+tr.dataset.idx], e);
    });
    if (sizeSel) sizeSel.addEventListener('change', () => { size = +sizeSel.value; page = 1; renderBody(); });

    function exportRows() {
      return filtered.map(r => { const o = {}; columns.forEach(c => { if (c.export === false) return; o[c.label.replace(/<[^>]+>/g, '')] = textVal(r, c).replace(/<[^>]+>/g, ''); }); return o; });
    }
    function doExport(kind) {
      if (!canExport && exportPerm) { ERP.ui.toast('ليس لديك صلاحية التصدير', 'error'); return; }
      const name = (title || opts.exportName || 'بيانات').replace(/<[^>]+>/g, '') + '-' + u.todayISO();
      if (kind === 'csv') {
        const cols = columns.filter(c => c.export !== false).map(c => ({ label: c.label.replace(/<[^>]+>/g, ''), value: r => textVal(r, c).replace(/<[^>]+>/g, '') }));
        u.downloadText(u.toCSV(filtered, cols), name + '.csv', 'text/csv');
      } else if (kind === 'xlsx') {
        if (typeof XLSX === 'undefined') { ERP.ui.toast('مكتبة Excel غير متاحة (تحقق من الاتصال بالإنترنت)', 'error'); return; }
        const ws = XLSX.utils.json_to_sheet(exportRows()); ws['!cols'] = columns.map(() => ({ wch: 18 }));
        const wb = XLSX.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] }; XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); XLSX.writeFile(wb, name + '.xlsx');
      } else if (kind === 'print') {
        const cols = columns.filter(c => c.export !== false);
        ERP.print.table({ title: (title || opts.exportName || 'تقرير').replace(/<[^>]+>/g, ''), columns: cols.map(c => ({ label: c.label.replace(/<[^>]+>/g, ''), num: c.num })), rows: filtered.map(r => cols.map(c => textVal(r, c).replace(/<[^>]+>/g, ''))) });
      }
    }

    renderHead(); renderBody();

    return {
      setRows(r) { rows = r || []; selected.clear(); renderBody(); },
      refresh() { renderBody(); },
      getFiltered() { return filtered; },
      getSelected() { return [...selected]; },
      clearSelection() { selected.clear(); renderBody(); },
      setSearch(t) { term = t; if (searchInp) searchInp.value = t; page = 1; renderBody(); },
      export: doExport,
      root,
    };
  };
})();
