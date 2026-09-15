'use strict';

/* ---------------------------------------------------------------
   QA Test Scenario Tool — dashboard logic
   Products (Message / Email / Content)
     -> enhancements of that product
        -> test scenarios of that enhancement
---------------------------------------------------------------- */

const state = {
  products: [],
  product: null,        // selected product key
  enhancements: [],     // enhancements of the selected product
  enhancement: null,    // full enhancement (with scenarios) when open
  enhFilter: '',
  scenarioFilter: '',
  openTestCases: new Set(),   // scenario serial numbers whose test-case panel is open
  documents: [],              // enhancement write-ups
  docFilter: '',
  enhancementDocs: [],        // documents linked to the open enhancement
  view: 'dashboard',          // dashboard | enhancements | scenarios | documents
  openDocs: new Set(),        // document ids expanded in the list
  docBodies: {},              // id -> full document (loaded on first expand)
  docTab: 'message',          // active product tab in Documents
  editingDoc: null,           // document whose edit row should start open
};

const el = (id) => document.getElementById(id);

const dom = {
  productList: el('productList'),
  crumbs: el('crumbs'),
  enhancementView: el('enhancementView'),
  enhancementList: el('enhancementList'),
  productTitle: el('productTitle'),
  productSub: el('productSub'),
  enhancementSearch: el('enhancementSearch'),
  addForProductBtn: el('addForProductBtn'),
  scenarioView: el('scenarioView'),
  enhancementTitle: el('enhancementTitle'),
  enhancementSub: el('enhancementSub'),
  scenarioHead: el('scenarioHead'),
  scenarioBody: el('scenarioBody'),
  scenarioFoot: el('scenarioFoot'),
  scenarioSearch: el('scenarioSearch'),
  exportBtn: el('exportBtn'),
  reuploadBtn: el('reuploadBtn'),
  deleteBtn: el('deleteBtn'),
  modal: el('modal'),
  modalTitle: el('modalTitle'),
  modalProduct: el('modalProduct'),
  modalName: el('modalName'),
  modalDesc: el('modalDesc'),
  modalFile: el('modalFile'),
  modalMode: el('modalMode'),
  modalSplit: el('modalSplit'),
  modalError: el('modalError'),
  modalSubmit: el('modalSubmit'),
  productField: el('productField'),
  nameField: el('nameField'),
  descField: el('descField'),
  modeField: el('modeField'),
  uploadForm: el('uploadForm'),
  toast: el('toast'),
  addScenarioForm: el('addScenarioForm'),
  addScenarioText: el('addScenarioText'),
  addScenarioExtras: el('addScenarioExtras'),
  addScenarioBtn: el('addScenarioBtn'),
  documentsView: el('documentsView'),
  documentList: el('documentList'),
  documentSearch: el('documentSearch'),
  fileField: el('fileField'),
  docField: el('docField'),
  docFieldLabel: el('docFieldLabel'),
  splitField: el('splitField'),
  modalDoc: el('modalDoc'),
  modalHint: el('modalHint'),
  docLinkBtn: el('docLinkBtn'),
  fileFieldLabel: el('fileFieldLabel'),
  nameFieldLabel: el('nameFieldLabel'),
  docTabs: el('docTabs'),
  renameEnhancementBtn: el('renameEnhancementBtn'),
  renameForm: el('renameForm'),
  renameInput: el('renameInput'),
};

/* ---------------- helpers ---------------- */

async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.classList.toggle('error', isError);
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 3800);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function productLabel(key) {
  const p = state.products.find((item) => item.key === key);
  return p ? p.label : key;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ---------------- products (left panel) ---------------- */

async function loadProducts() {
  const { products, documentCount } = await api('/api/products');
  state.products = products;
  state.documentCount = documentCount || 0;
  renderProducts();
  fillProductSelect();
}

/** Two-letter monogram for the nav chip: "Data Sprawl" -> DS, "Email" -> EM. */
function monogram(label) {
  const words = String(label).trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : String(label).slice(0, 2)).toUpperCase();
}

function navItem({ label, blurb, count, active, onClick, muted }) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `product-item${active ? ' active' : ''}`;
  btn.innerHTML = `
    <span class="p-top">
      <span class="p-chip"></span>
      <span class="p-name">
        <strong></strong>
        <span class="pill"></span>
      </span>
    </span>
    <p class="p-blurb"></p>`;
  btn.querySelector('.p-chip').textContent = monogram(label);
  btn.querySelector('strong').textContent = label;
  const pill = btn.querySelector('.pill');
  pill.textContent = count;
  if (muted) pill.classList.add('ghost');
  btn.querySelector('.p-blurb').textContent = blurb;
  btn.addEventListener('click', onClick);
  li.appendChild(btn);
  return li;
}

function renderProducts() {
  dom.productList.innerHTML = '';

  state.products.forEach((product) => {
    dom.productList.appendChild(navItem({
      label: product.label,
      blurb: product.blurb,
      count: product.enhancementCount,
      muted: !product.enhancementCount,
      active: state.product === product.key,
      onClick: () => openProduct(product.key),
    }));
  });

  const divider = document.createElement('li');
  divider.className = 'nav-divider';
  dom.productList.appendChild(divider);

  dom.productList.appendChild(navItem({
    label: 'Documents',
    blurb: 'Enhancement write-ups with matter and screenshots',
    count: state.documentCount || 0,
    muted: !state.documentCount,
    active: state.view === 'documents',
    onClick: () => openDocuments(),
  }));
}

function fillProductSelect() {
  dom.modalProduct.innerHTML = '';
  state.products.forEach((product) => {
    const option = document.createElement('option');
    option.value = product.key;
    option.textContent = product.label;
    dom.modalProduct.appendChild(option);
  });
}

/* ---------------- enhancement list ---------------- */

async function openProduct(key, { silent = false } = {}) {
  state.product = key;
  state.enhancement = null;
  state.view = 'enhancements';
  state.enhFilter = '';
  dom.enhancementSearch.value = '';
  renderProducts();

  hideAllViews();
  dom.enhancementView.hidden = false;
  dom.enhancementSearch.hidden = false;
  dom.addForProductBtn.hidden = false;

  const product = state.products.find((p) => p.key === key);
  dom.productTitle.textContent = `${product.label} — enhancements`;
  dom.productSub.textContent = 'Pick an enhancement to see its uploaded test scenarios.';
  renderCrumbs();

  try {
    const { enhancements } = await api(`/api/products/${key}/enhancements`);
    state.enhancements = enhancements;
    renderEnhancements();
  } catch (err) {
    if (!silent) toast(err.message, true);
  }
}

function renderEnhancements() {
  const term = state.enhFilter.trim().toLowerCase();
  const items = term
    ? state.enhancements.filter((e) =>
        `${e.name} ${e.description} ${e.sourceFile}`.toLowerCase().includes(term))
    : state.enhancements;

  dom.enhancementList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    if (state.enhancements.length && term) {
      empty.innerHTML = '<h3>No match</h3><p>No enhancement matches that search.</p>';
    } else {
      empty.innerHTML = `<h3>No enhancements yet</h3>
        <p>Add the enhancement or feature you are testing and upload its test scenario CSV.</p>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '+ New Enhancement';
      btn.addEventListener('click', () => openCreateModal(state.product));
      empty.appendChild(btn);
    }
    dom.enhancementList.appendChild(empty);
    return;
  }

  items.forEach((enh) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'enh-card';
    card.innerHTML = `
      <span>
        <p class="enh-name"></p>
        <p class="enh-meta"></p>
      </span>
      <span class="enh-right">
        <span class="pill"></span>
        <span class="chev">&rsaquo;</span>
      </span>`;
    card.querySelector('.enh-name').textContent = enh.name;
    const meta = [
      enh.description,
      enh.sourceFile ? `File: ${enh.sourceFile}` : '',
      `Updated ${formatDate(enh.updatedAt)}`,
    ].filter(Boolean).join('  ·  ');
    card.querySelector('.enh-meta').textContent = meta;
    card.querySelector('.pill').textContent = plural(enh.scenarioCount, 'scenario');
    card.addEventListener('click', () => openEnhancement(enh.id));
    dom.enhancementList.appendChild(card);
  });
}

/* ---------------- scenario table ---------------- */

async function openEnhancement(id) {
  try {
    const { enhancement, documents } = await api(`/api/enhancements/${id}`);
    state.enhancement = enhancement;
    state.enhancementDocs = documents || [];
    state.view = 'scenarios';
    state.scenarioFilter = '';
    state.openTestCases = new Set();
    dom.scenarioSearch.value = '';

    hideAllViews();
    dom.scenarioView.hidden = false;
    dom.renameForm.hidden = true;
    dom.enhancementTitle.textContent = enhancement.name;
    dom.enhancementSub.textContent = [
      productLabel(enhancement.product),
      enhancement.description,
      enhancement.sourceFile ? `Source: ${enhancement.sourceFile}` : '',
      `Uploaded ${formatDate(enhancement.createdAt)}`,
    ].filter(Boolean).join('  ·  ');
    dom.exportBtn.href = `/api/enhancements/${enhancement.id}/export.csv`;

    const linked = state.enhancementDocs[0];
    dom.docLinkBtn.hidden = !linked;
    if (linked) dom.docLinkBtn.onclick = () => openDocuments({ expand: linked.id });

    renderCrumbs();
    renderScenarios();
    renderAddBoxExtras();
  } catch (err) {
    toast(err.message, true);
  }
}

/* One input per extra column, so a manually added row can fill them too.
   Built here (not in renderScenarios) so searching never wipes what you typed. */
function renderAddBoxExtras() {
  dom.addScenarioExtras.innerHTML = '';
  (state.enhancement.extraColumns || []).forEach((col) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.placeholder = col;
    input.dataset.col = col;
    input.autocomplete = 'off';
    dom.addScenarioExtras.appendChild(input);
  });
}

async function addScenarioInTool(event) {
  event.preventDefault();
  const enh = state.enhancement;
  if (!enh) return;

  const text = dom.addScenarioText.value.trim();
  if (!text) {
    dom.addScenarioText.focus();
    toast('Type the test scenario before adding it.', true);
    return;
  }

  const extra = {};
  dom.addScenarioExtras.querySelectorAll('input[data-col]').forEach((input) => {
    extra[input.dataset.col] = input.value;
  });

  dom.addScenarioBtn.disabled = true;
  try {
    const result = await api(`/api/enhancements/${enh.id}/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: text, extra }),
    });

    state.enhancement = result.enhancement;
    dom.addScenarioText.value = '';
    dom.addScenarioExtras.querySelectorAll('input[data-col]').forEach((input) => { input.value = ''; });

    // clear any active search so the newly added row is actually visible
    state.scenarioFilter = '';
    dom.scenarioSearch.value = '';
    renderScenarios();
    await loadProducts();
    toast(`Added as test scenario ${result.sno}.`);
    dom.addScenarioText.focus();
  } catch (err) {
    toast(err.message, true);
  } finally {
    dom.addScenarioBtn.disabled = false;
  }
}

function renderScenarios() {
  const enh = state.enhancement;
  if (!enh) return;

  const columns = ['S.No', 'Test Scenario', ...enh.extraColumns];
  dom.scenarioHead.innerHTML = '';
  const headRow = document.createElement('tr');
  columns.forEach((name, idx) => {
    const th = document.createElement('th');
    th.textContent = name;
    if (idx === 0) th.className = 'sno';
    headRow.appendChild(th);
  });
  const actHead = document.createElement('th');
  actHead.className = 'act';
  actHead.textContent = 'Action';
  headRow.appendChild(actHead);
  dom.scenarioHead.appendChild(headRow);

  const term = state.scenarioFilter.trim().toLowerCase();
  const rows = term
    ? enh.scenarios.filter((s) =>
        `${s.scenario} ${Object.values(s.extra || {}).join(' ')}`.toLowerCase().includes(term))
    : enh.scenarios;

  dom.scenarioBody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length + 1; // + the Action column
    td.textContent = term ? 'No test scenario matches that search.' : 'No test scenarios uploaded yet.';
    tr.appendChild(td);
    dom.scenarioBody.appendChild(tr);
  }

  // Every scenario gets its own row, numbered sequentially.
  rows.forEach((scenario) => {
    const tr = document.createElement('tr');
    const sno = document.createElement('td');
    sno.className = 'sno';
    sno.textContent = scenario.sno;
    tr.appendChild(sno);

    const text = document.createElement('td');
    text.textContent = scenario.scenario;
    tr.appendChild(text);

    enh.extraColumns.forEach((col) => {
      const td = document.createElement('td');
      td.textContent = (scenario.extra || {})[col] || '';
      tr.appendChild(td);
    });

    const act = document.createElement('td');
    act.className = 'act';

    const tcBtn = document.createElement('button');
    tcBtn.type = 'button';
    tcBtn.className = 'tc-btn';
    const open = state.openTestCases.has(scenario.sno);
    tcBtn.textContent = open ? 'Hide Test Cases' : 'Test Cases';
    tcBtn.title = `Detailed test cases for test scenario ${scenario.sno}`;
    tcBtn.addEventListener('click', () => toggleTestCases(scenario.sno));
    act.appendChild(tcBtn);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.textContent = 'Delete';
    del.title = `Delete test scenario ${scenario.sno}`;
    del.addEventListener('click', () => deleteScenarioRow(scenario.sno, scenario.scenario, del));
    act.appendChild(del);
    tr.appendChild(act);

    dom.scenarioBody.appendChild(tr);

    // Expanded detail row sits directly under its scenario, spanning the table.
    if (state.openTestCases.has(scenario.sno)) {
      dom.scenarioBody.appendChild(buildTestCaseRow(scenario, columns.length + 1));
    }
  });

  if (term) {
    dom.scenarioFoot.textContent = `Showing ${rows.length} of ${plural(enh.scenarios.length, 'test scenario')}`;
  } else if (!enh.scenarios.length) {
    dom.scenarioFoot.textContent = 'No test scenarios yet — upload a CSV or add one below.';
  } else {
    dom.scenarioFoot.textContent = `${plural(enh.scenarios.length, 'test scenario')} · serial numbers 1 to ${enh.scenarios.length}`;
  }
}

/* ---------------- test cases (Claude-generated) ---------------- */

const TC_COLUMNS = ['Test Case', 'Test Scenario', 'Preconditions', 'Test Steps', 'Expected Result'];

function toggleTestCases(sno) {
  if (state.openTestCases.has(sno)) state.openTestCases.delete(sno);
  else state.openTestCases.add(sno);
  renderScenarios();
}

function buildTestCaseRow(scenario, colSpan) {
  const tr = document.createElement('tr');
  tr.className = 'tc-row';
  const td = document.createElement('td');
  td.colSpan = colSpan;

  const panel = document.createElement('div');
  panel.className = 'tc-panel';

  const head = document.createElement('div');
  head.className = 'tc-head';
  const title = document.createElement('span');
  title.className = 'tc-title';
  title.textContent = `Test cases for test scenario ${scenario.sno}`;
  head.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'tc-meta';
  head.appendChild(meta);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'btn btn-outline tc-action';
  head.appendChild(action);

  const body = document.createElement('div');
  body.className = 'tc-body';

  panel.appendChild(head);
  panel.appendChild(body);
  td.appendChild(panel);
  tr.appendChild(td);

  const cases = scenario.testCases || [];
  if (cases.length) {
    const info = scenario.testCasesMeta || {};
    meta.textContent = info.generatedAt ? `Generated ${formatDate(info.generatedAt)} · ${info.model || ''}` : '';
    action.textContent = 'Regenerate';
    action.addEventListener('click', () => runTestCases(scenario.sno, true, action, body));
    body.appendChild(renderTestCaseTable(cases));
  } else {
    meta.textContent = 'Not generated yet';
    action.textContent = 'Generate test cases';
    action.classList.add('btn-primary');
    action.classList.remove('btn-outline');
    action.addEventListener('click', () => runTestCases(scenario.sno, false, action, body));
    const hint = document.createElement('p');
    hint.className = 'tc-hint';
    hint.textContent =
      'AI writes the Test Case, Preconditions, Test Steps and Expected Result for this scenario. You can regenerate any time.';
    body.appendChild(hint);
  }

  return tr;
}

function renderTestCaseTable(cases) {
  const wrap = document.createElement('div');
  wrap.className = 'tc-table-wrap';

  const table = document.createElement('table');
  table.className = 'tc-table';

  // fixed column proportions keep the five columns readable instead of cramped
  const colgroup = document.createElement('colgroup');
  ['c1', 'c2', 'c3', 'c4', 'c5'].forEach((cls) => {
    const col = document.createElement('col');
    col.className = cls;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  TC_COLUMNS.forEach((name) => {
    const th = document.createElement('th');
    th.textContent = name;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  cases.forEach((tc) => {
    const row = document.createElement('tr');

    const idCell = document.createElement('td');
    idCell.className = 'tc-id';
    const idText = document.createElement('strong');
    idText.textContent = tc.id || '';
    idCell.appendChild(idText);
    if (tc.title) {
      const sub = document.createElement('span');
      sub.className = 'tc-id-sub';
      sub.textContent = tc.title;
      idCell.appendChild(sub);
    }
    row.appendChild(idCell);

    [tc.testScenario, tc.preconditions].forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value || '';
      row.appendChild(td);
    });

    const steps = document.createElement('td');
    const ol = document.createElement('ol');
    ol.className = 'tc-steps';
    (tc.testSteps || []).forEach((step) => {
      const li = document.createElement('li');
      li.textContent = step;
      ol.appendChild(li);
    });
    steps.appendChild(ol);
    row.appendChild(steps);

    const expected = document.createElement('td');
    expected.textContent = tc.expectedResult || '';
    row.appendChild(expected);

    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

async function runTestCases(sno, regenerate, button, body) {
  const enh = state.enhancement;
  if (!enh) return;

  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = 'Generating…';
  body.innerHTML = '';
  const loading = document.createElement('p');
  loading.className = 'tc-loading';
  loading.textContent = 'Writing the test cases — this usually takes 10–30 seconds…';
  body.appendChild(loading);

  try {
    const result = await api(`/api/enhancements/${enh.id}/scenarios/${sno}/testcases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate: Boolean(regenerate) }),
    });

    const scenario = state.enhancement.scenarios.find((s) => Number(s.sno) === Number(sno));
    if (scenario) {
      scenario.testCases = result.testCases;
      scenario.testCasesMeta = result.meta;
    }
    renderScenarios();
    toast(`${result.testCases.length} test case(s) ready for scenario ${sno}.`);
  } catch (err) {
    button.disabled = false;
    button.textContent = previousLabel;
    body.innerHTML = '';
    const problem = document.createElement('p');
    problem.className = 'tc-error';
    problem.textContent = err.message;
    body.appendChild(problem);
  }
}

/* ---------------- rename the open enhancement ---------------- */

function startRename() {
  if (!state.enhancement) return;
  dom.renameInput.value = state.enhancement.name;
  dom.renameForm.hidden = false;
  dom.renameInput.focus();
  dom.renameInput.select();
}

function cancelRename() {
  dom.renameForm.hidden = true;
}

async function submitRename(event) {
  event.preventDefault();
  const enh = state.enhancement;
  if (!enh) return;

  const name = dom.renameInput.value.trim();
  if (!name) {
    toast('Enter a name.', true);
    return;
  }
  if (name === enh.name) {
    cancelRename();
    return;
  }

  try {
    await api(`/api/enhancements/${enh.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    cancelRename();
    await loadProducts();
    await openEnhancement(enh.id);
    toast('Name updated.');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- yes / no confirm ---------------- */

let confirmResolve = null;

function askConfirm(question, quote) {
  el('confirmText').textContent = question;
  const quoteEl = el('confirmQuote');
  quoteEl.textContent = quote || '';
  quoteEl.hidden = !quote;
  el('confirmModal').hidden = false;
  setTimeout(() => el('confirmNo').focus(), 30);

  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(answer) {
  el('confirmModal').hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(answer);
}

async function deleteScenarioRow(sno, text, button) {
  const enh = state.enhancement;
  if (!enh) return;

  const yes = await askConfirm(`Delete test scenario ${sno} from "${enh.name}"?`, text);
  if (!yes) return;

  button.disabled = true;
  try {
    const result = await api(`/api/enhancements/${enh.id}/scenarios/${sno}`, { method: 'DELETE' });
    state.enhancement = result.enhancement;
    renderScenarios();          // remaining rows are renumbered 1..N by the server
    renderAddBoxExtras();
    await loadProducts();
    toast(`Test scenario ${sno} deleted.`);
  } catch (err) {
    button.disabled = false;
    toast(err.message, true);
  }
}

/* ---------------- breadcrumbs ---------------- */

function renderCrumbs() {
  dom.crumbs.innerHTML = '';

  const add = (text, onClick) => {
    if (dom.crumbs.childNodes.length) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      dom.crumbs.appendChild(sep);
    }
    if (onClick) {
      const a = document.createElement('a');
      a.textContent = text;
      a.addEventListener('click', onClick);
      dom.crumbs.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.textContent = text;
      dom.crumbs.appendChild(span);
    }
  };

  const away = state.product || state.view === 'documents';
  add('Dashboard', away ? () => resetToDashboard() : null);

  if (state.view === 'documents') {
    add('Enhancement Documents', null);
    return;
  }

  if (state.product) {
    add(productLabel(state.product), state.enhancement ? () => openProduct(state.product) : null);
  }
  if (state.enhancement) add(state.enhancement.name, null);
}

function resetToDashboard() {
  state.product = null;
  state.enhancement = null;
  state.enhancements = [];
  state.view = 'dashboard';
  renderProducts();
  renderCrumbs();
  hideAllViews();
  dom.enhancementView.hidden = false;
  dom.enhancementSearch.hidden = true;
  dom.addForProductBtn.hidden = true;
  dom.productTitle.textContent = 'Dashboard';
  dom.productSub.textContent = 'Test scenarios and enhancement documents across every product.';
  renderDashboard();
}

/** Landing view: the totals at a glance, then a card per product. */
function renderDashboard() {
  dom.enhancementList.innerHTML = '';

  const totals = state.products.reduce(
    (acc, p) => ({
      enhancements: acc.enhancements + p.enhancementCount,
      scenarios: acc.scenarios + p.scenarioCount,
      testCases: acc.testCases + (p.testCaseCount || 0),
    }),
    { enhancements: 0, scenarios: 0, testCases: 0 }
  );

  const stats = document.createElement('div');
  stats.className = 'stat-row';
  [
    ['Enhancements', totals.enhancements, 'features and customizations under test'],
    ['Test scenarios', totals.scenarios, 'rows across every enhancement'],
    ['Scenarios with test cases', totals.testCases, 'expanded into detailed test cases'],
    ['Documents', state.documentCount || 0, 'write-ups with matter and screenshots'],
  ].forEach(([label, value, hint]) => {
    const tile = document.createElement('div');
    tile.className = 'stat';
    tile.innerHTML = '<p class="stat-value"></p><p class="stat-label"></p><p class="stat-hint"></p>';
    tile.querySelector('.stat-value').textContent = value;
    tile.querySelector('.stat-label').textContent = label;
    tile.querySelector('.stat-hint').textContent = hint;
    stats.appendChild(tile);
  });
  dom.enhancementList.appendChild(stats);

  const heading = document.createElement('p');
  heading.className = 'section-head';
  heading.textContent = 'Products';
  dom.enhancementList.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'home-grid';

  state.products.forEach((product) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'home-card';
    card.innerHTML = `
      <span class="home-card-top">
        <span class="p-chip"></span>
        <span class="home-card-name"></span>
      </span>
      <span class="home-card-blurb"></span>
      <span class="home-card-stats"></span>`;
    card.querySelector('.p-chip').textContent = monogram(product.label);
    card.querySelector('.home-card-name').textContent = product.label;
    card.querySelector('.home-card-blurb').textContent = product.blurb;
    card.querySelector('.home-card-stats').textContent = [
      plural(product.enhancementCount, 'enhancement'),
      plural(product.scenarioCount, 'scenario'),
      `${product.documentCount || 0} doc${(product.documentCount || 0) === 1 ? '' : 's'}`,
    ].join('  ·  ');
    card.addEventListener('click', () => openProduct(product.key));
    grid.appendChild(card);
  });

  dom.enhancementList.appendChild(grid);
}

/* ---------------- enhancement documents ---------------- */

const KIND_LABEL = { docx: 'Word document', pdf: 'PDF', image: 'Screenshot', text: 'Text / Markdown' };

function hideAllViews() {
  dom.enhancementView.hidden = true;
  dom.scenarioView.hidden = true;
  dom.documentsView.hidden = true;
}

async function openDocuments({ expand } = {}) {
  state.product = null;
  state.enhancement = null;
  state.view = 'documents';
  state.docFilter = '';
  dom.documentSearch.value = '';

  hideAllViews();
  dom.documentsView.hidden = false;

  try {
    const { documents } = await api('/api/documents');
    state.documents = documents;

    if (expand) {
      const target = documents.find((d) => d.id === expand);
      if (target) state.docTab = target.product || 'unassigned';
      await loadDocumentBody(expand);
      state.openDocs.add(expand);
    } else if (!documentsInTab(state.docTab).length) {
      // land on a tab that actually has something in it
      const firstFilled = docTabs().find((t) => documentsInTab(t.key).length);
      if (firstFilled) state.docTab = firstFilled.key;
    }

    renderProducts();
    renderCrumbs();
    renderDocTabs();
    renderDocuments();
  } catch (err) {
    toast(err.message, true);
  }
}

/** One tab per product, plus a transitional tab for documents with no product. */
function docTabs() {
  const tabs = state.products.map((p) => ({ key: p.key, label: p.label }));
  if (state.documents.some((d) => !d.product)) tabs.push({ key: 'unassigned', label: 'Unassigned' });
  return tabs;
}

function documentsInTab(tabKey) {
  return state.documents.filter((d) => (tabKey === 'unassigned' ? !d.product : d.product === tabKey));
}

function renderDocTabs() {
  dom.docTabs.innerHTML = '';
  docTabs().forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tab${state.docTab === tab.key ? ' active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', state.docTab === tab.key ? 'true' : 'false');

    const label = document.createElement('span');
    label.textContent = tab.label;
    btn.appendChild(label);

    const count = document.createElement('span');
    count.className = 'tab-count';
    count.textContent = documentsInTab(tab.key).length;
    btn.appendChild(count);

    btn.addEventListener('click', () => {
      state.docTab = tab.key;
      renderDocTabs();
      renderDocuments();
    });
    dom.docTabs.appendChild(btn);
  });
}

/** Fetch the document once; the body is kept for as long as the page lives. */
async function loadDocumentBody(id) {
  if (state.docBodies[id]) return state.docBodies[id];
  const { document: doc } = await api(`/api/documents/${id}`);
  state.docBodies[id] = doc;
  return doc;
}

/**
 * The card is a dropdown: click to open the document, click again to close it.
 * Only one document stays open — opening another closes the previous one.
 */
async function toggleDocument(id, { startEditing = false } = {}) {
  if (state.openDocs.has(id) && !startEditing) {
    state.openDocs.delete(id);
    renderDocuments();
    return;
  }

  try {
    await loadDocumentBody(id);
    state.openDocs.clear();          // only one document stays open at a time
    state.openDocs.add(id);
    state.editingDoc = startEditing ? id : null;
    renderDocuments();
  } catch (err) {
    toast(err.message, true);
  }
}

function documentMeta(doc) {
  return [
    KIND_LABEL[doc.kind] || doc.kind,
    doc.product ? productLabel(doc.product) : '',
    doc.description,
    `File: ${doc.fileName}`,
    doc.imageCount ? plural(doc.imageCount, 'screenshot') : '',
    `Added ${formatDate(doc.createdAt)}`,
  ].filter(Boolean).join('  ·  ');
}

function renderDocuments() {
  const term = state.docFilter.trim().toLowerCase();
  const inTab = documentsInTab(state.docTab);
  const items = term
    ? inTab.filter((d) => `${d.name} ${d.description} ${d.fileName}`.toLowerCase().includes(term))
    : inTab;

  dom.documentList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    if (inTab.length && term) {
      empty.innerHTML = '<h3>No match</h3><p>No document in this tab matches that search.</p>';
    } else {
      const where = state.docTab === 'unassigned' ? '' : ` for ${productLabel(state.docTab)}`;
      empty.innerHTML = `<h3>No documents${where} yet</h3>
        <p>Upload the write-up for an enhancement or customization — the matter and its screenshots
        are shown right here. You can also attach one while creating a new enhancement.</p>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '+ Upload document';
      btn.addEventListener('click', openDocumentModal);
      empty.appendChild(btn);
    }
    dom.documentList.appendChild(empty);
    return;
  }

  items.forEach((doc) => {
    const open = state.openDocs.has(doc.id);
    const wrap = document.createElement('div');
    wrap.className = `doc-item${open ? ' open' : ''}`;

    // A div, not a button: the Edit control lives inside the header next to the
    // name, and a button cannot legally contain another button.
    const card = document.createElement('div');
    card.className = 'enh-card doc-card';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.setAttribute('aria-expanded', open ? 'true' : 'false');
    card.innerHTML = `
      <span class="doc-card-main">
        <span class="doc-name-row">
          <span class="enh-name"></span>
          <button type="button" class="edit-btn doc-edit-btn">Edit</button>
        </span>
        <p class="enh-meta"></p>
      </span>
      <span class="enh-right">
        <span class="pill ghost"></span>
        <span class="chev"></span>
      </span>`;
    card.querySelector('.enh-name').textContent = doc.name;
    card.querySelector('.enh-meta').textContent = documentMeta(doc);
    card.querySelector('.pill').textContent = KIND_LABEL[doc.kind] || doc.kind;
    card.querySelector('.chev').textContent = open ? '▾' : '▸';
    card.title = open ? 'Click to close this document' : 'Click to open this document';

    const toggle = () => toggleDocument(doc.id);
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    const editBtn = card.querySelector('.doc-edit-btn');
    editBtn.title = 'Rename this document or move it to another product';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();                       // never toggles the card
      toggleDocument(doc.id, { startEditing: true });
    });

    wrap.appendChild(card);

    if (open) wrap.appendChild(buildDocumentPanel(state.docBodies[doc.id] || doc));
    dom.documentList.appendChild(wrap);
  });
}

function buildDocumentPanel(doc) {
  const panel = document.createElement('div');
  panel.className = 'doc-panel';

  const bar = document.createElement('div');
  bar.className = 'doc-bar';

  const label = document.createElement('span');
  label.className = 'doc-bar-label';
  label.textContent = doc.fileName;
  bar.appendChild(label);

  const download = document.createElement('a');
  download.className = 'btn btn-outline doc-bar-btn';
  download.textContent = 'Download original';
  download.href = `/api/documents/${doc.id}/file?download=1`;
  download.setAttribute('download', '');
  bar.appendChild(download);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-outline doc-bar-btn';
  close.textContent = 'Close';
  close.addEventListener('click', () => toggleDocument(doc.id));
  bar.appendChild(close);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-danger doc-bar-btn';
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteDocument(doc));
  bar.appendChild(del);

  panel.appendChild(bar);

  // Edit row: rename, and move the document to another product tab.
  const editRow = document.createElement('form');
  editRow.className = 'doc-edit';
  editRow.hidden = state.editingDoc !== doc.id;

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'input';
  nameInput.maxLength = 140;
  nameInput.value = doc.name;
  nameInput.setAttribute('aria-label', 'Document name');
  editRow.appendChild(nameInput);

  const productSelect = document.createElement('select');
  productSelect.className = 'input doc-edit-product';
  state.products.forEach((p) => {
    const option = document.createElement('option');
    option.value = p.key;
    option.textContent = p.label;
    productSelect.appendChild(option);
  });
  const noneOption = document.createElement('option');
  noneOption.value = '';
  noneOption.textContent = 'Unassigned';
  productSelect.appendChild(noneOption);
  productSelect.value = doc.product || '';
  editRow.appendChild(productSelect);

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-primary doc-bar-btn';
  save.textContent = 'Save';
  editRow.appendChild(save);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-outline doc-bar-btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { editRow.hidden = true; state.editingDoc = null; });
  editRow.appendChild(cancel);

  editRow.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!nameInput.value.trim()) {
      toast('The document needs a name.', true);
      return;
    }
    save.disabled = true;
    try {
      await api(`/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value, product: productSelect.value }),
      });
      delete state.docBodies[doc.id];
      state.docTab = productSelect.value || 'unassigned';
      await openDocuments({ expand: doc.id });
      toast('Document updated.');
    } catch (err) {
      toast(err.message, true);
    } finally {
      save.disabled = false;
    }
  });

  panel.appendChild(editRow);

  const body = document.createElement('div');
  body.className = 'doc-body';

  if (doc.kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'doc-pdf';
    frame.src = `/api/documents/${doc.id}/file`;
    frame.title = doc.name;
    body.appendChild(frame);
  } else if (doc.kind === 'image') {
    const figure = document.createElement('figure');
    figure.className = 'doc-figure';
    const img = document.createElement('img');
    img.src = `/api/documents/${doc.id}/file`;
    img.alt = doc.name;
    figure.appendChild(img);
    body.appendChild(figure);
  } else {
    // .docx / .md / .txt were converted to a safe HTML subset on the server
    const article = document.createElement('article');
    article.className = 'doc-article';
    article.innerHTML = doc.html || '<p class="doc-empty">This document has no readable text.</p>';
    body.appendChild(article);
  }

  panel.appendChild(body);
  return panel;
}

async function deleteDocument(doc) {
  if (!doc) return;

  const yes = await askConfirm(`Delete the document "${doc.name}"?`, doc.fileName);
  if (!yes) return;

  try {
    await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
    state.openDocs.delete(doc.id);
    delete state.docBodies[doc.id];
    await loadProducts();
    await openDocuments();
    toast('Document deleted.');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- upload dialog ---------------- */

let modalMode = 'create'; // 'create' | 'reupload' | 'document'

const HINTS = {
  create:
    'Both files are optional — attach either one, or both. CSV/XLSX: columns S.No and Test Scenario (extra columns are kept); serial numbers are re-generated. Document: .docx keeps its text and screenshots, PDFs open in the viewer.',
  scenarios:
    'Expected columns: S.No and Test Scenario. Extra columns such as Priority or Expected Result are kept and shown too. Serial numbers are re-generated so every scenario sits on its own numbered row.',
  document:
    'Word documents (.docx) are shown inside the tool with their screenshots, exactly where they sit in the text. PDFs open in the built-in viewer, images show as a single screenshot, and .md/.txt are formatted as text.',
};

/** Show only the fields that belong to the current dialog mode. */
function applyModalMode() {
  const isCreate = modalMode === 'create';
  const isReupload = modalMode === 'reupload';
  const isDocument = modalMode === 'document';

  dom.productField.hidden = isReupload;
  dom.nameField.hidden = isReupload;
  dom.descField.hidden = isReupload;
  dom.modeField.hidden = !isReupload;
  dom.fileField.hidden = isDocument;
  dom.splitField.hidden = isDocument;
  dom.docField.hidden = isReupload;
  dom.modalHint.textContent = isDocument ? HINTS.document : (isCreate ? HINTS.create : HINTS.scenarios);

  dom.docFieldLabel.innerHTML = isDocument
    ? 'Document file <em>(.docx, .pdf, .md, .txt, image)</em>'
    : 'Enhancement document <em>(optional — .docx, .pdf, .md, .txt, image)</em>';
  dom.fileFieldLabel.innerHTML = isCreate
    ? 'Test scenarios file <em>(optional — .csv, .xlsx, .xls)</em>'
    : 'Test scenarios file <em>(.csv, .xlsx, .xls)</em>';
  dom.nameFieldLabel.textContent = isDocument ? 'Document name (optional)' : 'Enhancement / feature name';
}

function openCreateModal(productKey) {
  modalMode = 'create';
  dom.modalTitle.textContent = 'New enhancement';
  dom.modalProduct.value = productKey || state.product || (state.products[0] && state.products[0].key);
  dom.modalName.value = '';
  dom.modalDesc.value = '';
  dom.modalSubmit.textContent = 'Create & upload';
  applyModalMode();
  showModal();
}

function openReuploadModal() {
  modalMode = 'reupload';
  dom.modalTitle.textContent = `Upload / add scenarios — ${state.enhancement.name}`;
  dom.modalMode.value = 'replace';
  dom.modalSubmit.textContent = 'Upload scenarios';
  applyModalMode();
  showModal();
}

function openDocumentModal() {
  modalMode = 'document';
  dom.modalTitle.textContent = 'Upload enhancement document';
  const tabProduct = state.docTab && state.docTab !== 'unassigned' ? state.docTab : null;
  dom.modalProduct.value = tabProduct || state.product || (state.products[0] && state.products[0].key);
  dom.modalName.value = '';
  dom.modalDesc.value = '';
  dom.modalSubmit.textContent = 'Upload document';
  applyModalMode();
  showModal();
}

function showModal() {
  dom.modalError.hidden = true;
  dom.modalFile.value = '';
  dom.modalDoc.value = '';
  dom.modal.hidden = false;
  setTimeout(() => (modalMode === 'reupload' ? dom.modalFile : dom.modalName).focus(), 30);
}

function closeModal() {
  dom.modal.hidden = true;
  dom.uploadForm.reset();
  dom.modalSplit.checked = true;
}

function modalError(message) {
  dom.modalError.textContent = message;
  dom.modalError.hidden = false;
}

async function submitUpload(event) {
  event.preventDefault();
  dom.modalError.hidden = true;

  const isDocument = modalMode === 'document';

  if (isDocument && !dom.modalDoc.files.length) {
    modalError('Choose the document file (.docx, .pdf, .md, .txt or an image).');
    return;
  }
  if (modalMode === 'reupload' && !dom.modalFile.files.length) {
    modalError('Choose a .csv or .xlsx file of test scenarios.');
    return;
  }
  if (modalMode === 'create' && !dom.modalFile.files.length && !dom.modalDoc.files.length) {
    modalError('Attach a test scenario file, a document, or both — at least one is needed.');
    return;
  }
  if (modalMode === 'create' && !dom.modalName.value.trim()) {
    modalError('Enter the enhancement / feature name.');
    return;
  }

  const body = new FormData();
  let url;

  if (isDocument) {
    url = '/api/documents';
    body.append('file', dom.modalDoc.files[0]);
    body.append('name', dom.modalName.value);
    body.append('description', dom.modalDesc.value);
    body.append('product', dom.modalProduct.value);   // keeps each product's documents separate
  } else {
    if (dom.modalFile.files.length) body.append('file', dom.modalFile.files[0]);
    body.append('splitLines', dom.modalSplit.checked ? 'true' : 'false');

    if (modalMode === 'create') {
      url = '/api/enhancements';
      body.append('product', dom.modalProduct.value);
      body.append('name', dom.modalName.value);
      body.append('description', dom.modalDesc.value);
      if (dom.modalDoc.files.length) body.append('document', dom.modalDoc.files[0]);
    } else {
      url = `/api/enhancements/${state.enhancement.id}/scenarios`;
      body.append('mode', dom.modalMode.value);
    }
  }

  dom.modalSubmit.disabled = true;
  dom.modalSubmit.textContent = 'Uploading…';
  try {
    const result = await api(url, { method: 'POST', body });
    closeModal();
    await loadProducts();

    if (isDocument) {
      toast(`Document "${result.document.name}" stored.`);
      await openDocuments({ expand: result.document.id });
    } else {
      const skipped = result.skipped ? `, ${result.skipped} empty row(s) skipped` : '';
      const withDoc = result.document ? ' Document stored.' : '';
      toast(result.imported
        ? `${result.imported} test scenario(s) imported${skipped}.${withDoc}`
        : `Enhancement created.${withDoc || ' Add scenarios whenever you are ready.'}`);

      if (modalMode === 'create') {
        await openProduct(result.enhancement.product);
        await openEnhancement(result.enhancement.id);
      } else {
        await openEnhancement(state.enhancement.id);
      }
    }
  } catch (err) {
    modalError(err.message);
  } finally {
    dom.modalSubmit.disabled = false;
    dom.modalSubmit.textContent = modalMode === 'create' ? 'Create & upload' : 'Upload';
  }
}

async function deleteEnhancement() {
  const enh = state.enhancement;
  if (!enh) return;
  if (!window.confirm(`Delete "${enh.name}" and its ${plural(enh.scenarios.length, 'test scenario')}?`)) return;

  try {
    await api(`/api/enhancements/${enh.id}`, { method: 'DELETE' });
    const product = enh.product;
    state.enhancement = null;
    await loadProducts();
    await openProduct(product);
    toast('Enhancement deleted.');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- wiring ---------------- */

el('newEnhancementBtn').addEventListener('click', () => openCreateModal(state.product));
dom.addForProductBtn.addEventListener('click', () => openCreateModal(state.product));
dom.reuploadBtn.addEventListener('click', openReuploadModal);
dom.deleteBtn.addEventListener('click', deleteEnhancement);
dom.uploadForm.addEventListener('submit', submitUpload);
dom.addScenarioForm.addEventListener('submit', addScenarioInTool);
dom.renameEnhancementBtn.addEventListener('click', startRename);
dom.renameForm.addEventListener('submit', submitRename);
el('renameCancel').addEventListener('click', cancelRename);
el('addDocumentBtn').addEventListener('click', openDocumentModal);
dom.documentSearch.addEventListener('input', (e) => {
  state.docFilter = e.target.value;
  renderDocuments();
});
el('modalClose').addEventListener('click', closeModal);
el('modalCancel').addEventListener('click', closeModal);
dom.modal.addEventListener('click', (e) => { if (e.target === dom.modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dom.modal.hidden) closeModal(); });

// confirm dialog: Yes deletes, No / ✕ / Escape / backdrop all cancel
el('confirmYes').addEventListener('click', () => settleConfirm(true));
el('confirmNo').addEventListener('click', () => settleConfirm(false));
el('confirmClose').addEventListener('click', () => settleConfirm(false));
el('confirmModal').addEventListener('click', (e) => { if (e.target === el('confirmModal')) settleConfirm(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el('confirmModal').hidden) settleConfirm(false);
});

dom.enhancementSearch.addEventListener('input', (e) => {
  state.enhFilter = e.target.value;
  renderEnhancements();
});
dom.scenarioSearch.addEventListener('input', (e) => {
  state.scenarioFilter = e.target.value;
  renderScenarios();
});

(async function init() {
  try {
    await loadProducts();
    resetToDashboard();
  } catch (err) {
    toast(`Could not reach the server: ${err.message}`, true);
  }
})();
