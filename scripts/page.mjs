// Step 1: the headless-browser pass.
// Loads the post in headless Chrome at 1440 x 1000, wakes lazy content near the top, then reads COMPUTED styles from
// the real elements (body text, h1/h2, links, header band, nav, buttons, article container, logo image), finds the hero
// photo behind the post title and the layers painted over it, and samples the screenshot's pixels for the header band
// and the logo ink. Returns everything in memory; extract.mjs turns it into brand tokens.
//
// The scroll stops after the first screens (only the header and hero matter here), a border-radius probe reads the
// corner style, and nothing is written to disk here.
// The page is untrusted: nothing it says is followed; we only read styles, geometry and image URLs.
import { guardPage } from "./net.mjs";

export const VIEW_W = 1440;
export const VIEW_H = 1000;
const W = VIEW_W;
const H = VIEW_H;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/**
 * @param {import("puppeteer-core").Browser} browser
 * @param {string} url
 * @param {{ navTimeoutMs?: number }} [options]
 * @returns {Promise<{ data: any; renderedHtml: string; screenshot: Uint8Array; clean: Uint8Array | null }>}
 */
export async function readPage(browser, url, options = {}) {
  const navTimeout = Math.max(5_000, options.navTimeoutMs ?? 20_000);
  const fontReqs = new Set();
  const cssReqs = new Set();
  const page = await browser.newPage();
  // every request the page makes (itself, its redirects, subresources) is checked against private targets first
  if (options.guard) await guardPage(page, options.guard);
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.setUserAgent(UA);
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  page.on("response", (r) => {
    const t = r.request().resourceType();
    if (t === "font") fontReqs.add(r.url());
    if (t === "stylesheet") cssReqs.add(r.url());
  });
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: navTimeout });
  } catch {
    // a page that never goes quiet (chat widgets, analytics beacons): what has loaded by now is enough
    await page.evaluate(() => document.readyState).catch(async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
    });
    await new Promise((r) => setTimeout(r, 1500));
  }
  // smooth-scrolling themes would still be gliding when we measure: make scrolling instant
  await page.addStyleTag({ content: "html,body{scroll-behavior:auto!important}" }).catch(() => {});
  // scroll the first screens in steps so lazy hero backgrounds and logos (loading=lazy, data-src) load
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    const max = Math.min(document.documentElement.scrollHeight, 4000);
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
  });
  await Promise.race([page.evaluate(() => document.fonts.ready), new Promise((r) => setTimeout(r, 4000))]);
  await new Promise((r) => setTimeout(r, 400));

  const data = await page.evaluate(() => {
    const vw = window.innerWidth;
    const cs = (el) => getComputedStyle(el);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = cs(el);
      return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05;
    };
    const absRect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const NOT_CONTENT = "nav, aside, footer, header, [role=navigation], [role=complementary], [role=contentinfo], [role=banner], form, .sidebar, #sidebar, .widget, .comments, #comments";
    const outside = (el) => !el.closest(NOT_CONTENT);
    const txtLen = (el) => (el.innerText || "").replace(/\s+/g, " ").trim().length;

    // ---------- article container ----------
    let article = null;
    let articleMethod = "";
    const arts = [...document.querySelectorAll("article, [itemprop=articleBody]")].filter(visible);
    const pText = (el) => [...el.querySelectorAll("p")].filter((p) => outside(p) || el.contains(p.closest(NOT_CONTENT)) === false).reduce((n, p) => n + txtLen(p), 0);
    if (arts.length) {
      arts.sort((a, b) => pText(b) - pText(a));
      if (pText(arts[0]) > 400) {
        article = arts[0];
        articleMethod = "article element";
      }
    }
    if (!article) {
      // largest text-dense container: the deepest block holding >= 70% of the page's paragraph text, outside nav/aside/footer
      const ps = [...document.querySelectorAll("p, li")].filter((p) => visible(p) && outside(p) && txtLen(p) > 40);
      const total = ps.reduce((n, p) => n + txtLen(p), 0);
      const score = new Map();
      for (const p of ps) {
        let a = p.parentElement;
        while (a && a !== document.body) {
          score.set(a, (score.get(a) || 0) + txtLen(p));
          a = a.parentElement;
        }
      }
      let best = null;
      let bestDepth = -1;
      for (const [el, n] of score) {
        if (n < total * 0.7 || !outside(el)) continue;
        let d = 0;
        for (let a = el; a; a = a.parentElement) d++;
        if (d > bestDepth) {
          best = el;
          bestDepth = d;
        }
      }
      article = best || document.querySelector("main, [role=main]") || document.body;
      articleMethod = best ? "largest text-dense container" : "main/body fallback";
    }
    article.setAttribute("data-rb-article", "1");

    const para = [...article.querySelectorAll("p")].find((p) => visible(p) && txtLen(p) > 80 && outside(p)) || [...document.querySelectorAll("p")].find((p) => visible(p) && txtLen(p) > 80) || article;
    para.setAttribute("data-rb-para", "1");
    const h1s = [...document.querySelectorAll("h1")].filter((h) => visible(h) && txtLen(h) > 3);
    const normT = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const pageTitle = normT(document.querySelector('meta[property="og:title"]')?.content || document.title.split(/\s[|–—-]\s/)[0]);
    // the post title: an <h1>, else (builders like Duda/Wix) the biggest visible element whose text is the post title
    let title = h1s.find((h) => article.contains(h)) || h1s.find((h) => pageTitle && normT(h.innerText).startsWith(pageTitle.slice(0, 30))) || null;
    if (!title && pageTitle) {
      const hits = [...document.querySelectorAll("body *")].filter((el) => el.children.length < 4 && visible(el) && normT(el.innerText) === pageTitle);
      title = hits.sort((a, b) => parseFloat(cs(b).fontSize) - parseFloat(cs(a).fontSize))[0] || null;
    }
    if (!title) title = h1s.sort((a, b) => parseFloat(cs(b).fontSize) - parseFloat(cs(a).fontSize))[0] || null;
    if (title) {
      title.setAttribute("data-rb-title", "1");
      // the full-width block the title sits in (a hero band on many business sites)
      let hero = title.parentElement;
      while (hero && hero !== document.body && hero.getBoundingClientRect().width < vw * 0.9) hero = hero.parentElement;
      if (hero && hero !== document.body && hero.getBoundingClientRect().height < 900) hero.setAttribute("data-rb-hero", "1");
    }
    const h2 = [...article.querySelectorAll("h2, h3")].find(visible) || null;
    if (h2) h2.setAttribute("data-rb-h2", "1");
    const link = [...article.querySelectorAll("p a[href], li a[href]")].find((a) => visible(a) && outside(a) && txtLen(a) > 2) || null;

    // ---------- header band ----------
    const hdrCands = [...document.querySelectorAll("header, [role=banner], [class*=header], [id*=header], [class*=masthead], [class*=navbar], [class*=top-bar], [class*=topbar]")].filter((el) => {
      if (!visible(el) || article.contains(el) || el.contains(article)) return false;
      const r = el.getBoundingClientRect();
      const n = (el.className && el.className.baseVal === undefined ? el.className : "") + " " + el.id;
      if (/post-header|entry-header|article-header|footer|widget|modal|popup|cookie/i.test(n)) return false;
      return r.top + window.scrollY < 260 && r.width >= vw * 0.9 && r.height >= 36 && r.height <= 420;
    });
    // outermost candidate wins (covers top bar + main bar together)
    let header = hdrCands.find((el) => !hdrCands.some((o) => o !== el && o.contains(el))) || null;
    if (!header) {
      const nav = [...document.querySelectorAll("nav")].find((n) => visible(n) && n.getBoundingClientRect().top < 260);
      if (nav) {
        header = nav;
        while (header.parentElement && header.parentElement !== document.body && header.parentElement.getBoundingClientRect().height < 420) header = header.parentElement;
      }
    }
    if (header) header.setAttribute("data-rb-header", "1");
    const bgOf = (el) => {
      for (let a = el; a; a = a.parentElement) {
        const s = cs(a);
        const img = s.backgroundImage && s.backgroundImage !== "none" ? s.backgroundImage : null;
        const col = s.backgroundColor;
        const transparent = !col || col === "transparent" || /rgba\(.*,\s*0\)$/.test(col);
        if (img && /gradient/.test(img)) return { color: transparent ? null : col, image: img, from: a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") };
        if (!transparent) return { color: col, image: img, from: a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") };
      }
      return { color: "rgb(255, 255, 255)", image: null, from: "default" };
    };
    // gradients painted by the header or any wide child of it
    let headerGradient = null;
    if (header) {
      for (const el of [header, ...header.querySelectorAll("*")].slice(0, 300)) {
        const s = cs(el);
        if (/gradient\(/.test(s.backgroundImage) && el.getBoundingClientRect().width >= vw * 0.6) {
          headerGradient = s.backgroundImage;
          break;
        }
      }
    }

    // ---------- logo ----------
    let logo = null;
    if (header) {
      const imgs = [...header.querySelectorAll("img")].filter(visible);
      const homeHref = (a) => {
        try {
          const u = new URL(a.href, location.href);
          return u.host === location.host && (u.pathname === "/" || u.pathname === "");
        } catch {
          return false;
        }
      };
      const score = (im) => {
        const n = [im.className, im.id, im.alt, im.src, im.parentElement?.className || "", im.closest("a")?.className || ""].join(" ").toLowerCase();
        let s = 0;
        if (/logo|brand|site-title|wordmark|custom-logo/.test(n)) s += 3;
        if (im.closest("a") && homeHref(im.closest("a"))) s += 2;
        const r = im.getBoundingClientRect();
        if (r.left < vw * 0.4) s += 1;
        if (r.width < 40) s -= 3;
        return s;
      };
      const best = imgs.map((im) => [im, score(im)]).sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= 2) {
        const im = best[0];
        im.setAttribute("data-rb-logo", "1");
        logo = { src: im.currentSrc || im.src, alt: im.alt || "", rect: absRect(im), naturalWidth: im.naturalWidth, naturalHeight: im.naturalHeight };
      }
    }
    let logoTextEl = header ? [...header.querySelectorAll("[class*=logo], [class*=site-title], [class*=site-name], [class*=brand]")].find((el) => visible(el) && txtLen(el) > 1 && txtLen(el) < 60 && !el.querySelector("img")) : null;
    // the deepest element carrying that same text is the one whose font is actually drawn
    while (logoTextEl) {
      const t = (logoTextEl.innerText || "").trim();
      const kid = [...logoTextEl.children].find((c) => (c.innerText || "").trim() === t);
      if (!kid) break;
      logoTextEl = kid;
    }

    // ---------- buttons (the site's call-to-action colour) ----------
    const pageBg = bgOf(para).color;
    const btns = {};
    for (const el of document.querySelectorAll("a, button, input[type=submit], [class*=btn], [class*=button]")) {
      if (!visible(el)) continue;
      const s = cs(el);
      const col = s.backgroundColor;
      if (!col || col === "transparent" || /rgba\(.*,\s*0\)$/.test(col) || col === pageBg) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 24 || r.width > vw * 0.6 || r.height > 120) continue;
      const k = col;
      btns[k] = btns[k] || { bg: col, color: s.color, radius: s.borderTopLeftRadius, fontFamily: s.fontFamily, fontWeight: s.fontWeight, textTransform: s.textTransform, count: 0, area: 0, text: (el.innerText || el.value || "").trim().slice(0, 40) };
      btns[k].count++;
      btns[k].area += r.width * r.height;
    }

    // ---------- corner radius: buttons, inputs and the first article images ----------
    const radii = [];
    for (const el of [...document.querySelectorAll("button, input[type=submit], input[type=text], input[type=email], a[class*=btn], a[class*=button]")].filter(visible).slice(0, 12).concat([...article.querySelectorAll("img")].filter(visible).slice(0, 3))) {
      const v = parseFloat(cs(el).borderTopLeftRadius);
      if (Number.isFinite(v) && v < 200) radii.push(v);
    }
    radii.sort((a, b) => a - b);
    const radius = radii.length ? radii[Math.floor(radii.length / 2)] : 0;

    // ---------- fonts: which family in each stack actually renders ----------
    const ctx = document.createElement("canvas").getContext("2d");
    const SAMPLE = "Hamburgefonstiv 0123 WMQ";
    const avail = (fam) => {
      if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|-apple-system|ui-\w+|inherit|initial)$/i.test(fam)) return true;
      for (const g of ["monospace", "serif"]) {
        ctx.font = `40px ${g}`;
        const a = ctx.measureText(SAMPLE).width;
        ctx.font = `40px "${fam}", ${g}`;
        if (Math.abs(ctx.measureText(SAMPLE).width - a) > 0.5) return true;
      }
      return false;
    };
    const fams = (stack) => stack.split(",").map((f) => f.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    // shape class of a family: mono / serif / slab / sans, measured from glyphs
    const shape = (fam) => {
      ctx.font = `100px "${fam}", sans-serif`;
      if (Math.abs(ctx.measureText("iiii").width - ctx.measureText("mmmm").width) < 1) return "mono";
      const c = document.createElement("canvas");
      c.width = 200;
      c.height = 200;
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, 200, 200);
      g.fillStyle = "#000";
      g.font = `140px "${fam}", sans-serif`;
      g.textBaseline = "alphabetic";
      g.fillText("I", 60, 170);
      const px = g.getImageData(0, 0, 200, 200).data;
      const rowW = (y) => {
        let n = 0;
        for (let x = 0; x < 200; x++) if (px[(y * 200 + x) * 4] < 128) n++;
        return n;
      };
      const rows = [];
      for (let y = 0; y < 200; y++) rows.push(rowW(y));
      const ink = rows.map((w, y) => [w, y]).filter(([w]) => w > 0);
      if (!ink.length) return "sans";
      const top = ink[0][1];
      const bot = ink[ink.length - 1][1];
      const mid = rows[Math.round((top + bot) / 2)];
      const foot = rows[bot - 2] || 0;
      if (foot > mid * 1.6) {
        let thick = 0;
        for (let y = bot; y > top && rows[y] > mid * 1.4; y--) thick++;
        return thick / (bot - top) > 0.075 ? "slab" : "serif";
      }
      return "sans";
    };
    const fontInfo = (el) => {
      if (!el) return null;
      const s = cs(el);
      const list = fams(s.fontFamily);
      const rendered = list.find(avail) || list[list.length - 1];
      return {
        stack: s.fontFamily,
        rendered,
        shape: shape(rendered),
        size: parseFloat(s.fontSize),
        weight: s.fontWeight,
        lineHeight: s.lineHeight,
        color: s.color,
        transform: s.textTransform,
        letterSpacing: s.letterSpacing,
        style: s.fontStyle,
        marginBottom: parseFloat(s.marginBottom),
      };
    };
    const navLink = header ? [...header.querySelectorAll("nav a, a")].find((a) => visible(a) && txtLen(a) > 2 && !a.querySelector("img")) : null;
    const bestBtn = Object.values(btns).sort((a, b) => b.area - a.area)[0];
    const btnEl = bestBtn ? [...document.querySelectorAll("a, button, input[type=submit], [class*=btn], [class*=button]")].find((el) => visible(el) && cs(el).backgroundColor === bestBtn.bg) : null;

    // @font-face rules we can read (same-origin and inline sheets)
    const faces = [];
    for (const sh of document.styleSheets) {
      let rules;
      try {
        rules = sh.cssRules;
      } catch {
        continue;
      }
      const walk = (rs, base) => {
        for (const r of rs) {
          if (r.type === CSSRule.FONT_FACE_RULE) {
            const st = r.style;
            const srcs = [...(st.getPropertyValue("src") || "").matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => {
              try {
                return new URL(m[1], base).href;
              } catch {
                return m[1];
              }
            }).filter((u) => !u.startsWith("data:"));
            faces.push({ family: st.getPropertyValue("font-family").replace(/['"]/g, "").trim(), weight: st.getPropertyValue("font-weight") || "400", style: st.getPropertyValue("font-style") || "normal", src: srcs });
          } else if (r.cssRules) walk(r.cssRules, base);
        }
      };
      walk(rules, sh.href || location.href);
    }

    // ---------- hero photo: the image behind / around the post title ----------
    // Candidates: CSS background images (own layer, ::before, ::after) on the title's ancestors and on any element whose
    // box overlaps or directly adjoins the title block near the top of the page; big <img>/<picture> the same way.
    // Then the layers painted between that photo and the title text (overlay colour + opacity), read from the stack.
    const heroPhoto = (() => {
      if (!title) return null;
      const sy = window.scrollY;
      const tr = title.getBoundingClientRect();
      const T = { x: tr.left, y: tr.top + sy, w: tr.width, h: tr.height };
      if (T.y > 1600) return null;
      const BAD = /logo|icon|avatar|gravatar|sprite|badge|emoji|favicon|spacer|pixel|placeholder/i;
      const parseCol = (v) => {
        const m = (v || "").match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      // url() layers of a background-image value; image-set -> its largest resolution
      const urlLayers = (bgi) => {
        if (!bgi || bgi === "none") return [];
        const layers = [];
        let depth = 0, cur = "";
        for (const ch of bgi) {
          if (ch === "(") depth++;
          if (ch === ")") depth--;
          if (ch === "," && depth === 0) {
            layers.push(cur.trim());
            cur = "";
          } else cur += ch;
        }
        if (cur.trim()) layers.push(cur.trim());
        return layers.map((l, i) => {
          if (/gradient\(/.test(l)) return { i, gradient: l };
          const us = [...l.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)\s*([\d.]+)?(x|dppx|w)?/g)].map((m) => ({ u: m[1], k: m[2] ? parseFloat(m[2]) : 1 }));
          if (!us.length) return { i };
          us.sort((a, b) => b.k - a.k);
          try {
            return { i, url: new URL(us[0].u, location.href).href };
          } catch {
            return { i };
          }
        });
      };
      const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top + sy, w: r.width, h: r.height };
      };
      const near = (R) => {
        // overlaps the title, or adjoins it (<= 60 px above/below) with horizontal overlap
        const hOver = Math.min(R.x + R.w, T.x + T.w) - Math.max(R.x, T.x);
        if (hOver < Math.min(T.w, R.w) * 0.5) return 0;
        const vGap = Math.max(R.y - (T.y + T.h), T.y - (R.y + R.h));
        if (vGap <= 0) return 2; // overlaps
        return vGap <= 60 ? 1 : 0;
      };
      const cands = [];
      const seen = new Set();
      const push = (el, pseudo, url, kind, extra = {}) => {
        if (!url || url.startsWith("data:") || BAD.test(url) || seen.has(url + pseudo)) return;
        const R = rectOf(el);
        if (R.w < vw * 0.35 || R.h < 120 || R.y > 1600) return;
        const rel = near(R);
        if (!rel) return;
        const n = [el.className && el.className.baseVal === undefined ? el.className : "", el.id, el.alt || ""].join(" ");
        if (BAD.test(n)) return;
        seen.add(url + pseudo);
        cands.push({ el, pseudo, url, kind, rel, rect: R, area: R.w * R.h, ...extra });
      };
      const scan = (el) => {
        for (const pseudo of ["", "::before", "::after"]) {
          const s = pseudo ? getComputedStyle(el, pseudo) : cs(el);
          if (pseudo && (s.content === "none" || s.display === "none")) continue;
          for (const L of urlLayers(s.backgroundImage)) {
            if (L.url) push(el, pseudo, L.url, "css-bg", { size: s.backgroundSize, position: s.backgroundPosition, layers: s.backgroundImage });
          }
        }
      };
      for (let a = title; a && a !== document.documentElement; a = a.parentElement) {
        if (a.getBoundingClientRect().height > 1600) break;
        scan(a);
      }
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.35 || r.top + sy > 1600 || r.height < 120) continue;
        if (el.tagName === "IMG") {
          if (!visible(el)) continue;
          const cand = [];
          for (const part of (el.getAttribute("srcset") || "").split(/,\s+(?=\S)/)) {
            const [u, w] = part.trim().split(/\s+/);
            if (u && !u.startsWith("data:")) cand.push({ u, w: w && w.endsWith("w") ? parseInt(w) : 0 });
          }
          const pic = el.closest("picture");
          if (pic) for (const so of pic.querySelectorAll("source")) for (const part of (so.getAttribute("srcset") || "").split(/,\s+(?=\S)/)) {
            const [u, w] = part.trim().split(/\s+/);
            if (u && !u.startsWith("data:")) cand.push({ u, w: w && w.endsWith("w") ? parseInt(w) : 0 });
          }
          const cur = el.currentSrc || el.src;
          if (cur && !cur.startsWith("data:")) cand.push({ u: cur, w: el.naturalWidth || 0 });
          if (!cand.length) continue;
          cand.sort((a, b) => b.w - a.w);
          let u;
          try {
            u = new URL(cand[0].u, location.href).href;
          } catch {
            continue;
          }
          const s = cs(el);
          push(el, "", u, "img", { size: s.objectFit === "cover" ? "cover" : s.objectFit, position: s.objectPosition, natural: { w: el.naturalWidth, h: el.naturalHeight } });
        } else if (!el.closest("[data-rb-article]") || el.contains(title)) {
          scan(el);
        }
      }
      if (!cands.length) return { found: false };
      // overlapping beats adjoining; then the biggest
      cands.sort((a, b) => b.rel - a.rel || b.area - a.area);
      const P = cands[0];

      // layers between the photo and the title: hit-test the stack at a few points of the title (pointer-events forced on)
      // (themes with scroll-behavior:smooth may still be scrolling: jump so the title is in view, instantly)
      const st = document.createElement("style");
      st.textContent = "*{pointer-events:auto!important} html,body{scroll-behavior:auto!important}";
      document.head.appendChild(st);
      window.scrollTo({ top: Math.max(0, T.y - 200), left: 0, behavior: "instant" });
      const tv = title.getBoundingClientRect();
      const pts = [0.15, 0.5, 0.85].map((fx) => [tv.left + tv.width * fx, tv.top + tv.height * 0.5]).filter(([x, y]) => x >= 0 && y >= 0 && x < vw && y < window.innerHeight);
      const layersBetween = new Map();
      for (const [x, y] of pts) {
        const stack = document.elementsFromPoint(x, y);
        const iT = stack.findIndex((e) => e === title || title.contains(e));
        const iP = stack.indexOf(P.el);
        if (iT < 0 || iP < 0) continue;
        for (const e of stack.slice(iT + 1, iP)) layersBetween.set(e, true);
      }
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      st.remove();
      // composite every coloured layer (bottom to top) into one colour + alpha
      const paints = [];
      const addPaint = (el, pseudo) => {
        const s = pseudo ? getComputedStyle(el, pseudo) : cs(el);
        if (pseudo && (s.content === "none" || s.display === "none")) return;
        const op = parseFloat(s.opacity || "1");
        const bc = parseCol(s.backgroundColor);
        if (bc && bc.a > 0.01) paints.push({ ...bc, a: bc.a * op, from: el.tagName.toLowerCase() + pseudo, blend: s.mixBlendMode });
        for (const L of urlLayers(s.backgroundImage)) {
          if (!L.gradient) continue;
          const stops = [...L.gradient.matchAll(/rgba?\([^)]+\)/g)].map((m) => parseCol(m[0])).filter(Boolean);
          if (!stops.length) continue;
          const av = (k) => stops.reduce((n, c) => n + c[k], 0) / stops.length;
          paints.push({ r: av("r"), g: av("g"), b: av("b"), a: av("a") * op, from: el.tagName.toLowerCase() + pseudo + " gradient", gradient: L.gradient, blend: s.mixBlendMode, op });
        }
      };
      // gradient layers painted above the url layer on the photo element itself, and its pseudo elements
      if (P.kind === "css-bg") {
        const s = P.pseudo ? getComputedStyle(P.el, P.pseudo) : cs(P.el);
        const ls = urlLayers(s.backgroundImage);
        const iu = ls.findIndex((l) => l.url === P.url);
        for (const L of ls.slice(0, Math.max(0, iu))) {
          if (!L.gradient) continue;
          const stops = [...L.gradient.matchAll(/rgba?\([^)]+\)/g)].map((m) => parseCol(m[0])).filter(Boolean);
          if (!stops.length) continue;
          const av = (k) => stops.reduce((n, c) => n + c[k], 0) / stops.length;
          paints.push({ r: av("r"), g: av("g"), b: av("b"), a: av("a"), from: "photo layer gradient", gradient: L.gradient });
        }
        if (!P.pseudo) for (const ps of ["::before", "::after"]) addPaint(P.el, ps);
        else if (P.pseudo === "::before") addPaint(P.el, "::after");
      }
      for (const e of [...layersBetween.keys()].reverse()) {
        const er = e.getBoundingClientRect();
        if (er.width * er.height < tr.width * tr.height * 0.6) continue; // small boxes (buttons, chips) are not overlays
        // the stack is top-first, so everything between the title and the photo is painted above the photo
        addPaint(e, "");
        for (const ps of ["::before", "::after"]) addPaint(e, ps);
      }
      let A = 0, C = [0, 0, 0];
      for (const p of paints) {
        const a = Math.max(0, Math.min(1, p.a));
        const nA = a + A * (1 - a);
        if (nA <= 0) continue;
        C = [p.r, p.g, p.b].map((v, k) => (v * a + C[k] * A * (1 - a)) / nA);
        A = nA;
      }
      const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
      const ts = cs(title);
      let align = ts.textAlign;
      if (align === "start" || align === "justify") align = "left";
      if (align === "end") align = "right";
      // a left-aligned title block that sits centred in its photo reads as centred
      const pr = P.rect;
      if (align === "left" && Math.abs(T.x + T.w / 2 - (pr.x + pr.w / 2)) < pr.w * 0.04 && T.w < pr.w * 0.8) {
        const range = document.createRange();
        range.selectNodeContents(title);
        const lr = [...range.getClientRects()];
        if (lr.length > 1 && Math.abs(lr[0].left - lr[lr.length - 1].left) > 30) align = "center";
      }
      P.el.setAttribute("data-rb-heroimg", "1");
      // a half-transparent photo shows what is under it (often black): that colour is part of the look
      const pst = P.pseudo ? getComputedStyle(P.el, P.pseudo) : cs(P.el);
      const photoOpacity = parseFloat(pst.opacity || "1");
      const hostBg = P.pseudo ? parseCol(cs(P.el).backgroundColor) : null;
      const under = hostBg && hostBg.a > 0.5 ? cs(P.el).backgroundColor : bgOf(P.pseudo ? P.el.parentElement || P.el : P.el.parentElement || P.el).color;
      return {
        found: true,
        src: P.url,
        kind: P.kind,
        pseudo: P.pseudo,
        relation: P.rel === 2 ? "behind title" : "adjoins title",
        rect: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.w), h: Math.round(pr.h) },
        size: P.size || "",
        position: P.position || "",
        natural: P.natural || null,
        photoOpacity,
        under,
        overlayCss: A > 0.01 ? { color: hex(...C), alpha: +A.toFixed(3), layers: paints.map((p) => ({ from: p.from, color: hex(p.r, p.g, p.b), alpha: +p.a.toFixed(3), blend: p.blend || "normal", gradient: p.gradient || null, elOpacity: p.op ?? 1 })) } : null,
        titleColor: ts.color,
        titleAlign: align,
        candidates: cands.slice(0, 6).map((c) => ({ url: c.url, kind: c.kind, rel: c.rel, w: Math.round(c.rect.w), h: Math.round(c.rect.h) })),
      };
    })();

    const meta = (k) => document.querySelector(`meta[property="${k}"], meta[name="${k}"]`)?.content || "";
    const aw = absRect(article);
    const pw = absRect(para);
    return {
      finalUrl: location.href,
      title: document.title,
      siteName: meta("og:site_name"),
      ogTitle: meta("og:title"),
      article: { method: articleMethod, tag: article.tagName.toLowerCase(), rect: aw, paraWidth: pw.w },
      body: fontInfo(document.body),
      para: fontInfo(para),
      h1: fontInfo(title),
      h1Text: title ? txtLen(title) && title.innerText.trim() : "",
      h2: fontInfo(h2),
      link: link ? { color: cs(link).color, decoration: cs(link).textDecorationLine } : null,
      nav: fontInfo(navLink),
      logoText: logoTextEl ? { text: logoTextEl.innerText.trim(), ...fontInfo(logoTextEl) } : null,
      button: bestBtn ? { ...bestBtn, font: fontInfo(btnEl) } : null,
      buttons: Object.values(btns).sort((a, b) => b.area - a.area).slice(0, 6),
      pageBg,
      bodyBg: bgOf(document.body).color,
      header: header ? { rect: absRect(header), bg: bgOf(header), color: cs(header).color, gradient: headerGradient, tag: header.tagName.toLowerCase(), cls: String(header.className).slice(0, 100) } : null,
      logo,
      radius,
      googleLinks: [...document.querySelectorAll("link[rel~=stylesheet][href*='fonts.googleapis.com']")].map((l) => l.href),
      faces,
      heroPhoto,
      ogImage: (() => {
        const v = meta("og:image") || meta("og:image:url") || meta("twitter:image") || meta("twitter:image:src");
        try {
          return v ? new URL(v, location.href).href : "";
        } catch {
          return "";
        }
      })(),
      ogImageFrom: meta("og:image") || meta("og:image:url") ? "og" : meta("twitter:image") || meta("twitter:image:src") ? "twitter" : "",
    };
  });

  // hide big fixed overlays (cookie bars, chat popups) for the screenshot only
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      if ((s.position === "fixed" || s.position === "sticky") && !el.closest("[data-rb-header]") && !el.querySelector("[data-rb-header]")) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height > window.innerWidth * window.innerHeight * 0.12 || r.top > window.innerHeight * 0.5) el.style.visibility = "hidden";
      }
    }
    window.scrollTo(0, 0);
  });
  await new Promise((r) => setTimeout(r, 300));
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });

  // pixel sampling of the screenshot: header band colour + logo ink (what the eye sees, whatever painted it)
  // re-measure in viewport coordinates right before the shot (sticky headers move while we scroll)
  const rects = await page.evaluate(() => {
    const o = {};
    for (const [k, sel] of [["header", "[data-rb-header]"], ["logo", "[data-rb-logo]"], ["hero", "[data-rb-hero]"], ["title", "[data-rb-title]"]]) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) o[k] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return o;
  });
  data.shotRects = rects;
  const sampler = await browser.newPage();
  await sampler.setContent(`<img id=i src="data:image/png;base64,${Buffer.from(png).toString("base64")}">`);
  await sampler.waitForSelector("#i");
  data.samples = await sampler.evaluate(async (rects) => {
    const im = document.getElementById("i");
    await im.decode();
    const c = document.createElement("canvas");
    c.width = im.naturalWidth;
    c.height = im.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(im, 0, 0);
    const hex = (r, gg, b) => "#" + [r, gg, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const out = {};
    for (const [k, r] of Object.entries(rects)) {
      const x = Math.max(0, r.x), y = Math.max(0, r.y);
      const w = Math.min(c.width - x, r.w), h = Math.min(c.height - y, r.h);
      if (w < 2 || h < 2) continue;
      const d = g.getImageData(x, y, w, h).data;
      const bins = new Map();
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const key = (d[i] >> 3) + "," + (d[i + 1] >> 3) + "," + (d[i + 2] >> 3);
        const b = bins.get(key) || [0, 0, 0, 0];
        b[0]++;
        b[1] += d[i];
        b[2] += d[i + 1];
        b[3] += d[i + 2];
        bins.set(key, b);
      }
      const top = [...bins.values()].sort((a, b) => b[0] - a[0])[0];
      const dom = [top[1] / top[0], top[2] / top[0], top[3] / top[0]];
      // ink: pixels far from the dominant colour
      let ir = 0, ig = 0, ib = 0, ni = 0;
      for (let i = 0; i < d.length; i += 4) {
        const dd = Math.abs(d[i] - dom[0]) + Math.abs(d[i + 1] - dom[1]) + Math.abs(d[i + 2] - dom[2]);
        if (dd > 90) {
          ir += d[i];
          ig += d[i + 1];
          ib += d[i + 2];
          ni++;
        }
      }
      // border ring = what surrounds the element
      let br = 0, bgg = 0, bb = 0, nb = 0;
      const ring = (xx, yy) => {
        if (xx < 0 || yy < 0 || xx >= c.width || yy >= c.height) return;
        const p = g.getImageData(xx, yy, 1, 1).data;
        br += p[0];
        bgg += p[1];
        bb += p[2];
        nb++;
      };
      for (let t = 0; t < 40; t++) {
        ring(r.x - 6, r.y + (r.h * t) / 40);
        ring(r.x + r.w + 6, r.y + (r.h * t) / 40);
        ring(r.x + (r.w * t) / 40, r.y - 6);
        ring(r.x + (r.w * t) / 40, r.y + r.h + 6);
      }
      let mr = 0, mg = 0, mb = 0;
      for (let i = 0; i < d.length; i += 4) {
        mr += d[i];
        mg += d[i + 1];
        mb += d[i + 2];
      }
      out[k] = {
        mean: hex(mr / n, mg / n, mb / n),
        dominant: hex(...dom),
        uniform: +(top[0] / n).toFixed(3),
        ink: ni ? hex(ir / ni, ig / ni, ib / ni) : null,
        inkShare: +(ni / n).toFixed(3),
        surround: nb ? hex(br / nb, bgg / nb, bb / nb) : null,
      };
    }
    return out;
  }, rects);
  data.fontRequests = [...fontReqs];
  data.cssRequests = [...cssReqs];
  data.screenshot = "screenshot.png";
  const renderedHtml = await page.content(); // before the text-hiding pass below touches inline styles

  // hero, clean: the photo's box (or the title's hero block) screenshotted with every text, button, logo and small
  // chip on top of it made invisible. It is the last-resort hero image (a crop) and, set against the downloaded photo,
  // it measures the overlay the site paints between photo and text.
  const cleanRect = await page.evaluate(() => {
    const P = document.querySelector("[data-rb-heroimg]") || document.querySelector("[data-rb-hero]");
    if (!P) return null;
    window.scrollTo(0, 0);
    const R = P.getBoundingClientRect();
    if (R.width < 200 || R.height < 80) return null;
    const area = R.width * R.height;
    const hit = (r) => r.right > R.left && r.left < R.right && r.bottom > R.top && r.top < R.bottom;
    for (const el of document.querySelectorAll("body *")) {
      if (el === P || el.contains(P)) continue;
      const r = el.getBoundingClientRect();
      if (!hit(r) || r.width === 0) continue;
      const s = getComputedStyle(el);
      const small = r.width * r.height < area * 0.4;
      const filled = s.backgroundColor && !/rgba\(.*,\s*0\)$|transparent/.test(s.backgroundColor);
      if (/^(IMG|SVG|BUTTON|INPUT|SELECT|TEXTAREA|IFRAME|VIDEO|CANVAS|PICTURE)$/i.test(el.tagName) || (small && (filled || parseFloat(s.borderTopWidth) > 0))) {
        el.style.setProperty("visibility", "hidden", "important");
        continue;
      }
      if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
        el.style.setProperty("color", "transparent", "important");
        el.style.setProperty("-webkit-text-fill-color", "transparent", "important");
        el.style.setProperty("text-shadow", "none", "important");
        el.style.setProperty("text-decoration-color", "transparent", "important");
      }
    }
    const r = P.getBoundingClientRect();
    return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top + window.scrollY)), w: Math.round(Math.min(r.width, window.innerWidth)), h: Math.round(Math.min(r.height, 1400)) };
  });
  let clean = null;
  if (cleanRect && cleanRect.w > 50 && cleanRect.h > 50) {
    await new Promise((r) => setTimeout(r, 250));
    clean = await page.screenshot({ clip: { x: cleanRect.x, y: cleanRect.y, width: cleanRect.w, height: cleanRect.h }, captureBeyondViewport: true });
    data.heroClean = { rect: cleanRect, of: data.heroPhoto?.found ? "photo box" : "title hero block" };
  }
  await page.close().catch(() => undefined);
  await sampler.close().catch(() => undefined);
  return { data, renderedHtml, screenshot: png, clean };
}
