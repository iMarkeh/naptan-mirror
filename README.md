# Naptan Mirror

Private project. No support provided. Just public so things work.

## Things to remember

- Refreshes automatically every 8 hours.
- Each refresh commits a small update to the repo, which keeps it active.
- The JSON and CSV both only contain the columns which are used in the sites. See build.mjs for details on saved columns. Easting/Northing are consumed during the build to fill in any blank lat/lon and are not stored.
- `naptan.csv.gz` is also published (same content, ~4x smaller). `meta.json.formats.csvGz` points to it and `csvGzHash`/`csvGzSize` describe it. Sites wanting a smaller download can fetch the `.gz` and decompress before parsing (e.g. `DecompressionStream('gzip')`); `formats.csv` stays unchanged for everyone else.
- `naptan.json` is a matrix: row 0 is the header, each following row is one stop in that same column order. `meta.json.columns` lists the header.
- If any stops can't be converted from easting/northing, `meta.json.conversionErrors` lists them (ATCOCode, CommonName, easting/northing, reason, and the underlying error message) and they're shown on the status page.
- Rail replacement stop data (`data/rrl.csv`) is published alongside the NaPTAN files. It's only checked about once a day, re-downloading only when DfT's source actually changes (tracked via the signed URL's GCS `x-goog-generation`/`etag`, with a content-hash safety net). `meta.json.rrl.datasetUpdatedAt` is the dataset's real last-updated time.
