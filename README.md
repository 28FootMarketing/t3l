# Teach Them To Love Outreach Ministries (T3L) — Website

Marketing/outreach website for **Teach Them To Love Outreach Ministries**, a
faith-rooted, trauma-informed 501(c)(3) community wellness organization in
Georgetown, TX.

## Contents

| Path | Purpose |
| --- | --- |
| `index.html` | Complete, self-contained landing page. Open directly in a browser to preview. |
| `assets/t3l.css` | Stylesheet for the site. All rules are scoped to `#t3l-ghl` so the markup can be embedded without style collisions. |
| `embed/t3l-ghl-embed.html` | The raw markup block only (no `<head>`, no styles) intended to be pasted into a GoHighLevel (GHL) custom-code / HTML element. |

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

- Images are hot-linked from the organization's existing Wix/WordPress CDN URLs.
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
