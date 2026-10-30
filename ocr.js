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
  const lines = data.lines ?? [];
  const found = findPrices(words);
  const big = await readBigPrice(worker, canvas, words).catch(() => null);
  const cands = big ? [{ ...big, perUnit: false }, ...found.filter(f => f.cents !== big.cents)] : found;
  // O nome fica logo acima do preço da etiqueta (e não no alto da foto, onde costuma
  // aparecer a embalagem do produto).
  const anchor = (cands.find(c => !c.perUnit) ?? cands[0])?.bbox ?? null;
  const nameText = findNameText(lines, anchor);
  return {
    prices: checkWithUnitPrice(cands, nameText),
    name: titleCase(nameText).slice(0, 60).trim(),
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
  const valid = c => (c > 0 && c < 100000 ? { cents: c, bbox: big.bbox } : null);
  await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789,.R$' });
  try {
    const { data } = await worker.recognize(canvas, { rectangle: { left, top, width: right - left, height: bottom - top } });
    const text = (data.text ?? '').replace(/R\$?/g, ' ').replace(/\s+/g, ' ').trim();
    const full = text.match(/(\d{1,4})\s*[,.]\s*(\d{2})(?!\d)/);
    if (full) return valid(Number(full[1]) * 100 + Number(full[2]));

    // Só os reais saíram (às vezes separados, como "1 8", ou com lixo depois, como "18.2"):
    // procura os centavos elevados ao lado. As caixas da primeira leitura são mais precisas
    // que as desta (que esticam até a borda do recorte).
    const lead = text.match(/^\d[\d ]*/)?.[0].replace(/ /g, '');
    const sameLine = withDigits.filter(w => heightOf(w) >= h * 0.6 && w.bbox.y0 < big.bbox.y1 && w.bbox.y1 > big.bbox.y0);
    if (lead && lead.length <= 6) {
      await worker.setParameters({ tessedit_char_whitelist: '0123456789,.' });
      const cents = await readRaisedCents(worker, canvas, sameLine);
      if (cents !== null) {
        // "499" + centavos "99": os centavos já vieram grudados nos reais.
        const cc = String(cents).padStart(2, '0');
        const reais = lead.length >= 3 && lead.endsWith(cc) ? lead.slice(0, -2) : lead;
        if (reais.length <= 4) return valid(Number(reais) * 100 + cents);
      }
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

// Rótulo de preço por kg/litro: "P/KG", "POR LITRO", "DO KG", "MÉDIA", "R$/KG", "kg:".
// Não basta ter "kg": o nome "ARROZ 5KG" não faz o preço ao lado virar preço por kg.
const PER_UNIT = /\bp\s*\/\s*(kg|l|lt|100\s*g)\b|\bpor\s+(kg|quilo|litro|lt|l|100\s*g)\b|\bdo\s+(kg|quilo|litro)\b|m[eé]dia|\/\s*(kg|l|lt)\b|\bkg\s*:/i;
const TAX = /tribut|impost|ibpt/i;

// Texto das palavras de tamanho parecido ao lado ou logo acima de um número.
// Na etiqueta, "MÉDIA P/KG" fica em cima do "R$ 79,50" e "Tributação" em cima do imposto.
function contextOf(w, words) {
  const h = heightOf(w);
  const cy = (w.bbox.y0 + w.bbox.y1) / 2;
  return words.filter(o => {
    if (o === w) return false;
    const oh = heightOf(o);
    if (oh < h * 0.5 || oh > h * 2) return false;
    // Na mesma linha: o rótulo costuma vir antes, às vezes longe
    // ("PREÇO POR LITRO ATACADO R$ 10,99").
    const sameRow = Math.abs((o.bbox.y0 + o.bbox.y1) / 2 - cy) < h * 0.5
      && (o.bbox.x0 - w.bbox.x1 < h * 1.5 && w.bbox.x0 - o.bbox.x1 < h * 25);
    const gapAbove = w.bbox.y0 - o.bbox.y1;
    const above = gapAbove > -h * 0.3 && gapAbove < h * 1.5
      && o.bbox.x0 < w.bbox.x1 + h && o.bbox.x1 > w.bbox.x0 - h;
    return sameRow || above;
  }).map(o => o.text).join(' ');
}

// Devolve os preços encontrados, do mais provável ao menos provável, com a posição na foto.
// O preço de verdade costuma ser o maior número da etiqueta; preço por kg/litro vem menor
// e marcado (perUnit); o valor de imposto ("Tributação R$ 2,75") é descartado.
export function findPrices(words) {
  const found = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const raw = w.text.trim();
    if (!raw) continue;
    const prev = words[i - 1];
    const next = words[i + 1];
    const h = heightOf(w);
    const withCurrency = /^R[$S5]/i.test(raw) || (prev && CURRENCY.test(prev.text.trim()));
    const core = fixDigits(raw.replace(/^R[$S5]?/i, '')).replace(/[^\d,.]/g, '');

    let cents = null;
    const full = core.match(/^(\d{1,4})[,.](\d{2})$/);
    if (full) {
      cents = Number(full[1]) * 100 + Number(full[2]);
    } else {
      // Reais grandes com centavos pequenos ao lado, como nas etiquetas: 4 ⁹⁹
      // Só vale se a palavra for mesmo um número (evita "Loja: 38" virar R$ 0,38).
      const digitWord = /^(R[$S5])?[\dOoIl|]{1,4}[,.]?$/i.test(raw);
      const whole = digitWord ? core.match(/^(\d{1,4})[,.]?$/) : null;
      const nc = next ? fixDigits(next.text.trim()).replace(/[^\d]/g, '') : '';
      if (whole && /^\d{2}$/.test(nc)
        && heightOf(next) < h * 0.85
        && next.bbox.x0 - w.bbox.x1 < h
        && Math.abs(next.bbox.y0 - w.bbox.y0) < h * 0.5) {
        cents = Number(whole[1]) * 100 + Number(nc);
      }
    }
    if (cents > 0 && cents < 100000) {
      const context = contextOf(w, words);
      if (TAX.test(context)) continue;
      const perUnit = /\/\s*(kg|lt|l)\b/i.test(raw) || PER_UNIT.test(context);
      const base = /100\s*(g|ml)/i.test(context) ? 100 : 1000;   // preço por 100 g ou por kg/litro
      const score = h * (perUnit ? 0.4 : 1) * (withCurrency ? 1.25 : 1) * (w.confidence >= 60 ? 1 : 0.7);
      found.push({ cents, score, perUnit, base, bbox: w.bbox });
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

// Números que o leitor costuma trocar entre si nas letras grossas das etiquetas.
const LOOK_ALIKE = new Set(['17', '71', '56', '65', '68', '86', '38', '83', '08', '80', '89', '98']);
function lookAlike(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length || sa === sb) return false;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i] && !LOOK_ALIKE.has(sa[i] + sb[i])) return false;
  return true;
}

// Peso ou volume escrito no nome ("100G", "1,6KG", "500ML", "2L"), em gramas ou mililitros.
function amountFromName(text) {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|gr|g|ml|lt|l)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const big = /^(kg|lt|l)$/i.test(m[2]);
  const amount = big ? n * 1000 : n;
  return amount > 0 && amount <= 50000 ? amount : null;
}

// As etiquetas mostram o preço por kg ou por litro. Com o peso do nome dá para conferir a conta:
// 100 g a R$ 79,50 o kg = R$ 7,95.
function checkWithUnitPrice(cands, nameText) {
  const unit = cands.filter(c => !c.perUnit).map(c => c.cents);
  const perUnitCands = cands.filter(c => c.perUnit);
  const perUnit = perUnitCands.map(c => c.cents);
  const amount = amountFromName(nameText);
  if (amount && perUnitCands.length) {
    const { cents: per, base } = perUnitCands[0];
    const expected = Math.round((per * amount) / base);
    const exp = String(expected);
    const top = unit.length ? String(unit[0]) : '';
    // O primeiro preço lido está quase certo: números trocados ("1,95" no lugar de "7,95")
    // ou um número a mais na frente ("17,95"). Fica o valor que fecha a conta.
    const misread = top && top !== exp && (lookAlike(top, exp) || (top.length > exp.length && top.endsWith(exp)));
    const matchAt = unit.findIndex(c => Math.abs(c - expected) <= 2);
    if (misread) {
      if (matchAt > 0) unit.splice(matchAt, 1);
      unit[0] = expected;
    } else if (matchAt < 0 && expected > 0) {
      // Não bate com nada lido: vira uma opção para tocar. Em atacarejo o preço por litro
      // costuma ser o do atacado, e o preço normal (varejo) continua em primeiro.
      unit.splice(unit.length ? 1 : 0, 0, expected);
    }
  }
  return [...new Set([...unit, ...perUnit])].slice(0, 4);
}

// ---------- nome ----------
const NOISE = new Set([
  'r', 'rs', 'un', 'und', 'unid', 'unidade', 'kg', 'g', 'cod', 'codigo', 'preco', 'precos', 'oferta', 'ofertas',
  'promocao', 'promo', 'leve', 'pague', 'por', 'cada', 'a', 'vista', 'validade', 'ean', 'ref', 'sku', 'de', 'apenas',
  'so', 'hoje', 'economize', 'clube', 'cartao', 'total', 'gr', 'item', 'itens', 'data', 'emissao', 'reais',
  'litro', 'litros', 'l', 'ml', 'quilo', 'gramas', 'embalagem', 'media', 'p/kg', 'p/l', 'tributacao', 'loja', 'dta',
  'partir', 'atacado', 'varejo', 'li', 'acima', 'unidades',
]);
// Frases de etiqueta (muitas de atacarejo) e de embalagem que nunca são o nome do produto:
// "A PARTIR DE 3 UN", "PREÇO POR LITRO ATACADO", "VAREJO", "PRONTO PARA O CONSUMO".
const LABEL_PHRASE = /\ba partir\b|\bpreco (por|unit|do|de|da)\b|\batacado\b|\bvarejo\b|\bleve \d|\bpague \d|\bno cartao\b|\bpronto para\b|\bacima de\b/;
const plainText = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const SMALL_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'em', 'c/', 'p/']);
const plain = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9/]+/g, '');

function titleCase(s) {
  return s.toLowerCase().split(/\s+/).filter(Boolean).map((w, i) => {
    if (/\d/.test(w)) return w.replace(/(\d)l$/, '$1L');
    if (i > 0 && SMALL_WORDS.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

// Texto da linha sem preços, códigos e palavras de etiqueta; vazio se não parece um nome.
function lineText(line) {
  const tokens = (line.words ?? [])
    .filter(w => w.confidence >= 50)
    .map(w => w.text.trim())
    .filter(t => t && !/\d[,.]\d{2}/.test(t) && !/^\d{5,}$/.test(t) && !CURRENCY.test(t))
    .map(t => t.replace(/[^\p{L}\p{N}%.,/-]/gu, ''))
    .filter(Boolean);
  const text = tokens.join(' ');
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const chars = text.replace(/\s/g, '').length;
  if (letters < 3 || letters / chars < 0.6) return '';
  if (tokens.every(t => NOISE.has(plain(t)) || plain(t).length < 2)) return '';
  if (LABEL_PHRASE.test(plainText(text))) return '';
  return text;
}

// Escolhe a linha com mais letras lidas com segurança. A embalagem atrás da etiqueta sai
// borrada (pouca segurança); o nome impresso na etiqueta sai nítido. Linhas logo acima do
// preço valem o dobro. Nome longo que quebra em duas linhas (mesmo tamanho, bem juntas) é juntado.
export function findNameText(lines, anchor = null) {
  const ah = anchor ? anchor.y1 - anchor.y0 : 0;
  const scored = lines.map(line => {
    const text = lineText(line);
    if (!text) return null;
    const sure = (line.words ?? []).filter(w => w.confidence >= 70).map(w => w.text).join('');
    let score = (sure.match(/\p{L}/gu) ?? []).length;
    if (anchor) {
      const gap = anchor.y0 - line.bbox.y1;
      if (gap > -ah * 0.5 && gap < ah * 4) score *= 2;
      else if (line.bbox.y0 > anchor.y1) score *= 0.5;
    }
    return { line, text, score };
  }).filter(Boolean);
  if (!scored.length) return '';
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  const bh = best.line.bbox.y1 - best.line.bbox.y0;
  const continues = (upper, lower) => {
    const gap = lower.bbox.y0 - upper.bbox.y1;
    const other = upper === best.line ? lower : upper;
    const oh = other.bbox.y1 - other.bbox.y0;
    return gap >= -bh * 0.2 && gap < bh * 1.2 && oh >= bh * 0.6 && oh <= bh * 1.6;
  };
  const before = scored.find(s => s !== best && continues(s.line, best.line));
  if (before) return `${before.text} ${best.text}`;
  const after = scored.find(s => s !== best && continues(best.line, s.line));
  return after ? `${best.text} ${after.text}` : best.text;
}
