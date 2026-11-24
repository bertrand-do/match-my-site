// Pixel work (overlay measurement, tone grids, image kind, perceptual hash), done on a canvas inside the same headless
// Chrome the extractor already runs. Functions: place, measure_overlay, gradient_layer, gradient_fit, tone_grid, image_kind, ahash, the hero "photo-like" check).
// Images go in as data: URLs (the downloaded bytes), so the canvas is never tainted and nothing is fetched again.
// Resampling is the browser's (bilinear-ish) instead of PIL's LANCZOS/BILINEAR: the numbers are means over cells and
// least-squares fits, so the small difference does not change a decision.

/** Installs window.__px in the page. Runs in the browser (serialised by puppeteer): no outer references. */
function install() {
  const imgs = new Map();
  const canvas = (w, h) => { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const ctx = (c) => c.getContext("2d", { willReadFrequently: true });
  const dims = (s) => (s instanceof HTMLImageElement ? [s.naturalWidth, s.naturalHeight] : [s.width, s.height]);
  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const splitTop = (s) => { const out = []; let buf = ""; let d = 0; for (const ch of s) { if ("([".includes(ch)) d++; else if (")]".includes(ch)) d--; if (ch === "," && d === 0) { out.push(buf); buf = ""; } else buf += ch; } out.push(buf); return out.map((x) => x.trim()).filter(Boolean); };
  const cssPos = (v) => {
    const kw = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
    const parts = String(v || "50% 50%").split(",")[0].trim().split(/\s+/);
    const out = [];
    for (const p of parts.slice(0, 2)) {
      if (p in kw) out.push(kw[p]);
      else if (p.endsWith("%")) { const n = parseFloat(p); out.push(Number.isFinite(n) ? n / 100 : 0.5); }
      else out.push(0);
    }
    if (out.length === 1) out.push(0.5);
    if (out.length === 0) out.push(0.5, 0.5);
    if (parts[0] === "top" || parts[0] === "bottom") return [out[1], out[0]];
    return [out[0], out[1]];
  };
  /** The photo as CSS paints it into a w x h box (background-size / object-fit + position), black behind. */
  const place = (src, w, h, size, pos) => {
    const [pw, ph] = dims(src);
    const sz = String(size || "cover").split(",")[0].trim();
    let s;
    if (!sz || sz === "cover" || sz === "fill") s = Math.max(w / pw, h / ph);
    else if (sz === "contain" || sz === "scale-down") s = Math.min(w / pw, h / ph);
    else if (sz.startsWith("auto") || sz === "none") s = 1;
    else {
      const m = /^([\d.]+)(%|px)/.exec(sz);
      s = m ? (m[2] === "%" ? (w * parseFloat(m[1])) / 100 / pw : parseFloat(m[1]) / pw) : Math.max(w / pw, h / ph);
    }
    const sw = Math.max(1, Math.round(pw * s));
    const sh = Math.max(1, Math.round(ph * s));
    const [fx, fy] = cssPos(pos);
    const c = canvas(w, h);
    const g = ctx(c);
    g.fillStyle = "#000";
    g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(src, Math.round((w - sw) * fx), Math.round((h - sh) * fy), sw, sh);
    return c;
  };
  const resize = (src, w, h) => { const c = canvas(w, h); const g = ctx(c); g.imageSmoothingQuality = "medium"; g.drawImage(src, 0, 0, c.width, c.height); return c; };
  const rgbOf = (c) => { const d = ctx(c).getImageData(0, 0, c.width, c.height).data; const out = new Float64Array((d.length / 4) * 3); for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { out[j] = d[i]; out[j + 1] = d[i + 1]; out[j + 2] = d[i + 2]; } return out; };
  const grey = (c) => { const d = ctx(c).getImageData(0, 0, c.width, c.height).data; const out = new Float64Array(d.length / 4); for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; return out; };
  /** A source image, optionally drawn at `opacity` over `under` (the half-transparent hero photos some themes use). */
  const source = (key, opacity, under) => {
    const im = imgs.get(key);
    if (!im) throw new Error(`no image ${key}`);
    if (!(opacity < 0.99)) return im;
    const c = canvas(im.naturalWidth, im.naturalHeight);
    const g = ctx(c);
    g.fillStyle = under || "#000";
    g.fillRect(0, 0, c.width, c.height);
    g.globalAlpha = Math.max(0, opacity);
    g.drawImage(im, 0, 0);
    return c;
  };
  const gradientLayer = (css, w, h) => {
    const m = /^\s*linear-gradient\((.*)\)\s*$/s.exec(css || "");
    if (!m) return null;
    let args = splitTop(m[1]);
    let ang = 180;
    const first = (args[0] || "").trim();
    const sides = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270, "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135, "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315 };
    if (/^-?[\d.]+deg$/.test(first)) { ang = parseFloat(first); args = args.slice(1); }
    else if (/^-?[\d.]+turn$/.test(first)) { ang = parseFloat(first) * 360; args = args.slice(1); }
    else if (first in sides) { ang = sides[first]; args = args.slice(1); }
    const stops = [];
    for (const a of args) {
      const mm = /^\s*(rgba?\([^)]*\))\s*(-?[\d.]+%)?/.exec(a);
      if (!mm) return null;
      const nums = mm[1].slice(mm[1].indexOf("(") + 1, -1).split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      stops.push([nums.slice(0, 3), nums.length > 3 ? nums[3] : 1, mm[2] ? parseFloat(mm[2]) / 100 : null]);
    }
    if (stops.length < 2) return null;
    if (stops[0][2] === null) stops[0][2] = 0;
    if (stops[stops.length - 1][2] === null) stops[stops.length - 1][2] = 1;
    for (let i = 1; i < stops.length - 1; i++) {
      if (stops[i][2] !== null) continue;
      let j = i + 1;
      while (stops[j][2] === null) j++;
      stops[i][2] = stops[i - 1][2] + (stops[j][2] - stops[i - 1][2]) / (j - i + 1);
    }
    const th = (ang * Math.PI) / 180;
    const L = Math.abs(w * Math.sin(th)) + Math.abs(h * Math.cos(th)) || 1;
    const pos = stops.map((s) => s[2]);
    const interp = (t, vals) => {
      if (t <= pos[0]) return vals[0];
      for (let k = 1; k < pos.length; k++) if (t <= pos[k]) { const span = pos[k] - pos[k - 1] || 1; return vals[k - 1] + ((vals[k] - vals[k - 1]) * (t - pos[k - 1])) / span; }
      return vals[vals.length - 1];
    };
    const rgb = new Float64Array(w * h * 3);
    const alpha = new Float64Array(w * h);
    const chans = [0, 1, 2].map((c) => stops.map((s) => s[0][c]));
    const alphas = stops.map((s) => s[1]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = ((x + 0.5 - w / 2) * Math.sin(th) - (y + 0.5 - h / 2) * Math.cos(th)) / L + 0.5;
      const i = y * w + x;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = interp(t, chans[c]);
      alpha[i] = interp(t, alphas);
    }
    return { rgb, alpha };
  };
  const fitBox = (clean) => { const W = 240; return [W, Math.max(8, Math.round((clean.naturalHeight * W) / clean.naturalWidth))]; };

  window.__px = {
    async load(key, dataUrl) {
      const im = new Image();
      im.src = dataUrl;
      await im.decode();
      imgs.set(key, im);
      return { w: im.naturalWidth, h: im.naturalHeight };
    },
    drop(key) { imgs.delete(key); },
    /** Fit clean = (1 - a) * photo + a * colour over the photo's box: the overlay the site actually paints. */
    measureOverlay(photo, opacity, under, cleanKey, size, pos) {
      const clean = imgs.get(cleanKey);
      const [W, H] = fitBox(clean);
      const y = rgbOf(resize(clean, W, H));
      const x = rgbOf(resize(place(source(photo, opacity, under), clean.naturalWidth, clean.naturalHeight, size, pos), W, H));
      const n = W * H;
      const mx = [0, 0, 0]; const my = [0, 0, 0];
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { mx[c] += x[i * 3 + c]; my[c] += y[i * 3 + c]; }
      for (let c = 0; c < 3; c++) { mx[c] /= n; my[c] /= n; }
      let sxy = 0; let sxx = 0;
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { const dx = x[i * 3 + c] - mx[c]; sxy += dx * (y[i * 3 + c] - my[c]); sxx += dx * dx; }
      const k = sxx > 0 ? sxy / sxx : 0;
      const b = [0, 1, 2].map((c) => my[c] - k * mx[c]);
      const yMean = (my[0] + my[1] + my[2]) / 3;
      let ssRes = 0; let ssTot = 0;
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { const v = y[i * 3 + c]; const p = k * x[i * 3 + c] + b[c]; ssRes += (v - p) ** 2; ssTot += (v - yMean) ** 2; }
      const r2 = 1 - ssRes / (ssTot || 1);
      const a = Math.min(1, Math.max(0, 1 - k));
      if (a < 0.03) return { color: null, opacity: 0, r2: Math.round(r2 * 1000) / 1000 };
      return { color: hex(...b.map((v) => Math.min(255, Math.max(0, v / a)))), opacity: Math.round(a * 1000) / 1000, r2: Math.round(r2 * 1000) / 1000 };
    },
    /** R2 of "photo under this CSS gradient" against the page pixels (null when the gradient is not understood). */
    gradientFit(photo, opacity, under, cleanKey, size, pos, css, elOpacity) {
      const clean = imgs.get(cleanKey);
      const [W, H] = fitBox(clean);
      const g = gradientLayer(css, W, H);
      if (!g) return null;
      const shot = rgbOf(resize(clean, W, H));
      const ph = rgbOf(resize(place(source(photo, opacity, under), clean.naturalWidth, clean.naturalHeight, size, pos), W, H));
      let mean = 0;
      for (const v of shot) mean += v;
      mean /= shot.length;
      let ssRes = 0; let ssTot = 0;
      for (let i = 0; i < W * H; i++) {
        const al = g.alpha[i] * elOpacity;
        for (let c = 0; c < 3; c++) { const pred = ph[i * 3 + c] * (1 - al) + g.rgb[i * 3 + c] * al; const v = shot[i * 3 + c]; ssRes += (v - pred) ** 2; ssTot += (v - mean) ** 2; }
      }
      return Math.round((1 - ssRes / (ssTot || 1)) * 1000) / 1000;
    },
    /** Mean colour of each cell of the photo as placed in a hero box (cover, or wider: zoom < 1). */
    toneGrid(photo, opacity, under, aspect, cols, rows, pos, zoom) {
      const src = source(photo, opacity, under);
      const W = cols * 8;
      let H = Math.max(rows, Math.round(W / aspect));
      H = rows * Math.max(1, Math.round(H / rows));
      const [pw, ph] = dims(src);
      const coverW = Math.max(W, (H * pw) / ph);
      const size = `${((Math.max(coverW, W / Math.max(zoom, 0.2)) / W) * 100).toFixed(3)}%`;
      const arr = rgbOf(place(src, W, H, size, pos));
      const ch = Math.floor(H / rows); const cw = Math.floor(W / cols);
      const cells = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const m = [0, 0, 0]; let n = 0;
        for (let yy = r * ch; yy < (r + 1) * ch; yy++) for (let xx = c * cw; xx < (c + 1) * cw; xx++) { const i = (yy * W + xx) * 3; m[0] += arr[i]; m[1] += arr[i + 1]; m[2] += arr[i + 2]; n++; }
        cells.push(hex(m[0] / n, m[1] / n, m[2] / n));
      }
      return { cols, rows, cells };
    },
    /** "graphic" (infographic, chart, screenshot: big flat areas, few colours) or "photo". */
    imageKind(key) {
      const im = imgs.get(key);
      const s = Math.min(1, 160 / im.naturalWidth, 160 / im.naturalHeight);
      const c = resize(im, Math.max(1, Math.round(im.naturalWidth * s)), Math.max(1, Math.round(im.naturalHeight * s)));
      const d = ctx(c).getImageData(0, 0, c.width, c.height).data;
      const counts = new Map();
      let n = 0;
      for (let i = 0; i < d.length; i += 4) { const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); counts.set(k, (counts.get(k) || 0) + 1); n++; }
      let max = 0;
      for (const v of counts.values()) if (v > max) max = v;
      const top = max / n;
      return { kind: top >= 0.3 || (counts.size < 90 && top >= 0.15) ? "graphic" : "photo", flatShare: Math.round(top * 1000) / 1000 };
    },
    /** Average hash (12 x 12 grey, above the mean), for "is this the same picture". */
    ahash(key, opacity, under) {
      const src = source(key, opacity, under);
      const g = grey(resize(src, 12, 12));
      let mean = 0;
      for (const v of g) mean += v;
      mean /= g.length;
      const [w, h] = dims(src);
      return { bits: [...g].map((v) => (v > mean ? 1 : 0)), w, h };
    },
    /** The clean hero block is imagery, not one flat colour (grey std above 14 at 96 px wide). */
    photoLike(key) {
      const im = imgs.get(key);
      const g = grey(resize(im, 96, Math.max(8, Math.round((96 * im.naturalHeight) / im.naturalWidth))));
      let mean = 0;
      for (const v of g) mean += v;
      mean /= g.length;
      let sd = 0;
      for (const v of g) sd += (v - mean) ** 2;
      return Math.sqrt(sd / g.length) > 14;
    },
  };
}

/** A blank page in `browser` with the pixel helpers installed. Call the helpers with `px.call(name, ...args)`. */
export async function pixelPage(browser) {
  const page = await browser.newPage();
  await page.evaluate(install);
  return {
    async load(key, bytes, type) {
      return page.evaluate((k, url) => window.__px.load(k, url), key, `data:${type || "application/octet-stream"};base64,${Buffer.from(bytes).toString("base64")}`);
    },
    call(name, ...args) {
      return page.evaluate((n, a) => window.__px[n](...a), name, args);
    },
    close: () => page.close().catch(() => undefined),
  };
}
