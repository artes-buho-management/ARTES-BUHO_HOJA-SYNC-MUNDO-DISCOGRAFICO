const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SPREADSHEET_ID = 'REPLACE_WITH_SHEET_ID';
const DEFAULT_KEY_PATH = path.resolve(__dirname, '../../../secrets/robot-codex-key-20260308-220232.json');
const TARGET_SHEETS = ['DISCOGR', 'EDIT', 'DISTRI'];
const STATUS_HEADER = 'ESTADO EMAIL REVISION';
const MERGE_HEADER = 'Merge status';
const MAX_WEB_CHECKS = 120;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

async function getAccessToken(sa, scopes) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp,
  };

  const unsigned = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const assertion = `${unsigned}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await resp.json();
  if (!resp.ok || !json.access_token) {
    const err = new Error('TOKEN_ERROR');
    err.details = json;
    throw err;
  }
  return json.access_token;
}

async function apiGetJson(url, token) {
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const err = new Error(`API_GET_${resp.status}`);
    err.status = resp.status;
    err.details = data;
    throw err;
  }
  return data;
}

async function apiPutJson(url, token, body) {
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const err = new Error(`API_PUT_${resp.status}`);
    err.status = resp.status;
    err.details = data;
    throw err;
  }
  return data;
}

function normalizeSpaces(v) {
  return String(v || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeader(v) {
  return normalizeSpaces(v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function normalizeCompany(v) {
  return normalizeSpaces(v)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureLen(row, len) {
  const out = row.slice(0, len);
  while (out.length < len) out.push('');
  return out;
}

function colToA1(colIndex1) {
  let n = colIndex1;
  let out = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCharCode(65 + m) + out;
    n = Math.floor((n - m - 1) / 26);
  }
  return out;
}

function isPlaceholder(v) {
  const s = normalizeHeader(v);
  return s === '' || s === 'IA NO ENCUENTRA' || s === 'NO ENCONTRADO' || s === 'N/A' || s === 'NA';
}

function extractValidEmail(text) {
  const raw = String(text || '').toLowerCase();
  const match = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return match ? match[0] : '';
}

function getColumnMap(header) {
  const norm = header.map((h) => normalizeHeader(h));
  const status = norm.findIndex((h) => h === normalizeHeader(STATUS_HEADER));
  const merge = norm.findIndex((h) => h === normalizeHeader(MERGE_HEADER));
  const name = norm.findIndex((h) => h.startsWith('NOMBRE') && !h.includes('CONTACTO'));
  return { status, merge, name, norm };
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4500);
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!resp.ok && resp.status >= 500) return '';
    return String(await resp.text());
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

async function findEmailFromWeb(company, cache) {
  const c = normalizeCompany(company);
  if (!c) return '';
  if (cache[c]) return cache[c];

  const words = c.split(' ').filter(Boolean).slice(0, 3);
  const slug = words.join('');
  if (!slug) {
    cache[c] = '';
    return '';
  }

  const domains = [`${slug}.com`, `${slug}.es`, `${slug}.net`];
  const paths = ['', '/contacto', '/contact', '/about', '/sobre-nosotros'];

  let checks = cache.__checks || 0;
  for (const d of domains) {
    for (const p of paths) {
      if (checks >= MAX_WEB_CHECKS) {
        cache.__checks = checks;
        cache[c] = '';
        return '';
      }
      checks++;
      const html = await fetchHtml(`https://${d}${p}`);
      const email = extractValidEmail(html);
      if (email) {
        cache.__checks = checks;
        cache[c] = email;
        return email;
      }
    }
  }

  cache.__checks = checks;
  cache[c] = '';
  return '';
}

async function run() {
  const args = parseArgs(process.argv);
  const spreadsheetId = args.spreadsheetId || DEFAULT_SPREADSHEET_ID;
  const keyPath = args.key || DEFAULT_KEY_PATH;
  const nowIso = new Date().toISOString();

  const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const token = await getAccessToken(sa, ['https://www.googleapis.com/auth/spreadsheets']);

  const sheetValues = {};
  const maps = {};
  const colCounts = {};

  for (const sheetName of TARGET_SHEETS) {
    const getResp = await apiGetJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}!A:ZZ`,
      token
    );
    const values = getResp.values || [];
    if (values.length === 0) continue;

    const header = values[0].slice();
    const colMap = getColumnMap(header);
    const colCount = header.length;
    const rows = values.slice(1).map((r) => ensureLen(r, colCount));

    sheetValues[sheetName] = { header, rows };
    maps[sheetName] = colMap;
    colCounts[sheetName] = colCount;
  }

  const bag = {};
  for (const sheetName of Object.keys(sheetValues)) {
    const { header, rows } = sheetValues[sheetName];
    const map = maps[sheetName];
    for (const row of rows) {
      const company = map.name >= 0 ? normalizeCompany(row[map.name]) : '';
      if (!company) continue;
      if (!bag[company]) bag[company] = {};

      for (let c = 0; c < header.length; c++) {
        if (c === map.status || c === map.merge) continue;
        const key = normalizeHeader(header[c]);
        const val = normalizeSpaces(row[c]);
        if (isPlaceholder(val)) continue;
        if (!bag[company][key]) bag[company][key] = val;
      }
    }
  }

  const report = {
    generatedAt: nowIso,
    spreadsheetId,
    action: 'AUTOCOMPLETE_VIA_SA',
    sheets: [],
    totalFilled: 0,
    totalNoFind: 0,
    webChecks: 0,
  };

  const webCache = { __checks: 0 };

  for (const sheetName of Object.keys(sheetValues)) {
    const { header, rows } = sheetValues[sheetName];
    const map = maps[sheetName];
    const outRows = [header];
    let filled = 0;
    let noFind = 0;

    for (const row0 of rows) {
      const row = row0.slice();
      const company = map.name >= 0 ? normalizeCompany(row[map.name]) : '';
      const companyBag = company ? bag[company] || {} : {};

      for (let c = 0; c < header.length; c++) {
        if (c === map.status || c === map.merge) continue;
        const current = normalizeSpaces(row[c]);
        if (!isPlaceholder(current)) continue;

        const head = normalizeHeader(header[c] || '');
        let next = companyBag[head] || '';
        if (!next && head === 'EMAIL' && company) {
          next = await findEmailFromWeb(company, webCache);
        }
        if (!next) {
          next = 'IA NO ENCUENTRA';
          noFind++;
        } else {
          filled++;
        }
        row[c] = next;
      }

      outRows.push(row);
    }

    const outCols = colCounts[sheetName];
    const writeRange = `${sheetName}!A1:${colToA1(outCols)}${outRows.length}`;
    await apiPutJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(writeRange)}?valueInputOption=USER_ENTERED`,
      token,
      {
        range: writeRange,
        majorDimension: 'ROWS',
        values: outRows,
      }
    );

    report.sheets.push({
      sheet: sheetName,
      rows: rows.length,
      filled,
      noFind,
    });
    report.totalFilled += filled;
    report.totalNoFind += noFind;
  }

  report.webChecks = webCache.__checks || 0;

  const stamp = nowIso.replace(/[:.]/g, '-');
  const reportsDir = path.resolve(__dirname, '../reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outPath = path.resolve(reportsDir, `autocomplete_via_sa_${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(JSON.stringify({ ok: true, report, outPath }, null, 2));
}

run().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: err.message || String(err),
        status: err.status || null,
        details: err.details || null,
      },
      null,
      2
    )
  );
  process.exit(1);
});
