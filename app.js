import { readTag } from './ocr.js?v=7';

// ---------- formatos (pt-BR, R$) ----------
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const NUM2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INT = new Intl.NumberFormat('pt-BR');
const KG = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const DAY = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const MONTH = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
const STAMP = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const fmt = cents => BRL.format(cents / 100);
const toInput = cents => NUM2.format(cents / 100);
const perUnit = it => (it.unit === 'kg' ? 'kg' : 'un');
const subtotal = it => Math.round(it.price * it.qty);
const plural = (n, one, many) => `${INT.format(n)} ${n === 1 ? one : many}`;
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const $ = (sel, root = document) => root.querySelector(sel);

// Aceita "4,99", "4.99", "R$ 1.234,56", "5".
function parseMoney(text) {
  const s = String(text ?? '').replace(/[^\d,.]/g, '');
  if (!/\d/.test(s)) return null;
  const sep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  const decLen = sep >= 0 ? s.length - sep - 1 : 0;
  let whole = s;
  let dec = '';
  if (sep >= 0 && decLen > 0 && decLen <= 2) {
    whole = s.slice(0, sep);
    dec = s.slice(sep + 1);
  }
  const cents = Number(whole.replace(/\D/g, '') || 0) * 100 + Number(dec.padEnd(2, '0') || 0);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

function parseKg(text) {
  const n = Number(String(text ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n < 100 ? Math.round(n * 1000) / 1000 : null;
}

// ---------- dados guardados no celular ----------
const STORE_KEY = 'quanto-vai-dar:v1';
const newCart = limit => ({ startedAt: Date.now(), limit: limit ?? null, items: [] });

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved?.cart && Array.isArray(saved.trips)) return saved;
  } catch {}
  return { cart: newCart(null), trips: [], lastLimit: null, lastStore: '', lastBackupAt: null };
}

const state = load();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('Não consegui salvar no celular. Veja se há espaço livre.', 'warn');
  }
}

const cartTotal = () => state.cart.items.reduce((sum, it) => sum + subtotal(it), 0);

// Última vez que o produto foi comprado (as compras ficam da mais nova para a mais antiga).
function lastPurchase(name, unit) {
  const key = norm(name);
  if (!key) return null;
  for (const trip of state.trips) {
    const it = trip.items.find(i => norm(i.name) === key && (!unit || i.unit === unit));
    if (it) return { price: it.price, unit: it.unit, date: trip.date, store: trip.store };
  }
  return null;
}

const RANK = { none: 0, ok: 0, warn: 1, over: 2 };
function limitStatus(total = cartTotal()) {
  const { limit } = state.cart;
  if (!limit) return 'none';
  if (total > limit) return 'over';
  return total >= limit * 0.8 ? 'warn' : 'ok';
}

// ---------- avisos ----------
function toast(text, kind = 'info', action) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'warn' ? 'alert' : 'status');
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { el.remove(); action.run(); });
    el.append(b);
  }
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), action ? 7000 : 5000);
}

function warnLimit(before) {
  const from = limitStatus(before);
  const to = limitStatus();
  if (RANK[to] <= RANK[from]) return;
  const { limit } = state.cart;
  if (to === 'over') {
    toast(`Passou do limite de ${fmt(limit)}! Total agora: ${fmt(cartTotal())}.`, 'warn');
    navigator.vibrate?.([150, 80, 150]);
  } else {
    toast(`Atenção: você já usou ${Math.round((cartTotal() / limit) * 100)}% do limite.`);
  }
}

function warnPrice(it) {
  const last = lastPurchase(it.name, it.unit);
  if (last && it.price > last.price) {
    const where = last.store ? ` no ${last.store}` : '';
    toast(`${it.name} está ${fmt(it.price - last.price)} mais caro que em ${DAY.format(last.date)}${where}.`, 'warn');
  }
}

// ---------- carrinho ----------
const trashIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

function priceHTML(cents) {
  const reais = Math.floor(cents / 100);
  const cc = String(cents % 100).padStart(2, '0');
  return `<span class="cur">R$</span><span class="int">${INT.format(reais)}</span><span class="cents">,${cc}</span>`;
}

function itemHTML(it) {
  const last = lastPurchase(it.name, it.unit);
  const diff = last ? it.price - last.price : 0;
  const badge = !diff ? '' : `<span class="badge ${diff > 0 ? 'up' : 'down'}" title="Última compra: ${fmt(last.price)} em ${DAY.format(last.date)}">${diff > 0 ? '▲' : '▼'} ${fmt(Math.abs(diff))} ${diff > 0 ? 'mais caro' : 'mais barato'}</span>`;
  const qty = it.unit === 'kg'
    ? `<span class="weight">${KG.format(it.qty)} kg</span>`
    : `<div class="stepper" role="group" aria-label="Quantidade de ${esc(it.name)}">
        <button type="button" data-act="dec" aria-label="${it.qty > 1 ? 'Diminuir' : 'Tirar do carrinho'}">${it.qty > 1 ? '−' : trashIcon}</button>
        <span class="qty">${it.qty}</span>
        <button type="button" data-act="inc" aria-label="Aumentar">+</button>
      </div>`;
  return `<li class="item" data-id="${it.id}">
    <button type="button" class="item-main" data-act="edit">
      <span class="item-name">${esc(it.name)}</span>
      <span class="item-meta"><span>${fmt(it.price)} / ${perUnit(it)}</span>${badge}</span>
    </button>
    <div class="item-side">
      <strong class="item-sub">${fmt(subtotal(it))}</strong>
      ${qty}
    </div>
  </li>`;
}

function renderCart() {
  const { items, limit } = state.cart;
  const total = cartTotal();
  const status = limitStatus(total);

  $('#total').innerHTML = priceHTML(total);
  $('#total').setAttribute('aria-label', `Total no carrinho: ${fmt(total)}`);
  $('#tag').dataset.status = status;
  const units = items.reduce((sum, it) => sum + (it.unit === 'kg' ? 1 : it.qty), 0);
  $('#count').textContent = items.length
    ? `${plural(items.length, 'produto', 'produtos')} · ${plural(units, 'item', 'itens')}`
    : 'Nenhum produto ainda';

  const bar = $('#limitBar');
  bar.hidden = !limit;
  if (limit) {
    bar.firstElementChild.style.width = `${Math.min(100, (total / limit) * 100)}%`;
    $('#limitBtn').textContent = status === 'over'
      ? `Limite de ${fmt(limit)} · mudar`
      : `Faltam ${fmt(limit - total)} · limite ${fmt(limit)}`;
  } else {
    $('#limitBtn').textContent = 'Definir limite de gastos';
  }

  const over = $('#overAlert');
  over.hidden = status !== 'over';
  if (status === 'over') over.textContent = `Você passou do limite em ${fmt(total - limit)}.`;

  $('#emptyCart').hidden = items.length > 0;
  $('#cartList').hidden = items.length === 0;
  $('#items').innerHTML = [...items].reverse().map(itemHTML).join('');
  $('#miniTotal').textContent = fmt(total);
}

function renderLists() {
  const names = new Map();
  for (const it of state.cart.items) names.set(norm(it.name), it.name);
  for (const trip of state.trips) for (const it of trip.items) if (!names.has(norm(it.name))) names.set(norm(it.name), it.name);
  $('#knownNames').innerHTML = [...names.values()].slice(0, 400).map(n => `<option value="${esc(n)}"></option>`).join('');
  const stores = [...new Set(state.trips.map(t => t.store).filter(Boolean))];
  $('#knownStores').innerHTML = stores.map(s => `<option value="${esc(s)}"></option>`).join('');
}

function pulse() {
  const tag = $('#tag');
  tag.classList.remove('pulse');
  void tag.offsetWidth;
  tag.classList.add('pulse');
}

function commit(before) {
  save();
  renderCart();
  renderLists();
  warnLimit(before);
  pulse();
}

function removeItem(id) {
  const items = state.cart.items;
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0) return;
  const [gone] = items.splice(idx, 1);
  save();
  renderCart();
  toast(`${gone.name} saiu do carrinho.`, 'info', {
    label: 'Desfazer',
    run: () => {
      const before = cartTotal();
      state.cart.items.splice(Math.min(idx, state.cart.items.length), 0, gone);
      commit(before);
    },
  });
}

$('#items').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const it = state.cart.items.find(i => i.id === id);
  if (!it) return;
  const before = cartTotal();
  if (btn.dataset.act === 'edit') return openItemSheet({ item: it });
  if (btn.dataset.act === 'inc') it.qty = Math.min(99, it.qty + 1);
  if (btn.dataset.act === 'dec') {
    if (it.qty <= 1) return removeItem(id);
    it.qty -= 1;
  }
  commit(before);
});

// ---------- folha do produto ----------
const itemSheet = $('#itemSheet');
let editingId = null;
let unit = 'un';
let scanToken = 0;

function setUnit(u) {
  unit = u;
  for (const b of itemSheet.querySelectorAll('[data-unit]')) b.setAttribute('aria-pressed', String(b.dataset.unit === u));
  $('#qtyUn').hidden = u !== 'un';
  $('#qtyKg').hidden = u !== 'kg';
  $('#priceLabel').textContent = u === 'kg' ? 'Preço do kg' : 'Preço';
  updatePreview();
}

function readForm() {
  return {
    name: $('#fName').value.trim().replace(/\s+/g, ' '),
    price: parseMoney($('#fPrice').value),
    unit,
    qty: unit === 'kg' ? parseKg($('#fKg').value) : Math.min(99, Math.max(1, Math.round(Number($('#fQty').value) || 1))),
  };
}

function showItemError(msg, field) {
  const el = $('#itemError');
  el.textContent = msg;
  el.hidden = !msg;
  if (field) $(field).focus();
}

function updatePreview() {
  const it = readForm();
  const note = $('#compareNote');
  const last = it.name ? lastPurchase(it.name, it.unit) : null;
  note.hidden = !last;
  if (last) {
    const when = `${DAY.format(last.date)}${last.store ? ` no ${last.store}` : ''}`;
    const diff = it.price ? it.price - last.price : null;
    if (diff === null) {
      note.className = 'note info';
      note.textContent = `Na última compra você pagou ${fmt(last.price)} / ${perUnit(it)} (${when}).`;
    } else if (diff > 0) {
      note.className = 'note up';
      note.textContent = `Mais caro que na última compra: você pagou ${fmt(last.price)} em ${when}. Diferença: ${fmt(diff)} por ${perUnit(it)}.`;
    } else if (diff < 0) {
      note.className = 'note down';
      note.textContent = `Mais barato que na última compra (${fmt(last.price)} em ${when}). Economia de ${fmt(-diff)} por ${perUnit(it)}.`;
    } else {
      note.className = 'note same';
      note.textContent = `Mesmo preço da última compra (${when}).`;
    }
  }

  const sub = $('#subtotalNote');
  if (!it.price || !it.qty) {
    sub.innerHTML = '';
    return;
  }
  const editing = state.cart.items.find(i => i.id === editingId);
  const newTotal = cartTotal() - (editing ? subtotal(editing) : 0) + subtotal(it);
  const { limit } = state.cart;
  const overBy = limit && newTotal > limit ? newTotal - limit : 0;
  sub.innerHTML = `Subtotal <strong>${fmt(subtotal(it))}</strong> · o carrinho vai para <strong>${fmt(newTotal)}</strong>`
    + (overBy ? ` <span class="over">· passa do limite em ${fmt(overBy)}</span>` : '');
}

function openItemSheet({ item = null, photo = null } = {}) {
  editingId = item?.id ?? null;
  scanToken++;
  $('#itemTitle').textContent = item ? 'Editar produto' : 'Novo produto';
  $('#itemSubmit').textContent = item ? 'Salvar alterações' : 'Adicionar ao carrinho';
  $('#itemDelete').hidden = !item;
  $('#fName').value = item?.name ?? '';
  $('#fPrice').value = item ? toInput(item.price) : '';
  $('#fQty').value = item?.unit === 'un' ? item.qty : 1;
  $('#fKg').value = item?.unit === 'kg' ? KG.format(item.qty) : '';
  $('#scan').hidden = true;
  $('#priceChips').hidden = true;
  showItemError('');
  setUnit(item?.unit ?? 'un');
  itemSheet.showModal();
  if (photo) scanPhoto(photo);
  else if (!item) $('#fName').focus();
}

function renderChips(prices) {
  const box = $('#priceChips');
  box.hidden = prices.length < 2;
  const current = parseMoney($('#fPrice').value);
  box.innerHTML = '<span class="chips-label">Preços na foto</span>'
    + prices.map(c => `<button type="button" data-cents="${c}" aria-pressed="${c === current}">${fmt(c)}</button>`).join('');
}

async function scanPhoto(file) {
  const token = ++scanToken;
  const scan = $('#scan');
  const msg = $('#scanMsg');
  const bar = $('#scanBar');
  scan.hidden = false;
  scan.dataset.state = 'busy';
  msg.textContent = 'Preparando a foto…';
  bar.style.width = '2%';
  $('#scanImg').removeAttribute('src');
  try {
    const result = await readTag(file, {
      onProgress: p => {
        if (token !== scanToken) return;
        msg.textContent = p.label;
        bar.style.width = `${Math.max(2, Math.round(p.progress * 100))}%`;
      },
      onThumb: src => { if (token === scanToken) $('#scanImg').src = src; },
    });
    if (token !== scanToken) return;
    scan.dataset.state = 'done';
    if (result.name && !$('#fName').value.trim()) $('#fName').value = result.name;
    if (result.prices.length && !$('#fPrice').value.trim()) $('#fPrice').value = toInput(result.prices[0]);
    renderChips(result.prices);
    msg.textContent = result.prices.length
      ? 'Confira o nome e o preço antes de adicionar.'
      : 'Não achei o preço na foto. Digite abaixo.';
    if (!result.name) $('#fName').placeholder = 'Não li o nome — digite aqui';
    updatePreview();
  } catch {
    if (token !== scanToken) return;
    scan.dataset.state = 'error';
    msg.textContent = navigator.onLine
      ? 'Não consegui ler a foto. Digite o nome e o preço abaixo.'
      : 'Sem internet para ler a etiqueta pela primeira vez. Digite o nome e o preço abaixo.';
  }
}

$('#priceChips').addEventListener('click', e => {
  const b = e.target.closest('[data-cents]');
  if (!b) return;
  $('#fPrice').value = toInput(Number(b.dataset.cents));
  for (const c of $('#priceChips').querySelectorAll('[data-cents]')) c.setAttribute('aria-pressed', String(c === b));
  updatePreview();
});

itemSheet.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => setUnit(b.dataset.unit)));
itemSheet.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
  const q = $('#fQty');
  q.value = Math.min(99, Math.max(1, (Math.round(Number(q.value)) || 1) + Number(b.dataset.step)));
  updatePreview();
}));

$('#fName').addEventListener('input', () => {
  // Produto já comprado por quilo? Troca para quilo sozinho.
  const last = lastPurchase($('#fName').value);
  if (last && last.unit !== unit && !$('#fPrice').value.trim()) setUnit(last.unit);
  else updatePreview();
  showItemError('');
});
for (const id of ['#fPrice', '#fQty', '#fKg']) $(id).addEventListener('input', () => { updatePreview(); showItemError(''); });
$('#fPrice').addEventListener('blur', () => {
  const c = parseMoney($('#fPrice').value);
  if (c) $('#fPrice').value = toInput(c);
});

$('#itemForm').addEventListener('submit', e => {
  e.preventDefault();
  const it = readForm();
  if (!it.name) return showItemError('Escreva o nome do produto.', '#fName');
  if (!it.price) return showItemError('Digite o preço, por exemplo 4,99.', '#fPrice');
  if (!it.qty) return showItemError('Digite o peso em quilos, por exemplo 0,750.', '#fKg');

  const before = cartTotal();
  const items = state.cart.items;
  let priceChanged = !editingId;
  if (editingId) {
    const cur = items.find(i => i.id === editingId);
    priceChanged = cur.price !== it.price || norm(cur.name) !== norm(it.name);
    Object.assign(cur, it);
  } else {
    // Mesmo produto e mesmo preço já no carrinho: só soma a quantidade.
    const twin = items.find(i => i.unit === 'un' && it.unit === 'un' && i.price === it.price && norm(i.name) === norm(it.name));
    if (twin) twin.qty = Math.min(99, twin.qty + it.qty);
    else items.push({ id: uid(), ...it, addedAt: Date.now() });
    navigator.storage?.persist?.().catch(() => {});
  }
  itemSheet.close();
  commit(before);
  if (priceChanged) warnPrice(it);
});

$('#itemDelete').addEventListener('click', () => {
  const id = editingId;
  itemSheet.close();
  removeItem(id);
});

itemSheet.addEventListener('close', () => { scanToken++; });

// ---------- câmera e digitar ----------
$('#camBtn').addEventListener('click', () => $('#camInput').click());
$('#camInput').addEventListener('change', e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) openItemSheet({ photo: file });
});
$('#typeBtn').addEventListener('click', () => openItemSheet());

// ---------- limite ----------
const limitSheet = $('#limitSheet');
$('#limitBtn').addEventListener('click', () => {
  const current = state.cart.limit ?? state.lastLimit;
  $('#fLimit').value = current ? toInput(current) : '';
  $('#limitError').hidden = true;
  limitSheet.showModal();
});
$('#limitChips').addEventListener('click', e => {
  const b = e.target.closest('[data-limit]');
  if (b) $('#fLimit').value = toInput(Number(b.dataset.limit));
});
$('#limitForm').addEventListener('submit', e => {
  e.preventDefault();
  const cents = parseMoney($('#fLimit').value);
  if (!cents) {
    $('#limitError').textContent = 'Digite um valor, por exemplo 200,00.';
    $('#limitError').hidden = false;
    return;
  }
  state.cart.limit = cents;
  state.lastLimit = cents;
  limitSheet.close();
  save();
  renderCart();
  toast(`Limite de ${fmt(cents)} definido.`);
});
$('#noLimit').addEventListener('click', () => {
  state.cart.limit = null;
  limitSheet.close();
  save();
  renderCart();
});

// ---------- finalizar compra ----------
const finishSheet = $('#finishSheet');
$('#finishBtn').addEventListener('click', () => {
  const { items } = state.cart;
  $('#finCount').textContent = plural(items.length, 'produto', 'produtos');
  $('#finTotal').textContent = fmt(cartTotal());
  $('#fStore').value = state.lastStore ?? '';
  finishSheet.showModal();
});
$('#finishForm').addEventListener('submit', e => {
  e.preventDefault();
  const { cart } = state;
  if (!cart.items.length) return finishSheet.close();
  const store = $('#fStore').value.trim();
  state.trips.unshift({
    id: uid(),
    date: Date.now(),
    store,
    limit: cart.limit,
    total: cartTotal(),
    items: cart.items.map(({ name, price, unit: u, qty }) => ({ name, price, unit: u, qty })),
  });
  state.lastStore = store;
  state.cart = newCart(cart.limit ?? state.lastLimit);
  finishSheet.close();
  save();
  renderCart();
  renderLists();
  toast('Compra salva no histórico.', 'ok');
});
$('#discardBtn').addEventListener('click', () => {
  const old = state.cart;
  state.cart = newCart(old.limit);
  finishSheet.close();
  save();
  renderCart();
  toast('Carrinho esvaziado.', 'info', {
    label: 'Desfazer',
    run: () => { state.cart = old; save(); renderCart(); },
  });
});

// ---------- histórico ----------
function searchProducts(q) {
  const key = norm(q);
  if (key.length < 2) return null;
  const found = new Map();
  for (const trip of state.trips) {
    for (const it of trip.items) {
      const k = norm(it.name);
      if (!k.includes(key)) continue;
      const id = `${k}|${it.unit}`;
      const rec = { price: it.price, date: trip.date, store: trip.store };
      const entry = found.get(id) ?? { name: it.name, unit: it.unit, last: rec, best: rec };
      if (it.price < entry.best.price) entry.best = rec;
      found.set(id, entry);
    }
  }
  return [...found.values()].slice(0, 12);
}

function renderHits() {
  const hits = searchProducts($('#search').value);
  const box = $('#hits');
  if (!hits) { box.innerHTML = ''; return; }
  if (!hits.length) { box.innerHTML = '<li class="hit-empty">Nenhum produto com esse nome nas compras salvas.</li>'; return; }
  const where = r => `${DAY.format(r.date)}${r.store ? ` · ${esc(r.store)}` : ''}`;
  box.innerHTML = hits.map(h => `<li class="hit">
    <span class="hit-name">${esc(h.name)}</span>
    <span class="hit-row"><span>Última vez · ${where(h.last)}</span><strong>${fmt(h.last.price)}/${perUnit(h)}</strong></span>
    ${h.best.price < h.last.price ? `<span class="hit-row best"><span>Mais barato · ${where(h.best)}</span><strong>${fmt(h.best.price)}/${perUnit(h)}</strong></span>` : ''}
  </li>`).join('');
}

function renderHistory() {
  const { trips } = state;
  $('#histEmpty').hidden = trips.length > 0;
  $('#search').closest('.search').hidden = trips.length === 0;
  const months = new Map();
  for (const t of trips) {
    const d = new Date(t.date);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!months.has(key)) months.set(key, { label: capitalize(MONTH.format(d)), total: 0, trips: [] });
    const m = months.get(key);
    m.total += t.total;
    m.trips.push(t);
  }
  let html = '';
  for (const m of months.values()) {
    html += `<li class="month"><h2>${m.label}</h2><span>${plural(m.trips.length, 'compra', 'compras')} · ${fmt(m.total)}</span></li>`;
    for (const t of m.trips) {
      const limitLine = !t.limit ? ''
        : t.total > t.limit
          ? `<span class="trip-limit out">${fmt(t.total - t.limit)} acima do limite</span>`
          : `<span class="trip-limit in">${fmt(t.limit - t.total)} abaixo do limite</span>`;
      html += `<li><button type="button" class="trip" data-trip="${t.id}">
        <span class="trip-date">${capitalize(WEEKDAY.format(t.date))}</span>
        <strong class="trip-total">${fmt(t.total)}</strong>
        <span class="trip-meta">${t.store ? `${esc(t.store)} · ` : ''}${plural(t.items.length, 'produto', 'produtos')}</span>
        ${limitLine}
      </button></li>`;
    }
  }
  $('#trips').innerHTML = html;
  renderHits();
  renderBackupInfo();
}

$('#search').addEventListener('input', renderHits);

const tripSheet = $('#tripSheet');
let openTripId = null;

$('#trips').addEventListener('click', e => {
  const b = e.target.closest('[data-trip]');
  if (!b) return;
  const t = state.trips.find(x => x.id === b.dataset.trip);
  if (!t) return;
  openTripId = t.id;
  $('#tripTitle').textContent = t.store || 'Compra';
  const money = c => NUM2.format(c / 100);
  const lines = t.items.map(it => `<div class="r-item">
      <div class="r-name">${esc(it.name)}</div>
      <div class="r-line"><span>${it.unit === 'kg' ? `${KG.format(it.qty)} kg` : `${it.qty} un`} x ${money(it.price)}</span><span>${money(subtotal(it))}</span></div>
    </div>`).join('');
  $('#receipt').innerHTML = `
    <div class="r-head"><strong>QUANTO VAI DAR?</strong><span>${esc(t.store || 'Supermercado')}</span><span>${STAMP.format(t.date)}</span></div>
    <div class="r-rule"></div>
    ${lines}
    <div class="r-rule"></div>
    <div class="r-total"><span>TOTAL</span><span>${fmt(t.total)}</span></div>
    ${t.limit ? `<div class="r-line ${t.total > t.limit ? 'up' : ''}"><span>Limite</span><span>${fmt(t.limit)}</span></div>` : ''}
    <div class="r-foot">${plural(t.items.length, 'produto', 'produtos')}</div>`;
  tripSheet.showModal();
});

$('#deleteTrip').addEventListener('click', () => {
  const idx = state.trips.findIndex(t => t.id === openTripId);
  tripSheet.close();
  if (idx < 0) return;
  const [gone] = state.trips.splice(idx, 1);
  save();
  renderHistory();
  renderLists();
  renderCart();
  toast('Compra apagada do histórico.', 'info', {
    label: 'Desfazer',
    run: () => {
      state.trips.splice(Math.min(idx, state.trips.length), 0, gone);
      save();
      renderHistory();
      renderLists();
      renderCart();
    },
  });
});

// ---------- backup ----------
// O arquivo leva as compras para outro celular ou para um novo endereço do app.
// Vai como .txt porque o compartilhamento do Android não aceita .json.
const BACKUP_APP = 'quanto-vai-dar';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function renderBackupInfo() {
  const el = $('#backupInfo');
  const stale = state.trips.length >= 3 && (!state.lastBackupAt || Date.now() - state.lastBackupAt > MONTH_MS);
  el.classList.toggle('stale', stale);
  if (state.lastBackupAt) {
    el.textContent = `Último backup: ${STAMP.format(state.lastBackupAt)}.${stale ? ' Já passou de um mês, que tal salvar outro?' : ''}`;
  } else {
    el.textContent = state.trips.length ? 'Você ainda não salvou nenhum backup.' : 'Mudou de celular ou de endereço do app? Restaure seu backup aqui.';
  }
}

function backupFile(now) {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const payload = {
    app: BACKUP_APP,
    version: 1,
    exportedAt: now,
    data: { cart: state.cart, trips: state.trips, lastLimit: state.lastLimit, lastStore: state.lastStore },
  };
  return new File([JSON.stringify(payload)], `quanto-vai-dar-backup-${day}.txt`, { type: 'text/plain' });
}

$('#exportBtn').addEventListener('click', async () => {
  if (!state.trips.length && !state.cart.items.length) return toast('Ainda não há compras para salvar.');
  const now = Date.now();
  const file = backupFile(now);
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Backup do Quanto Vai Dar?' });
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;   // a pessoa fechou a tela de compartilhar
    return toast('Não consegui salvar o backup. Tente de novo.', 'warn');
  }
  state.lastBackupAt = now;
  save();
  renderBackupInfo();
  toast('Backup pronto. Guarde o arquivo em um lugar seguro.', 'ok');
});

function cleanItem(it) {
  const name = String(it?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const price = Math.round(Number(it?.price));
  const u = it?.unit === 'kg' ? 'kg' : 'un';
  const qty = Number(it?.qty);
  if (!name || !(price > 0) || !(qty > 0)) return null;
  return { name, price, unit: u, qty: u === 'un' ? Math.min(99, Math.max(1, Math.round(qty))) : Math.round(qty * 1000) / 1000 };
}

const cleanLimit = v => (Number(v) > 0 ? Math.round(Number(v)) : null);

// Confere o arquivo antes de usar: aceita só o que tem cara de compra válida.
function readBackup(raw) {
  const d = raw?.app === BACKUP_APP ? raw.data : null;
  if (!d || !Array.isArray(d.trips)) return null;
  const trips = d.trips.map(t => {
    const items = (Array.isArray(t?.items) ? t.items : []).map(cleanItem).filter(Boolean);
    const date = Number(t?.date);
    if (!items.length || !Number.isFinite(date)) return null;
    return {
      id: String(t.id || uid()),
      date,
      store: String(t.store ?? '').trim().slice(0, 80),
      limit: cleanLimit(t.limit),
      total: items.reduce((sum, it) => sum + subtotal(it), 0),
      items,
    };
  }).filter(Boolean);
  const cartItems = (Array.isArray(d.cart?.items) ? d.cart.items : [])
    .map(cleanItem).filter(Boolean)
    .map(it => ({ id: uid(), ...it, addedAt: Date.now() }));
  return {
    trips,
    cart: cartItems.length ? { startedAt: Date.now(), limit: cleanLimit(d.cart.limit), items: cartItems } : null,
    lastLimit: cleanLimit(d.lastLimit),
    lastStore: String(d.lastStore ?? '').trim().slice(0, 80),
  };
}

$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  let backup = null;
  try {
    backup = readBackup(JSON.parse(await file.text()));
  } catch {}
  if (!backup) return toast('Esse arquivo não é um backup do Quanto Vai Dar?. Escolha o arquivo que começa com "quanto-vai-dar-backup".', 'warn');

  // Junta com o que já está no celular, sem apagar nada.
  const known = new Set(state.trips.map(t => t.id));
  const added = backup.trips.filter(t => !known.has(t.id));
  state.trips = [...state.trips, ...added].sort((a, b) => b.date - a.date);
  const cartRestored = !state.cart.items.length && Boolean(backup.cart);
  if (cartRestored) state.cart = backup.cart;
  state.lastLimit ??= backup.lastLimit;
  if (!state.lastStore) state.lastStore = backup.lastStore;
  save();
  renderHistory();
  renderLists();
  renderCart();
  if (!added.length && !cartRestored) return toast('Tudo o que está nesse backup já estava no celular.');
  toast(`Backup restaurado: ${plural(added.length, 'compra', 'compras')}${cartRestored ? ' e o carrinho' : ''}.`, 'ok');
});

// ---------- abas, folhas e barra de baixo ----------
let tab = 'cart';
function showTab(next) {
  tab = next;
  $('#viewCart').hidden = tab !== 'cart';
  $('#viewHistory').hidden = tab !== 'history';
  $('#cartActions').hidden = tab !== 'cart';
  for (const b of document.querySelectorAll('[data-tab]')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (tab === 'history') renderHistory();
  updateMini();
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

for (const d of document.querySelectorAll('dialog.sheet')) {
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => d.close()));
}

const dock = $('#dock');
new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight}px`)).observe(dock);

// Mostra o total pequeno no topo quando a etiqueta amarela sai da tela.
let tagVisible = true;
function updateMini() { $('#miniTotal').hidden = tagVisible || tab !== 'cart'; }
new IntersectionObserver(([entry]) => { tagVisible = entry.isIntersecting; updateMini(); }, { rootMargin: '-64px 0px 0px 0px' }).observe($('#tag'));

// ---------- modo claro / escuro ----------
// Segue o celular até a pessoa tocar no botão; depois lembra a escolha.
const THEME_KEY = 'quanto-vai-dar:tema';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme ?? (darkQuery.matches ? 'dark' : 'light');

function paintTheme() {
  const dark = currentTheme() === 'dark';
  const btn = $('#themeBtn');
  btn.dataset.mode = dark ? 'dark' : 'light';
  btn.setAttribute('aria-label', dark ? 'Ativar modo claro' : 'Ativar modo escuro');
  $('#themeColor').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
}

$('#themeBtn').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  paintTheme();
});
darkQuery.addEventListener('change', paintTheme);
paintTheme();

// ---------- instalar como app ----------
let installEvent = null;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  $('#install').hidden = false;
});
$('#install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  $('#install').hidden = true;
});
addEventListener('appinstalled', () => { $('#install').hidden = true; });

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

renderCart();
renderLists();
