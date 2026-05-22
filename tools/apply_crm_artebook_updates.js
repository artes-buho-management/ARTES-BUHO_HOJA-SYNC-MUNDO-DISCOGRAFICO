const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SPREADSHEET_ID = 'REPLACE_WITH_SHEET_ID';
const DEFAULT_KEY_PATH = path.resolve(__dirname, '../../../secrets/robot-codex-key-20260308-220232.json');
const TARGET_SHEETS = ['DISCOGR', 'EDIT', 'DISTRI'];
const REVIEW_SHEET = 'REVISION_CORREOS';
const SUMMARY_SHEET = 'RESUMEN_CRM';
const STATUS_HEADER = 'ESTADO EMAIL REVISION';
const MERGE_HEADER = 'Merge status';
const TAG_HEADER = 'ETIQUETA REVISION';
const STATUS_OPTIONS = ['BIEN', 'CORREGIDO', 'MAL'];

const ROW_COLORS = {
  BIEN: { red: 0.88, green: 0.95, blue: 0.88 },
  CORREGIDO: { red: 0.86, green: 0.92, blue: 0.98 },
  CAMBIADO: { red: 0.86, green: 0.92, blue: 0.98 },
  MAL: { red: 0.98, green: 0.87, blue: 0.87 },
  WHITE: { red: 1, green: 1, blue: 1 },
};

const CORPORATE = {
  RED: { red: 0.78, green: 0.16, blue: 0.16 },
  YELLOW: { red: 1, green: 0.8, blue: 0 },
  WHITE: { red: 1, green: 1, blue: 1 },
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

function normalizeKey(v) {
  return normalizeSpaces(v).toLowerCase();
}

function normalizeEntityName(v) {
  return normalizeSpaces(v)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEmailKey(v) {
  return normalizeSpaces(v).toLowerCase();
}

function normalizePhoneKey(v) {
  return normalizeSpaces(v).replace(/\D+/g, '');
}

function ensureLen(row, len) {
  const out = row.slice(0, len);
  while (out.length < len) out.push('');
  return out;
}

function maxCols(rows) {
  let max = 0;
  for (const r of rows) {
    if (Array.isArray(r) && r.length > max) max = r.length;
  }
  return max;
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

function isLikelyEmail(v) {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v || '');
}

function isSheetErrorMarker(v) {
  const raw = normalizeHeader(v);
  return raw.startsWith('#ERROR') || raw.startsWith('#N/A') || raw.startsWith('#REF');
}

function canonicalStatus(rawStatus, rawEmail) {
  const s = normalizeHeader(rawStatus);
  if (s === 'BIEN') return 'BIEN';
  if (s === 'CORREGIDO' || s === 'CAMBIADO') return 'CORREGIDO';
  if (s === 'MAL') return 'MAL';

  const email = normalizeSpaces(rawEmail).toLowerCase();
  if (!email) return 'MAL';
  if (email.includes('no encontrado') || email.includes('no encuentra')) return 'MAL';
  if (isLikelyEmail(email)) return 'BIEN';
  return 'MAL';
}

function canonicalReviewStatus(raw) {
  const s = normalizeHeader(raw);
  if (s.includes('BIEN') || s === 'OK') return 'BIEN';
  if (s.includes('CORREGIDO') || s.includes('CAMBIADO')) return 'CORREGIDO';
  return 'MAL';
}

function reviewStatusRank(status) {
  if (status === 'MAL') return 0;
  if (status === 'CORREGIDO' || status === 'CAMBIADO') return 1;
  return 2;
}

function buildColorSegments(statuses) {
  const segments = [];
  let currentStatus = '';
  let start = -1;
  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i];
    if (!status) {
      if (currentStatus) {
        segments.push({ status: currentStatus, startRow: start, endRow: i + 1 });
        currentStatus = '';
        start = -1;
      }
      continue;
    }
    if (!currentStatus) {
      currentStatus = status;
      start = i + 2;
      continue;
    }
    if (status !== currentStatus) {
      segments.push({ status: currentStatus, startRow: start, endRow: i + 1 });
      currentStatus = status;
      start = i + 2;
    }
  }
  if (currentStatus) {
    segments.push({ status: currentStatus, startRow: start, endRow: statuses.length + 1 });
  }
  return segments;
}

function columnWidth(headerText) {
  const h = normalizeHeader(headerText);
  if (h.startsWith('NOMBRE') && !h.includes('CONTACTO')) return 230;
  if (h === 'EMPRESA') return 230;
  if (h === 'ESTILO' || h === 'ESTILOS') return 230;
  if (h.includes('TAMANO')) return 150;
  if (h === 'MUNICIPIO') return 140;
  if (h === 'PROVINCIA') return 140;
  if (h === 'CCAA') return 190;
  if (h === 'ORIGEN') return 130;
  if (h === 'EMAIL') return 260;
  if (h.includes('TELEFONO')) return 150;
  if (h.includes('NOMBRE CONTACTO')) return 210;
  if (h.includes('OBSERVACIONES')) return 280;
  if (h === normalizeHeader(MERGE_HEADER)) return 170;
  if (h === normalizeHeader(STATUS_HEADER) || h === 'ESTADO') return 190;
  if (h === 'FECHA') return 170;
  if (h === 'MOTIVO') return 230;
  if (h === 'REVISADO_POR') return 170;
  return Math.max(120, Math.min(280, normalizeSpaces(headerText).length * 11));
}

function dedupeRows(rows, keyCols) {
  const seen = new Set();
  const out = [];
  let removed = 0;
  for (const row of rows) {
    const isEmpty = row.every((v) => !normalizeSpaces(v));
    if (isEmpty) continue;

    const key = keyCols.map((idx) => normalizeKey(row[idx] || '')).join('||');
    const keyBare = key.replace(/\|/g, '');
    if (!keyBare) {
      out.push(row);
      continue;
    }
    if (seen.has(key)) {
      removed++;
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  return { out, removed };
}

function statusKeepRank(status) {
  const s = normalizeHeader(status);
  if (s === 'BIEN') return 3;
  if (s === 'CORREGIDO' || s === 'CAMBIADO') return 2;
  if (s === 'MAL') return 1;
  return 0;
}

function filledCellsCount(row) {
  let count = 0;
  for (const v of row) {
    if (normalizeSpaces(v)) count++;
  }
  return count;
}

function rowKeepScore(row, idxStatus, idxEmail) {
  const status = idxStatus >= 0 ? row[idxStatus] : '';
  const email = idxEmail >= 0 ? row[idxEmail] : '';
  const canonical = canonicalStatus(status, email);
  const rank = statusKeepRank(canonical);
  return rank * 1000 + filledCellsCount(row);
}

function dedupeTargetRows(rows, { idxName, idxEmail, idxPhone, idxStatus }) {
  const out = [];
  const keyToIndex = new Map();
  let removed = 0;

  for (const raw of rows) {
    const row = raw.slice();
    const name = idxName >= 0 ? normalizeEntityName(row[idxName]) : '';
    const email = idxEmail >= 0 ? normalizeEmailKey(row[idxEmail]) : '';
    const phone = idxPhone >= 0 ? normalizePhoneKey(row[idxPhone]) : '';

    let key = '';
    if (name && email) key = `NE|${name}|${email}`;
    else if (name && phone) key = `NP|${name}|${phone}`;

    if (!key) {
      out.push(row);
      continue;
    }

    if (!keyToIndex.has(key)) {
      keyToIndex.set(key, out.length);
      out.push(row);
      continue;
    }

    const idx = keyToIndex.get(key);
    const current = out[idx];
    const currentScore = rowKeepScore(current, idxStatus, idxEmail);
    const candidateScore = rowKeepScore(row, idxStatus, idxEmail);

    if (candidateScore > currentScore) {
      out[idx] = row;
    }
    removed++;
  }

  return { out, removed };
}

function removeHeaderColumns(header, body, headerNameNormalized) {
  const indexes = [];
  for (let i = 0; i < header.length; i++) {
    if (normalizeHeader(header[i]) === headerNameNormalized) indexes.push(i);
  }
  indexes.sort((a, b) => b - a);
  for (const idx of indexes) {
    header.splice(idx, 1);
    for (const row of body) {
      if (row.length > idx) row.splice(idx, 1);
    }
  }
  return indexes.length;
}

function reorderRowsByIndices(header, body, orderIdx) {
  const newHeader = orderIdx.map((idx) => header[idx] || '');
  const newBody = body.map((row) => {
    const full = ensureLen(row, header.length);
    return orderIdx.map((idx) => full[idx] || '');
  });
  return { header: newHeader, body: newBody };
}

function pickColumnIndex(headersNorm, matcher, used) {
  for (let i = 0; i < headersNorm.length; i++) {
    if (used.has(i)) continue;
    if (matcher(headersNorm[i])) return i;
  }
  return -1;
}

function targetColumnOrderIndices(header) {
  const headersNorm = header.map((h) => normalizeHeader(h));
  const mergeIdx = headersNorm.findIndex((h) => h === normalizeHeader(MERGE_HEADER));
  const statusIdx = headersNorm.findIndex((h) => h === normalizeHeader(STATUS_HEADER));
  const used = new Set();
  const order = [];
  const matchers = [
    (h) => h.startsWith('NOMBRE') && !h.includes('CONTACTO'),
    (h) => h === 'ESTILO' || h === 'ESTILOS',
    (h) => h.includes('TAMANO'),
    (h) => h === 'CCAA',
    (h) => h === 'PROVINCIA',
    (h) => h === 'MUNICIPIO',
    (h) => h === 'EMAIL',
    (h) => h.includes('TELEFONO'),
    (h) => h.includes('NOMBRE CONTACTO'),
    (h) => h.includes('OBSERVACIONES'),
  ];

  for (const matcher of matchers) {
    const idx = pickColumnIndex(headersNorm, matcher, used);
    if (idx >= 0 && idx !== mergeIdx && idx !== statusIdx) {
      used.add(idx);
      order.push(idx);
    }
  }

  for (let i = 0; i < header.length; i++) {
    if (i === mergeIdx) continue;
    if (i === statusIdx) continue;
    if (used.has(i)) continue;
    used.add(i);
    order.push(i);
  }

  if (statusIdx >= 0) order.push(statusIdx);
  if (mergeIdx >= 0) order.push(mergeIdx);
  return order;
}

function headerStyleRequests(sheetId, colCount, frozenCols) {
  return [
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: CORPORATE.RED,
            textFormat: {
              bold: true,
              foregroundColor: CORPORATE.WHITE,
            },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            wrapStrategy: 'WRAP',
          },
        },
        fields:
          'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy',
      },
    },
    {
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        top: { style: 'SOLID', color: CORPORATE.YELLOW },
        bottom: { style: 'SOLID', color: CORPORATE.YELLOW },
        left: { style: 'SOLID', color: CORPORATE.YELLOW },
        right: { style: 'SOLID', color: CORPORATE.YELLOW },
        innerVertical: { style: 'SOLID', color: CORPORATE.YELLOW },
      },
    },
    {
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: 0,
          endIndex: 1,
        },
        properties: {
          pixelSize: 34,
        },
        fields: 'pixelSize',
      },
    },
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: {
            frozenRowCount: 1,
            frozenColumnCount: frozenCols,
          },
        },
        fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    },
  ];
}

function statusPaintRequests(sheetId, rowCount, colCount, statuses) {
  const requests = [];
  if (rowCount > 1) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 1,
          endRowIndex: rowCount,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: ROW_COLORS.WHITE,
          },
        },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
  }
  const segments = buildColorSegments(statuses);
  for (const seg of segments) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: seg.startRow - 1,
          endRowIndex: seg.endRow,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: ROW_COLORS[seg.status] || ROW_COLORS.WHITE,
          },
        },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
  }
  return requests;
}

function widthRequests(sheetId, header) {
  const requests = [];
  for (let i = 0; i < header.length; i++) {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: i,
          endIndex: i + 1,
        },
        properties: {
          pixelSize: columnWidth(header[i]),
        },
        fields: 'pixelSize',
      },
    });
  }
  return requests;
}

function simpleFilterRequest(sheetId, rows, cols) {
  return {
    setBasicFilter: {
      filter: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: rows,
          startColumnIndex: 0,
          endColumnIndex: cols,
        },
      },
    },
  };
}

function statusValidationRule() {
  return {
    condition: {
      type: 'ONE_OF_LIST',
      values: STATUS_OPTIONS.map((v) => ({ userEnteredValue: v })),
    },
    inputMessage: 'Selecciona BIEN, CORREGIDO o MAL',
    strict: true,
    showCustomUi: true,
  };
}

function setColumnsHiddenRequest(sheetId, startIndex, endIndex, hiddenByUser) {
  if (startIndex >= endIndex) return null;
  return {
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension: 'COLUMNS',
        startIndex,
        endIndex,
      },
      properties: {
        hiddenByUser,
      },
      fields: 'hiddenByUser',
    },
  };
}

async function getChartIdsForSheet({ token, spreadsheetId, sheetId }) {
  const meta = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId),charts(chartId))`,
    token
  );
  const sheet = (meta.sheets || []).find((s) => s.properties?.sheetId === sheetId);
  return (sheet?.charts || []).map((c) => c.chartId).filter((v) => typeof v === 'number');
}

async function clearExtraArea({ token, spreadsheetId, sheetName, oldRows, oldCols, newRows, newCols }) {
  if (newCols < oldCols) {
    const clearColsRange = `${sheetName}!${colToA1(newCols + 1)}1:${colToA1(oldCols)}${oldRows}`;
    await apiPostText(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(clearColsRange)}:clear`,
      token,
      {}
    );
  }
  if (newRows < oldRows) {
    const clearRowsRange = `${sheetName}!A${newRows + 1}:${colToA1(Math.max(oldCols, newCols))}${oldRows}`;
    await apiPostText(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(clearRowsRange)}:clear`,
      token,
      {}
    );
  }
}

async function ensureSheetExists({ token, spreadsheetId, name }) {
  const meta = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false`,
    token
  );
  const existing = (meta.sheets || []).find((s) => s.properties?.title === name);
  if (existing) return existing.properties;

  await apiPostJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    token,
    {
      requests: [{ addSheet: { properties: { title: name } } }],
    }
  );

  const meta2 = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false`,
    token
  );
  const created = (meta2.sheets || []).find((s) => s.properties?.title === name);
  if (!created) throw new Error(`No se pudo crear hoja ${name}`);
  return created.properties;
}

async function updateSummarySheet({ token, spreadsheetId, summaryProps, targetSummaries, reviewSummary, generatedAt }) {
  const sheetName = SUMMARY_SHEET;
  const getResp = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}!A:ZZ`,
    token
  );
  const oldRows = (getResp.values || []).length || 1;
  const oldCols = Math.max(maxCols(getResp.values || [['']]), 1);

  const header = [
    'ACTUALIZADO_UTC',
    'PESTANA',
    'TOTAL_REGISTROS',
    'BIEN',
    'CORREGIDO',
    'MAL',
    'DUPLICADOS_ELIMINADOS',
    'NOTA',
  ];

  const rows = [];
  let totalReg = 0;
  let totalBien = 0;
  let totalCorregido = 0;
  let totalMal = 0;
  let totalDup = 0;

  for (const s of targetSummaries) {
    const sheetCorregido = Number(s.corregido ?? s.cambiado ?? 0);
    totalReg += s.rows || 0;
    totalBien += s.bien || 0;
    totalCorregido += sheetCorregido;
    totalMal += s.mal || 0;
    totalDup += s.removedDuplicates || 0;
    rows.push([
      generatedAt,
      s.sheet,
      s.rows || 0,
      s.bien || 0,
      sheetCorregido,
      s.mal || 0,
      s.removedDuplicates || 0,
      'OK',
    ]);
  }

  rows.push([
    generatedAt,
    'TOTAL',
    totalReg,
    totalBien,
    totalCorregido,
    totalMal,
    totalDup,
    reviewSummary ? `Revision: ${reviewSummary.rows || 0} registros` : 'Sin revision',
  ]);

  const outRows = [header, ...rows];
  const outCols = header.length;

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

  await clearExtraArea({
    token,
    spreadsheetId,
    sheetName,
    oldRows,
    oldCols,
    newRows: outRows.length,
    newCols: outCols,
  });

  const helperRows = [
    ['ESTADO', 'TOTAL'],
    ['BIEN', totalBien],
    ['CORREGIDO', totalCorregido],
    ['MAL', totalMal],
  ];
  const helperRange = `${sheetName}!J1:K${helperRows.length}`;
  await apiPutJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(helperRange)}?valueInputOption=USER_ENTERED`,
    token,
    {
      range: helperRange,
      majorDimension: 'ROWS',
      values: helperRows,
    }
  );

  const rowStatuses = rows.map((r) => {
    const mal = Number(r[5] || 0);
    const corregido = Number(r[4] || 0);
    if (mal > 0) return 'MAL';
    if (corregido > 0) return 'CORREGIDO';
    return 'BIEN';
  });

  const existingChartIds = await getChartIdsForSheet({
    token,
    spreadsheetId,
    sheetId: summaryProps.sheetId,
  });

  const requests = [];
  for (const chartId of existingChartIds) {
    requests.push({
      deleteEmbeddedObject: {
        objectId: chartId,
      },
    });
  }

  requests.push(...statusPaintRequests(summaryProps.sheetId, outRows.length, outCols, rowStatuses));
  requests.push(...headerStyleRequests(summaryProps.sheetId, outCols, 1));
  requests.push(...widthRequests(summaryProps.sheetId, header));
  requests.push(simpleFilterRequest(summaryProps.sheetId, outRows.length, outCols));

  if (outRows.length > 1) {
    requests.push({
      repeatCell: {
        range: {
          sheetId: summaryProps.sheetId,
          startRowIndex: 1,
          endRowIndex: outRows.length,
          startColumnIndex: 2,
          endColumnIndex: 7,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    });
  }

  const totalColumnCount = summaryProps.gridProperties?.columnCount || outCols;
  const unhideMainReq = setColumnsHiddenRequest(
    summaryProps.sheetId,
    0,
    Math.min(outCols, totalColumnCount),
    false
  );
  if (unhideMainReq) requests.push(unhideMainReq);
  const hideRestReq = setColumnsHiddenRequest(
    summaryProps.sheetId,
    outCols,
    totalColumnCount,
    true
  );
  if (hideRestReq) requests.push(hideRestReq);

  if (outRows.length >= 2) {
    const helperStartCol = 9; // J
    const helperEndCol = 11; // K + 1
    const helperStartRow = 1; // fila 2 (sin cabecera)
    const helperEndRow = 4; // fila 4 incluida (exclusive index)
    requests.push({
      addChart: {
        chart: {
          spec: {
            title: 'Estado Global de Emails',
            pieChart: {
              legendPosition: 'RIGHT_LEGEND',
              domain: {
                sourceRange: {
                  sources: [
                    {
                      sheetId: summaryProps.sheetId,
                      startRowIndex: helperStartRow,
                      endRowIndex: helperEndRow,
                      startColumnIndex: helperStartCol,
                      endColumnIndex: helperStartCol + 1,
                    },
                  ],
                },
              },
              series: {
                sourceRange: {
                  sources: [
                    {
                      sheetId: summaryProps.sheetId,
                      startRowIndex: helperStartRow,
                      endRowIndex: helperEndRow,
                      startColumnIndex: helperStartCol + 1,
                      endColumnIndex: helperEndCol,
                    },
                  ],
                },
              },
            },
          },
          position: {
            overlayPosition: {
              anchorCell: {
                sheetId: summaryProps.sheetId,
                rowIndex: 6,
                columnIndex: 0,
              },
              offsetXPixels: 8,
              offsetYPixels: 8,
              widthPixels: 520,
              heightPixels: 320,
            },
          },
        },
      },
    });
  }

  if (targetSummaries.length > 0) {
    const chartEndRowIndex = 1 + targetSummaries.length;
    requests.push({
      addChart: {
        chart: {
          spec: {
            title: 'Estado por Pestana',
            basicChart: {
              chartType: 'COLUMN',
              legendPosition: 'BOTTOM_LEGEND',
              headerCount: 1,
              axis: [
                { position: 'BOTTOM_AXIS', title: 'Pestana' },
                { position: 'LEFT_AXIS', title: 'Registros' },
              ],
              domains: [
                {
                  domain: {
                    sourceRange: {
                      sources: [
                        {
                          sheetId: summaryProps.sheetId,
                          startRowIndex: 0,
                          endRowIndex: chartEndRowIndex,
                          startColumnIndex: 1,
                          endColumnIndex: 2,
                        },
                      ],
                    },
                  },
                },
              ],
              series: [
                {
                  series: {
                    sourceRange: {
                      sources: [
                        {
                          sheetId: summaryProps.sheetId,
                          startRowIndex: 0,
                          endRowIndex: chartEndRowIndex,
                          startColumnIndex: 3,
                          endColumnIndex: 4,
                        },
                      ],
                    },
                  },
                  targetAxis: 'LEFT_AXIS',
                },
                {
                  series: {
                    sourceRange: {
                      sources: [
                        {
                          sheetId: summaryProps.sheetId,
                          startRowIndex: 0,
                          endRowIndex: chartEndRowIndex,
                          startColumnIndex: 4,
                          endColumnIndex: 5,
                        },
                      ],
                    },
                  },
                  targetAxis: 'LEFT_AXIS',
                },
                {
                  series: {
                    sourceRange: {
                      sources: [
                        {
                          sheetId: summaryProps.sheetId,
                          startRowIndex: 0,
                          endRowIndex: chartEndRowIndex,
                          startColumnIndex: 5,
                          endColumnIndex: 6,
                        },
                      ],
                    },
                  },
                  targetAxis: 'LEFT_AXIS',
                },
              ],
              stackedType: 'NOT_STACKED',
            },
          },
          position: {
            overlayPosition: {
              anchorCell: {
                sheetId: summaryProps.sheetId,
                rowIndex: 6,
                columnIndex: 6,
              },
              offsetXPixels: 8,
              offsetYPixels: 8,
              widthPixels: 560,
              heightPixels: 320,
            },
          },
        },
      },
    });
  }

  await apiPostJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    token,
    { requests }
  );

  return {
    sheet: sheetName,
    rows: rows.length,
    columns: outCols,
  };
}

async function optimizeReviewSheet({ token, spreadsheetId, sheetProps }) {
  const sheetName = REVIEW_SHEET;
  const getResp = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}!A:ZZ`,
    token
  );
  const values = getResp.values || [];
  if (values.length === 0) {
    return {
      sheet: sheetName,
      rows: 0,
      columns: 0,
    };
  }

  const oldRows = values.length;
  const oldCols = Math.max(maxCols(values), 1);
  const inHeader = values[0].slice();
  const inBody = values.slice(1).map((r) => r.slice());
  const hNorm = inHeader.map((h) => normalizeHeader(h));

  const idx = {
    fecha: hNorm.findIndex((h) => h.includes('FECHA')),
    origen: hNorm.findIndex((h) => h === 'PESTANA' || h === 'ORIGEN'),
    empresa: hNorm.findIndex((h) => h.includes('NOMBRE_ENTIDAD') || h === 'EMPRESA' || h.startsWith('NOMBRE')),
    emailOriginal: hNorm.findIndex((h) => h === 'EMAIL_ORIGINAL' || h === 'EMAIL'),
    emailNormalizado: hNorm.findIndex((h) => h === 'EMAIL_NORMALIZADO'),
    estado: hNorm.findIndex((h) => h === 'ESTADO'),
    motivo: hNorm.findIndex((h) => h === 'MOTIVO'),
    revisadoPor: hNorm.findIndex((h) => h === 'REVISADO_POR'),
  };

  const outHeader = ['FECHA', 'ORIGEN', 'EMPRESA', 'EMAIL', 'ESTADO', 'MOTIVO', 'REVISADO_POR'];
  const outBodyRaw = [];
  for (const r0 of inBody) {
    const row = ensureLen(r0, inHeader.length).map((v) => normalizeSpaces(v));
    const isEmpty = row.every((v) => !v);
    if (isEmpty) continue;

    const fecha = idx.fecha >= 0 ? row[idx.fecha] : '';
    const origen = idx.origen >= 0 ? row[idx.origen] : '';
    const empresa = idx.empresa >= 0 ? row[idx.empresa] : '';
    const emailNorm = idx.emailNormalizado >= 0 ? row[idx.emailNormalizado] : '';
    const emailOrig = idx.emailOriginal >= 0 ? row[idx.emailOriginal] : '';
    const email = emailNorm || emailOrig || '';
    const estadoRaw = idx.estado >= 0 ? row[idx.estado] : '';
    const estado = canonicalReviewStatus(estadoRaw);
    const motivo = idx.motivo >= 0 ? row[idx.motivo] : '';
    const revisadoPor = idx.revisadoPor >= 0 ? row[idx.revisadoPor] : '';
    outBodyRaw.push([fecha, origen, empresa, email, estado, motivo, revisadoPor]);
  }

  const dedup = dedupeRows(outBodyRaw, [1, 2, 3]);
  const outBody = dedup.out.sort((a, b) => {
    const rankDiff = reviewStatusRank(canonicalReviewStatus(a[4])) - reviewStatusRank(canonicalReviewStatus(b[4]));
    if (rankDiff !== 0) return rankDiff;
    const tA = Date.parse(a[0] || '') || 0;
    const tB = Date.parse(b[0] || '') || 0;
    return tB - tA;
  });
  const statuses = outBody.map((r) => canonicalReviewStatus(r[4]));
  const outRows = [outHeader, ...outBody];
  const outCols = outHeader.length;

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

  await clearExtraArea({
    token,
    spreadsheetId,
    sheetName,
    oldRows,
    oldCols,
    newRows: outRows.length,
    newCols: outCols,
  });

  const requests = [];
  requests.push(...statusPaintRequests(sheetProps.sheetId, outRows.length, outCols, statuses));
  requests.push(...headerStyleRequests(sheetProps.sheetId, outCols, 2));
  requests.push(...widthRequests(sheetProps.sheetId, outHeader));
  requests.push(simpleFilterRequest(sheetProps.sheetId, outRows.length, outCols));
  if (outRows.length > 1) {
    requests.push({
      setDataValidation: {
        range: {
          sheetId: sheetProps.sheetId,
          startRowIndex: 1,
          endRowIndex: outRows.length,
          startColumnIndex: 4,
          endColumnIndex: 5,
        },
        rule: statusValidationRule(),
      },
    });
  }

  const totalColumnCount = sheetProps.gridProperties?.columnCount || outCols;
  const unhideUsedReq = setColumnsHiddenRequest(
    sheetProps.sheetId,
    0,
    Math.min(outCols, totalColumnCount),
    false
  );
  if (unhideUsedReq) requests.push(unhideUsedReq);
  const hideUnusedReq = setColumnsHiddenRequest(
    sheetProps.sheetId,
    outCols,
    totalColumnCount,
    true
  );
  if (hideUnusedReq) requests.push(hideUnusedReq);

  await apiPostJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    token,
    { requests }
  );

  return {
    sheet: sheetName,
    rows: outBody.length,
    columns: outCols,
    removedDuplicates: dedup.removed,
  };
}

async function processTargetSheet({ token, spreadsheetId, sheetName, sheetProps }) {
  const getResp = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}!A:ZZ`,
    token
  );
  const values = getResp.values || [];
  if (values.length === 0) {
    return {
      sheet: sheetName,
      rows: 0,
      columns: 0,
      removedDuplicates: 0,
      removedTagColumn: 0,
      bien: 0,
      corregido: 0,
      mal: 0,
    };
  }

  const oldRows = values.length;
  const oldCols = Math.max(maxCols(values), 1);

  let header = values[0].slice();
  let body = values.slice(1).map((r) => r.slice());

  const removedTagColumn = removeHeaderColumns(header, body, normalizeHeader(TAG_HEADER));
  header = header.map((h) => normalizeHeader(h) === normalizeHeader(STATUS_HEADER) ? STATUS_HEADER : h);

  if (!header.some((h) => normalizeHeader(h) === normalizeHeader(STATUS_HEADER))) {
    header.push(STATUS_HEADER);
    body = body.map((r) => [...r, '']);
  }
  if (!header.some((h) => normalizeHeader(h) === normalizeHeader(MERGE_HEADER))) {
    header.push(MERGE_HEADER);
    body = body.map((r) => [...r, '']);
  }

  const order = targetColumnOrderIndices(header);
  const reordered = reorderRowsByIndices(header, body, order);
  header = reordered.header;
  body = reordered.body;

  const hNorm = header.map((h) => normalizeHeader(h));
  const idxName = hNorm.findIndex((h) => h.startsWith('NOMBRE') && !h.includes('CONTACTO'));
  const idxEmail = hNorm.findIndex((h) => h === 'EMAIL');
  const idxPhone = hNorm.findIndex((h) => h.includes('TELEFONO'));
  const idxStatus = hNorm.findIndex((h) => h === normalizeHeader(STATUS_HEADER));
  const idxMerge = hNorm.findIndex((h) => h === normalizeHeader(MERGE_HEADER));

  body = body.map((r) => ensureLen(r, header.length));
  const dedup = dedupeTargetRows(body, { idxName, idxEmail, idxPhone, idxStatus });
  body = dedup.out;

  const outRows = [header];
  const rowStatuses = [];
  let countBien = 0;
  let countCorregido = 0;
  let countMal = 0;
  for (const r0 of body) {
    const row = ensureLen(r0, header.length).map((v) => normalizeSpaces(v));
    if (idxEmail >= 0 && isSheetErrorMarker(row[idxEmail])) row[idxEmail] = 'No encontrado';
    if (idxPhone >= 0 && isSheetErrorMarker(row[idxPhone])) row[idxPhone] = 'No encontrado';
    const status = canonicalStatus(idxStatus >= 0 ? row[idxStatus] : '', idxEmail >= 0 ? row[idxEmail] : '');
    if (idxStatus >= 0) row[idxStatus] = status;
    if (status === 'BIEN') countBien++;
    else if (status === 'CORREGIDO' || status === 'CAMBIADO') countCorregido++;
    else countMal++;
    outRows.push(row);
    rowStatuses.push(status);
  }

  const outCols = header.length;
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

  await clearExtraArea({
    token,
    spreadsheetId,
    sheetName,
    oldRows,
    oldCols,
    newRows: outRows.length,
    newCols: outCols,
  });

  const requests = [];
  requests.push(...statusPaintRequests(sheetProps.sheetId, outRows.length, outCols, rowStatuses));
  requests.push(...headerStyleRequests(sheetProps.sheetId, outCols, 2));
  requests.push(...widthRequests(sheetProps.sheetId, header));
  requests.push(simpleFilterRequest(sheetProps.sheetId, outRows.length, outCols));
  if (outRows.length > 1 && idxMerge >= 0) {
    requests.push({
      setDataValidation: {
        range: {
          sheetId: sheetProps.sheetId,
          startRowIndex: 1,
          endRowIndex: outRows.length,
          startColumnIndex: idxMerge,
          endColumnIndex: idxMerge + 1,
        },
        rule: null,
      },
    });
  }
  if (outRows.length > 1 && idxStatus >= 0) {
    requests.push({
      setDataValidation: {
        range: {
          sheetId: sheetProps.sheetId,
          startRowIndex: 1,
          endRowIndex: outRows.length,
          startColumnIndex: idxStatus,
          endColumnIndex: idxStatus + 1,
        },
        rule: statusValidationRule(),
      },
    });
    requests.push({
      repeatCell: {
        range: {
          sheetId: sheetProps.sheetId,
          startRowIndex: 1,
          endRowIndex: outRows.length,
          startColumnIndex: idxStatus,
          endColumnIndex: idxStatus + 1,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
            textFormat: { bold: true },
          },
        },
        fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.bold',
      },
    });
  }
  if (outRows.length > 1 && idxPhone >= 0) {
    requests.push({
      setDataValidation: {
        range: {
          sheetId: sheetProps.sheetId,
          startRowIndex: 1,
          endRowIndex: outRows.length,
          startColumnIndex: idxPhone,
          endColumnIndex: idxPhone + 1,
        },
        rule: null,
      },
    });
    requests.push({
      repeatCell: {
        range: {
          sheetId: sheetProps.sheetId,
          startRowIndex: 1,
          endRowIndex: outRows.length,
          startColumnIndex: idxPhone,
          endColumnIndex: idxPhone + 1,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: false },
          },
        },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    });
  }
  if (outRows.length > 1 && idxMerge >= 0) {
    requests.push({
      repeatCell: {
        range: {
          sheetId: sheetProps.sheetId,
          startRowIndex: 1,
          endRowIndex: outRows.length,
          startColumnIndex: idxMerge,
          endColumnIndex: idxMerge + 1,
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    });
  }

  await apiPostJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    token,
    { requests }
  );

  return {
    sheet: sheetName,
    rows: outRows.length - 1,
    columns: outCols,
    removedDuplicates: dedup.removed,
    removedTagColumn,
    mergeStatusColumn: MERGE_HEADER,
    mergeStatusColumnPosition: idxMerge + 1,
    statusColumn: STATUS_HEADER,
    bien: countBien,
    corregido: countCorregido,
    mal: countMal,
  };
}

async function styleSimpleSheetHeader({ token, spreadsheetId, sheetName, sheetProps }) {
  const valuesResp = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetName)}!A:ZZ`,
    token
  );
  const values = valuesResp.values || [];
  const rowValues = values[0] || [];
  if (rowValues.length === 0) return false;
  const usedRows = Math.max(values.length, 1);

  const requests = [];
  requests.push(...headerStyleRequests(sheetProps.sheetId, rowValues.length, 1));
  requests.push(...widthRequests(sheetProps.sheetId, rowValues));
  requests.push(simpleFilterRequest(sheetProps.sheetId, usedRows, rowValues.length));

  await apiPostJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    token,
    { requests }
  );
  return true;
}

async function applyArtebookUpdates() {
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
  const sheetByName = {};
  for (const s of meta.sheets || []) {
    if (s.properties && s.properties.title) sheetByName[s.properties.title] = s.properties;
  }

  const summary = {
    generatedAt: nowIso,
    spreadsheetId,
    workbookTitle: meta.properties?.title || '',
    targetSheets: [],
    reviewSheet: null,
    summarySheet: null,
    headerStyleSheets: [],
  };

  for (const sheetName of TARGET_SHEETS) {
    const props = sheetByName[sheetName];
    if (!props) continue;
    const res = await processTargetSheet({
      token,
      spreadsheetId,
      sheetName,
      sheetProps: props,
    });
    summary.targetSheets.push(res);
    summary.headerStyleSheets.push(sheetName);
  }

  if (sheetByName[REVIEW_SHEET]) {
    summary.reviewSheet = await optimizeReviewSheet({
      token,
      spreadsheetId,
      sheetProps: sheetByName[REVIEW_SHEET],
    });
    summary.headerStyleSheets.push(REVIEW_SHEET);
  }

  const summaryProps = await ensureSheetExists({
    token,
    spreadsheetId,
    name: SUMMARY_SHEET,
  });
  summary.summarySheet = await updateSummarySheet({
    token,
    spreadsheetId,
    summaryProps,
    targetSummaries: summary.targetSheets,
    reviewSummary: summary.reviewSheet,
    generatedAt: nowIso,
  });
  summary.headerStyleSheets.push(SUMMARY_SHEET);

  for (const s of meta.sheets || []) {
    const title = s.properties?.title;
    if (!title) continue;
    if (TARGET_SHEETS.includes(title)) continue;
    if (title === REVIEW_SHEET) continue;
    if (title === SUMMARY_SHEET) continue;
    const ok = await styleSimpleSheetHeader({
      token,
      spreadsheetId,
      sheetName: title,
      sheetProps: s.properties,
    });
    if (ok) summary.headerStyleSheets.push(title);
  }

  const stamp = nowIso.replace(/[:.]/g, '-');
  const reportsDir = path.resolve(__dirname, '../reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outPath = path.resolve(reportsDir, `crm_artebook_update_${stamp}.json`);
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

applyArtebookUpdates().catch((err) => {
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

