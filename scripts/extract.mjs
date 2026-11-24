// Reads a web page's own brand identity and returns brand tokens (fonts, colours, spacing, header, logo, hero).
//
//   extractBrand({ url, dir, images, timeoutMs })  ->  { ok, tokens, seconds, warning }
//
// Runs headless Chrome (puppeteer-core driving your installed Chrome, or CHROME_PATH), reads computed styles, finds
// the logo and the hero photo behind the page title, measures the overlay the site paints over that photo, and picks
// fonts (what actually renders; commercial faces are recorded by name and paired with the closest Google font).
// It downloads the logo and hero image (and any extra images you pass) into `dir`; font files are NOT downloaded,
// only their names and source URLs are recorded. Every local file in the tokens is a file:// URL. The page and every
// file it points at are untrusted data: only styles, geometry and pixels are read, and downloads are size-capped
// and http(s) only.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeGuard, safeFetch } from "./net.mjs";
import { readPage, VIEW_H, VIEW_W } from "./page.mjs";
import { pixelPage } from "./pixels.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const MAX_BYTES = 15 * 1024 * 1024;
export const BRAND_TIMEOUT_MS = 45_000;

/* ------------------------------------------------------------------ colours */
const NAMED = { white: "#ffffff", black: "#000000", red: "#ff0000", blue: "#0000ff", navy: "#000080", gray: "#808080", grey: "#808080", silver: "#c0c0c0", green: "#008000", orange: "#ffa500", purple: "#800080", teal: "#008080", maroon: "#800000", darkblue: "#00008b", steelblue: "#4682b4", whitesmoke: "#f5f5f5", transparent: "transparent" };
const h2 = (n) => Math.max(0, Math.min(255, Math.trunc(n))).toString(16).padStart(2, "0");
const normHex = (h) => { let s = h.replace(/^#/, ""); if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join(""); return `#${s.slice(0, 6).toLowerCase()}`; };
export function toHex(value) {
  if (!value) return null;
  const c = String(value).trim().toLowerCase();
  if (c.startsWith("#")) return c.length === 9 && c.slice(7, 9) === "00" ? "transparent" : normHex(c);
  if (c in NAMED) return NAMED[c];
  let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/.exec(c);
  if (m) {
    if (m[4] !== undefined) { const a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]); if (a < 0.05) return "transparent"; }
    return `#${h2(+m[1])}${h2(+m[2])}${h2(+m[3])}`;
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%/.exec(c);
  if (m) {
    const hh = +m[1] / 360; const s = +m[2] / 100; const l = +m[3] / 100;
    const f = (n) => { const k = (n + hh * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return `#${h2(f(0) * 255)}${h2(f(8) * 255)}${h2(f(4) * 255)}`;
  }
  return null;
}
export function parseGradient(v) {
  const m = /(?<![-\w])(linear|radial)-gradient\((.*)\)/s.exec(v || "");
  if (!m) return null;
  const stops = [...m[2].matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)].map((x) => toHex(x[0])).filter((s) => s && s !== "transparent");
  return stops.length ? { type: m[1], stops, css: m[0] } : null;
}
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export const lum = (h) => { const [r, g, b] = rgb(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const mix = (a, b, t) => { const x = rgb(a); const y = rgb(b); return `#${x.map((v, i) => Math.round((v + (y[i] - v) * t) * 255).toString(16).padStart(2, "0")).join("")}`; };
const cdist = (a, b) => rgb(a).reduce((n, v, i) => n + Math.abs(v - rgb(b)[i]), 0) * 255;
const readableOn = (bg, prefer) => (prefer && prefer !== "transparent" && contrast(prefer, bg) >= 3 ? prefer : contrast("#ffffff", bg) >= contrast("#111111", bg) ? "#ffffff" : "#111111");
const isHex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/* ------------------------------------------------------------------ fonts */
const weightNum = (w) => { const s = String(w ?? "400").trim().toLowerCase(); return { normal: 400, bold: 700, bolder: 800, lighter: 300 }[s] ?? (/^\d+$/.test(s) ? Number(s) : 400); };
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "-apple-system", "blinkmacsystemfont", "inherit", "initial"]);
// Known commercial / system families -> the closest free Google family (same proportions and feel).
const SUBSTITUTES = {
  helvetica: "Arimo", "helvetica neue": "Arimo", arial: "Arimo", "sans-serif": "Arimo", "liberation sans": "Arimo",
  "-apple-system": "Inter", "system-ui": "Inter", blinkmacsystemfont: "Inter", "segoe ui": "Inter", "sf pro text": "Inter", "sf pro display": "Inter", "ui-sans-serif": "Inter",
  times: "Tinos", "times new roman": "Tinos", serif: "Tinos", georgia: "Gelasio", charter: "Charis SIL", "iowan old style": "Source Serif 4",
  palatino: "Domine", "palatino linotype": "Domine", "book antiqua": "Domine", garamond: "EB Garamond", baskerville: "Libre Baskerville", cambria: "Caladea",
  verdana: "Open Sans", tahoma: "PT Sans", "trebuchet ms": "Fira Sans", calibri: "Carlito", "gill sans": "Lato", futura: "Jost", "century gothic": "Questrial",
  "proxima nova": "Montserrat", gotham: "Montserrat", avenir: "Nunito Sans", "avenir next": "Nunito Sans", "brandon grotesque": "Josefin Sans", "museo sans": "Mulish",
  "acumin pro": "Roboto", graphik: "Inter", circular: "DM Sans", gilroy: "Plus Jakarta Sans", "sofia pro": "Outfit", "neue haas grotesk": "Inter", "aktiv grotesk": "Inter",
  "freight text pro": "Source Serif 4", tiempos: "Source Serif 4", "minion pro": "Crimson Pro", "adobe garamond pro": "EB Garamond", "museo slab": "Roboto Slab", rockwell: "Roboto Slab",
  courier: "Courier Prime", "courier new": "Courier Prime", menlo: "JetBrains Mono", monaco: "JetBrains Mono", consolas: "Inconsolata", monospace: "JetBrains Mono",
};
const CLASS_DEFAULT = { serif: "Source Serif 4", sans: "Inter", slab: "Roboto Slab", mono: "JetBrains Mono", rounded: "Nunito" };
/** Hook for "this exact family is a known Google font"; only families linked from Google Fonts by the page count here. */
const knownGoogleFamily = () => false;

export function googleFamilies(links) {
  const out = new Map();
  for (const href of links) {
    let params;
    try { params = new URL(href).searchParams; } catch { continue; }
    for (const fam of params.getAll("family")) {
      for (const part of fam.split("|")) {
        const [rawName, spec = ""] = part.split(/:(.*)/s);
        const name = rawName.replace(/\+/g, " ").trim();
        if (!name) continue;
        const ws = [...spec.matchAll(/(?<![\d.])([1-9]00)(?!\d)/g)].map((m) => Number(m[1]));
        const set = out.get(name) ?? new Set();
        for (const w of ws.length ? ws : [400]) set.add(w);
        out.set(name, set);
      }
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
}

function fontClass(name, shape, stack) {
  const n = (name || "").toLowerCase();
  if (n.includes("mono") || n.includes("code") || shape === "mono") return "mono";
  if (n.includes("slab") || shape === "slab") return "slab";
  if (n.includes("round")) return "rounded";
  if (n.includes("sans") || n.includes("grotesk") || n.includes("gothic")) return "sans";
  if (shape === "serif" || shape === "sans") return shape;
  return /\bserif\b/.test(stack || "") && !(stack || "").includes("sans-serif") ? "serif" : "sans";
}

const srcRank = ([u, f]) => (f === "woff2" || u.split("?")[0].endsWith(".woff2") ? 0 : u.split("?")[0].endsWith(".woff") ? 1 : 2);

/** Font token from what the browser says actually renders (info.rendered), not just the CSS stack. */
export function chooseFont(info, gfonts, faces) {
  const fam = String(info.rendered || "").trim();
  const stack = info.stack || "";
  const cls = fontClass(fam, info.shape, stack);
  const generic = { serif: "serif", slab: "serif", mono: "monospace" }[cls] ?? "sans-serif";
  const res = { stack, rendered: fam, class: cls, generic };
  const low = fam.toLowerCase();
  const g = [...gfonts.keys()].find((k) => k.toLowerCase() === low);
  if (g || (!(low in SUBSTITUTES) && knownGoogleFamily(fam))) return { ...res, family: g ?? fam, source: "google", weights: g ? gfonts.get(g) : [300, 400, 500, 600, 700, 800] };
  const mine = faces.filter((f) => f.family.toLowerCase() === low && f.src.length);
  if (mine.length && !GENERIC.has(low)) {
    const files = [];
    for (const f of mine) {
      const src = [...f.src].sort((a, b) => srcRank(a) - srcRank(b))[0];
      if (src && !files.some((x) => x.url === src[0])) files.push({ weight: weightNum(String(f.weight || "400").split(/\s+/)[0]), style: String(f.style || "normal").trim(), url: src[0] });
    }
    if (files.length) {
      const sub = SUBSTITUTES[low] ?? CLASS_DEFAULT[cls];
      return { ...res, family: mine[0].family, source: "self-hosted", files, fallback: { family: sub, source: "google", weights: [300, 400, 500, 600, 700], why: `closest Google font (${cls})` } };
    }
  }
  const sub = SUBSTITUTES[low] ?? CLASS_DEFAULT[cls];
  return { ...res, family: sub, source: "google", weights: [300, 400, 500, 600, 700, 800], substitute: { for: fam, with: sub, why: low in SUBSTITUTES ? "known look-alike" : `no free copy of this font; closest Google font for a ${cls} face` } };
}

/** @font-face rules of stylesheets the page's CSSOM could not read (cross-origin sheets). */
function fontFacesOf(css, base) {
  const out = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const decl = Object.fromEntries(m[1].split(";").map((d) => d.split(/:(.*)/s)).filter((p) => p.length > 1).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]));
    const family = (decl["font-family"] || "").replace(/['"]/g, "").trim();
    if (!family) continue;
    const src = [...(decl.src || "").matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)\s*(?:format\(\s*['"]?([\w-]+)['"]?\s*\))?/g)]
      .filter((x) => !x[1].startsWith("data:"))
      .map((x) => { try { return [new URL(x[1], base).href, x[2] || ""]; } catch { return null; } })
      .filter(Boolean);
    out.push({ family, weight: decl["font-weight"] || "400", style: decl["font-style"] || "normal", src });
  }
  return out;
}

/* ------------------------------------------------------------------ downloads */
const sniff = (b) => {
  if (b[0] === 0x89 && b[1] === 0x50) return ["image/png", ".png"];
  if (b[0] === 0xff && b[1] === 0xd8) return ["image/jpeg", ".jpg"];
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return ["image/webp", ".webp"];
  if (b.toString("ascii", 0, 3) === "GIF") return ["image/gif", ".gif"];
  if (b.toString("ascii", 4, 12).startsWith("ftypavi")) return ["image/avif", ".avif"];
  if (/<svg[\s>]/i.test(b.subarray(0, 2048).toString("utf8"))) return ["image/svg+xml", ".svg"];
  return [null, null];
};

function makeFetcher(deadline, guard) {
  return async function download(url, { perMs = 10_000 } = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error("not an http(s) link");
    const left = deadline - Date.now();
    if (left < 1_500) throw new Error("out of time");
    // every hop checked: no private, loopback, link-local or metadata address (net.mjs)
    const res = await safeFetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(Math.min(perMs, left - 1_000)) }, { guard });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new Error("file too big");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("file too big");
    return { bytes: buf, type: res.headers.get("content-type") ?? "" };
  };
}

/* ------------------------------------------------------------------ hero helpers */
const HERO_MIN_W = 800;
const HERO_BAD = /logo|icon|avatar|gravatar|sprite|badge|emoji|favicon|spacer|pixel|placeholder/i;
// hero box sizes used for the tone grid (landscape 1920 x 900, portrait 1080 x 1660)
const HERO_BOX = { landscape: [1920, 900, 12, 6], portrait: [1080, 1660, 6, 10] };
const cssPos = (v) => {
  const kw = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  const parts = String(v || "50% 50%").split(",")[0].trim().split(/\s+/);
  const out = parts.slice(0, 2).map((p) => (p in kw ? kw[p] : p.endsWith("%") ? (Number.isFinite(parseFloat(p)) ? parseFloat(p) / 100 : 0.5) : 0));
  if (out.length === 1) out.push(0.5);
  if (!out.length) out.push(0.5, 0.5);
  return parts[0] === "top" || parts[0] === "bottom" ? [out[1], out[0]] : [out[0], out[1]];
};
export function urlStem(u) {
  let p = "";
  try { p = new URL(u).pathname.toLowerCase(); } catch { p = String(u).toLowerCase(); }
  p = p.replace(/\.(jpe?g|png|webp|avif|gif)$/, "");
  return p.split("/").pop().replace(/(-\d{2,4}x\d{2,4}|-\d{3,4}w?|-scaled|@\dx)+$/, "");
}
/** Same file at larger sizes: other URLs in the page sharing the stem (largest number first), then the bare original. */
function biggerVariants(url, page) {
  const stem = urlStem(url);
  const found = new Map();
  for (const m of (page || "").matchAll(/https?:\/\/[^\s"'()<>]+?\.(?:jpe?g|png|webp|avif)/gi)) {
    const u = m[0].replace(/&amp;/g, "&");
    if (u !== url && urlStem(u) === stem) {
      const nums = [...u.matchAll(/-(\d{3,4})(?:x\d+|w)?(?=\.\w+$)/g)].map((x) => Number(x[1]));
      found.set(u, nums.length ? Math.max(...nums) : 99999);
    }
  }
  const out = [...found].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1)).map(([u]) => u);
  const bare = url.replace(/(-\d{2,4}x\d{2,4}|-\d{3,4})(\.\w+)$/, "$2");
  if (bare !== url) out.push(bare);
  return out;
}

/* ------------------------------------------------------------------ the extraction */

/** The Chrome to run: CHROME_PATH, else an installed Google Chrome / Chromium found in the usual places. */
export async function chromePath() {
  const { existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
    return process.env.CHROME_PATH;
  }
  const home = homedir();
  const env = process.env;
  const byOs = {
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/opt/google/chrome/chrome"],
    win32: [`${env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`, `${env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`, `${env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`, `${env.PROGRAMFILES ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`],
  };
  const found = (byOs[process.platform] ?? []).find((p) => existsSync(p));
  if (found) return found;
  throw new Error("Google Chrome was not found. Install it, or set CHROME_PATH to the Chrome executable.");
}

async function launch() {
  const { default: puppeteer } = await import("puppeteer-core");
  const linux = process.platform === "linux";
  return puppeteer.launch({
    executablePath: await chromePath(),
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-notifications", "--mute-audio", "--hide-scrollbars", `--window-size=${VIEW_W},${VIEW_H}`, ...(linux ? ["--no-sandbox", "--disable-dev-shm-usage"] : [])],
  });
}

/**
 * Reads `url` and writes its files into `dir`. `images`: extra image URLs to download and measure.
 * Throws on failure; extractBrand wraps it with the time cap.
 */
async function run({ url, dir, images = [], deadline, onBrowser, log, lookup }) {
  // the post itself first: a link to a private address never reaches Chrome
  const guard = makeGuard(lookup);
  await guard(url);
  await mkdir(dir, { recursive: true });
  const download = makeFetcher(deadline, guard);
  const fileUrl = (name) => pathToFileURL(path.join(dir, name)).href;
  const save = async (name, bytes) => { await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), bytes); return fileUrl(name); };
  const browser = await launch();
  onBrowser(browser);
  const t0 = Date.now();
  const { data: comp, renderedHtml: page, clean } = await readPage(browser, url, { navTimeoutMs: Math.min(20_000, deadline - Date.now() - 15_000), guard });
  log(`page read in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const px = await pixelPage(browser);
  const loaded = new Map();
  /** Loads bytes into the pixel page; returns its natural size, or null when Chrome cannot decode it. */
  const decode = async (key, bytes, type) => {
    const sniffed = sniff(bytes)[0] ?? (type || "").split(";")[0];
    try { const d = await px.load(key, bytes, sniffed); loaded.set(key, d); return d; } catch { return null; }
  };

  /* ---- fonts: google links (link tags + stylesheet requests), CSSOM faces, cross-origin sheets ---- */
  const gfonts = googleFamilies([...(comp.googleLinks ?? []), ...(comp.cssRequests ?? []).filter((u) => u.includes("fonts.googleapis.com"))]);
  const faces = (comp.faces ?? []).map((f) => ({ family: f.family, weight: f.weight || "400", style: f.style || "normal", src: (f.src ?? []).map((u) => [u, ""]) }));
  let origin = "";
  try { origin = new URL(comp.finalUrl || url).origin; } catch { /* keep empty */ }
  const foreign = (comp.cssRequests ?? []).filter((u) => !u.includes("fonts.googleapis.com") && !u.startsWith(origin) && !/fontawesome|font-awesome|dashicons|emoji/i.test(u)).slice(0, 6);
  await Promise.all(foreign.map(async (u) => {
    try { const { bytes } = await download(u, { perMs: 5_000 }); faces.push(...fontFacesOf(bytes.toString("utf8"), u)); } catch { /* a sheet we cannot read */ }
  }));

  /* ---- tokens from the computed styles (over neutral defaults) ---- */
  const hx = (v) => (v ? toHex(v) : null);
  const para = comp.para ?? {};
  const h1 = comp.h1 ?? {};
  const h2i = comp.h2 ?? {};
  let pageBg = hx(comp.pageBg) || "#ffffff";
  if (pageBg === "transparent") pageBg = "#ffffff";
  const text = hx(para.color) && hx(para.color) !== "transparent" ? hx(para.color) : "#222222";
  const heading = [hx(h1.color), hx(h2i.color), text].find((c) => c && c !== "transparent" && contrast(c, pageBg) >= 3) ?? text;
  const subheading = [hx(h2i.color), heading].find((c) => c && c !== "transparent" && contrast(c, pageBg) >= 3) ?? heading;
  const link = hx(comp.link?.color);
  const btn = comp.button ?? {};
  let bcol = hx(btn.bg);
  if (bcol === "transparent") bcol = null;
  const hdr = comp.header ?? {};
  const smp = comp.samples?.header ?? {};
  const grad = hdr.gradient ? parseGradient(hdr.gradient) : null;
  let band = null;
  if (grad) band = grad.stops[grad.stops.length - 1];
  else if (smp.dominant && (smp.uniform ?? 0) >= 0.25) band = smp.dominant;
  else if (hdr.bg?.color) band = hx(hdr.bg.color);
  const hasBand = Boolean(band && band !== "transparent" && contrast(band, pageBg) > 1.4);
  const lt = comp.logoText;
  const hdrRef = hasBand ? band : pageBg;
  const linkOk = link && link !== "transparent";
  let accent;
  if (linkOk && contrast(link, text) > 1.3) accent = link;
  else if (bcol) accent = bcol;
  else accent = hasBand ? band : linkOk ? link : "#2a5db0";
  const colors = {
    background: pageBg,
    pageBackground: hx(comp.bodyBg) && hx(comp.bodyBg) !== "transparent" ? hx(comp.bodyBg) : pageBg,
    text, heading, subheading,
    link: linkOk ? link : "#2a5db0",
    accent,
    primary: grad ? grad.stops[grad.stops.length - 1] : hasBand ? band : bcol || accent,
    headerBackground: hasBand ? band : null,
    headerGradient: hasBand ? grad : null,
    headerText: readableOn(hdrRef, hasBand ? hx(lt?.color) || hx(comp.nav?.color) : heading),
    muted: mix(text, pageBg, 0.45),
    hairline: mix(text, pageBg, 0.86),
    ...(bcol ? { button: bcol, buttonText: readableOn(bcol, hx(btn.color)) } : {}),
  };
  const pxv = (v, size) => { const m = /([\d.]+)px/.exec(v || ""); return m && size ? parseFloat(m[1]) / size : null; };
  const htok = (i, fb) => (i && i.weight ? { weight: weightNum(i.weight), case: i.transform || "none", letterSpacing: i.letterSpacing || "normal", style: i.style || "normal" } : fb);
  const headTok = htok(comp.h1, { weight: 700, case: "none", letterSpacing: "normal", style: "normal" });
  const type = {
    bodySizePx: para.size ? Math.round(para.size * 10) / 10 : 16,
    bodyLineHeight: para.size ? Math.round((pxv(para.lineHeight, para.size) ?? 1.5) * 100) / 100 : 1.5,
    bodyWeight: weightNum(para.weight),
    h1SizePx: h1.size ? Math.round(h1.size * 10) / 10 : null,
    heading: headTok,
    subheading: htok(comp.h2, headTok),
    logoSizePx: lt?.size ? Math.round(lt.size * 10) / 10 : null,
    logoWeight: lt?.weight ? weightNum(lt.weight) : null,
  };
  const fonts = {};
  const notes = [];
  const bodyInfo = para.rendered ? para : comp.body ?? { rendered: "Inter", stack: "" };
  for (const [role, info] of [["heading", comp.h1 || comp.h2 || bodyInfo], ["body", bodyInfo], ["ui", btn.font || comp.nav || bodyInfo]]) fonts[role] = chooseFont(info?.rendered ? info : bodyInfo, gfonts, faces);
  fonts.logo = lt?.rendered ? chooseFont(lt, gfonts, faces) : fonts.heading;
  for (const [role, f] of Object.entries(fonts)) if (f.substitute) notes.push(`${role}: '${f.substitute.for}' -> ${f.substitute.with} (${f.substitute.why})`);
  let radius = Number(comp.radius ?? 0) || 0;
  if (btn.radius) { const r = parseFloat(btn.radius); if (Number.isFinite(r)) radius = r; }
  const mw = comp.article?.paraWidth ?? null;
  const lh = type.bodyLineHeight || 1.5;
  const bpx = type.bodySizePx || 16;
  const score = Number(lh >= 1.55) + Number(bpx >= 19) + Number(mw !== null && mw <= 820) + Number((para.marginBottom ?? 0) >= bpx * 1.2);
  const hs = comp.samples?.hero ?? {};
  const h1c = hx(h1.color);
  let heroBg = null;
  if (hs.dominant && h1c && h1c !== "transparent") {
    const cand = (hs.uniform ?? 0) >= 0.35 ? hs.dominant : hs.mean;
    if (cand && contrast(cand, pageBg) > 1.25 && contrast(h1c, cand) >= 2.5) heroBg = cand;
  }
  colors.hero = heroBg ? { background: heroBg, text: h1c } : null;
  const hr = comp.shotRects?.header ?? hdr.rect;
  const feel = { density: score >= 2 ? "airy" : lh < 1.35 && bpx < 15 ? "dense" : "normal", radiusPx: radius, hasHeaderBand: hasBand, contentMaxWidthPx: mw, headerHeightPx: hr ? hr.h : null };
  const postTitle = (comp.h1Text || comp.ogTitle || "").trim();
  const nt = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let host = "";
  try { host = new URL(comp.finalUrl || url).hostname.replace(/^www\./, ""); } catch { host = url; }
  const titleSplit = (comp.title || "").split(/\s[|–—-]\s/);
  const siteCands = [comp.siteName, lt?.text, comp.logo?.alt, titleSplit.length > 1 ? titleSplit[titleSplit.length - 1] : ""];
  const siteName = siteCands.map((c) => (c || "").trim()).find((c) => c.length > 1 && c.length <= 40 && nt(c) !== nt(postTitle) && !(nt(c).length > 25 && nt(postTitle).startsWith(nt(c).slice(0, 25))) && !c.toLowerCase().includes("logo")) || host;

  const brand = { source: { url: comp.finalUrl || url, method: "headless browser (computed styles)" }, siteName, postTitle, fonts, colors, type, feel, images: [] };

  /* ---- the supplied images: downloaded once, measured (size, photo or graphic, tall) ---- */
  const hashes = new Map();
  const uniq = [...new Set(images.filter((s) => /^https?:\/\//i.test(s)))].slice(0, 16);
  await Promise.all(uniq.map(async (src, k) => {
    const entry = { src, alt: "" };
    brand.images[k] = entry;
    try {
      const { bytes, type: ct } = await download(src);
      const ext = sniff(bytes)[1] ?? (path.extname(new URL(src).pathname).toLowerCase() || ".jpg");
      const key = `img${k}`;
      const d = await decode(key, bytes, ct);
      if (!d || !d.w) { entry.error = "not a readable image"; return; }
      entry.local = await save(`img${String(k + 1).padStart(2, "0")}${ext}`, bytes);
      entry.width = d.w;
      entry.height = d.h;
      const kind = await px.call("imageKind", key);
      entry.kind = kind.kind;
      entry.flatShare = kind.flatShare;
      entry.tall = d.h / d.w > 1.3;
      hashes.set(src, await px.call("ahash", key, 1, null));
    } catch (error) { entry.error = String(error?.message ?? error).slice(0, 120); }
  }));
  brand.images = brand.images.filter(Boolean);

  /* ---- the logo ---- */
  const lg = comp.logo;
  if (lg?.src && !lg.src.startsWith("data:")) {
    const where = hasBand ? band : pageBg;
    const s = comp.samples?.logo ?? {};
    const sur = s.surround || s.dominant;
    let legible = false; let why = "could not sample the logo";
    if (sur && cdist(sur, where) < 60) { legible = true; why = `logo sat on ${sur} on the site, close to the page's ${where}`; }
    else if (s.ink && contrast(s.ink, where) >= 2.2) { legible = true; why = `logo ink ${s.ink} reads on ${where} (${contrast(s.ink, where).toFixed(1)}:1)`; }
    else if (s.ink) why = `logo ink ${s.ink} on ${where} would be too faint`;
    const lr = comp.shotRects?.logo ?? lg.rect ?? {};
    brand.logo = { src: lg.src, alt: lg.alt || "", legible, why, displayHeightPx: lr.h ?? null };
    try {
      const { bytes, type: ct } = await download(lg.src);
      const [, ext] = sniff(bytes);
      const d = await decode("logo", bytes, ct);
      brand.logo.local = await save(`logo${ext ?? (path.extname(new URL(lg.src).pathname).toLowerCase() || ".png")}`, bytes);
      brand.logo.width = d?.w || lg.naturalWidth || null;
      brand.logo.height = d?.h || lg.naturalHeight || null;
      if (!brand.logo.width || !brand.logo.height) brand.logo.legible = false;
    } catch (error) {
      brand.logo.error = String(error?.message ?? error).slice(0, 120);
      brand.logo.legible = false;
    }
  }

  /* ---- the hero photo behind the post title ---- */
  const hero = await heroOf({ comp, page, clean, download, decode, save, px, images: brand.images, hashes, deadline });
  if (hero && !hero.none) brand.hero = hero;
  else if (hero) brand.heroTried = hero.tried;

  /* ---- self-hosted fonts: names and source URLs are recorded in brand.fonts[role].files; the files are not downloaded ---- */
  brand.notes = notes;
  await px.close();
  return brand;
}

async function heroOf({ comp, page, clean, download, decode, save, px, images, hashes }) {
  const hp = comp.heroPhoto ?? {};
  const tried = [];
  let cleanDims = null;
  if (clean) cleanDims = await decode("clean", clean, "image/png");
  const grab = async (url, source) => {
    if (!url || url.startsWith("data:") || HERO_BAD.test(url)) { tried.push({ url, why: "empty or logo/icon-like" }); return null; }
    const list = [url, ...(source === "css-bg" || source === "img" ? biggerVariants(url, page).slice(0, 4) : [])];
    for (const u of list) {
      try {
        const { bytes, type } = await download(u);
        const d = await decode("hero", bytes, type);
        if (!d) { tried.push({ url: u, why: "not a readable image" }); continue; }
        if (d.w < HERO_MIN_W) { tried.push({ url: u, why: `too small (${d.w} px wide)` }); continue; }
        if (Math.min(d.w, d.h) < 200 || d.w / Math.max(1, d.h) > 8) { tried.push({ url: u, why: `strip/icon shape ${d.w}x${d.h}` }); continue; }
        let ext = sniff(bytes)[1];
        if (!ext) { ext = path.extname(new URL(u).pathname).toLowerCase(); if (![".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"].includes(ext)) ext = ".jpg"; }
        return { url: u, local: await save(`hero${ext}`, bytes), dims: d };
      } catch (error) { tried.push({ url: u, why: `download failed: ${String(error?.message ?? error).slice(0, 80)}` }); }
    }
    return null;
  };
  let got = null;
  let source = null;
  if (hp.found) { got = await grab(hp.src, hp.kind); source = got ? hp.kind : null; }
  // fallbacks only when the title really sits on imagery (the clean crop of its hero block is not one flat colour)
  const photoLike = cleanDims ? await px.call("photoLike", "clean") : false;
  if (!got && photoLike && comp.ogImage) { got = await grab(comp.ogImage, comp.ogImageFrom || "og"); source = got ? "og" : null; }
  if (!got && photoLike && cleanDims && cleanDims.w >= HERO_MIN_W) {
    await decode("hero", clean, "image/png");
    got = { url: null, local: await save("hero.png", clean), dims: cleanDims };
    source = "crop";
  }
  if (!got) return tried.length ? { none: true, tried } : null;
  const css = source === "css-bg" || source === "img";
  // the photo as the page shows it: at its own opacity over the colour under it
  const pOp = css ? Number(hp.photoOpacity ?? 1) || 1 : 1;
  let under = hp.under ? toHex(hp.under) : "#000000";
  if (!under || under === "transparent") under = "#ffffff";
  const opArgs = [pOp, under];
  const pos = css ? hp.position : "50% 50%";
  const size = css ? hp.size : "cover";
  // the overlay actually painted between photo and text: measured from pixels when the photo is the one on the page
  const cssOv = hp.found ? hp.overlayCss : null;
  let overlay = null;
  const oneGradient = (cssOv?.layers ?? []).filter((L) => L.gradient);
  if (source === "crop") overlay = { color: null, opacity: 0, how: "baked into the crop" };
  else if (cleanDims && css) {
    const m = await px.call("measureOverlay", "hero", ...opArgs, "clean", size, pos);
    const gR2 = oneGradient.length === 1 && cssOv.layers.length === 1 ? await px.call("gradientFit", "hero", ...opArgs, "clean", size, pos, oneGradient[0].gradient, oneGradient[0].elOpacity ?? 1) : null;
    if (gR2 !== null && gR2 >= Math.max(0.5, m.r2 - 0.03)) {
      overlay = { color: cssOv.color, opacity: cssOv.alpha, r2: gR2, how: `CSS gradient, confirmed by pixels (r2 ${gR2} vs flat ${m.r2})`, css: { gradient: oneGradient[0].gradient, opacity: oneGradient[0].elOpacity ?? 1 } };
    } else if (m.r2 >= 0.6) {
      overlay = { ...m, how: "measured (photo vs page pixels)" };
      // a CSS gradient whose average colour matches the measurement keeps its direction, at the measured strength
      for (const L of cssOv?.layers ?? []) {
        if (L.gradient && m.color && cdist(L.color, m.color) < 70) {
          const alphas = [...L.gradient.matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)].map((x) => parseFloat(x[1]));
          const opaque = (alphas.length ? alphas : [1]).every((a) => a >= 0.98);
          overlay.css = { gradient: L.gradient, opacity: opaque ? m.opacity : L.elOpacity ?? 1 };
          break;
        }
      }
    } else if (cssOv) overlay = { color: cssOv.color, opacity: cssOv.alpha, how: `CSS (pixel fit too weak, flat r2 ${m.r2}, gradient r2 ${gR2})` };
  } else if (cssOv) overlay = { color: cssOv.color, opacity: cssOv.alpha, how: "CSS" };
  if (overlay && String(overlay.how).startsWith("CSS") && cssOv && oneGradient.length === 1 && cssOv.layers.length === 1) overlay.css = { gradient: oneGradient[0].gradient, opacity: oneGradient[0].elOpacity ?? 1 };
  // how much of the photo's width the site's box shows
  let zoom = 1;
  const { w: pw0, h: ph0 } = got.dims;
  if (css && hp.rect) {
    const { w: rw, h: rh } = hp.rect;
    const sz = String(size || "cover").split(",")[0].trim();
    const sc = ["cover", "fill", ""].includes(sz) ? Math.max(rw / pw0, rh / ph0) : ["contain", "scale-down"].includes(sz) ? Math.min(rw / pw0, rh / ph0) : sz.startsWith("auto") || sz === "none" ? 1 : Math.max(rw / pw0, rh / ph0);
    zoom = Math.round(Math.min(1, rw / (pw0 * sc)) * 1000) / 1000;
  }
  const [fx, fy] = cssPos(pos);
  const grid = {};
  for (const [k, [w, h, c, r]] of Object.entries(HERO_BOX)) grid[k] = await px.call("toneGrid", "hero", ...opArgs, w / h, c, r, pos, zoom);
  const hero = {
    src: got.url || "screenshot crop", local: got.local, source, width: pw0, height: ph0,
    position: `${Math.round(fx * 100)}% ${Math.round(fy * 100)}%`,
    overlay, titleColor: hp.titleColor ? toHex(hp.titleColor) : null, titleAlign: hp.titleAlign || "left", zoom,
    photoOpacity: Math.round(pOp * 1000) / 1000, under: pOp < 0.99 ? under : null, grid, tried,
  };
  // the same picture as one of the supplied images: flag both
  const heroHash = await px.call("ahash", "hero", ...opArgs);
  for (const img of images) {
    if (!img.local) continue;
    let same = Boolean(got.url) && urlStem(got.url) === urlStem(img.src);
    const ih = hashes.get(img.src);
    if (!same && ih) {
      const diff = ih.bits.reduce((n, b, i) => n + (b !== heroHash.bits[i] ? 1 : 0), 0) / ih.bits.length;
      if (Math.abs(ih.w / ih.h - heroHash.w / heroHash.h) < 0.05 && diff < 0.12) same = true;
    }
    if (same) { img.sameAsHero = true; hero.sameAsImage = img.src; }
  }
  return hero;
}

/**
 * Extracts the brand of `url` into `dir`, capped at `timeoutMs` (default 45 s). Never throws: on any failure or a
 * timeout it returns ok:false with a warning, and the caller decides what to do.
 */
export async function extractBrand({ url, dir, images = [], timeoutMs = BRAND_TIMEOUT_MS, log = () => undefined, lookup }) {
  const t0 = Date.now();
  let browser = null;
  let timer;
  const seconds = () => Math.round((Date.now() - t0) / 100) / 10;
  try {
    const tokens = await Promise.race([
      run({ url, dir, images, deadline: t0 + timeoutMs, onBrowser: (b) => { browser = b; }, log, lookup }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the brand pass took longer than ${Math.round(timeoutMs / 1000)} s`)), timeoutMs); }),
    ]);
    return { ok: true, tokens, seconds: seconds(), warning: null };
  } catch (error) {
    return { ok: false, tokens: null, seconds: seconds(), warning: `Could not read the site's look (${String(error?.message ?? error).slice(0, 200)}).` };
  } finally {
    clearTimeout(timer);
    if (browser) {
      const proc = browser.process();
      await Promise.race([browser.close().catch(() => undefined), new Promise((r) => setTimeout(r, 3_000))]);
      try { if (proc && proc.exitCode === null) proc.kill("SIGKILL"); } catch { /* gone */ }
    }
  }
}

/** The tokens without the parts only a debugger needs. */
export function slimTokens(tokens) {
  if (!tokens) return null;
  const { notes, heroTried, ...rest } = tokens;
  const hero = rest.hero ? (({ tried, grid, ...h }) => h)(rest.hero) : undefined;
  return { ...rest, ...(hero ? { hero } : {}), notes: notes ?? [] };
}
