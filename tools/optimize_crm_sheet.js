const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;

const DEFAULT_SPREADSHEET_ID = 'REPLACE_WITH_SHEET_ID';
const DEFAULT_KEY_PATH = path.resolve(__dirname, '../../../secrets/robot-codex-key-20260308-220232.json');
const TARGET_SHEETS = ['DISCOGR', 'EDIT', 'DISTRI'];
const REVIEW_SHEET = 'REVISION_CORREOS';
const REVIEWED_BY = 'CODEX_CRM_BOT';

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

function sheetRange(sheetName, rangeA1) {
  return `${sheetName}!${rangeA1}`;
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

function normalizeSpaces(v) {
  return String(v || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeader(h) {
  return normalizeSpaces(h)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function normalizeTextKey(v) {
  return normalizeSpaces(v).toLowerCase();
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
  const uniq = [...new Set(matches.map((m) => m.toLowerCase()))];
  if (uniq.length > 0) return uniq;
  return [text.toLowerCase()];
}

function getColumnIndexMap(header) {
  const map = {};
  for (let i = 0; i < header.length; i++) {
    const h = normalizeHeader(header[i]);
    if (h.startsWith('NOMBRE')) map.name = i;
    if (h === 'ESTILO' || h === 'ESTILOS') map.style = i;
    if (h.includes('TAMANO')) map.size = i;
    if (h === 'MUNICIPIO') map.city = i;
    if (h === 'PROVINCIA') map.province = i;
    if (h === 'CCAA') map.region = i;
    if (h === 'EMAIL') map.email = i;
    if (h.includes('TELEFONO')) map.phone = i;
    if (h.includes('CONTACTO')) map.contact = i;
    if (h.includes('OBSERVACIONES')) map.notes = i;
    if (h.includes('MERGE STATUS') || h.includes('ESTADO')) map.status = i;
  }
  return map;
}

function ensureLen(row, len) {
  const out = row.slice(0, len);
  while (out.length < len) out.push('');
  return out;
}

function normalizeRow(row, colMap, colCount) {
  const out = ensureLen(row, colCount).map((v) => normalizeSpaces(v));
  const defaultNo = 'No encontrado';
  for (const idx of [colMap.size, colMap.city, colMap.province, colMap.region, colMap.phone, colMap.contact]) {
    if (idx !== undefined && !out[idx]) out[idx] = defaultNo;
  }
  if (colMap.notes !== undefined && !out[colMap.notes]) {
    out[colMap.notes] = '';
  }
  if (colMap.email !== undefined) {
    out[colMap.email] = normalizeEmail(out[colMap.email]);
    if (!out[colMap.email]) out[colMap.email] = defaultNo;
  }
  if (colMap.name !== undefined && !out[colMap.name]) out[colMap.name] = defaultNo;
  return out;
}

function rowIsEmpty(row) {
  return row.every((v) => normalizeSpaces(v) === '');
}

function dedupeRows(rows, keyCols) {
  const seen = new Set();
  const kept = [];
  const removed = [];
  for (const row of rows) {
    const key = keyCols.map((i) => normalizeTextKey(row[i])).join('||');
    if (!key || /^(\|\|)*$/.test(key)) continue;
    if (seen.has(key)) {
      removed.push(row);
      continue;
    }
    seen.add(key);
    kept.push(row);
  }
  return { kept, removed };
}

async function hasMxRecord(domain, cache) {
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

async function upsertReviewSheet({ token, spreadsheetId, sheetMetaByName, rows }) {
  let reviewMeta = sheetMetaByName[REVIEW_SHEET];
  if (!reviewMeta) {
    await apiPostJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      token,
      {
        requests: [{ addSheet: { properties: { title: REVIEW_SHEET } } }],
      }
    );
    const meta = await apiGetJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false`,
      token
    );
    reviewMeta = (meta.sheets || []).find((s) => s.properties && s.properties.title === REVIEW_SHEET);
  }

  const reviewId = reviewMeta.properties.sheetId;
  await apiPostText(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(REVIEW_SHEET)}!A:Z:clear`,
    token,
    {}
  );

  const payloadRows = [REVIEW_HEADERS, ...rows];
  await apiPutJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(REVIEW_SHEET)}!A1?valueInputOption=USER_ENTERED`,
    token,
    {
      range: `${REVIEW_SHEET}!A1`,
      majorDimension: 'ROWS',
      values: payloadRows,
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
              sheetId: reviewId,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId: reviewId,
                startRowIndex: 0,
                endRowIndex: payloadRows.length,
                startColumnIndex: 0,
                endColumnIndex: REVIEW_HEADERS.length,
              },
            },
          },
        },
      ],
    }
  );
}

const REVIEW_HEADERS = [
  'FECHA_REVISION_UTC',
  'PESTANA',
  'NOMBRE_ENTIDAD',
  'EMAIL_ORIGINAL',
  'EMAIL_NORMALIZADO',
  'REVISADO',
  'ESTADO',
  'MOTIVO',
  'ALCANCE_VERIFICACION',
  'REVISADO_POR',
];

async function optimize() {
  const args = parseArgs(process.argv);
  const spreadsheetId = args.spreadsheetId || DEFAULT_SPREADSHEET_ID;
  const keyPath = args.key || DEFAULT_KEY_PATH;
  const nowIso = new Date().toISOString();

  const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const token = await getAccessToken(sa, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
  ]);

  const meta = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false`,
    token
  );
  const sheetMetaByName = {};
  for (const s of meta.sheets || []) {
    if (s.properties && s.properties.title) {
      sheetMetaByName[s.properties.title] = s;
    }
  }

  const backup = {
    generatedAt: nowIso,
    spreadsheetId,
    workbookTitle: meta.properties?.title || '',
    sheets: {},
  };

  const summary = {
    generatedAt: nowIso,
    spreadsheetId,
    workbookTitle: meta.properties?.title || '',
    sheetOptimizations: [],
    reviewRows: 0,
  };

  const reviewRows = [];
  const mxCache = new Map();

  for (const sheetName of TARGET_SHEETS) {
    if (!sheetMetaByName[sheetName]) continue;
    const getResp = await apiGetJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}!A:K`,
      token
    );
    const values = getResp.values || [];
    if (values.length === 0) continue;

    backup.sheets[sheetName] = values;
    const header = ensureLen(values[0], 11);
    const dataRows = values.slice(1).map((r) => ensureLen(r, 11));
    const colMap = getColumnIndexMap(header);
    const colCount = 11;

    if (colMap.status === undefined) {
      colMap.status = 10;
      header[10] = 'Merge status';
    }

    const normalizedRows = dataRows
      .filter((r) => !rowIsEmpty(r))
      .map((r) => normalizeRow(r, colMap, colCount));

    const keyCols = [colMap.name, colMap.email, colMap.phone, colMap.city, colMap.province].filter((v) => v !== undefined);
    const { kept, removed } = dedupeRows(normalizedRows, keyCols);

    for (const row of kept) {
      const emailVal = colMap.email !== undefined ? row[colMap.email] : '';
      const ok = isLikelyEmail(emailVal);
      row[colMap.status] = ok ? 'OPTIMIZADO_OK' : 'REVISAR_EMAIL';
    }

    const finalRows = [header, ...kept];
    const writeRange = `${sheetName}!A1:K${finalRows.length}`;
    await apiPutJson(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(writeRange)}?valueInputOption=USER_ENTERED`,
      token,
      {
        range: writeRange,
        majorDimension: 'ROWS',
        values: finalRows,
      }
    );

    const oldLastRow = values.length;
    if (finalRows.length < oldLastRow) {
      const clearRange = `${sheetName}!A${finalRows.length + 1}:K${oldLastRow}`;
      await apiPostText(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(clearRange)}:clear`,
        token,
        {}
      );
    }

    for (let i = 0; i < kept.length; i++) {
      const row = kept[i];
      const name = colMap.name !== undefined ? row[colMap.name] : '';
      const emailRaw = colMap.email !== undefined ? row[colMap.email] : '';
      const candidates = emailRaw && emailRaw !== 'No encontrado' ? extractEmails(emailRaw) : [];
      if (candidates.length === 0) {
        reviewRows.push([
          nowIso,
          sheetName,
          name,
          emailRaw || 'No encontrado',
          '',
          'SI',
          'MAL',
          'SIN_EMAIL',
          'No existe email en el registro',
          REVIEWED_BY,
        ]);
        continue;
      }

      for (const email of candidates) {
        const valid = isLikelyEmail(email);
        let mxOk = false;
        if (valid) {
          const domain = email.split('@')[1] || '';
          mxOk = await hasMxRecord(domain, mxCache);
        }
        const state = valid && mxOk ? 'BIEN' : 'MAL';
        const reason = !valid ? 'FORMATO_INVALIDO' : mxOk ? 'OK' : 'DOMINIO_SIN_MX';
        reviewRows.push([
          nowIso,
          sheetName,
          name,
          emailRaw,
          email,
          'SI',
          state,
          reason,
          'Verificacion tecnica: formato + registros MX de dominio (no valida buzon individual)',
          REVIEWED_BY,
        ]);
      }
    }

    summary.sheetOptimizations.push({
      sheet: sheetName,
      originalRows: dataRows.length,
      finalRows: kept.length,
      removedDuplicates: removed.length,
    });
  }

  const dedupReviewMap = new Map();
  for (const r of reviewRows) {
    const key = [r[1], normalizeTextKey(r[2]), normalizeTextKey(r[4])].join('||');
    if (!dedupReviewMap.has(key)) dedupReviewMap.set(key, r);
  }
  const reviewRowsUnique = [...dedupReviewMap.values()];
  summary.reviewRows = reviewRowsUnique.length;

  await upsertReviewSheet({
    token,
    spreadsheetId,
    sheetMetaByName,
    rows: reviewRowsUnique,
  });

  const stamp = nowIso.replace(/[:.]/g, '-');
  const reportsDir = path.resolve(__dirname, '../reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const backupPath = path.resolve(reportsDir, `backup_pre_optimize_${stamp}.json`);
  const resultPath = path.resolve(reportsDir, `optimize_result_${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
  fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(
    JSON.stringify(
      {
        ok: true,
        summary,
        backupPath,
        resultPath,
      },
      null,
      2
    )
  );
}

optimize().catch((err) => {
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

