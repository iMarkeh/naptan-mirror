#!/usr/bin/env node
// Naptan Mirror build script
//
// 1. Downloads the full UK NaPTAN dataset (CSV) from the DfT endpoint.
// 2. Saves a trimmed copy of it as data/naptan.csv, keeping only the
//    columns listed in JSON_COLUMNS (the ones the sites actually use).
// 3. Also parses it into data/naptan.json with the same columns, as a
//    matrix (row 0 is the header, each following row is one record).
// 4. Emits public/meta.json (timestamps, record count, hashes, download
//    URLs) and public/index.html (a small status page: links + last
//    refreshed / next update due).
//
// The big data files live in data/ because Cloudflare Pages caps each file
// at 25 MiB; the workflow uploads them to a GitHub Release (tag 'data')
// instead. The small files in public/ are deployed to Cloudflare Pages.

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DATA_DIR = join(__dirname, 'data');
const TMP_CSV = join(tmpdir(), `naptan-${Date.now()}.csv`);

// Big files (naptan.csv / naptan.json) exceed Cloudflare Pages' 25 MiB
// per-file limit, so they are published to a GitHub Release under the fixed
// tag 'data'. The release base URL is derived from GITHUB_REPOSITORY, which
// GitHub Actions sets automatically (owner/repo).
const REPO = process.env.GITHUB_REPOSITORY || 'your-name/naptan-mirror';
const RELEASE_BASE = `https://github.com/${REPO}/releases/download/data`;

// Configurable source. If DfT changes the URL, set NAPTAN_URL as a
// workflow/environment variable.
const NAPTAN_URL =
  process.env.NAPTAN_URL ||
  'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv';

// Only these columns go into data/naptan.json and data/naptan.csv. The
// sites don't need the rest, so the published files stay small. Easting and
// Northing are consumed during the build to fill in blank lat/lon and are
// not stored (see convertEastingNorthingToLatLon).
const JSON_COLUMNS = [
  'ATCOCode',
  'NaptanCode',
  'CommonName',
  'Indicator',
  'Bearing',
  'LocalityName',
  'Latitude',
  'Longitude',
  'StopType',
  'BusStopType',
  'AdministrativeAreaCode',
  'ModificationDateTime',
  'Status',
];

// OSGB36 easting/northing -> WGS84 lat/lon via proj4. These projection
// strings match the coordinate conversion used by the consuming sites, so
// derived coordinates stay consistent between systems.
const OSGB36_PROJ =
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs';
const WGS84_PROJ = '+proj=longlat +datum=WGS84 +no_defs';

// Converts an OSGB36 easting/northing pair to WGS84 lat/lon. Returns
// { lat, lon } on success, or { error } with a reason/message on failure.
function convertEastingNorthingToLatLon(easting, northing) {
  const e = Number(easting);
  const n = Number(northing);
  if (!Number.isFinite(e) || !Number.isFinite(n)) {
    return { error: 'invalid_easting_northing' };
  }
  try {
    const converted = proj4(OSGB36_PROJ, WGS84_PROJ, [e, n]);
    return { lat: converted[1], lon: converted[0] };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

// Self-test the conversion against a known OSGB36 -> WGS84 reference point
// (OSGB 531691,182089 ~= lat 51.52237, lon -0.10322). Guards against silent
// coordinate regressions, e.g. proj4 quietly skipping the datum shift.
const REF_EASTING = 531691;
const REF_NORTHING = 182089;
const REF_LAT = 51.52237;
const REF_LON = -0.10322;
const REF_TOLERANCE = 0.001;

function verifyConversion() {
  const ref = convertEastingNorthingToLatLon(REF_EASTING, REF_NORTHING);
  if (!ref || ref.error) {
    throw new Error(`Coordinate self-test failed: reference point did not convert (${ref?.error ?? 'unknown'})`);
  }
  if (
    Math.abs(ref.lat - REF_LAT) > REF_TOLERANCE ||
    Math.abs(ref.lon - REF_LON) > REF_TOLERANCE
  ) {
    throw new Error(
      `Coordinate self-test failed: expected (${REF_LAT}, ${REF_LON}) but got (${ref.lat}, ${ref.lon})`
    );
  }
  console.log(`[coords] self-test OK: (${REF_EASTING}, ${REF_NORTHING}) -> (${ref.lat.toFixed(5)}, ${ref.lon.toFixed(5)})`);
}

// Formats a Date as a friendly UK-time string (handles BST automatically).
function formatUK(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date);
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

// Quotes a single CSV field if it contains a comma, quote, or newline.
function csvEscape(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Escapes a value for embedding in the generated status page HTML.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Serialises trimmed records back to CSV with the given column order.
function toCsv(records, columns) {
  const lines = [columns.map(csvEscape).join(',')];
  for (const r of records) {
    lines.push(columns.map((c) => csvEscape(r[c] ?? '')).join(','));
  }
  return lines.join('\n');
}

// Serialises trimmed records as a JSON matrix: row 0 is the header (the
// column names), each following row is one record's values in that order.
function toMatrix(records, columns) {
  return [columns.slice(), ...records.map((r) => columns.map((c) => r[c] ?? ''))];
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

async function main() {
  await mkdir(PUBLIC_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await download(NAPTAN_URL, TMP_CSV);

  // Parse the download, using the file's own columns so nothing needs
  // maintaining when DfT changes the format.
  const text = await readFile(TMP_CSV, 'utf8');
  console.log('[json] parsing CSV...');
  const { headers, records } = parseCsv(text);
  console.log(
    `[json] ${records.length} stop records, ${headers.length} source columns`
  );

  // Sanity-check the conversion before trusting it for the whole dataset.
  verifyConversion();

  // Trim each record to just the columns the sites use. Any stop with a
  // blank Latitude/Longitude is re-derived from its Easting/Northing. Stops
  // that can't be converted are kept with blank coordinates and reported in
  // public/meta.json + the status page for investigation.
  const conversionErrors = [];
  const jsonRecords = records.map((r) => {
    const out = {};
    for (const col of JSON_COLUMNS) out[col] = r[col] ?? '';
    if (String(out.Latitude).trim() === '' || String(out.Longitude).trim() === '') {
      const easting = r['Easting'] ?? '';
      const northing = r['Northing'] ?? '';
      const converted = convertEastingNorthingToLatLon(easting, northing);
      if (converted && !converted.error && converted.lat && converted.lon) {
        out.Latitude = String(converted.lat);
        out.Longitude = String(converted.lon);
      } else {
        const missing =
          String(easting).trim() === '' || String(northing).trim() === '';
        const reason = missing
          ? 'missing_easting_northing'
          : converted?.error === 'invalid_easting_northing'
            ? 'invalid_easting_northing'
            : 'conversion_failed';
        conversionErrors.push({
          atcoCode: out.ATCOCode,
          commonName: out.CommonName,
          easting,
          northing,
          reason,
          error: missing ? '' : converted?.error ?? '',
        });
      }
    }
    return out;
  });
  console.log(
    `[coords] ${jsonRecords.length - conversionErrors.length} stops with lat/lon, ${conversionErrors.length} conversion errors`
  );

  const jsonPath = join(DATA_DIR, 'naptan.json');
  await writeFile(jsonPath, JSON.stringify(toMatrix(jsonRecords, JSON_COLUMNS)));
  const jsonHash = sha256(await readFile(jsonPath));

  // The CSV is trimmed to the same columns as the JSON (not a byte-for-byte
  // mirror of the source download).
  const csvPath = join(DATA_DIR, 'naptan.csv');
  await writeFile(csvPath, toCsv(jsonRecords, JSON_COLUMNS));
  const csvHash = sha256(await readFile(csvPath));
  console.log(`[csv] saved trimmed data -> data/naptan.csv (hash=${csvHash})`);

  const generatedAt = new Date();

  const meta = {
    generatedAt: generatedAt.toISOString(),
    source: NAPTAN_URL,
    recordCount: records.length,
    columns: JSON_COLUMNS,
    conversionErrors,
    csvHash,
    jsonHash,
    formats: {
      json: `${RELEASE_BASE}/naptan.json`,
      csv: `${RELEASE_BASE}/naptan.csv`,
    },
  };
  await writeFile(join(PUBLIC_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  // Render the conversion-errors section for the status page (hidden when
  // the run was clean). Full list, no cap, so every problem stop is visible.
  const errorsHtml = conversionErrors.length
    ? `<h2>Conversion errors (${conversionErrors.length})</h2>
<table>
<thead><tr><th>ATCOCode</th><th>CommonName</th><th>Easting</th><th>Northing</th><th>Reason</th><th>Error</th></tr></thead>
<tbody>
${conversionErrors
  .map(
    (e) => `<tr><td>${escapeHtml(e.atcoCode)}</td><td>${escapeHtml(e.commonName)}</td><td>${escapeHtml(e.easting)}</td><td>${escapeHtml(e.northing)}</td><td>${escapeHtml(e.reason)}</td><td>${escapeHtml(e.error)}</td></tr>`
  )
  .join('\n')}
</tbody>
</table>`
    : '';

  // Emit the status page. Cloudflare Pages serves index.html at the site root.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Naptan Mirror</title>
<style>
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
th { background: #eee; }
</style>
</head>
 <body>
<h1>Naptan Mirror</h1>
<p><a href="${RELEASE_BASE}/naptan.json">naptan.json</a> &mdash; dataset (JSON)</p>
<p><a href="${RELEASE_BASE}/naptan.csv">naptan.csv</a> &mdash; dataset (CSV)</p>
<p><strong>Last refreshed:</strong> ${formatUK(generatedAt)}</p>
<p>Stop data updates around 1am, 9am &amp; 5pm</p>
${errorsHtml}
<p><button id="refreshBtn">Refresh now</button> <span id="refreshStatus"></span></p>
<script>
document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  const status = document.getElementById('refreshStatus');
  btn.disabled = true;
  status.textContent = 'Requesting\u2026';
  try {
    const res = await fetch('/refresh', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      status.textContent = 'Refresh started.';
    } else if (res.status === 429) {
      status.textContent = 'Already refreshed recently \u2014 try again later.';
    } else {
      status.textContent = 'Failed (' + (data.error || res.status) + '): ' + (data.detail || '');
    }
  } catch {
    status.textContent = 'Request failed.';
  }
  btn.disabled = false;
});
</script>
</body>
</html>
`;
  await writeFile(join(PUBLIC_DIR, 'index.html'), html);

  // Cleanup temp download
  await rm(TMP_CSV, { force: true }).catch(() => {});

  console.log(
    `[done] wrote ${records.length} records (${JSON_COLUMNS.length} columns) -> data/naptan.json, data/naptan.csv, public/meta.json, public/index.html`
  );
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
