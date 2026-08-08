#!/usr/bin/env node
// Naptan Mirror build script
//
// 1. Downloads the full UK NaPTAN dataset (CSV) from the DfT endpoint.
// 2. Saves the download byte-for-byte as public/naptan.csv.
// 3. Also parses it into public/naptan.json, using whatever columns the
//    file actually has (no fixed column list to maintain).
// 4. Emits public/meta.json (timestamps, record count, hashes) and
//    public/index.html (a small status page: links + last refreshed /
//    next update due).
//
// No credit card / no paid services required: output is a static dir that is
// deployed to a Cloudflare Pages project by the GitHub Actions workflow.

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rm, copyFile, readFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const TMP_CSV = join(tmpdir(), `naptan-${Date.now()}.csv`);

// Configurable source. If DfT changes the URL, set NAPTAN_URL as a
// workflow/environment variable.
const NAPTAN_URL =
  process.env.NAPTAN_URL ||
  'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv';

// Refresh schedule in UTC hours, matching the workflow cron '0 */8 * * *'.
const REFRESH_HOURS_UTC = [0, 8, 16];

// Formats a Date as a friendly UK-time string (handles BST automatically).
function formatUK(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date);
}

// Next scheduled refresh after `from` (a Date), given the cron's UTC hours.
// The candidate times are aligned to the top of the hour, so the result
// matches what the GitHub Actions cron will actually fire at.
function nextRefresh(from) {
  for (const hour of REFRESH_HOURS_UTC) {
    const candidate = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour)
    );
    if (candidate > from) return candidate;
  }
  const tomorrow = new Date(from);
  tomorrow.setUTCDate(from.getUTCDate() + 1);
  return new Date(
    Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), REFRESH_HOURS_UTC[0])
  );
}

async function download(url, dest) {
  console.log(`[download] GET ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  console.log(
    `[download] status=${res.status} content-length=${total} bytes`
  );
  const fileStream = createWriteStream(dest);
  let received = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    fileStream.write(value);
    if (total) {
      const pct = ((received / total) * 100).toFixed(1);
      process.stdout.write(`\r[download] ${pct}% (${received} bytes)`);
    }
  }
  fileStream.end();
  await finished(fileStream);
  console.log(`\n[download] wrote ${received} bytes to ${dest}`);
}

// Minimal CSV parser that handles quoted fields, embedded commas, and
// embedded newlines. Returns { headers, records } where records are objects
// keyed by the column names taken from the file's own header row.
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    if (inQuotes) {
      row.push(field.replace(/""/g, '"'));
    } else {
      row.push(field);
    }
    field = '';
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      pushField();
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    pushField();
    rows.push(row);
  }

  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cells[c] !== undefined ? cells[c] : '';
    }
    records.push(obj);
  }
  return { headers, records };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

async function main() {
  await mkdir(PUBLIC_DIR, { recursive: true });
  await download(NAPTAN_URL, TMP_CSV);

  // The raw download is served as-is (byte-for-byte).
  const csvPath = join(PUBLIC_DIR, 'naptan.csv');
  await copyFile(TMP_CSV, csvPath);
  const csvHash = sha256(await readFile(csvPath));
  console.log(`[csv] saved raw download -> naptan.csv (hash=${csvHash})`);

  // Parse the same download to produce the JSON version, using the file's
  // own columns so nothing needs maintaining when DfT changes the format.
  const text = await readFile(TMP_CSV, 'utf8');
  console.log('[json] parsing CSV...');
  const { headers, records } = parseCsv(text);
  console.log(
    `[json] ${records.length} stop records, ${headers.length} source columns`
  );

  const jsonPath = join(PUBLIC_DIR, 'naptan.json');
  await writeFile(jsonPath, JSON.stringify(records));
  const jsonHash = sha256(await readFile(jsonPath));

  const generatedAt = new Date();
  const nextUpdate = nextRefresh(generatedAt);

  const meta = {
    generatedAt: generatedAt.toISOString(),
    nextUpdate: nextUpdate.toISOString(),
    source: NAPTAN_URL,
    recordCount: records.length,
    columns: headers,
    csvHash,
    jsonHash,
    formats: {
      json: '/naptan.json',
      csv: '/naptan.csv',
    },
  };
  await writeFile(join(PUBLIC_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  // Emit the status page. Cloudflare Pages serves index.html at the site root.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Naptan Mirror</title>
</head>
<body>
<h1>Naptan Mirror</h1>
<p><a href="naptan.json">naptan.json</a> &mdash; full dataset (JSON)</p>
<p><a href="naptan.csv">naptan.csv</a> &mdash; full dataset (CSV)</p>
<p><strong>Last refreshed:</strong> ${formatUK(generatedAt)}</p>
<p><strong>Next update due:</strong> ${formatUK(nextUpdate)}</p>
</body>
</html>
`;
  await writeFile(join(PUBLIC_DIR, 'index.html'), html);

  // Cleanup temp download
  await rm(TMP_CSV, { force: true }).catch(() => {});

  console.log(
    `[done] wrote ${records.length} records -> naptan.json, naptan.csv, meta.json, index.html`
  );
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
