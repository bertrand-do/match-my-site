# match-my-site

A Claude Code skill that reads any website and returns its brand kit: fonts, colours, logo, spacing and header style. Ask Claude to style a page, deck or video "like this site" and it works from the real values instead of guessing.

It opens the page in your own Google Chrome (always headless, no window), reads the computed styles from the real elements, finds the logo and header, and writes:

- `brand.json`: the raw tokens
- `brand.md`: a readable kit (colours with hex and role, fonts with fallbacks, logo file and URL, header style, notes)
- `preview.html`: one self-contained page with swatches, type samples and the logo, styled with the extracted tokens

## Install

```
cp -R match-my-site ~/.claude/skills/match-my-site
cd ~/.claude/skills/match-my-site
npm install
```

Needs Node 18 or newer and Google Chrome (auto-detected on macOS, Linux and Windows; set `CHROME_PATH` to use another Chromium-based browser).

## Usage

By asking Claude:

> Get the brand kit from https://example.com and style this landing page to match.

By CLI:

```
node scripts/brand-kit.mjs https://example.com --out out/example
```

## Example output

`brand.md` (excerpt):

```
# Brand kit: Steve Pavlina

| Role | Hex | Name in brand.json |
| header band background | `#044e75` | colors.headerBackground |
| accent (the colour to use for emphasis) | `#5580b2` | colors.accent |

- **heading**: **PT Serif** from Google Fonts, weights 300, 400, 700. Fallback stack: `serif`.
- **body**: **Charter**, self-hosted by the site (named, not downloaded). Closest free stand-in: **Charis SIL** (Google Fonts).

- Body: 24px, line height 1.4, weight 400
- Band: yes, background `#044e75`, a radial gradient (#066fa6 -> #044e75), text `#ffffff`
- Corner radius: 4px
```

## Limits

- Sites that block bots, show a consent wall, or ask for a login can return the wrong page and so the wrong kit.
- Fonts are only named, with the URL they load from. Licensed fonts are not downloaded or redistributed; the kit lists the closest free Google font instead.
- It reads one page. Colours and fonts reflect that page's header and article area.
- Network guard: only http(s) on standard ports; private, loopback and metadata addresses are refused.
- The logo and hero image are saved locally for your own use; check the site's terms before reusing them.

Built for Reelblog, which turns blog posts into narrated videos in the blog's own style: https://blog.reelzign.com

## License

MIT. See LICENSE.
