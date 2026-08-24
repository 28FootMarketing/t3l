# Teach Them To Love Outreach Ministries (T3L) — Website

Marketing/outreach website for **Teach Them To Love Outreach Ministries**, a
faith-rooted, trauma-informed 501(c)(3) community wellness organization in
Georgetown, TX.

## Contents

| Path | Purpose |
| --- | --- |
| `index.html` | Complete, self-contained landing page. Open directly in a browser to preview. |
| `assets/t3l.css` | Stylesheet for the site. All rules are scoped to `#t3l-ghl` so the markup can be embedded without style collisions. |
| `embed/t3l-ghl-embed.html` | The raw markup block only (no `<head>`, no styles) intended to be pasted into a GoHighLevel (GHL) custom-code / HTML element. Requires the CSS and images to be provided separately. |
| `embed/t3l-ghl-embed.selfcontained.html` | **Drop-in GHL block.** Same markup with the CSS inlined and all images embedded as data URIs — paste the whole file into one GHL Custom Code element, no separate CSS paste and no image hosting required. ~674 KB. |
| `assets/img/` | Self-hosted images (logo, founder photo, event artwork) so the site does not depend on external CDNs. |
| `404.html` | Themed "page not found" page (served automatically by static hosts such as Vercel). |
| `robots.txt` | Allows all crawlers and points to the sitemap. |
| `sitemap.xml` | Single-page sitemap for search engines. |

## Standalone hosting (off GoHighLevel)

The site now runs as a standalone static site (e.g. Vercel) rather than a GHL
embed, so it includes the pieces GHL used to provide:

- **Favicon / app icon** — the T3L medallion (`assets/img/t3l-logo.png`).
- **Smooth in-page scrolling** with a sticky-header offset (`scroll-margin-top`)
  so nav links land below the fixed header (disabled under
  `prefers-reduced-motion`).
- **`robots.txt` + `sitemap.xml`** for search engines.
- **`404.html`** for unknown paths.

Conversion is currently **call-only** (phone CTAs); there is no lead-capture
form. Add one later if the org wants online inquiries — it would need a form
endpoint (serverless function, or a service like Formspree).

## Images

All images are self-hosted in `assets/img/` — the site no longer hot-links any
external CDN:

| File | Used in | Notes |
| --- | --- | --- |
| `t3l-logo.png` | Header + footer | Round gold T3L medallion (121×121). |
| `founder.webp` | Our Story section | Dr. Lolita R. Gilmore-Randall (432×532). |
| `event-shades-of-purple.webp` | Events section | "Shades of Purple: An Urban Night Affair" flyer. |
| `hero-counseling.webp` | Hero background | Counseling scene shown behind the purple wash (subject on the right). |

Paths are **relative** (`assets/img/…`). This works for `index.html` /
`preview.html` served from the repo root or any host. For the **GoHighLevel
embed**, relative paths only resolve if the `assets/img/` files are hosted at a
matching path on the GHL domain — otherwise replace the `src` values in
`embed/t3l-ghl-embed.html` with the absolute URLs where you host the images
(e.g. `https://teachthemtolove.com/assets/img/t3l-logo.png`).

## Previewing locally

Just open `index.html` in any browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Using the GoHighLevel embed

`embed/t3l-ghl-embed.html` contains only the `<div id="t3l-ghl">…</div>` block
and its inline `<script>`. To use it inside GoHighLevel:

1. Add the contents of `assets/t3l.css` to the page/site custom CSS (or paste it
   inside a `<style>` tag before the block). The CSS is scoped to `#t3l-ghl`, so
   it will not affect the rest of the GHL page.
2. Load the fonts once in the page head:
   ```html
   <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
   ```
3. Paste the embed markup into a Custom HTML / Code element.

`index.html` already wires all three together for a standalone deployment.

## Notes

- Images are self-hosted in `assets/img/` (no external CDN dependency).
- Donation, ticketing, and social links point to the organization's live
  external services (PayPal, Cash App, Zeffy, Facebook, LinkedIn, Instagram).
- The page includes a domestic-violence safety notice, `NGO` schema.org
  structured data, a skip link, and responsive/mobile navigation.
- Verify hours, event details, venue, and ticketing before each publish.

## Organization details

- **Founder:** Dr. Lolita R. Gilmore-Randall
- **Address:** 601 Quail Valley Drive, Georgetown, TX 78626
- **Phone:** 512-649-2693
- **EIN:** 46-4850870 (registered 501(c)(3) nonprofit)
