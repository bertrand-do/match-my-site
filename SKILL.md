---
name: match-my-site
description: Read any website and return its brand kit - fonts, colours, logo, spacing, header style. Use when the user wants a page, deck, email, video or app to match an existing site's look ("match my site", "use my blog's style", "get the brand colours and fonts from <url>").
---

# match-my-site

Opens a URL in headless Chrome, reads the site's computed styles, and writes a brand kit you can build with.

## Run it

From this skill's folder (first time only: `npm install`):

```
node scripts/brand-kit.mjs <url> --out <dir>
```

Use a page of the site that has its normal header (the home page or a blog post). Takes 5 to 45 seconds. Chrome must be installed (set `CHROME_PATH` if it is not auto-detected). It always runs headless.

It writes three files into `<dir>`:

- `brand.json`: raw tokens (`tokens.colors`, `tokens.fonts`, `tokens.type`, `tokens.feel`, `tokens.logo`, `tokens.hero`).
- `brand.md`: the readable kit. Read this first.
- `preview.html`: one self-contained page showing swatches, type samples and the logo. Open it, or screenshot it, to check the result before building.

Also saved next to them when found: `logo.*` and `hero.*`.

## Read the output

- **Colours**: `background` is the reading surface, `text`/`heading` the ink, `accent` the colour for emphasis (links, buttons), `primary` the main brand colour, `headerBackground`/`headerText` the top band. `muted` and `hairline` are derived from text and background.
- **Fonts**: each role (heading, body, ui, logo) has a `family`, a `source` and a generic fallback. `google` means load it from Google Fonts. `self-hosted` means the site serves its own files: the name and file URLs are recorded, nothing is downloaded, and `fallback.family` is the closest free Google font. Never copy the site's font files; use the stand-in or ask the user to license the original.
- **Logo**: a URL plus a saved file, and `legible` says whether it reads on a light or dark surface. If there is no logo image, use the site name set in the logo font.
- **Spacing and feel**: body size and line height, text column width, corner radius, density (`airy`, `normal`, `dense`), header height.

## Use the kit

1. Read `brand.md`; look at `preview.html` if unsure.
2. Define CSS variables (or deck/video theme tokens) from the colours: `--bg`, `--text`, `--heading`, `--accent`, `--primary`, `--muted`, `--hair`.
3. Set heading and body fonts from the kit, using the Google Fonts stand-in where the original is self-hosted or licensed, with the generic fallback.
4. Copy the feel: corner radius, line height, column width, header band colour and height, button colour and text colour.
5. Place the saved logo where the site puts it. If `legible` is false, put it on a surface that matches `logo.why`.
6. For decks and videos, use large sizes but keep the same ratios (heading weight, letter spacing, line height).
7. Tell the user which fonts were substituted (listed under Notes).

Limits: sites that block bots may return a login or challenge page, which gives a wrong kit; say so and try another page. Colours come from the page that was read, so a very different section of the site can look different.
