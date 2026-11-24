#!/usr/bin/env node
// brand-kit.mjs <url> [--out <dir>]
// Reads a website's look in headless Chrome and writes brand.json, brand.md and preview.html into <dir> (default ./out/<host>).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractBrand } from "./extract.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const url = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
if (!url || args.includes("--help")) {
  console.error("usage: node brand-kit.mjs <url> [--out <dir>]\n  env: CHROME_PATH=/path/to/chrome (optional; auto-detected otherwise)");
  process.exit(url ? 0 : 2);
}
let target = url;
if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = `https://${target}`;
let host = "site";
try { host = new URL(target).hostname.replace(/^www\./, ""); } catch { /* keep default */ }
const dir = path.resolve(flag("--out") ?? path.join("out", host));
await mkdir(dir, { recursive: true });

const result = await extractBrand({ url: target, dir, log: (line) => console.error(line) });
if (!result.ok) {
  console.error(result.warning);
  process.exit(1);
}
const t = result.tokens;

/* ---------------------------------------------------------------- helpers */
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fileOf = (u) => (u ? fileURLToPath(u) : null);
const rel = (u) => (u ? path.relative(dir, fileOf(u)) : null);
const ROLE = {
  background: "page background (the reading surface)",
  pageBackground: "outer page / body background",
  text: "body text",
  heading: "headings",
  subheading: "sub-headings",
  link: "links",
  accent: "accent (the colour to use for emphasis)",
  primary: "primary brand colour",
  headerBackground: "header band background",
  headerText: "text on the header band",
  muted: "muted / secondary text (derived)",
  hairline: "borders and rules (derived)",
  button: "button background",
  buttonText: "text on buttons",
};
const swatches = [];
for (const [key, value] of Object.entries(t.colors)) {
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) swatches.push({ key, hex: value.toLowerCase(), role: ROLE[key] ?? key });
}
if (t.colors.hero) {
  swatches.push({ key: "hero.background", hex: t.colors.hero.background, role: "hero block background" });
  swatches.push({ key: "hero.text", hex: t.colors.hero.text, role: "text on the hero block" });
}
const GENERIC_STACK = { serif: "serif", "sans-serif": "sans-serif", monospace: "monospace" };
/** CSS family the preview uses for a font token: what the site renders if it is a Google font, else the closest Google font. */
function previewFamily(f) {
  const fam = f.source === "self-hosted" ? f.fallback?.family : f.family;
  return `'${fam}', ${GENERIC_STACK[f.generic] ?? "sans-serif"}`;
}
function googleNames() {
  const names = new Set();
  for (const f of Object.values(t.fonts)) {
    if (f.source === "google") names.add(f.family);
    if (f.fallback?.family) names.add(f.fallback.family);
  }
  return [...names];
}
const fontLine = (role, f) => {
  const name = f.rendered || f.family;
  if (f.source === "google") return f.substitute
    ? `- **${role}**: \`${name}\` (not freely available) -> use **${f.family}** from Google Fonts, weights ${f.weights.join(", ")}. Fallback stack: \`${f.generic}\`. (${f.substitute.why})`
    : `- **${role}**: **${f.family}** from Google Fonts, weights ${f.weights.join(", ")}. Fallback stack: \`${f.generic}\`.`;
  const files = (f.files ?? []).map((x) => `  - ${x.weight} ${x.style}: ${x.url}`).join("\n");
  return `- **${role}**: **${f.family}**, self-hosted by the site (named, not downloaded). Closest free stand-in: **${f.fallback?.family}** (Google Fonts). Fallback stack: \`${f.generic}\`. Original files, for reference only:\n${files}`;
};

/* ---------------------------------------------------------------- brand.json */
await writeFile(path.join(dir, "brand.json"), JSON.stringify(result, null, 2));

/* ---------------------------------------------------------------- brand.md */
const logoPath = t.logo?.local ? rel(t.logo.local) : null;
const heroPath = t.hero?.local ? rel(t.hero.local) : null;
const c = t.colors;
const g = c.headerGradient;
const md = [];
md.push(`# Brand kit: ${t.siteName}`, "", `Source: ${t.source.url} (read ${new Date().toISOString().slice(0, 10)}, ${t.source.method})`, "");
md.push("## Colours", "", "| Role | Hex | Name in brand.json |", "|---|---|---|");
for (const s of swatches) md.push(`| ${s.role} | \`${s.hex}\` | colors.${s.key} |`);
md.push("");
md.push("## Fonts", "");
for (const role of ["heading", "body", "ui", "logo"]) {
  const f = t.fonts[role];
  if (!f) continue;
  const same = ["heading", "body"].find((r) => r !== role && t.fonts[r] && t.fonts[r].family === f.family && r !== "logo" && role !== "heading");
  md.push(same && role !== "body" ? `- **${role}**: same as ${same} (${f.family})` : fontLine(role, f));
}
md.push("", "Type scale as the site renders it:", "");
md.push(`- Body: ${t.type.bodySizePx}px, line height ${t.type.bodyLineHeight}, weight ${t.type.bodyWeight}`);
if (t.type.h1SizePx) md.push(`- H1: ${t.type.h1SizePx}px, weight ${t.type.heading.weight}, letter spacing ${t.type.heading.letterSpacing}, case ${t.type.heading.case}`);
md.push(`- Sub-headings: weight ${t.type.subheading.weight}, letter spacing ${t.type.subheading.letterSpacing}`);
if (t.type.logoSizePx) md.push(`- Site name in the header: ${t.type.logoSizePx}px, weight ${t.type.logoWeight}`);
md.push("", "## Logo", "");
if (t.logo?.src) {
  md.push(`- URL: ${t.logo.src}`);
  md.push(logoPath ? `- Saved file: \`${logoPath}\`${t.logo.width ? ` (${t.logo.width} x ${t.logo.height}px)` : ""}` : `- Not saved${t.logo.error ? `: ${t.logo.error}` : ""}`);
  md.push(`- Readable on a light/dark surface: ${t.logo.legible ? "yes" : "no"} (${t.logo.why})`);
  if (t.logo.alt) md.push(`- Alt text: ${t.logo.alt}`);
} else md.push(`- No logo image found; the header shows the site name as text (${t.fonts.logo?.family ?? "heading font"}).`);
md.push("", "## Header", "");
md.push(`- Band: ${t.feel.hasHeaderBand ? `yes, background \`${c.headerBackground}\`${g ? `, a ${g.type} gradient (${g.stops.join(" -> ")})` : ""}, text \`${c.headerText}\`` : `none; the header sits on the page background, text \`${c.headerText}\``}`);
if (t.feel.headerHeightPx) md.push(`- Height: about ${t.feel.headerHeightPx}px at a 1440px wide viewport`);
md.push("", "## Spacing and feel", "");
md.push(`- Density: ${t.feel.density}`, `- Corner radius: ${t.feel.radiusPx}px`);
if (t.feel.contentMaxWidthPx) md.push(`- Text column width: about ${t.feel.contentMaxWidthPx}px`);
if (heroPath) {
  const o = t.hero.overlay;
  md.push("", "## Hero image", "", `- Saved file: \`${heroPath}\` (${t.hero.width} x ${t.hero.height}px), from ${t.hero.src}`, `- Title colour over it: ${t.hero.titleColor ?? "n/a"}${o ? `; the site paints ${o.color ?? "a dark"} overlay at about ${Math.round((o.opacity ?? 0) * 100)}% over it` : ""}`);
}
md.push("", "## Notes", "");
const notes = [...(t.notes ?? [])];
if (t.postTitle) notes.push(`Page title read: "${t.postTitle}"`);
if (!notes.length) notes.push("None.");
for (const n of notes) md.push(`- ${n}`);
md.push("", "Fonts are only named here. Licensed fonts are not downloaded; use the listed Google Fonts stand-in, or license the original.", "");
await writeFile(path.join(dir, "brand.md"), md.join("\n"));

/* ---------------------------------------------------------------- preview.html */
let logoTag = "";
if (t.logo?.local && !t.logo.error) {
  try {
    const bytes = await readFile(fileOf(t.logo.local));
    const ext = path.extname(fileOf(t.logo.local)).toLowerCase();
    const mime = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" }[ext] ?? "image/png";
    logoTag = `<img class="logo" alt="${esc(t.logo.alt || t.siteName)}" src="data:${mime};base64,${bytes.toString("base64")}">`;
  } catch { /* no logo in the preview */ }
}
const headBg = g ? `${g.type}-gradient(${g.stops.join(", ")})` : c.headerBackground ?? c.background;
const gf = googleNames();
const gfLink = gf.length ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${gf.map((n) => `family=${encodeURIComponent(n).replace(/%20/g, "+")}:wght@300;400;500;600;700`).join("&")}&display=swap">` : "";
const readable = (hex) => { const n = parseInt(hex.slice(1), 16); const l = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; return l > 0.6 ? "#111111" : "#ffffff"; };
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brand kit: ${esc(t.siteName)}</title>
${gfLink}
<style>
:root{--bg:${c.background};--page:${c.pageBackground};--text:${c.text};--heading:${c.heading};--link:${c.link};--accent:${c.accent};--muted:${c.muted};--hair:${c.hairline};--radius:${t.feel.radiusPx}px;--hf:${previewFamily(t.fonts.heading)};--bf:${previewFamily(t.fonts.body)};--uf:${previewFamily(t.fonts.ui)}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);font:${Math.min(t.type.bodySizePx, 20)}px/${t.type.bodyLineHeight} var(--bf)}
header{background:${headBg};color:${c.headerText};padding:18px 32px;display:flex;align-items:center;gap:20px;min-height:${Math.min(t.feel.headerHeightPx ?? 72, 120)}px;${t.feel.hasHeaderBand ? "" : "border-bottom:1px solid var(--hair);"}}
header .logo{max-height:56px;max-width:260px;object-fit:contain}header .name{font:${t.type.logoWeight ?? 700} ${Math.min(t.type.logoSizePx ?? 28, 40)}px ${previewFamily(t.fonts.logo)}}
main{max-width:${Math.max(720, Math.min(t.feel.contentMaxWidthPx ?? 900, 1000))}px;margin:0 auto;padding:32px 24px 64px}
section{background:var(--bg);border:1px solid var(--hair);border-radius:var(--radius);padding:24px;margin-bottom:24px}
h1,h2,h3{font-family:var(--hf);color:var(--heading);margin:0 0 .4em}h1{font-size:${Math.min(t.type.h1SizePx ?? 36, 48)}px;font-weight:${t.type.heading.weight};letter-spacing:${t.type.heading.letterSpacing};text-transform:${t.type.heading.case}}
h2{font-size:22px;font-weight:${t.type.subheading.weight}}small,.mono{color:var(--muted)}.mono{font:12px ui-monospace,Menlo,Consolas,monospace}
.sw{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.sw div{border:1px solid var(--hair);border-radius:var(--radius);overflow:hidden;background:var(--bg)}
.sw i{display:block;height:64px}.sw span{display:block;padding:8px 10px;font-size:13px}.sw b{display:block;font-family:ui-monospace,Menlo,monospace;font-weight:600}
.btn{display:inline-block;padding:10px 18px;border-radius:var(--radius);background:${c.button ?? c.accent};color:${c.buttonText ?? readable(c.button ?? c.accent)};font-family:var(--uf);margin-right:10px}a{color:var(--link)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:640px){.row{grid-template-columns:1fr}header{padding:14px 16px}}
</style></head><body>
<header>${logoTag}<span class="name">${esc(t.siteName)}</span></header>
<main>
<section><h1>${esc(t.postTitle || "A headline set in the heading font")}</h1>
<p>Body copy in <b>${esc(t.fonts.body.rendered || t.fonts.body.family)}</b> at ${t.type.bodySizePx}px with a line height of ${t.type.bodyLineHeight}. <a href="#">A link in the site's link colour</a>, then <span style="color:var(--muted)">muted secondary text</span>.</p>
<p><span class="btn">Primary button</span><span class="mono">radius ${t.feel.radiusPx}px, density ${esc(t.feel.density)}</span></p></section>
<section><h2>Colours</h2><div class="sw">${swatches.map((s) => `<div><i style="background:${s.hex}"></i><span><b>${s.hex}</b>${esc(s.role)}</span></div>`).join("")}</div></section>
<section><h2>Fonts</h2><div class="row">${["heading", "body", "ui", "logo"].filter((r) => t.fonts[r]).map((r) => { const f = t.fonts[r]; const fam = previewFamily(f); return `<div><small>${r}: ${esc(f.rendered || f.family)}${f.source === "self-hosted" ? ` (self-hosted; preview uses ${esc(f.fallback?.family)})` : f.substitute ? ` (preview uses ${esc(f.family)})` : ""}</small><div style="font-family:${fam};font-size:${r === "heading" ? 30 : 20}px;font-weight:${r === "heading" ? t.type.heading.weight : 400}">The quick brown fox jumps over the lazy dog</div></div>`; }).join("")}</div></section>
${logoTag ? `<section><h2>Logo</h2><div style="background:${c.headerBackground ?? c.background};padding:20px;border-radius:var(--radius);display:inline-block">${logoTag}</div> <small>${t.logo.legible ? "reads on the header colour" : "check contrast before reusing"}</small></section>` : ""}
</main></body></html>`;
await writeFile(path.join(dir, "preview.html"), html);

console.log(`Wrote ${path.join(dir, "brand.json")}\n      ${path.join(dir, "brand.md")}\n      ${path.join(dir, "preview.html")}`);
console.log(`${t.siteName}: heading ${t.fonts.heading.family}, body ${t.fonts.body.family}, accent ${c.accent}, header ${c.headerBackground ?? "none"}`);
