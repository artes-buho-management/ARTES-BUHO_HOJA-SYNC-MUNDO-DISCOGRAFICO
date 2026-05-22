const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;

const DEFAULT_SPREADSHEET_ID = 'REPLACE_WITH_SHEET_ID';
const DEFAULT_KEY_PATH = path.resolve(__dirname, '../../../secrets/robot-codex-key-20260308-220232.json');
const TARGET_SHEETS = ['DISCOGR', 'EDIT', 'DISTRI'];
const STATUS_HEADER = 'ESTADO EMAIL REVISION';

const COLORS = {
  BIEN: { red: 0.88, green: 0.95, blue: 0.88 }, // verde claro
  CAMBIADO: { red: 0.86, green: 0.92, blue: 0.98 }, // azul claro
  MAL: { red: 0.98, green: 0.87, blue: 0.87 }, // rojo claro
  DEFAULT: { red: 1, green: 1, blue: 1 },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
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
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .sign(sa.private_key, 'base64url');
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

async function apiPostJson(url, token, body) {
  const resp = await fetch(url, {
    method: 'POST',
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
    const err = new Error(`API_POST_${resp.status}`);
    err.status = resp.status;
    err.details = data;
    throw err;
  }
  return data;
}

async function apiPostText(url, token, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    let details;
    try {
      details = JSON.parse(text);
    } catch {
      details = { raw: text };
    }
    const err = new Error(`API_POST_${resp.status}`);
    err.status = resp.status;
    err.details = details;
    throw err;
  }
  return text;
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

function normalizeEmail(v) {
  return normalizeSpaces(v).toLowerCase();
}

function isLikelyEmail(v) {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v || '');
}

function extractEmails(raw) {
  const text = normalizeSpaces(raw);
  if (!text) return [];
  const matches = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

function heuristicFix(raw) {
  let t = normalizeSpaces(raw).toLowerCase();
  if (!t) return '';
  t = t
    .replace(/\(at\)|\[at\]|\s+at\s+|\s+arroba\s+/g, '@')
    .replace(/\s+/g, '')
    .replace(/,+/g, '.');
  return t;
}

async function hasMx(domain, cache) {
  if (!domain) return false;
  if (cache.has(domain)) return cache.get(domain);
  let ok = false;
  try {
    const mx = await dns.resolveMx(domain);
    ok = Array.isArray(mx) && mx.length > 0;
  } catch {
    ok = false;
  }
  cache.set(domain, ok);
  return ok;
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

function buildColorSegments(statuses) {
  const segments = [];
  let currentStatus = null;
  let start = -1;
  for (let i = 0; i < statuses.length; i++) {
    const s = statuses[i];
    if (!s) {
      if (currentStatus) {
        segments.push({ status: currentStatus, startRow: start, endRow: i });
        currentStatus = null;
        start = -1;
      }
      continue;
    }
    if (!currentStatus) {
      currentStatus = s;
      start = i + 2;
      continue;
    }
    if (s !== currentStatus) {
      segments.push({ status: currentStatus, startRow: start, endRow: i + 1 });
      currentStatus = s;
      start = i + 2;
    }
  }
  if (currentStatus) {
    segments.push({ status: currentStatus, startRow: start, endRow: statuses.length + 1 });
  }
  return segments;
}

async function applyVisualStatus() {
  const args = parseArgs(process.argv);
  const spreadsheetId = args.spreadsheetId || DEFAULT_SPREADSHEET_ID;
  const keyPath = args.key || DEFAULT_KEY_PATH;
  const nowIso = new Date().toISOString();

  const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const token = await getAccessToken(sa, ['https://www.googleapis.com/auth/spreadsheets']);

  const meta = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false`,
    token
  );
  const sheetsByName = {};
  for (const s of meta.sheets || []) {
    if (s.properties && s.properties.title) sheetsByName[s.properties.title] = s.properties;
  }

  const mxCache = new Map();
  const summary = {
    generatedAt: nowIso,
    spreadsheetId,
    sheets: [],
  };

  for (const sheetName of TARGET_SHEETS) {
    const sheetProps = sheetsByName[sheetName];
    if (!sheetProps) continue;

    const getResp = await apiGetJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}!A:ZZ`,
      token
    );
    const values = getResp.values || [];
    if (values.length === 0) continue;

    const header = values[0].slice();
    const body = values.slice(1);
    let emailCol = -1;
    let statusCol = -1;
    for (let i = 0; i < header.length; i++) {
      const h = normalizeHeader(header[i]);
      if (h === 'EMAIL') emailCol = i;
      if (h === normalizeHeader(STATUS_HEADER)) statusCol = i;
    }
    if (emailCol < 0) continue;

    if (statusCol < 0) {
      header.push(STATUS_HEADER);
      statusCol = header.length - 1;
    } else {
      header[statusCol] = STATUS_HEADER;
    }

    const outRows = [header];
    const rowStatuses = [];
    let countBien = 0;
    let countCambiado = 0;
    let countMal = 0;
    let changedEmails = 0;

    for (const rowOrig of body) {
      const row = ensureLen(rowOrig, header.length).map((v) => normalizeSpaces(v));
      if (row.every((v) => v === '')) {
        outRows.push(row);
        rowStatuses.push('');
        continue;
      }

      const originalRaw = row[emailCol] || '';
      const originalNorm = normalizeEmail(originalRaw);
      let candidate = '';

      const extracted = extractEmails(originalRaw);
      if (extracted.length > 0) {
        candidate = extracted[0];
      } else {
        const fixed = heuristicFix(originalRaw);
        if (isLikelyEmail(fixed)) candidate = fixed;
      }

      let status = 'MAL';
      if (candidate && isLikelyEmail(candidate)) {
        const domain = candidate.split('@')[1] || '';
        const mxOk = await hasMx(domain, mxCache);
        if (mxOk) {
          const changed = candidate !== originalNorm;
          status = changed ? 'CAMBIADO' : 'BIEN';
          if (changed) {
            row[emailCol] = candidate;
            changedEmails++;
          } else {
            row[emailCol] = originalNorm;
          }
        } else {
          status = 'MAL';
        }
      } else {
        status = 'MAL';
      }

      if (status === 'MAL' && !row[emailCol]) row[emailCol] = 'No encontrado';
      row[statusCol] = status;

      if (status === 'BIEN') countBien++;
      else if (status === 'CAMBIADO') countCambiado++;
      else countMal++;

      outRows.push(row);
      rowStatuses.push(status);
    }

    const colCount = header.length;
    const writeRange = `${sheetName}!A1:${colToA1(colCount)}${outRows.length}`;
    await apiPutJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(writeRange)}?valueInputOption=USER_ENTERED`,
      token,
      {
        range: writeRange,
        majorDimension: 'ROWS',
        values: outRows,
      }
    );

    const oldLastRow = values.length;
    if (outRows.length < oldLastRow) {
      const clearRange = `${sheetName}!A${outRows.length + 1}:${colToA1(colCount)}${oldLastRow}`;
      await apiPostText(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(clearRange)}:clear`,
        token,
        {}
      );
    }

    const segments = buildColorSegments(rowStatuses);
    const requests = [];
    for (const seg of segments) {
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheetProps.sheetId,
            startRowIndex: seg.startRow - 1,
            endRowIndex: seg.endRow,
            startColumnIndex: 0,
            endColumnIndex: colCount,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: COLORS[seg.status] || COLORS.DEFAULT,
            },
          },
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
    }

    if (requests.length > 0) {
      await apiPostJson(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        token,
        { requests }
      );
    }

    summary.sheets.push({
      sheet: sheetName,
      rowsProcessed: body.length,
      statusColumn: STATUS_HEADER,
      bien: countBien,
      cambiado: countCambiado,
      mal: countMal,
      changedEmails,
    });
  }

  const stamp = nowIso.replace(/[:.]/g, '-');
  const reportsDir = path.resolve(__dirname, '../reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outPath = path.resolve(reportsDir, `email_visual_status_${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(
    JSON.stringify(
      {
        ok: true,
        summary,
        outPath,
      },
      null,
      2
    )
  );
}

applyVisualStatus().catch((err) => {
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

