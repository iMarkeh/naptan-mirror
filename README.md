# Naptan Mirror

A free, no-credit-card system that automatically refreshes the full UK **NaPTAN**
dataset every 8 hours and serves it from a dedicated **Cloudflare Pages** site.

Your other projects then fetch from this mirror (e.g. `https://naptan-mirror.pages.dev/naptan.json`)
instead of hitting the DfT NaPTAN API directly — so the upstream download happens
**once, centrally**, and the data is edge-cached in a single shared place.

## What it produces

After each refresh, `public/` contains:

| File | Purpose |
|------|---------|
| `naptan.json` | Full dataset as a JSON array (broad column set) |
| `naptan.csv`  | Same data as CSV |
| `meta.json`   | `generatedAt`, `source`, `recordCount`, `jsonHash`, column list |

`meta.json` lets consumers detect changes (compare `jsonHash`) and skip redundant
reloads.

## How it runs

`.github/workflows/refresh.yml` is triggered:

- **on a schedule**: every 8 hours UTC (`0 */8 * * *`)
- **manually**: the `workflow_dispatch` "Run workflow" button in the Actions tab

Steps: `npm ci` → download + transform (`scripts/build.mjs`) → `wrangler pages deploy`.

GitHub Actions is free for public repos; the run takes a few minutes, 3×/day.

## Setup (no credit card required)

1. **Create the repo** `naptan-mirror` on GitHub (public, to keep Actions free).
2. **Create the Cloudflare Pages project** (Dashboard → Workers & Pages → Create → Pages →
   Direct Upload). Name it exactly `naptan-mirror`. No framework, no card.
3. **Create a Cloudflare API token** (Dashboard → My Profile → API Tokens → Create Token):
   permission `Account → Cloudflare Pages:Edit`, scoped to your account.
4. **Add GitHub repo secrets** (Settings → Secrets → Actions):
   - `CLOUDFLARE_API_TOKEN` — the token from step 3
   - `CLOUDFLARE_ACCOUNT_ID` — your account ID (in the dashboard URL)
5. *(Optional)* Add a **repo variable** `NAPTAN_URL` if you ever need to override the
   default DfT endpoint `https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv`.
6. Push the code. The first workflow run deploys the mirror to
   `https://naptan-mirror.pages.dev/`.

> **Keep-alive:** GitHub disables scheduled workflows after 60 days with no repo
> activity. Re-run the workflow manually if it ever pauses, or add a tiny commit
> periodically.

## Updating your existing projects

Replace the DfT NaPTAN API base URL with the mirror URL:

```
https://naptan-mirror.pages.dev
```

- Fetch `/naptan.json` (or `/naptan.csv`).
- Optionally fetch `/meta.json` first and compare `jsonHash` to your last load to
  skip reloading when nothing changed.

Your projects keep their own edge cache; the heavy upstream download now happens
only once, centrally.

## Customising columns

The `COLUMNS` array in `scripts/build.mjs` defines which NaPTAN fields are kept.
It intentionally keeps a broad set because different sites use different parts of
NaPTAN. Remove entries you are certain no project needs; the emitted files stay
stable for consumers.
