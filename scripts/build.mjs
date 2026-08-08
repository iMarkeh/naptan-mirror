#!/usr/bin/env node
// Naptan Mirror build script
//
// 1. Downloads the full UK NaPTAN dataset (CSV) from the DfT endpoint.
// 2. Parses it, keeping a broad column set so both consuming sites keep working.
// 3. Emits public/naptan.csv and public/naptan.json plus public/meta.json
//    (generatedAt, source, record count, content hash) so consumers can
//    detect changes and skip redundant reloads.
//
// No credit card / no paid services required: output is a static dir that is
// deployed to a Cloudflare Pages project by the GitHub Actions workflow.

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const TMP_CSV = join(tmpdir(), `naptan-${Date.now()}.csv`);

// Configurable source. Defaults to the legacy DfT direct-download endpoint.
// If DfT changes the URL, set NAPTAN_URL as a workflow/env variable.
const NAPTAN_URL =
  process.env.NAPTAN_URL ||
  'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv';

// Broad column set. These are the standard NaPTAN CSV headers. We keep a wide
// set because the two consuming sites use various different parts of NaPTAN.
// Only columns that are genuinely never useful (e.g. internal hash/signature
// fields if present) are omitted; everything else is preserved.
const COLUMNS = [
  'ATCOCode',
  'NaptanCode',
  'PlateCode',
  'CleardownCode',
  'CommonName',
  'CommonNameLang',
  'ShortCommonName',
  'ShortCommonNameLang',
  'Landmark',
  'LandmarkLang',
  'Street',
  'StreetLang',
  'Crossing',
  'CrossingLang',
  'Indicator',
  'IndicatorLang',
  'Bearing',
  'NptgLocalityCode',
  'LocalityName',
  'LocalityNameLang',
  'ParentLocalityName',
  'GrandParentLocalityName',
  'Town',
  'TownLang',
  'Suburb',
  'SuburbLang',
  'LocalityCentre',
  'GridType',
  'Easting',
  'Northing',
  'Longitude',
  'Latitude',
  'StopType',
  'BusStopType',
  'BusStopUserType',
  'BusShelter',
  'BusStreetFurniture',
  'BusWaitProvision',
  'BusInfoPoint',
  'BusCover',
  'RailTicketOffice',
  'RailPlatform',
  'RailEntrance',
  'TubeEntrance',
  'MetroEntrance',
  'AirEntrance',
  'FerryEntrance',
  'AccessibilityNote',
  'Note',
  'Notes',
  'AdministrativeAreaCode',
  'AdministrativeAreaName',
  'CreationDateTime',
  'ModificationDateTime',
  'RevisionNumber',
  'Status',
  'StopAreaCode',
  'StopAreaName',
  'StopAreaType',
  'StopAreaDirection',
  'StopPointType',
  'TimeZone',
];

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

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Minimal CSV parser that handles quoted fields, embedded commas, and
// embedded newlines. Returns { headers, rows } where rows are objects.
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    if (inQuotes) {
      // collapse escaped quotes
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
  // trailing field/row
  if (field.length > 0 || row.length > 0) {
    pushField();
    rows.push(row);
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue; // skip blank lines
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cells[c] !== undefined ? cells[c] : '';
    }
    records.push(obj);
  }
  return { headers, records };
}

async function main() {
  await mkdir(PUBLIC_DIR, { recursive: true });
  await download(NAPTAN_URL, TMP_CSV);

  const text = await (await import('node:fs/promises')).readFile(TMP_CSV, 'utf8');
  console.log('[parse] parsing CSV...');
  const { headers, records } = parseCsv(text);
  console.log(`[parse] ${records.length} stop records, ${headers.length} source columns`);

  // Keep only the columns we want, in a stable order. If a desired column is
  // missing from the source, it is emitted as empty (so consumers stay stable).
  const projected = records.map((rec) => {
    const out = {};
    for (const col of COLUMNS) {
      out[col] = rec[col] !== undefined ? rec[col] : '';
    }
    return out;
  });

  // Emit JSON
  const jsonPath = join(PUBLIC_DIR, 'naptan.json');
  await writeFile(jsonPath, JSON.stringify(projected));

  // Emit CSV
  const csvLines = [COLUMNS.join(',')];
  for (const rec of projected) {
    csvLines.push(COLUMNS.map((c) => csvEscape(rec[c])).join(','));
  }
  const csvPath = join(PUBLIC_DIR, 'naptan.csv');
  await writeFile(csvPath, csvLines.join('\n'));

  // Content hash of the JSON for change detection
  const jsonBuf = await (await import('node:fs/promises')).readFile(jsonPath);
  const hash = createHash('sha256').update(jsonBuf).digest('hex').slice(0, 16);

  const meta = {
    generatedAt: new Date().toISOString(),
    source: NAPTAN_URL,
    recordCount: projected.length,
    columns: COLUMNS,
    jsonHash: hash,
    formats: {
      json: '/naptan.json',
      csv: '/naptan.csv',
    },
  };
  await writeFile(join(PUBLIC_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  // Cleanup temp download
  await rm(TMP_CSV, { force: true }).catch(() => {});

  console.log(
    `[done] wrote ${projected.length} records -> naptan.json, naptan.csv, meta.json (hash=${hash})`
  );
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
