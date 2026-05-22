const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SPREADSHEET_ID = 'REPLACE_WITH_SHEET_ID';
const DEFAULT_KEY_PATH = path.resolve(__dirname, '../../../secrets/robot-codex-key-20260308-220232.json');
const TARGET_SHEETS = ['DISCOGR', 'EDIT', 'DISTRI'];
const CLEANUP_SHEET = 'LIMPIEZA_PRIORIDAD';
const DEFAULT_SHEET_LIMIT = 1200;

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

async function apiPostJson(url, token, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
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

async function apiPutJson(url, token, body) {
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
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

function isPlaceholder(v) {
  const s = normalizeHeader(v);
  return s === '' || s === 'NO ENCONTRADO' || s === 'IA NO ENCUENTRA' || s === 'N/A' || s === 'NA';
}

function isLikelyEmail(v) {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(v || '').trim());
}

function findIdx(headerNorm, matcher) {
  return headerNorm.findIndex(matcher);
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function boolArg(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v || '').toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'si' || s === 'yes' || s === 'on';
}

async function publishCleanupSheet({ token, spreadsheetId, items, limitRows }) {
  const meta = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false`,
    token
  );

  let sheet = (meta.sheets || []).find((s) => s.properties && s.properties.title === CLEANUP_SHEET);
  if (!sheet) {
    await apiPostJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      token,
      {
        requests: [{ addSheet: { properties: { title: CLEANUP_SHEET } } }],
      }
    );
    const meta2 = await apiGetJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false`,
      token
    );
    sheet = (meta2.sheets || []).find((s) => s.properties && s.properties.title === CLEANUP_SHEET);
  }

  const rows = [
    [
      'SHEET',
      'ROW',
      'PRIORITY_SCORE',
      'ACTION',
      'REASONS',
      'NOMBRE',
      'EMAIL',
      'TELEFONO',
      'CONTACTO',
      'MUNICIPIO',
      'PROVINCIA',
      'CCAA',
      'OBSERVACIONES',
    ],
  ];

  for (const it of items.slice(0, limitRows)) {
    rows.push([
      it.sheet,
      it.row,
      it.priorityScore,
      it.action,
      it.reasons,
      it.name,
      it.email,
      it.phone,
      it.contact,
      it.city,
      it.province,
      it.ccaa,
      it.notes,
    ]);
  }

  await apiPostJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${CLEANUP_SHEET}!A:Z`)}:clear`,
    token,
    {}
  );

  await apiPutJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${CLEANUP_SHEET}!A1`)}?valueInputOption=USER_ENTERED`,
    token,
    {
      range: `${CLEANUP_SHEET}!A1`,
      majorDimension: 'ROWS',
      values: rows,
    }
  );

  await apiPostJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    token,
    {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 },
            },
            fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: sheet.properties.sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 13,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.78, green: 0.16, blue: 0.16 },
                textFormat: {
                  bold: true,
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                },
                horizontalAlignment: 'CENTER',
              },
            },
            fields:
              'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.horizontalAlignment',
          },
        },
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId: sheet.properties.sheetId,
                startRowIndex: 0,
                endRowIndex: rows.length,
                startColumnIndex: 0,
                endColumnIndex: 13,
              },
            },
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: sheet.properties.sheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 13,
            },
          },
        },
      ],
    }
  );

  return {
    sheet: CLEANUP_SHEET,
    rowsWritten: rows.length - 1,
    limitRows,
  };
}

function scoreAndAction(row) {
  let score = 0;
  const reasons = [];

  if (!isLikelyEmail(row.email)) {
    score += 50;
    reasons.push('EMAIL_INVALIDO');
  }
  if (isPlaceholder(row.phone)) {
    score += 20;
    reasons.push('SIN_TELEFONO');
  }
  if (isPlaceholder(row.contact)) {
    score += 15;
    reasons.push('SIN_CONTACTO');
  }
  if (isPlaceholder(row.city) || isPlaceholder(row.province)) {
    score += 10;
    reasons.push('SIN_UBICACION');
  }
  if (isPlaceholder(row.notes)) {
    score += 5;
    reasons.push('SIN_NOTAS');
  }

  let action = 'REVISAR_MANUAL';
  if (!isLikelyEmail(row.email) && isPlaceholder(row.phone) && isPlaceholder(row.contact)) {
    action = 'CANDIDATO_BORRADO_DIRECTO';
  } else if (!isLikelyEmail(row.email)) {
    action = 'REVISAR_Y_CORREGIR_EMAIL';
  }

  return { score, reasons, action };
}

async function run() {
  const args = parseArgs(process.argv);
  const spreadsheetId = args.spreadsheetId || DEFAULT_SPREADSHEET_ID;
  const keyPath = args.key || DEFAULT_KEY_PATH;
  const publishSheet = boolArg(args.publishSheet || false);
  const limitRows = Math.max(1, Number(args.limit || DEFAULT_SHEET_LIMIT));
  const nowIso = new Date().toISOString();

  const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const scopes = publishSheet
    ? ['https://www.googleapis.com/auth/spreadsheets']
    : ['https://www.googleapis.com/auth/spreadsheets.readonly'];
  const token = await getAccessToken(sa, scopes);

  const items = [];
  const bySheet = [];

  for (const sheetName of TARGET_SHEETS) {
    const getResp = await apiGetJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}!A:ZZ`,
      token
    );
    const values = getResp.values || [];
    if (values.length < 2) continue;

    const header = values[0];
    const norm = header.map((h) => normalizeHeader(h));
    const idx = {
      name: findIdx(norm, (h) => h.startsWith('NOMBRE') && !h.includes('CONTACTO')),
      city: findIdx(norm, (h) => h === 'MUNICIPIO'),
      province: findIdx(norm, (h) => h === 'PROVINCIA'),
      ccaa: findIdx(norm, (h) => h === 'CCAA'),
      email: findIdx(norm, (h) => h === 'EMAIL'),
      phone: findIdx(norm, (h) => h.includes('TELEFONO')),
      contact: findIdx(norm, (h) => h.includes('NOMBRE CONTACTO')),
      notes: findIdx(norm, (h) => h.includes('OBSERVACIONES')),
      status: findIdx(norm, (h) => h === 'ESTADO EMAIL REVISION'),
    };

    let malCount = 0;
    for (let r = 1; r < values.length; r++) {
      const row = values[r] || [];
      const status = normalizeHeader(idx.status >= 0 ? row[idx.status] : '');
      if (status !== 'MAL') continue;
      malCount++;

      const item = {
        sheet: sheetName,
        row: r + 1,
        name: normalizeSpaces(idx.name >= 0 ? row[idx.name] : ''),
        city: normalizeSpaces(idx.city >= 0 ? row[idx.city] : ''),
        province: normalizeSpaces(idx.province >= 0 ? row[idx.province] : ''),
        ccaa: normalizeSpaces(idx.ccaa >= 0 ? row[idx.ccaa] : ''),
        email: normalizeSpaces(idx.email >= 0 ? row[idx.email] : ''),
        phone: normalizeSpaces(idx.phone >= 0 ? row[idx.phone] : ''),
        contact: normalizeSpaces(idx.contact >= 0 ? row[idx.contact] : ''),
        notes: normalizeSpaces(idx.notes >= 0 ? row[idx.notes] : ''),
      };
      const rank = scoreAndAction(item);
      item.priorityScore = rank.score;
      item.action = rank.action;
      item.reasons = rank.reasons.join('|');
      items.push(item);
    }

    bySheet.push({ sheet: sheetName, malRows: malCount });
  }

  items.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    const s = String(a.sheet).localeCompare(String(b.sheet));
    if (s !== 0) return s;
    return a.row - b.row;
  });

  const summary = {
    generatedAt: nowIso,
    spreadsheetId,
    publishSheet,
    totalMalRows: items.length,
    bySheet,
    top10: items.slice(0, 10),
  };

  const csvHeader = [
    'SHEET',
    'ROW',
    'PRIORITY_SCORE',
    'ACTION',
    'REASONS',
    'NOMBRE',
    'EMAIL',
    'TELEFONO',
    'CONTACTO',
    'MUNICIPIO',
    'PROVINCIA',
    'CCAA',
    'OBSERVACIONES',
  ];
  const csvLines = [csvHeader.join(',')];
  for (const it of items) {
    csvLines.push(
      [
        it.sheet,
        it.row,
        it.priorityScore,
        it.action,
        it.reasons,
        it.name,
        it.email,
        it.phone,
        it.contact,
        it.city,
        it.province,
        it.ccaa,
        it.notes,
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  const stamp = nowIso.replace(/[:.]/g, '-');
  const reportsDir = path.resolve(__dirname, '../reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const jsonPath = path.resolve(reportsDir, `mal_cleanup_report_${stamp}.json`);
  const csvPath = path.resolve(reportsDir, `mal_cleanup_report_${stamp}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, items }, null, 2), 'utf8');
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');

  let published = null;
  if (publishSheet) {
    published = await publishCleanupSheet({
      token,
      spreadsheetId,
      items,
      limitRows,
    });
  }

  console.log(JSON.stringify({ ok: true, summary, published, jsonPath, csvPath }, null, 2));
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
