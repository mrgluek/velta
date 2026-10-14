# Instant View (reader view for links) — research

Date: 2026-10-14. Question: can AMP pages (e.g.
`https://www.dp.ru/api/amp/a/2026/03/16/jelitnaja-chastnaja-shkola-v-moskve`)
drive a Telegram-like Instant View in Velta?

**Short answer:** use AMP as a *preferred source*, not as the mechanism.
Run a generic extractor (Mozilla Readability) on the AMP page when the publisher
has one, and on the canonical page otherwise. Use JSON-LD only for metadata
(title, author, date, image). Fetch from the receiver's device, only when the
user taps, and only from the publisher (never the Google AMP cache). Sanitize
to a small allowlist of tags. Remote images are off by default.

## 1. Measurements (fetched 2026-10-14 from the box, desktop Chrome UA)

### dp.ru sample
| | AMP page | Canonical page |
|---|---|---|
| HTTP / size | 200, 50 KB | 200, 108 KB |
| Discovery | `<link rel="canonical">` points back | `<link rel="amphtml" href=".../api/amp/a/...">` present |
| JSON-LD | `NewsArticle`: headline, image[], datePublished/Modified, author.name, publisher | none usable |
| Media | 12 `amp-img`, 2 `amp-ad`, `amp-analytics` (yadro.ru counter), `amp-accordion`; 0 `amp-video`/`amp-iframe` | — |
| Runtime | 10 `<script>`, 5 refs to `cdn.ampproject.org` | 8 `<script>` |
| Body markup | no `<p>`: paragraphs are `div`/`br` inside sections | text injected client-side |
| Readability | **OK**: title, byline "Виктория Грушевская", 6.2 K chars | **null** (SPA shell, no body in HTML) |

Here AMP is the only static HTML that has the article. Note also that the
markup is not "clean semantic": raw AMP still needs a generic extractor plus
nav/ad/analytics stripping. AMP does not get you per-block structure for free.

### Survey: 18 article URLs (first RSS item per site, same day)
Columns: amphtml present; JSON-LD `articleBody` length; Readability text length
on canonical (and on AMP when there is one).

| Site | HTTP | amphtml | ld articleBody | Readability canonical | Readability AMP |
|---|---|---|---|---|---|
| dp.ru | 200 | yes | – | **fail** | 6206 |
| meduza.io | 200 | yes | – | 991 | 1448 |
| interfax.ru | 200 | yes | – | 745 | 715 |
| iz.ru | 200 | yes | – | 2464 | 2414 |
| habr.com | 200 | yes | – | 18710 | 18687 |
| aljazeera.com | 200 | yes | – | 2964 | 3108 |
| kommersant.ru | 200 | no | – | 1387 | |
| ria.ru | 200 | no | – | 2213 | |
| vedomosti.ru | 200 | no | 588 | 587 | |
| bbc.co.uk | 200 | no | – | 3264 | |
| theguardian.com | 200 | no | – | 7444 | |
| spiegel.de | 200 | no | – | 2129 | |
| theverge.com | 200 | no | 3837 | 3703 | |
| arstechnica.com | 200 | no | – | 2313 | |
| rbc.ru | 401 (bot wall) | ? | | | |
| tass.ru | 200 (1.7 KB challenge page) | ? | | | |
| nytimes.com | 403 | ? | | | |
| lemonde.fr | 402 (paywall/bot) | ? | | | |

Results:
- **AMP adoption: 6 of 14 reachable sites (43%)**, or 6 of 18 tried. Among
  international sites only Al Jazeera still has it (1/7). BBC, Guardian, Spiegel,
  Verge, Ars and others have dropped AMP since Google stopped requiring it for Top
  Stories in 2021. Russian sites still have it more often (5/7 reachable: dp,
  meduza, interfax, iz, habr; not kommersant, ria, vedomosti).
- **Readability on canonical: 13/14 reachable.** It failed only on dp.ru, which
  is exactly where AMP saved it. **Readability on AMP: 6/6.** AMP pages are
  also smaller (on average about 40–60% of canonical size; habr 86 KB vs 268 KB).
- **JSON-LD articleBody: 2/14** (vedomosti, verge), and both are plain text (no
  images, headings or links). Usable only as a last-resort fallback. JSON-LD
  `*Article` *type/metadata* was present on 12/14, which is good for the header.
- 4/18 were blocked for a non-browser client (401/402/403/JS challenge). The
  device's own IP/UA may do better or worse. IV must degrade to "open in browser".

## 2. Approaches

| | (a) AMP-only | (b) Readability, AMP preferred | (c) JSON-LD articleBody |
|---|---|---|---|
| Coverage (measured) | 43% | ~100% of reachable | 14% |
| Quality | needs extractor anyway (dp.ru) | good text, images, headings | plain text only |
| Maintenance | AMP is shrinking | one library (Apache-2.0, ~90 KB) | none |
| Verdict | no | **yes** | metadata + fallback |

Telegram's IV uses hand-written **per-site templates** (the IV rules language,
contest-built) and a server-side renderer. This gives the best quality, but
it needs a central server (bad for privacy and not Velta's model) and ongoing
template work. Middle ground: a tiny optional per-host override table
(selector for body / elements to drop) for a handful of popular hosts, added
later only if needed.

Pipeline: fetch URL → if `<link rel=amphtml>` and same registrable domain →
fetch AMP → Readability → if fail/too short (<500 chars), retry on other
variant → else JSON-LD articleBody → else "Open in browser". The header comes
from JSON-LD (headline, author, datePublished, image), then OG, then Readability.

## 3. Privacy & security

- **Who fetches:** the receiver, on tap ("Instant view" button on the existing
  card or link context menu). Never automatically. This is the same IP exposure
  as link-preview "fetch" mode, and the same warning text
  (`LINK_PREVIEW_IP_WARNING`) applies. The sender-side picture mode (#88) does not
  extend to IV: shipping a whole article inside a message bloats mail and lets the
  sender forge "the article". If it is ever wanted, it should be an explicit
  "send as reader snapshot" attachment, clearly labelled as sender-provided.
- **No AMP cache:** never use `cdn.ampproject.org` / `*.cdn.ampproject.org`
  (Google sees the user). Fetch the publisher's `amphtml` URL directly, and only
  if it is on the same registrable domain as the canonical (otherwise one
  redirect can send you to any host).
- **Strip everything active:** all `<script>` (AMP runtime included),
  `amp-analytics`, `amp-pixel`, `amp-ad`, `amp-iframe`, `amp-embed`, iframes,
  forms, `style` attributes, event handlers, `<link>`/`<meta>`. Map `amp-img`→
  `img` and `amp-video`→ a poster + link. Output an allowlist only: p, h2–h4,
  ul/ol/li, blockquote, pre/code, figure/figcaption, img, a (href http(s),
  rel=noopener noreferrer, opens via inapp-browser.js), b/i/em/strong, br, hr,
  table basics. Run trackers.js on all hrefs.
- **Sanitizing in Rust** (e.g. `ammonia`) before the renderer sees anything.
  The renderer additionally builds DOM from the already-sanitized fragment with
  a `<template>`. The app CSP already forbids remote scripts.
- **Images:** the CSP `img-src` has no `https:`, so remote images cannot load
  in the renderer at all. That is good. Options: "no images" (default:
  placeholder with alt + tap-to-load) or "load images" (shell fetches each
  image, size-capped, downscaled with the existing `generate_thumbnail`, returned
  as data:/blob:). Every image fetch is another request to possibly third-party
  CDNs, so this must be a separate opt-in.
- **Tunnel/proxy:** today `fetch_link_preview` builds a plain `ureq` agent and
  does **not** go through the tunnel/proxy settings (tunnel.rs). IV (and the
  existing preview) should share one HTTP agent factory that respects the
  user's proxy/tunnel, or refuse to fetch when "all traffic via tunnel" is on.
- **Limits:** https only, ≤5 redirects, 5 s connect / 10 s total, HTML body
  ≤2 MB read (AMP spec caps itself at ~75 KB CSS; pages here were 46–222 KB),
  output ≤256 KB sanitized HTML, ≤30 images, each ≤1 MB pre-downscale.
  Content-Type must be text/html. Block private/loopback IPs (SSRF to LAN).
- **PWA:** the browser cannot fetch arbitrary sites (CORS), and a proxy run
  by the self-hoster would see every URL users open. Options: disable IV in
  the PWA (recommended at first), or an opt-in self-hosted `/reader?url=` proxy
  documented in pwa-self-host.md. When velta-core-service (Android bridge) is
  present, it can expose the same command over its loopback HTTP.

## 4. Fit in Velta

- **Fetch + extract:** Rust, in a new `velta-app/src-tauri/src/reader.rs`,
  command `fetch_instant_view(url) -> {title, byline, date, site, image, html,
  textLen, source:"amp"|"canonical"|"jsonld"}`. Rust extractor options:
  `readability`/`dom_smoothie` crates (ports of Readability) + `ammonia` +
  `scraper` for JSON-LD/amphtml discovery. Alternative: fetch in Rust, run
  Mozilla Readability in the renderer on a detached `DOMParser` document
  (no scripts execute in DOMParser docs), then sanitize. This is simpler and
  uses the reference implementation, but it puts untrusted markup into the
  renderer process. Prefer Rust-side sanitization in either case. The spike should
  compare `dom_smoothie` output against Mozilla on the 14 URLs above.
- **UI:** `app/js/instant-view.js` web component, `<velta-instant-view>`
  inside a native `<dialog>` (see docs/modals-audit-and-plan.md), `<article>`
  with header (site, title, author, date, lead image), body, footer "Open
  original" (via inapp-browser.js). Reader typography uses ui-scale.js and the
  theme. Entry point: an "Instant view" chip on the link-preview card when mode is
  `fetch`, and a link context-menu item in other modes (tap = explicit consent).
- **Cache:** `LruCache` from app/js/lru.js, e.g. 20 articles / 4 MB in memory,
  keyed by the tracker-stripped URL. Pin the open article (`canEvict`). Optional
  persistence for offline re-read, later and opt-in: store in IndexedDB or the
  app data dir with a TTL (24 h), clearable from settings.
- **Settings:** "Instant view: off / on tap" + "Load images in instant view",
  per-chat override using the same pattern as link-preview modes.

## 5. Recommendation

Build approach **(b)**. Generic Readability extraction is the engine. AMP is
preferred when `rel=amphtml` exists on the same domain, because it is smaller,
has static body HTML and has fewer scripts, and on dp.ru it is the only thing
that works. JSON-LD is used for header metadata and as a plain-text last resort.
Pure AMP covers fewer than half of sites in 2026 and almost no international ones.
Per-site Telegram-style templates are not worth it now. Desktop/Android first, the
PWA later or never.

## 6. Phased plan (rough)

1. **Spike (1–1.5 d):** Rust `reader.rs` with fetch (limits, SSRF guard),
   amphtml discovery, `dom_smoothie` vs JS Readability on the 14 URLs, ammonia
   allowlist. Fixture tests with saved HTML.
2. **MVP (3–4 d):** `fetch_instant_view` command, `<velta-instant-view>` dialog,
   text-only (image placeholders), LRU cache, entry from link card/context
   menu, setting + IP warning, tracker stripping on links. Tests in tests/.
3. **Images + proxy (2 d):** opt-in image fetch via the shell with downscale.
   Shared HTTP agent that respects tunnel/proxy (fix link-preview too).
4. **Polish (1–2 d):** RTL, tables/code, video posters, dark theme,
   accessibility (focus trap, Esc), Android back button, offline persistence.
5. **Optional (2–3 d):** PWA via a self-hosted reader proxy; per-host
   override table for top sites where Readability misfires.

Total: about 7–10 days for desktop/Android, +2–3 for the optional items.
