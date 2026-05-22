const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SPREADSHEET_ID = 'REPLACE_WITH_SHEET_ID';
const DEFAULT_SUBJECT = 'booking@artesbuhomanagement.com';
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 15000;

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

async function getAccessToken(sa, subject, scopes) {
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
  if (subject && String(subject).trim()) {
    claims.sub = String(subject).trim();
  }

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
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await resp.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const err = new Error(`API_ERROR_${resp.status}`);
    err.status = resp.status;
    err.details = data;
    throw err;
  }
  return data;
}

function isRetryableApiError(err) {
  const status = Number(err && err.status ? err.status : 0);
  if (status === 429) return true;
  const raw = JSON.stringify((err && err.details) || {}).toUpperCase();
  return raw.includes('RATE_LIMIT_EXCEEDED') || raw.includes('RESOURCE_EXHAUSTED');
}

function sleepMs(ms) {
  const safe = Math.max(0, Number(ms || 0));
  return new Promise((resolve) => setTimeout(resolve, safe));
}

async function apiGetJsonWithRetry(url, token) {
  let lastError = null;
  let attempt = 0;
  for (attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const data = await apiGetJson(url, token);
      return { ok: true, data, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (!isRetryableApiError(err) || attempt >= RETRY_MAX_ATTEMPTS) break;
      await sleepMs(RETRY_BASE_DELAY_MS * attempt);
    }
  }
  return { ok: false, data: null, error: lastError, attempts: attempt };
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

function gridRangeToA1(range) {
  if (!range || range.startRowIndex === undefined || range.endRowIndex === undefined || range.startColumnIndex === undefined || range.endColumnIndex === undefined) {
    return null;
  }
  const sr = range.startRowIndex + 1;
  const er = range.endRowIndex;
  const sc = range.startColumnIndex + 1;
  const ec = range.endColumnIndex;
  return `${colToA1(sc)}${sr}:${colToA1(ec)}${er}`;
}

function rgbToHex(colorObj) {
  if (!colorObj) return null;
  const r = Math.round((colorObj.red || 0) * 255);
  const g = Math.round((colorObj.green || 0) * 255);
  const b = Math.round((colorObj.blue || 0) * 255);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function normBorderSide(side) {
  if (!side) return null;
  return {
    style: side.style || null,
    color: rgbToHex(side.color) || null,
  };
}

function normBorders(b) {
  if (!b) return null;
  return {
    top: normBorderSide(b.top),
    right: normBorderSide(b.right),
    bottom: normBorderSide(b.bottom),
    left: normBorderSide(b.left),
    innerHorizontal: normBorderSide(b.innerHorizontal),
    innerVertical: normBorderSide(b.innerVertical),
  };
}

function addCount(map, key) {
  if (key === null || key === undefined || key === '') return;
  map[key] = (map[key] || 0) + 1;
}

function topEntries(map, max = 20) {
  return Object.entries(map)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

function safeString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

async function inspectSpreadsheet({ keyPath, subject, spreadsheetId, outJsonPath, outMdPath }) {
  const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const scopes = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
  ];
  const token = await getAccessToken(sa, subject, scopes);

  const driveMeta = await apiGetJson(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?fields=id,name,mimeType,owners(emailAddress,displayName),permissions(id,type,role,emailAddress,domain,allowFileDiscovery)`,
    token
  );

  const workbookMeta = await apiGetJson(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false`,
    token
  );

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      method: 'ServiceAccount+SheetsAPI',
      subject,
      serviceAccount: sa.client_email,
    },
    workbook: {
      spreadsheetId: workbookMeta.spreadsheetId,
      title: workbookMeta.properties?.title || driveMeta.name || '',
      locale: workbookMeta.properties?.locale || '',
      timeZone: workbookMeta.properties?.timeZone || '',
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      sheetCount: (workbookMeta.sheets || []).length,
    },
    permissions: {
      owners: (driveMeta.owners || []).map((o) => ({ email: o.emailAddress || '', name: o.displayName || '' })),
      permissions: (driveMeta.permissions || []).map((p) => ({
        id: p.id || '',
        type: p.type || '',
        role: p.role || '',
        emailAddress: p.emailAddress || '',
        domain: p.domain || '',
        allowFileDiscovery: !!p.allowFileDiscovery,
      })),
    },
    sheets: [],
  };

  for (const s of workbookMeta.sheets || []) {
    const props = s.properties || {};
    const title = props.title || `sheet_${props.sheetId}`;
    const grid = props.gridProperties || {};

    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(title)}?majorDimension=ROWS`;
    const formulasUrl = `${valuesUrl}&valueRenderOption=FORMULA`;
    const valuesResp = await apiGetJsonWithRetry(valuesUrl, token);
    const formulasResp = await apiGetJsonWithRetry(formulasUrl, token);
    const values = valuesResp.ok ? valuesResp.data.values || [] : [];
    const formulas = formulasResp.ok ? formulasResp.data.values || [] : [];

    const usedRows = values.length;
    const usedCols = values.reduce((m, r) => Math.max(m, (r || []).length), 0);
    const fmtRows = Math.max(usedRows, 1);
    const fmtCols = Math.max(usedCols, 1);
    const formatRangeA1 = `${title}!A1:${colToA1(fmtCols)}${fmtRows}`;

    const gridResp = await apiGetJsonWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=true&ranges=${encodeURIComponent(formatRangeA1)}`,
      token
    );
    const gridPayload = gridResp.ok ? gridResp.data : {};
    const gridSheet = (gridPayload.sheets || [])[0] || {};
    const gridData = (gridSheet.data || [])[0] || {};
    const rowData = gridData.rowData || [];
    const rowMeta = gridData.rowMetadata || [];
    const colMeta = gridData.columnMetadata || [];

    const fmtCounters = {
      background: {},
      fontFamily: {},
      fontSize: {},
      bold: 0,
      italic: 0,
      hAlign: {},
      vAlign: {},
      numberFormat: {},
      border: {},
    };

    const validations = [];
    const formulaSamples = [];
    const visibleRows = [];
    const maxSampleRows = 50;
    const maxFormulaSamples = 400;
    const maxValidationSamples = 500;

    for (let r = 0; r < rowData.length; r++) {
      const rowVals = rowData[r]?.values || [];
      const visibleRow = [];
      let hasVisible = false;
      for (let c = 0; c < rowVals.length; c++) {
        const cell = rowVals[c] || {};
        const userFmt = cell.userEnteredFormat || {};
        const textFmt = userFmt.textFormat || {};
        const numberFmt = userFmt.numberFormat || {};
        const val = safeString(cell.formattedValue);
        visibleRow.push(val);
        if (val !== '') hasVisible = true;

        addCount(fmtCounters.background, rgbToHex(userFmt.backgroundColor));
        addCount(fmtCounters.fontFamily, textFmt.fontFamily || null);
        addCount(fmtCounters.fontSize, textFmt.fontSize || null);
        addCount(fmtCounters.hAlign, userFmt.horizontalAlignment || null);
        addCount(fmtCounters.vAlign, userFmt.verticalAlignment || null);
        addCount(fmtCounters.numberFormat, numberFmt.pattern || numberFmt.type || null);
        if (textFmt.bold) fmtCounters.bold++;
        if (textFmt.italic) fmtCounters.italic++;

        const borderNorm = normBorders(userFmt.borders);
        if (borderNorm) addCount(fmtCounters.border, JSON.stringify(borderNorm));

        const ue = cell.userEnteredValue || {};
        if (ue.formulaValue && formulaSamples.length < maxFormulaSamples) {
          formulaSamples.push({
            a1: `${colToA1(c + 1)}${r + 1}`,
            formula: ue.formulaValue,
          });
        }

        if (cell.dataValidation && validations.length < maxValidationSamples) {
          validations.push({
            a1: `${colToA1(c + 1)}${r + 1}`,
            rule: cell.dataValidation,
          });
        }
      }
      if (hasVisible && visibleRows.length < maxSampleRows) {
        visibleRows.push(visibleRow);
      }
    }

    const readErrors = [];
    if (!valuesResp.ok) {
      readErrors.push({
        stage: 'values',
        status: valuesResp.error && valuesResp.error.status ? valuesResp.error.status : null,
        message: valuesResp.error && valuesResp.error.message ? valuesResp.error.message : 'LECTURA_FALLIDA',
      });
    }
    if (!formulasResp.ok) {
      readErrors.push({
        stage: 'formulas',
        status: formulasResp.error && formulasResp.error.status ? formulasResp.error.status : null,
        message: formulasResp.error && formulasResp.error.message ? formulasResp.error.message : 'LECTURA_FALLIDA',
      });
    }
    if (!gridResp.ok) {
      readErrors.push({
        stage: 'gridData',
        status: gridResp.error && gridResp.error.status ? gridResp.error.status : null,
        message: gridResp.error && gridResp.error.message ? gridResp.error.message : 'LECTURA_FALLIDA',
      });
    }

    const usedRangeA1 = readErrors.length
      ? `ERROR_LECTURA_${title}`
      : usedRows > 0 && usedCols > 0
        ? `A1:${colToA1(usedCols)}${usedRows}`
        : 'A1:A1';

    report.sheets.push({
      name: title,
      sheetId: props.sheetId,
      hidden: !!props.hidden,
      structure: {
        index: props.index,
        maxRows: grid.rowCount || 0,
        maxColumns: grid.columnCount || 0,
        frozenRows: grid.frozenRowCount || 0,
        frozenColumns: grid.frozenColumnCount || 0,
        usedRows,
        usedColumns: usedCols,
        usedRangeA1,
        rowHeightsSample: rowMeta.slice(0, Math.min(100, rowMeta.length)).map((m, i) => ({ row: i + 1, pixelSize: m.pixelSize || null })),
        columnWidthsSample: colMeta.slice(0, Math.min(100, colMeta.length)).map((m, i) => ({ column: i + 1, pixelSize: m.pixelSize || null })),
      },
      dataAndFormulas: {
        visibleRowsSample: visibleRows,
        formulaSamples,
      },
      formatting: {
        backgroundsTop: topEntries(fmtCounters.background, 40),
        fontFamiliesTop: topEntries(fmtCounters.fontFamily, 40),
        fontSizesTop: topEntries(fmtCounters.fontSize, 40),
        horizontalAlignTop: topEntries(fmtCounters.hAlign, 20),
        verticalAlignTop: topEntries(fmtCounters.vAlign, 20),
        numberFormatsTop: topEntries(fmtCounters.numberFormat, 40),
        boldCount: fmtCounters.bold,
        italicCount: fmtCounters.italic,
        bordersTop: topEntries(fmtCounters.border, 40).map((e) => ({ border: JSON.parse(e.value), count: e.count })),
      },
      mergedCells: {
        count: (s.merges || []).length,
        ranges: (s.merges || []).map((m) => gridRangeToA1(m)).filter(Boolean),
      },
      dataValidations: {
        count: validations.length,
        sample: validations,
      },
      filters: {
        basicFilter: s.basicFilter
          ? {
              rangeA1: gridRangeToA1(s.basicFilter.range),
              filterSpecs: s.basicFilter.filterSpecs || [],
              sortSpecs: s.basicFilter.sortSpecs || [],
            }
          : null,
        filterViews: (s.filterViews || []).map((fv) => ({
          id: fv.filterViewId,
          title: fv.title || '',
          rangeA1: gridRangeToA1(fv.range),
          filterSpecs: fv.filterSpecs || [],
          sortSpecs: fv.sortSpecs || [],
        })),
      },
      conditionalFormatting: {
        count: (s.conditionalFormats || []).length,
        rules: (s.conditionalFormats || []).map((cf, idx) => ({
          index: idx + 1,
          ranges: (cf.ranges || []).map((r) => gridRangeToA1(r)).filter(Boolean),
          hasBooleanRule: !!cf.booleanRule,
          hasGradientRule: !!cf.gradientRule,
          booleanRule: cf.booleanRule || null,
          gradientRule: cf.gradientRule || null,
        })),
      },
      protections: {
        count: (s.protectedRanges || []).length,
        ranges: (s.protectedRanges || []).map((pr) => ({
          rangeA1: gridRangeToA1(pr.range),
          description: pr.description || '',
          warningOnly: !!pr.warningOnly,
          domainUsersCanEdit: !!(pr.editors && pr.editors.domainUsersCanEdit),
          editorsUsers: pr.editors?.users || [],
          editorsGroups: pr.editors?.groups || [],
          unprotectedRanges: (pr.unprotectedRanges || []).map((r) => gridRangeToA1(r)).filter(Boolean),
        })),
      },
      diagnostics: {
        formatRangeRequested: formatRangeA1,
        retries: {
          values: valuesResp.attempts,
          formulas: formulasResp.attempts,
          gridData: gridResp.attempts,
        },
        readErrors,
      },
    });
  }

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, JSON.stringify(report, null, 2), 'utf8');

  const md = [];
  md.push(`# Inspeccion de hoja ${report.workbook.title}`);
  md.push('');
  md.push(`- Fecha: ${report.generatedAt}`);
  md.push(`- Spreadsheet ID: ${report.workbook.spreadsheetId}`);
  md.push(`- Pestanas: ${report.workbook.sheetCount}`);
  md.push(`- Propietario principal: ${(report.permissions.owners[0] && report.permissions.owners[0].email) || 'N/D'}`);
  md.push('');
  md.push('## Resumen por pestana');
  md.push('');
  for (const sh of report.sheets) {
    const errCount = (sh.diagnostics.readErrors || []).length;
    md.push(`- ${sh.name}: usado ${sh.structure.usedRangeA1}, merges=${sh.mergedCells.count}, validaciones=${sh.dataValidations.count}, condicional=${sh.conditionalFormatting.count}, protecciones=${sh.protections.count}, filterViews=${sh.filters.filterViews.length}, erroresLectura=${errCount}`);
  }
  md.push('');
  md.push(`JSON completo: ${outJsonPath}`);

  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outMdPath, md.join('\n'), 'utf8');

  return { report, outJsonPath, outMdPath };
}

async function main() {
  const args = parseArgs(process.argv);
  const keyPath = args.key || path.resolve(__dirname, '../../../secrets/robot-codex-key-20260308-220232.json');
  const subject = args.noSubject ? '' : (args.subject || DEFAULT_SUBJECT);
  const spreadsheetId = args.spreadsheetId || DEFAULT_SPREADSHEET_ID;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outJsonPath =
    args.outJson || path.resolve(__dirname, `../reports/inspeccion_sheet_${spreadsheetId}_${stamp}.json`);
  const outMdPath =
    args.outMd || path.resolve(__dirname, `../reports/inspeccion_sheet_${spreadsheetId}_${stamp}.md`);

  const { outJsonPath: jsonOut, outMdPath: mdOut, report } = await inspectSpreadsheet({
    keyPath,
    subject,
    spreadsheetId,
    outJsonPath,
    outMdPath,
  });

  console.log(JSON.stringify({
    ok: true,
    workbook: report.workbook,
    sheets: report.sheets.map((s) => ({
      name: s.name,
      usedRangeA1: s.structure.usedRangeA1,
      validations: s.dataValidations.count,
      conditionalRules: s.conditionalFormatting.count,
      protections: s.protections.count,
      filterViews: s.filters.filterViews.length,
      readErrors: (s.diagnostics.readErrors || []).length,
    })),
    outJson: jsonOut,
    outMd: mdOut,
  }, null, 2));
}

main().catch((err) => {
  const payload = {
    ok: false,
    message: err.message || String(err),
    status: err.status || null,
    details: err.details || null,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
