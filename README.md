# Openhouse Meta Ads: shared copy

A password-protected copy of the Openhouse Meta Ads dashboard for people who don't have access to the ad accounts. It shows the same view: the period, ad account and campaign filters, the headline figures, the spend chart, the Meta campaigns table and the drill-down into ad sets and ads.

## How it works

- `site/dashboard.html` is the live dashboard's page, unchanged. `site/runtime.js` stands in for the live dashboard's engine: it answers the page's questions from a data file instead of calling Meta.
- `scripts/fetch_meta.py` pulls the numbers from Meta's Marketing API into that data file: every campaign, ad set and ad's totals for each period, and each campaign's spend per day.
- `scripts/build.mjs` puts the page and the data together, gzips them and encrypts them with AES-256-GCM, using a key derived from the password (PBKDF2-SHA256, 600,000 rounds). Only the encrypted page is published.
- `.github/workflows/refresh.yml` runs every 2 hours: fetch, lock, publish to the `gh-pages` branch, which GitHub Pages serves.

No Meta numbers are ever committed to this repository. The `gh-pages` branch holds only the locked page, and only its latest version.

## What it needs

| Secret | What it is |
| --- | --- |
| `PAGE_PASSWORD` | The password viewers type. Set by `scripts/first-publish.sh`, or with `gh secret set PAGE_PASSWORD`. |
| `META_TOKEN` | A Meta system-user token with `ads_read` on Openhouse 2, Openhouse Temp, Openhouse Backup and Openhouse - 4. Business settings → Users → System users → Generate token. Then `gh secret set META_TOKEN`. |

## Changing things

- **Password:** `gh secret set PAGE_PASSWORD`, then run the workflow (Actions → Refresh dashboard → Run workflow). Devices that remembered the old password ask again.
- **Publish new numbers by hand:** `scripts/republish.sh path/to/snapshot.json`. It asks for the password once and checks it opens the page published now before changing anything.
- **Campaign names or ticket prices:** edit `site/lists/campaign-names.csv` or `site/lists/ticket-prices.csv` and push. The next refresh uses them.
- **Take it down:** Settings → Pages → Unpublish, or delete the repository.

## Viewing

Open the Pages link, type the password, and tick *Remember on this device* to skip it next time. *Lock and forget this device* at the bottom of the page undoes that.
