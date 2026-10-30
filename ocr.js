// Lê a foto da etiqueta de preço: encontra o preço (R$) e dá um palpite para o nome do produto.
// O leitor (Tesseract.js) só é baixado na primeira foto; depois fica guardado no celular.
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

const STEP_LABELS = {
  'loading tesseract core': 'Preparando o leitor…',
  'initializing tesseract': 'Preparando o leitor…',
  'loading language traineddata': 'Baixando o português (só na primeira vez)…',
  'initializing api': 'Preparando o leitor…',
  'recognizing text': 'Lendo a etiqueta…',
};

let workerReady = null;
let report = () => {};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Não foi possível baixar o leitor de etiquetas.'));
    document.head.append(s);
  });
}

function getWorker() {
  workerReady ??= (async () => {
    await loadScript(TESSERACT_URL);
    const worker = await window.Tesseract.createWorker('por', 1, {
      logger: m => {
        const reading = m.status === 'recognizing text';
        const p = Number(m.progress) || 0;
        report({ label: STEP_LABELS[m.status] ?? 'Lendo a etiqueta…', progress: reading ? 0.3 + p * 0.7 : p * 0.3 });
      },
    });
    // Etiqueta tem texto espalhado (nome, preço grande, preço por kg): modo "texto esparso".
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    return worker;
  })().catch(err => {
    workerReady = null;
    throw err;
  });
  return workerReady;
}

// Reduz a foto, faz uma miniatura e aumenta o contraste para o OCR.
async function prepare(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);

    const t = document.createElement('canvas');
    const ts = 160 / Math.max(w, h);
    t.width = Math.round(w * ts);
    t.height = Math.round(h * ts);
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    const thumb = t.toDataURL('image/jpeg', 0.75);

    boostContrast(ctx, w, h);
    return { canvas, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function boostContrast(ctx, w, h) {
  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const v = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    gray[j] = v;
    hist[v]++;
  }
  // Estica o contraste entre os 2% mais escuros e os 2% mais claros.
  let lo = 0, hi = 255, acc = 0;
  while (lo < 254 && (acc += hist[lo]) < n * 0.02) lo++;
  acc = 0;
  while (hi > lo + 1 && (acc += hist[hi]) < n * 0.02) hi--;
  const span = Math.max(1, hi - lo);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    px[i] = px[i + 1] = px[i + 2] = ((gray[j] - lo) * 255) / span;
  }
  ctx.putImageData(image, 0, 0);
}

export async function readTag(file, { onProgress = () => {}, onThumb = () => {} } = {}) {
  report = onProgress;
  report({ label: 'Preparando a foto…', progress: 0.02 });
  const { canvas, thumb } = await prepare(file);
  onThumb(thumb);
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  const words = data.words ?? [];
  const prices = findPrices(words);
  const big = await readBigPrice(worker, canvas, words).catch(() => null);
  return {
    prices: big ? [big, ...prices.filter(p => p !== big)].slice(0, 4) : prices,
    name: guessName(data.lines ?? []),
    text: data.text ?? '',
  };
}

// Segunda leitura só em volta do maior número da etiqueta, aceitando apenas dígitos.
// Resolve o caso comum dos centavos pequenos no alto (4 ⁹⁹), que a primeira leitura confunde com aspas.
async function readBigPrice(worker, canvas, words) {
  const withDigits = words.filter(w => /\d/.test(fixDigits(w.text)) && w.confidence > 30);
  if (!withDigits.length) return null;
  const big = withDigits.reduce((a, b) => (heightOf(b) > heightOf(a) ? b : a));
  const h = heightOf(big);
  const left = Math.max(0, Math.round(big.bbox.x0 - h * 1.2));
  const top = Math.max(0, Math.round(big.bbox.y0 - h * 0.35));
  const right = Math.min(canvas.width, Math.round(big.bbox.x1 + h * 2.2));
  const bottom = Math.min(canvas.height, Math.round(big.bbox.y1 + h * 0.35));
  const valid = c => (c > 0 && c < 100000 ? c : null);
  await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789,.R$' });
  try {
    const { data } = await worker.recognize(canvas, { rectangle: { left, top, width: right - left, height: bottom - top } });
    const text = (data.text ?? '').replace(/R\$?/g, ' ').replace(/\s+/g, ' ').trim();
    const full = text.match(/(\d{1,4})\s*[,.]\s*(\d{2})(?!\d)/);
    if (full) return valid(Number(full[1]) * 100 + Number(full[2]));

    // Só os reais saíram: procura os centavos elevados ao lado. As caixas da primeira
    // leitura são mais precisas que as desta (que esticam até a borda do recorte).
    const reais = text.match(/^\d{1,4}$/)?.[0];
    const sameLine = withDigits.filter(w => heightOf(w) >= h * 0.6 && w.bbox.y0 < big.bbox.y1 && w.bbox.y1 > big.bbox.y0);
    if (reais) {
      await worker.setParameters({ tessedit_char_whitelist: '0123456789,.' });
      const cents = await readRaisedCents(worker, canvas, sameLine);
      if (cents !== null) return valid(Number(reais) * 100 + cents);
    }

    // Tudo grudado, como "499": os dois últimos dígitos são os centavos.
    const joined = text.match(/^(\d{1,4})\s?(\d{2})$/);
    return joined ? valid(Number(joined[1]) * 100 + Number(joined[2])) : null;
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
  }
}

// Os reais ocupam a altura toda da linha; os centavos elevados ficam só na metade de cima
// e o "UN"/"KG" pequeno fica embaixo. Pelo desenho, acha onde os reais terminam e lê só os centavos.
async function readRaisedCents(worker, canvas, boxes) {
  if (!boxes.length) return null;
  const x0 = Math.max(0, Math.min(...boxes.map(s => s.bbox.x0)));
  const y0 = Math.max(0, Math.min(...boxes.map(s => s.bbox.y0)));
  const y1 = Math.min(canvas.height, Math.max(...boxes.map(s => s.bbox.y1)));
  const h = y1 - y0;
  const x1 = Math.min(canvas.width, Math.max(...boxes.map(s => s.bbox.x1)) + Math.round(h * 1.2));
  const w = x1 - x0;
  if (w < 8 || h < 12) return null;

  const px = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) hist[px[i]]++;
  const t = otsu(hist, w * h);
  let darkCount = 0;
  for (let v = 0; v <= t; v++) darkCount += hist[v];
  const inkIsDark = darkCount <= (w * h) / 2;   // tinta é a minoria dos pixels (vale para etiqueta clara ou escura)
  const ink = (x, y) => (inkIsDark ? px[(y * w + x) * 4] <= t : px[(y * w + x) * 4] > t);
  const columnHasInk = (x, from, to) => {
    for (let y = from; y < to; y++) if (ink(x, y)) return true;
    return false;
  };

  // Faixa entre 65% e 80% da altura: só os reais passam por ela.
  const midTop = Math.round(h * 0.65);
  const midBottom = Math.round(h * 0.8);
  let reaisEnd = -1;
  for (let x = 0; x < w; x++) if (columnHasInk(x, midTop, midBottom)) reaisEnd = x;
  if (reaisEnd < 0) return null;

  const highBand = Math.round(h * 0.55);
  let start = -1;
  let end = -1;
  for (let x = reaisEnd + 1; x < w; x++) {
    if (columnHasInk(x, 0, highBand)) {
      if (start < 0) start = x;
      end = x;
    } else if (start >= 0 && x - end > h * 0.5) break;
  }
  if (start < 0 || end - start < h * 0.2) return null;

  const pad = Math.round(h * 0.05);
  const rectangle = {
    left: x0 + Math.max(0, start - pad),
    top: y0,
    width: Math.min(w - start + pad, end - start + pad * 2),
    height: Math.min(h, highBand + pad),
  };
  const { data } = await worker.recognize(canvas, { rectangle });
  const digits = (data.text ?? '').replace(/\D/g, '');
  return /^\d{2}$/.test(digits) ? Number(digits) : null;
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

// ---------- preço ----------
const CURRENCY = /^R[$S5]$/i;
const fixDigits = t => t.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1');
const heightOf = w => w.bbox.y1 - w.bbox.y0;

// Devolve os preços encontrados (em centavos), do mais provável ao menos provável.
// O preço de verdade costuma ser o maior número da etiqueta; "preço por kg" vem menor.
export function findPrices(words) {
  const found = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const raw = w.text.trim();
    if (!raw) continue;
    const prev = words[i - 1];
    const next = words[i + 1];
    const h = heightOf(w);
    const perKg = /k\s*g|\/\s*k/i.test(raw) || (next && /^\/?\s*k\s*g/i.test(next.text.trim()));
    const withCurrency = /^R[$S5]/i.test(raw) || (prev && CURRENCY.test(prev.text.trim()));
    const core = fixDigits(raw.replace(/^R[$S5]?/i, '')).replace(/[^\d,.]/g, '');

    let cents = null;
    const full = core.match(/^(\d{1,4})[,.](\d{2})$/);
    if (full) {
      cents = Number(full[1]) * 100 + Number(full[2]);
    } else {
      // Reais grandes com centavos pequenos ao lado, como nas etiquetas: 4 ⁹⁹
      const whole = core.match(/^(\d{1,4})[,.]?$/);
      const nc = next ? fixDigits(next.text.trim()).replace(/[^\d]/g, '') : '';
      if (whole && /^\d{2}$/.test(nc)
        && heightOf(next) < h * 0.85
        && next.bbox.x0 - w.bbox.x1 < h
        && Math.abs(next.bbox.y0 - w.bbox.y0) < h * 0.5) {
        cents = Number(whole[1]) * 100 + Number(nc);
      }
    }
    if (cents > 0 && cents < 100000) {
      const score = h * (perKg ? 0.5 : 1) * (withCurrency ? 1.25 : 1) * (w.confidence >= 60 ? 1 : 0.7);
      found.push({ cents, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return [...new Set(found.map(f => f.cents))].slice(0, 4);
}

// ---------- nome ----------
const NOISE = new Set([
  'r', 'rs', 'un', 'und', 'unid', 'unidade', 'kg', 'g', 'cod', 'codigo', 'preco', 'precos', 'oferta', 'ofertas',
  'promocao', 'promo', 'leve', 'pague', 'por', 'cada', 'a', 'vista', 'validade', 'ean', 'ref', 'sku', 'de', 'apenas',
  'so', 'hoje', 'economize', 'clube', 'cartao', 'total', 'gr', 'item', 'itens', 'data', 'emissao', 'reais',
  'litro', 'litros', 'l', 'ml', 'quilo', 'gramas', 'embalagem',
]);
const SMALL_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'em', 'c/', 'p/']);
const plain = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9/]+/g, '');

function titleCase(s) {
  return s.toLowerCase().split(/\s+/).filter(Boolean).map((w, i) => {
    if (/\d/.test(w)) return w.replace(/(\d)l$/, '$1L');
    if (i > 0 && SMALL_WORDS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

// O nome do produto fica no alto da etiqueta: pega a primeira linha com cara de texto
// e, se houver, a linha logo abaixo dela (nomes longos quebram em duas linhas).
export function guessName(lines) {
  const kept = [];
  let first = null;
  const sorted = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  for (const line of sorted) {
    const tokens = (line.words ?? [])
      .filter(w => w.confidence >= 50)
      .map(w => w.text.trim())
      .filter(t => t && !/\d[,.]\d{2}/.test(t) && !/^\d{5,}$/.test(t) && !CURRENCY.test(t))
      .map(t => t.replace(/[^\p{L}\p{N}%.,/-]/gu, ''))
      .filter(Boolean);
    const text = tokens.join(' ');
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    const chars = text.replace(/\s/g, '').length;
    if (letters < 3 || letters / chars < 0.6) continue;
    if (tokens.every(t => NOISE.has(plain(t)) || plain(t).length < 2)) continue;
    if (first) {
      const fh = first.bbox.y1 - first.bbox.y0;
      const near = line.bbox.y0 - first.bbox.y1 < fh * 1.2;
      const similar = line.bbox.y1 - line.bbox.y0 >= fh * 0.6;
      if (near && similar) kept.push(text);
      break;
    }
    first = line;
    kept.push(text);
  }
  return titleCase(kept.join(' ')).slice(0, 60).trim();
}
