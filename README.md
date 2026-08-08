# Naptan Mirror

Automatically downloads the full UK NaPTAN dataset every 8 hours and stores it in
one place, so my other projects fetch it from there instead of each hitting the
NaPTAN API directly.

## Where my projects get it from

The data files live on a GitHub Release (tag `data`) — these URLs never change:

- https://github.com/<my-name>/naptan-mirror/releases/download/data/naptan.json
- https://github.com/<my-name>/naptan-mirror/releases/download/data/naptan.csv

`https://naptan-mirror.pages.dev` shows a status page (links + last refreshed
time and next update due), plus `https://naptan-mirror.pages.dev/meta.json` gives
the timestamps, record count and hashes.

## To refresh it manually

GitHub → this repo → Actions → "Refresh Naptan cache" → Run workflow.

## Things to remember

- Refreshes automatically every 8 hours.
- Each refresh commits a small update to the repo, which keeps it active.
- The JSON only contains columns which are used in the sites. See build.mjs for details on saved columns.
