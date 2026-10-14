// ===== 保单管理平台 - 主逻辑 =====
const STORAGE_KEY = 'policy_management_data_v2';
const TODAY = new Date('2026-10-14');

// 状态
let policies = loadPolicies();
let currentView = { type: 'all', value: null };
let searchTerm = '';
let sortKey = 'nextPaymentDate';
let sortAsc = true;

// ===== 数据加载/存储 =====
function loadPolicies() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      // 如果缓存版本低于当前版本，或缺少最新保单，重新从 data.js 加载
      const storedVersion = stored._version || 0;
      const hasNewPolicy = stored.some(p => p.id === 'POL012');
      if (storedVersion < DATA_VERSION || !hasNewPolicy) {
        const fresh = JSON.parse(JSON.stringify(initialPolicies));
        fresh._version = DATA_VERSION;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        return fresh;
      }
      // 终身保单的expiryDate兜底
      const updated = stored.map(p => {
        if (!p.expiryDate && p.insurancePeriod === '终身') {
          return { ...p, expiryDate: '终身' };
        }
        if (p.category === '护理险') {
          return { ...p, category: '寿险', subCategory: '终身寿险' };
        }
        return p;
      });
      const changed = updated.some((p, i) => JSON.stringify(p) !== JSON.stringify(stored[i]));
      if (changed) {
        updated._version = DATA_VERSION;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      }
      return updated;
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(initialPolicies));
}
function savePolicies() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(policies));
}

// ===== 工具函数 =====
function fmtDate(d) {
  if (!d) return '';
  return d;
}
function daysBetween(d) {
  if (!d) return null;
  const t = new Date(d);
  if (isNaN(t)) return null;
  return Math.round((t - TODAY) / (1000 * 60 * 60 * 24));
}
function catClass(cat) {
  const map = { '重疾险': '重疾险', '医疗险': '医疗险', '寿险': '寿险', '意外险': '意外险' };
  return map[cat] || '其他';
}
function getStatus(p) {
  // 保障到期判断
  const ed = daysBetween(p.expiryDate);
  if (ed !== null && ed < 0) return 'expired';
  // 下次缴费临近
  const np = daysBetween(p.nextPaymentDate);
  if (np !== null && np >= 0 && np <= 30) return 'expire';
  if (p.status === '失效' || p.status === '退保') return 'expired';
  return 'active';
}
function statusText(s) {
  return { active: '有效', expire: '待缴费', expired: '已失效' }[s] || '有效';
}

// ===== 统计 =====
function computeStats() {
  const total = policies.length;
  let annual = 0;
  policies.forEach(p => { if (p.annualPremium) annual += parseFloat(p.annualPremium) || 0; });
  const alertList = policies.filter(p => {
    const s = getStatus(p);
    return s === 'expire' || s === 'expired';
  });
  // 家庭成员数（拆分"岳增&罗伟芹"等合并被保人）
  const members = new Set();
  policies.forEach(p => {
    (p.insured.split('&')).forEach(m => { if (m.trim()) members.add(m.trim()); });
  });
  // 险种数
  const cats = new Set(policies.map(p => p.category));

  return {
    total, annual: Math.round(annual), alerts: alertList.length,
    memberCount: members.size, catCount: cats.size
  };
}

// ===== 渲染 =====
function renderStats() {
  const s = computeStats();
  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card" data-view="all"><div class="stat-icon">📋</div><div class="stat-info"><div class="stat-value">${s.total}</div><div class="stat-label">保单总数</div></div></div>
    <div class="stat-card"><div class="stat-icon">💵</div><div class="stat-info"><div class="stat-value">${s.annual.toLocaleString()}</div><div class="stat-label">年保费合计(元)</div></div></div>
    <div class="stat-card" data-view="alert"><div class="stat-icon">⏰</div><div class="stat-info"><div class="stat-value">${s.alerts}</div><div class="stat-label">待处理/到期</div></div></div>
    <div class="stat-card"><div class="stat-icon">👨‍👩‍👧</div><div class="stat-info"><div class="stat-value">${s.memberCount}</div><div class="stat-label">被保人数</div></div></div>
    <div class="stat-card"><div class="stat-icon">🏷️</div><div class="stat-info"><div class="stat-value">${s.catCount}</div><div class="stat-label">险种类型</div></div></div>
  `;
  document.getElementById('statsGrid').querySelectorAll('.stat-card[data-view]').forEach(el => {
    el.addEventListener('click', () => setView('view', el.dataset.view === 'alert' ? 'alert' : 'all'));
  });
  document.getElementById('headerTotal').textContent = `共 ${s.total} 份保单`;
  const alertBadge = document.getElementById('headerAlert');
  if (s.alerts > 0) { alertBadge.style.display = ''; alertBadge.textContent = `⏰ ${s.alerts} 份待处理`; }
  else alertBadge.style.display = 'none';
}

function renderSidebarCounts() {
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  set('cntAll', policies.length);
  const alertN = policies.filter(p => ['expire', 'expired'].includes(getStatus(p))).length;
  set('cntAlert', alertN);
  ['重疾险', '医疗险', '寿险', '意外险', '其他'].forEach(c => {
    set('cat-' + c, policies.filter(p => catClass(p.category) === c).length);
  });
  ['岳元曦', '岳元琪', '岳增', '罗伟芹'].forEach(m => {
    set('mem-' + m, policies.filter(p => p.insured.includes(m)).length);
  });
}

function getFiltered() {
  let list = policies.slice();
  // 视图过滤
  if (currentView.type === 'cat') list = list.filter(p => catClass(p.category) === currentView.value);
  else if (currentView.type === 'member') list = list.filter(p => p.insured.includes(currentView.value) || p.policyholder === currentView.value);
  else if (currentView.type === 'alert') list = list.filter(p => ['expire', 'expired'].includes(getStatus(p)));
  // 搜索
  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    list = list.filter(p =>
      [p.productName, p.insured, p.policyholder, p.insurer, p.category, p.policyNo, p.notes, (p.tags || []).join(' ')]
        .join(' ').toLowerCase().includes(t)
    );
  }
  // 排序
  list.sort((a, b) => {
    let va = a[sortKey] || '', vb = b[sortKey] || '';
    if (sortKey === 'annualPremium') { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });
  return list;
}

function renderTable() {
  const list = getFiltered();
  const body = document.getElementById('policyBody');
  const empty = document.getElementById('emptyState');
  if (list.length === 0) {
    body.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  body.innerHTML = list.map(p => {
    const st = getStatus(p);
    const np = daysBetween(p.nextPaymentDate);
    const ed = daysBetween(p.expiryDate);
    const npText = p.nextPaymentDate ? `${fmtDate(p.nextPaymentDate)}${np !== null && np >= 0 && np <= 30 ? ` <span class="date-cell soon">(${np}天)</span>` : ''}` : '—';
    const edText = p.expiryDate ? `${fmtDate(p.expiryDate)}${ed !== null && ed < 0 ? ' <span class="date-cell soon">(已到期)</span>' : ''}` : '—';
    return `<tr data-id="${p.id}">
      <td><div class="policy-name">${p.productName}</div><div class="policy-sub">${p.insurer}</div></td>
      <td>${p.insured}<div class="policy-sub">${p.relationship}</div></td>
      <td><span class="badge badge-cat-${catClass(p.category)}">${p.category}</span></td>
      <td>${p.insurer}</td>
      <td>${p.annualPremium ? Number(p.annualPremium).toLocaleString() : '—'}</td>
      <td class="date-cell">${npText}</td>
      <td class="date-cell">${edText}</td>
      <td><span class="status-dot ${st}">${statusText(st)}</span></td>
      <td><div class="action-btns">
        <button class="action-btn" data-act="view" data-id="${p.id}" title="查看">👁</button>
        <button class="action-btn" data-act="edit" data-id="${p.id}" title="编辑">✏️</button>
        <button class="action-btn" data-act="del" data-id="${p.id}" title="删除">🗑</button>
      </div></td>
    </tr>`;
  }).join('');

  body.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.action-btn')) return;
      openModal(tr.dataset.id, 'view');
    });
  });
  body.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id, act = btn.dataset.act;
      if (act === 'view') openModal(id, 'view');
      else if (act === 'edit') openModal(id, 'edit');
      else if (act === 'del') deletePolicy(id);
    });
  });
}

function renderAll() {
  renderStats();
  renderSidebarCounts();
  renderTable();
}

// ===== 视图切换 =====
function setView(type, value) {
  currentView = { type, value };
  document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
  if (type === 'all') document.querySelector('[data-view="all"]').classList.add('active');
  else if (type === 'alert') document.querySelector('[data-view="alert"]').classList.add('active');
  else if (type === 'cat') document.querySelector(`[data-cat="${value}"]`).classList.add('active');
  else if (type === 'member') document.querySelector(`[data-member="${value}"]`).classList.add('active');
  renderTable();
}

// ===== 弹窗 =====
const modal = document.getElementById('modal');
const modalBody = document.getElementById('modalBody');
const modalTitle = document.getElementById('modalTitle');

function openModal(id, mode) {
  const p = policies.find(x => x.id === id);
  if (!p) return;
  if (mode === 'view') renderViewMode(p);
  else renderEditMode(p);
  modal.classList.add('open');
}

function closeModal() { modal.classList.remove('open'); }

function renderViewMode(p) {
  modalTitle.textContent = p.productName;
  const st = getStatus(p);
  const rows = [
    ['投保人', p.policyholder], ['被保人', `${p.insured}（${p.relationship}）`],
    ['保险公司', p.insurer], ['险种', p.category + (p.subCategory ? ' / ' + p.subCategory : '')],
    ['保单号', p.policyNo], ['保障期间', p.insurancePeriod],
    ['缴费期间', p.paymentPeriod], ['年保费(元)', p.annualPremium ? Number(p.annualPremium).toLocaleString() : ''],
    ['保额(元)', p.sumInsured ? Number(p.sumInsured).toLocaleString() : ''],
    ['受益人', p.beneficiary], ['保障到期', p.expiryDate],
    ['下次缴费日', p.nextPaymentDate], ['状态', statusText(st)],
    ['备注', p.notes], ['关联合同', p.pdfFile],
    ['标签', (p.tags || []).join('、')]
  ];
  const stBanner = st === 'expire' || st === 'expired'
    ? `<div class="reminder-banner"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z"/></svg><div>${statusText(st)}：本保单需要关注，请及时处理缴费或续保。</div></div>`
    : '';
  modalBody.innerHTML = stBanner + rows.map(([l, v]) =>
    `<div class="detail-row"><div class="detail-label">${l}</div><div class="detail-value ${v ? '' : 'blank'}">${v || '未填写'}</div></div>`
  ).join('') +
    `<div class="modal-footer"><button class="btn btn-primary" id="modalEditBtn">编辑</button><button class="btn btn-outline" id="modalCloseBtn">关闭</button></div>`;
  modalBody.querySelector('#modalEditBtn').addEventListener('click', () => renderEditMode(p));
  modalBody.querySelector('#modalCloseBtn').addEventListener('click', closeModal);
}

function fieldHTML(label, key, val, type = 'text', full = false) {
  const cls = full ? 'field full' : 'field';
  if (type === 'select') {
    const opts = ['有效', '失效', '退保', '其他'];
    return `<div class="${cls}"><label>${label}</label><select data-key="${key}">${opts.map(o => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
  }
  if (type === 'textarea') {
    return `<div class="${cls}"><label>${label}</label><textarea data-key="${key}">${val || ''}</textarea></div>`;
  }
  return `<div class="${cls}"><label>${label}</label><input type="${type}" data-key="${key}" value="${val || ''}"></div>`;
}

function renderEditMode(p) {
  modalTitle.textContent = p.id.startsWith('POL') && p.productName ? '编辑保单' : '编辑保单';
  modalBody.innerHTML = `
    <div class="field-grid">
      ${fieldHTML('保单名称', 'productName', p.productName, 'text', true)}
      ${fieldHTML('投保人', 'policyholder', p.policyholder)}
      ${fieldHTML('被保人', 'insured', p.insured)}
      ${fieldHTML('关系', 'relationship', p.relationship)}
      ${fieldHTML('保险公司', 'insurer', p.insurer)}
      ${fieldHTML('险种', 'category', p.category)}
      ${fieldHTML('子类别', 'subCategory', p.subCategory)}
      ${fieldHTML('保单号', 'policyNo', p.policyNo)}
      ${fieldHTML('保障期间', 'insurancePeriod', p.insurancePeriod)}
      ${fieldHTML('缴费期间', 'paymentPeriod', p.paymentPeriod)}
      ${fieldHTML('年保费(元)', 'annualPremium', p.annualPremium, 'number')}
      ${fieldHTML('保额(元)', 'sumInsured', p.sumInsured, 'number')}
      ${fieldHTML('受益人', 'beneficiary', p.beneficiary)}
      ${fieldHTML('保障到期', 'expiryDate', p.expiryDate, 'date')}
      ${fieldHTML('下次缴费日', 'nextPaymentDate', p.nextPaymentDate, 'date')}
      ${fieldHTML('状态', 'status', p.status, 'select')}
      ${fieldHTML('关联合同文件', 'pdfFile', p.pdfFile, 'text', true)}
      ${fieldHTML('备注', 'notes', p.notes, 'textarea', true)}
      ${fieldHTML('标签(空格分隔)', 'tags', (p.tags || []).join(' '), 'text', true)}
    </div>
    <div class="modal-footer">
      <button class="btn btn-danger" id="modalDelBtn">删除</button>
      <button class="btn btn-outline" id="modalCancelBtn">取消</button>
      <button class="btn btn-primary" id="modalSaveBtn">保存</button>
    </div>`;
  modalBody.querySelector('#modalSaveBtn').addEventListener('click', () => savePolicy(p.id));
  modalBody.querySelector('#modalCancelBtn').addEventListener('click', () => renderViewMode(p));
  modalBody.querySelector('#modalDelBtn').addEventListener('click', () => { closeModal(); deletePolicy(p.id); });
}

function savePolicy(id) {
  const p = policies.find(x => x.id === id);
  modalBody.querySelectorAll('[data-key]').forEach(el => {
    const k = el.dataset.key;
    let v = el.value;
    if (k === 'tags') v = v.split(/[\s,，、]+/).filter(Boolean);
    if (k === 'annualPremium' || k === 'sumInsured') v = v ? String(v) : '';
    p[k] = v;
  });
  p.updatedAt = TODAY.toISOString().slice(0, 10);
  savePolicies();
  closeModal();
  renderAll();
}

function deletePolicy(id) {
  if (!confirm('确定删除该保单吗？此操作不可恢复。')) return;
  policies = policies.filter(p => p.id !== id);
  savePolicies();
  renderAll();
}

function addPolicy() {
  const id = 'POL' + Date.now().toString().slice(-6);
  const p = {
    id, policyholder: '', insured: '', relationship: '本人', insurer: '', productName: '',
    category: '重疾险', subCategory: '', policyNo: '', insurancePeriod: '', paymentPeriod: '',
    annualPremium: '', sumInsured: '', beneficiary: '', status: '有效', expiryDate: '',
    nextPaymentDate: '', notes: '', pdfFile: '', tags: [],
    createdAt: TODAY.toISOString().slice(0, 10), updatedAt: TODAY.toISOString().slice(0, 10)
  };
  policies.push(p);
  savePolicies();
  openModal(id, 'edit');
}

// ===== 导入/导出 =====
function exportJSON() {
  const blob = new Blob([JSON.stringify(policies, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '保单数据_' + TODAY.toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}
function importJSON(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (Array.isArray(data)) { policies = data; savePolicies(); renderAll(); alert('导入成功，共 ' + data.length + ' 份保单'); }
      else alert('文件格式不正确');
    } catch (err) { alert('解析失败：' + err.message); }
  };
  reader.readAsText(file);
}

// ===== 事件绑定 =====
document.querySelectorAll('.sidebar-item[data-view]').forEach(el => el.addEventListener('click', () => setView(el.dataset.view === 'alert' ? 'alert' : 'all')));
document.querySelectorAll('.sidebar-item[data-cat]').forEach(el => el.addEventListener('click', () => setView('cat', el.dataset.cat)));
document.querySelectorAll('.sidebar-item[data-member]').forEach(el => el.addEventListener('click', () => setView('member', el.dataset.member)));
document.getElementById('searchInput').addEventListener('input', e => { searchTerm = e.target.value.trim(); renderTable(); });
document.querySelectorAll('.policy-table thead th[data-sort]').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.sort;
  if (sortKey === k) sortAsc = !sortAsc; else { sortKey = k; sortAsc = true; }
  renderTable();
}));
document.getElementById('addBtn').addEventListener('click', addPolicy);
document.getElementById('exportBtn').addEventListener('click', exportJSON);
document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', e => { if (e.target.files[0]) importJSON(e.target.files[0]); });
document.getElementById('modalClose').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ===== 启动 =====
renderAll();
