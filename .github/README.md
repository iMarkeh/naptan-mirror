# Naptan Mirror

Automatically downloads the full UK NaPTAN dataset every 8 hours and stores it on a
Cloudflare Pages site, so my other projects fetch it from one place instead of each
hitting the NaPTAN API directly.

## Where my projects get it from

https://naptan-mirror.pages.dev

The site root (`/`) shows a status page with links plus the last refreshed
time and next update due.

- `naptan.json` — full dataset (JSON)
- `naptan.csv` — full dataset (CSV)
- `meta.json` — timestamp, record count, and a hash to check if the data changed

## To refresh it manually

GitHub → this repo → Actions → "Refresh Naptan cache" → Run workflow.

## Things to remember

- Refreshes automatically every 8 hours.
- Each refresh commits a small update to the repo, which keeps it active.
