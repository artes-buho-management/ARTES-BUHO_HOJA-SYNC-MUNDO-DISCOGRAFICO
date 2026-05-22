const CRM_CFG = {
  TARGET_SHEETS: ['DISCOGR', 'EDIT', 'DISTRI'],
  REVIEW_SHEET: 'REVISION_CORREOS',
  SUMMARY_SHEET: 'RESUMEN_CRM',
  AUDIT_SHEET: 'AUDITORIA_CONTACTOS',
  STATUS_HEADER: 'ESTADO EMAIL REVISION',
  MERGE_HEADER: 'Merge status',
  STATUS_OPTIONS: ['BIEN', 'CORREGIDO', 'MAL'],
  PANEL_TITLE: 'CRM Mundo Discografico',
  STATE_KEY: 'CRM_IA_STATE_JSON',
  LOCK_PREFIX: 'CRM_IA_LOCK_',
  JOB_HANDLER: 'crmEjecutarProcesoIAEnSegundoPlano_',
  CHUNK_SIZE: 20,
  MAX_WEB_CHECKS: 180,
  FAST_WIDTHS: [230, 260, 170, 150, 150, 220, 220, 150, 220, 260, 170, 180],
  DEV_NAME: 'RUBEN COTON',
  COMPANY: 'ARTES BUHO',
  COLORS: {
    BIEN: '#e0f2e0',
    CORREGIDO: '#dbeaf9',
    MAL: '#f9dddd',
    WHITE: '#ffffff',
    HEADER_RED: '#c62828',
    HEADER_YELLOW: '#ffcc00',
    HEADER_TEXT: '#ffffff',
  },
};

function crmAbrirVentanaAuditoria() {
  crmAbrirVentanaProceso_('AUDIT');
}

function crmAbrirVentanaAutocompletado() {
  crmAbrirVentanaProceso_('AUTOCOMPLETE');
}

function crmAbrirVentanaProceso_(mode) {
  const tpl = HtmlService.createTemplateFromFile('CRM_PANEL');
  tpl.mode = mode;
  tpl.appName = CRM_CFG.PANEL_TITLE;
  tpl.devName = CRM_CFG.DEV_NAME;
  tpl.companyName = CRM_CFG.COMPANY;

  const title = mode === 'AUTOCOMPLETE' ? 'IA Autocompletado de Celdas' : 'IA Auditoria de Contactos';
  const html = tpl.evaluate().setWidth(460).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, title);
}

function crmPanelGetEstado() {
  return crmGetState_();
}

function crmPanelIniciarDesdeVentana(mode) {
  const processMode = mode === 'AUTOCOMPLETE' ? 'AUTOCOMPLETE' : 'AUDIT';
  return crmStartProcess_(processMode);
}

function crmStartProcess_(mode) {
  const current = crmGetState_();
  if (current.status === 'RUNNING') return current;

  const jobId = 'JOB_' + String(new Date().getTime());
  const nowIso = new Date().toISOString();

  crmSaveState_(
    Object.assign(crmDefaultState_(), {
      jobId,
      mode,
      status: 'RUNNING',
      progress: 0,
      message: 'Preparando proceso IA...',
      startedAt: nowIso,
      finishedAt: '',
      error: '',
      triggerId: '',
      totalRows: 0,
      processedRows: 0,
      totalMal: 0,
      totalCorregido: 0,
      totalBien: 0,
      totalAutocompleteFilled: 0,
      totalAutocompleteNoFind: 0,
      sheets: [],
      activity: [`${nowIso} | Inicio ${mode}`],
    })
  );

  try {
    crmEnsureMergeStatusLastAll_();
    crmLockWorkbook_(jobId);
    crmSetProgress_(jobId, 2, 'Hoja bloqueada. Lanzando motor IA...', 0, 0);

    crmRemoveFunctionTriggers_(CRM_CFG.JOB_HANDLER);
    const trigger = ScriptApp.newTrigger(CRM_CFG.JOB_HANDLER).timeBased().after(1000).create();

    crmUpdateState_({
      triggerId: trigger.getUniqueId(),
      progress: 3,
      message: mode === 'AUTOCOMPLETE' ? 'Autocompletado IA en cola...' : 'Auditoria IA en cola...',
    });

    SpreadsheetApp.getActive().toast('Proceso IA iniciado. La hoja queda bloqueada temporalmente.', CRM_CFG.PANEL_TITLE, 8);
    return crmGetState_();
  } catch (err) {
    crmUnlockWorkbook_(jobId);
    crmUpdateState_({
      status: 'ERROR',
      error: String(err && err.message ? err.message : err),
      message: 'No se pudo iniciar el proceso IA.',
      finishedAt: new Date().toISOString(),
      progress: 0,
    });
    return crmGetState_();
  }
}

function crmEjecutarProcesoIAEnSegundoPlano_() {
  const state = crmGetState_();
  if (state.status !== 'RUNNING' || !state.jobId) return;

  const jobId = state.jobId;
  let result;

  try {
    if (state.mode === 'AUTOCOMPLETE') {
      crmSetProgress_(jobId, 4, 'Preparando autocompletado IA...', 0, 0);
      result = crmRunAutocompleteProcess_(jobId);
    } else {
      crmSetProgress_(jobId, 4, 'Preparando auditoria IA...', 0, 0);
      result = crmRunAuditProcess_(jobId);
    }

    crmSetProgress_(jobId, 96, 'Actualizando resumen visual...', result.totalRows || 0, result.totalRows || 0);
    const visual = crmActualizarResumenVisual_();

    crmUpdateState_({
      status: 'DONE',
      progress: 100,
      message: state.mode === 'AUTOCOMPLETE'
        ? `Autocompletado finalizado. Celdas completadas: ${result.totalAutocompleteFilled}.`
        : `Auditoria finalizada. BIEN: ${result.totalBien}, CORREGIDO: ${result.totalCorregido}, MAL: ${result.totalMal}.`,
      finishedAt: new Date().toISOString(),
      lastResult: result,
      lastVisual: visual,
      error: '',
    });

    crmAppendActivity_(jobId, 'Proceso finalizado al 100%.');
  } catch (err) {
    crmUpdateState_({
      status: 'ERROR',
      message: 'Error durante el proceso IA.',
      error: String(err && err.message ? err.message : err),
      finishedAt: new Date().toISOString(),
    });
    crmAppendActivity_(jobId, `ERROR: ${String(err && err.message ? err.message : err)}`);
  } finally {
    crmUnlockWorkbook_(jobId);
    const finalState = crmGetState_();
    crmDeleteTriggerById_(finalState.triggerId);
    crmUpdateState_({ triggerId: '' });
  }
}

function crmAplicarFormatoVisualAlAbrir_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const startedAt = Date.now();
  const maxMs = 4500;

  CRM_CFG.TARGET_SHEETS.forEach((name) => {
    if (Date.now() - startedAt > maxMs) return;
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    crmEnsureMergeStatusLast_(sh);
    crmApplyQuickVisualSheet_(sh, 2);
  });

  if (Date.now() - startedAt > maxMs) return;
  const review = ss.getSheetByName(CRM_CFG.REVIEW_SHEET);
  if (review) crmApplyQuickVisualSheet_(review, 2);

  if (Date.now() - startedAt > maxMs) return;
  const summary = ss.getSheetByName(CRM_CFG.SUMMARY_SHEET);
  if (summary) {
    crmApplyQuickVisualSheet_(summary, 1);
    crmApplySummaryWidths_(summary);
  }

  if (Date.now() - startedAt > maxMs) return;
  const ccaa = ss.getSheetByName('CCAA');
  if (ccaa) crmApplyQuickVisualSheet_(ccaa, 1);

  SpreadsheetApp.flush();
}

function crmAplicarFormatoVisualAhora() {
  crmAplicarFormatoVisualAlAbrir_();
  SpreadsheetApp.getActive().toast('Formato visual rapido aplicado.', CRM_CFG.PANEL_TITLE, 6);
}

function crmApplyQuickVisualSheet_(sheet, frozenCols) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const lastCol = Math.max(sheet.getLastColumn(), 1);

  crmApplyCorporateHeader_(sheet, lastCol);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(Math.min(frozenCols, lastCol));

  const filter = sheet.getFilter();
  if (!filter) {
    sheet.getRange(1, 1, lastRow, lastCol).createFilter();
  }

  const maxWidthCols = Math.min(lastCol, CRM_CFG.FAST_WIDTHS.length);
  for (let i = 0; i < maxWidthCols; i++) {
    sheet.setColumnWidth(i + 1, CRM_CFG.FAST_WIDTHS[i]);
  }
}

function crmEnsureMergeStatusLastAll_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  CRM_CFG.TARGET_SHEETS.forEach((name) => {
    const sh = ss.getSheetByName(name);
    if (sh) crmEnsureMergeStatusLast_(sh);
  });
}

function crmEnsureStatusColumn_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;

  const header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  const statusIdx = header.findIndex((h) => crmNormHeader_(h) === crmNormHeader_(CRM_CFG.STATUS_HEADER));
  if (statusIdx >= 0) return;

  const mergeIdx = header.findIndex((h) => crmNormHeader_(h) === crmNormHeader_(CRM_CFG.MERGE_HEADER));
  if (mergeIdx >= 0) {
    const mergeCol = mergeIdx + 1;
    sheet.insertColumnBefore(mergeCol);
    sheet.getRange(1, mergeCol, 1, 1).setValue(CRM_CFG.STATUS_HEADER);
  } else {
    sheet.insertColumnAfter(lastCol);
    sheet.getRange(1, lastCol + 1, 1, 1).setValue(CRM_CFG.STATUS_HEADER);
  }
}

function crmEnsureMergeStatusLast_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;

  const header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  const mergeIdx = header.findIndex((h) => crmNormHeader_(h) === crmNormHeader_(CRM_CFG.MERGE_HEADER));
  if (mergeIdx < 0) return;

  const mergeCol = mergeIdx + 1;
  if (mergeCol === lastCol) return;

  const fullColRange = sheet.getRange(1, mergeCol, sheet.getMaxRows(), 1);
  sheet.moveColumns(fullColRange, lastCol + 1);
}

function crmRunAuditProcess_(jobId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const nowIso = new Date().toISOString();
  const auditRows = [];
  const sheetStats = [];
  const webCache = { __count: 0 };

  let totalRows = 0;
  let totalBien = 0;
  let totalCorregido = 0;
  let totalMal = 0;
  let processedRows = 0;

  const totalRowsToProcess = CRM_CFG.TARGET_SHEETS.reduce((acc, name) => {
    const sh = ss.getSheetByName(name);
    return acc + (sh ? Math.max(sh.getLastRow() - 1, 0) : 0);
  }, 0);

  crmSetProgress_(jobId, 5, `Auditando ${totalRowsToProcess} filas...`, 0, totalRowsToProcess);
  crmAppendActivity_(jobId, `Total filas objetivo: ${totalRowsToProcess}`);

  CRM_CFG.TARGET_SHEETS.forEach((sheetName) => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    crmEnsureStatusColumn_(sheet);
    crmEnsureMergeStatusLast_(sheet);

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return;

    const header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    const col = crmGetColumnMap_(header);
    if (col.status < 0 || col.email < 0) return;

    const rowCount = lastRow - 1;
    const range = sheet.getRange(2, 1, rowCount, lastCol);
    const values = range.getDisplayValues();
    const outputValues = values.map((r) => r.slice());
    const outputBg = new Array(values.length);
    let chunkStart = 0;

    const companyToEmail = {};
    for (let i = 0; i < values.length; i++) {
      const company = crmNorm_(col.name >= 0 ? values[i][col.name] : '');
      const email = crmExtractValidEmail_(values[i][col.email]);
      if (company && email) companyToEmail[company] = email;
    }

    let bien = 0;
    let corregido = 0;
    let mal = 0;

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const sourceEmailRaw = row[col.email] || '';
      const sourceEmail = crmIsSheetErrorValue_(sourceEmailRaw) ? '' : sourceEmailRaw;
      const companyRaw = col.name >= 0 ? row[col.name] : '';
      const companyNorm = crmNorm_(companyRaw);
      const originalEmail = crmExtractValidEmail_(sourceEmail);

      if (col.email >= 0 && crmIsSheetErrorValue_(row[col.email])) {
        row[col.email] = '';
      }
      if (col.phone >= 0 && crmIsSheetErrorValue_(row[col.phone])) {
        row[col.phone] = 'No encontrado';
      }

      let finalEmail = originalEmail;
      let finalStatus = 'MAL';
      let reason = 'SIN_EMAIL';

      if (originalEmail) {
        const webCheck = crmCheckEmailInWeb_(originalEmail, webCache);
        if (webCheck.ok) {
          finalStatus = 'BIEN';
          reason = 'EMAIL_WEB_OK';
        } else {
          reason = 'EMAIL_SIN_WEB';
        }
      } else {
        reason = 'FORMATO_INVALIDO';
      }

      if (finalStatus !== 'BIEN') {
        let altEmail = '';

        if (companyNorm && companyToEmail[companyNorm]) {
          altEmail = companyToEmail[companyNorm];
        }

        if (!altEmail) {
          altEmail = crmFindAlternateEmailWeb_(companyRaw, sourceEmail, webCache, originalEmail);
        }

        if (altEmail && altEmail !== originalEmail) {
          finalEmail = altEmail;
          finalStatus = 'CORREGIDO';
          reason = 'EMAIL_ALTERNATIVO';
          if (companyNorm) companyToEmail[companyNorm] = altEmail;
        } else {
          finalStatus = 'MAL';
        }
      }

      row[col.email] = finalEmail || originalEmail || 'No encontrado';
      row[col.status] = finalStatus;
      outputValues[i] = row;

      const rowColor = crmColorByStatus_(finalStatus);
      const rowBg = [];
      for (let c = 0; c < lastCol; c++) rowBg.push(rowColor);
      outputBg[i] = rowBg;

      if (finalStatus === 'BIEN') bien++;
      else if (finalStatus === 'CORREGIDO') corregido++;
      else mal++;

      const action = finalStatus === 'MAL' ? 'REVISAR_MANUAL' : finalStatus === 'CORREGIDO' ? 'EMAIL_CORREGIDO' : 'OK';
      const link = `=HYPERLINK("#gid=${sheet.getSheetId()}&range=A${i + 2}","Ir a fila")`;

      auditRows.push([
        nowIso,
        sheetName,
        i + 2,
        companyRaw,
        row[col.email] || '',
        finalStatus,
        reason,
        'NO',
        action,
        link,
      ]);

      processedRows++;
      if (processedRows % CRM_CFG.CHUNK_SIZE === 0 || processedRows === totalRowsToProcess) {
        const chunkLen = i - chunkStart + 1;
        if (chunkLen > 0) {
          sheet.getRange(chunkStart + 2, 1, chunkLen, lastCol).setValues(outputValues.slice(chunkStart, chunkStart + chunkLen));
          sheet.getRange(chunkStart + 2, 1, chunkLen, lastCol).setBackgrounds(outputBg.slice(chunkStart, chunkStart + chunkLen));
          chunkStart = i + 1;
        }
        const ratio = totalRowsToProcess > 0 ? processedRows / totalRowsToProcess : 1;
        const pct = Math.max(5, Math.min(95, Math.floor(5 + ratio * 88)));
        crmSetProgress_(jobId, pct, `Auditando ${sheetName}: fila ${i + 2}`, processedRows, totalRowsToProcess);
        crmAppendActivity_(jobId, `${sheetName} fila ${i + 2}: ${finalStatus}`);
        SpreadsheetApp.flush();
      }
    }

    if (chunkStart < outputValues.length) {
      const chunkLen = outputValues.length - chunkStart;
      sheet.getRange(chunkStart + 2, 1, chunkLen, lastCol).setValues(outputValues.slice(chunkStart));
      sheet.getRange(chunkStart + 2, 1, chunkLen, lastCol).setBackgrounds(outputBg.slice(chunkStart));
    }

    if (col.status >= 0 && rowCount > 0) {
      const statusRange = sheet.getRange(2, col.status + 1, rowCount, 1);
      statusRange.setDataValidation(crmStatusValidationRule_());
      statusRange.setHorizontalAlignment('center').setFontWeight('bold');
    }

    if (col.phone >= 0 && rowCount > 0) {
      sheet.getRange(2, col.phone + 1, rowCount, 1).clearDataValidations().setFontWeight('normal');
    }

    crmApplyQuickVisualSheet_(sheet, 2);

    sheetStats.push({ sheet: sheetName, rows: rowCount, bien, corregido, mal });
    totalRows += rowCount;
    totalBien += bien;
    totalCorregido += corregido;
    totalMal += mal;
  });

  crmSetProgress_(jobId, 95, 'Generando hoja de auditoria...', processedRows, totalRowsToProcess);
  const auditSheet = crmEnsureSheet_(ss, CRM_CFG.AUDIT_SHEET);
  crmWriteAuditSheet_(auditSheet, auditRows);

  crmUpdateState_({
    totalRows,
    processedRows,
    totalBien,
    totalCorregido,
    totalMal,
    sheets: sheetStats,
  });

  return {
    generatedAt: nowIso,
    totalRows,
    totalBien,
    totalCorregido,
    totalMal,
    sheets: sheetStats,
  };
}

function crmRunAutocompleteProcess_(jobId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const nowIso = new Date().toISOString();
  const webCache = { __count: 0 };

  let totalRows = 0;
  let processedRows = 0;
  let totalFilled = 0;
  let totalNoFind = 0;
  const sheetStats = [];

  const rowsToProcess = CRM_CFG.TARGET_SHEETS.reduce((acc, name) => {
    const sh = ss.getSheetByName(name);
    return acc + (sh ? Math.max(sh.getLastRow() - 1, 0) : 0);
  }, 0);

  crmSetProgress_(jobId, 5, `Autocompletando ${rowsToProcess} filas...`, 0, rowsToProcess);
  crmAppendActivity_(jobId, `Total filas objetivo: ${rowsToProcess}`);

  const lookups = crmBuildCompanyLookup_();

  CRM_CFG.TARGET_SHEETS.forEach((sheetName) => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    crmEnsureStatusColumn_(sheet);
    crmEnsureMergeStatusLast_(sheet);

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return;

    const header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    const col = crmGetColumnMap_(header);
    const rowCount = lastRow - 1;
    const range = sheet.getRange(2, 1, rowCount, lastCol);
    const values = range.getDisplayValues();
    const outputValues = values.map((r) => r.slice());
    let chunkStart = 0;

    let filled = 0;
    let noFind = 0;

    for (let i = 0; i < values.length; i++) {
      const row = outputValues[i];
      const company = col.name >= 0 ? row[col.name] : '';
      const companyKey = crmNorm_(company);
      const companyBag = lookups[companyKey] || {};

      for (let c = 0; c < lastCol; c++) {
        if (c === col.merge || c === col.status) continue;

        const current = crmNormSpaces_(row[c]);
        if (current) continue;

        const head = crmNormHeader_(header[c] || '');
        let nextValue = '';

        if (companyBag[head]) {
          nextValue = companyBag[head];
        } else if (head === 'EMAIL') {
          nextValue = crmFindAlternateEmailWeb_(company, '', webCache);
        }

        if (!nextValue) {
          nextValue = 'IA NO ENCUENTRA';
          noFind++;
        } else {
          filled++;
        }

        row[c] = nextValue;
      }

      outputValues[i] = row;

      processedRows++;
      if (processedRows % CRM_CFG.CHUNK_SIZE === 0 || processedRows === rowsToProcess) {
        const chunkLen = i - chunkStart + 1;
        if (chunkLen > 0) {
          sheet.getRange(chunkStart + 2, 1, chunkLen, lastCol).setValues(outputValues.slice(chunkStart, chunkStart + chunkLen));
          chunkStart = i + 1;
        }
        const ratio = rowsToProcess > 0 ? processedRows / rowsToProcess : 1;
        const pct = Math.max(5, Math.min(95, Math.floor(5 + ratio * 88)));
        crmSetProgress_(jobId, pct, `Autocompletando ${sheetName}: fila ${i + 2}`, processedRows, rowsToProcess);
        crmAppendActivity_(jobId, `${sheetName} fila ${i + 2}: autocompletado`);
        SpreadsheetApp.flush();
      }
    }

    if (chunkStart < outputValues.length) {
      const chunkLen = outputValues.length - chunkStart;
      sheet.getRange(chunkStart + 2, 1, chunkLen, lastCol).setValues(outputValues.slice(chunkStart));
    }

    crmApplyQuickVisualSheet_(sheet, 2);

    totalRows += rowCount;
    totalFilled += filled;
    totalNoFind += noFind;
    sheetStats.push({ sheet: sheetName, rows: rowCount, filled, noFind });
  });

  crmUpdateState_({
    totalRows,
    processedRows,
    totalAutocompleteFilled: totalFilled,
    totalAutocompleteNoFind: totalNoFind,
    sheets: sheetStats,
  });

  return {
    generatedAt: nowIso,
    totalRows,
    totalAutocompleteFilled: totalFilled,
    totalAutocompleteNoFind: totalNoFind,
    sheets: sheetStats,
  };
}

function crmBuildCompanyLookup_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const bag = {};

  CRM_CFG.TARGET_SHEETS.forEach((sheetName) => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return;

    const header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    const col = crmGetColumnMap_(header);

    values.forEach((row) => {
      const company = crmNorm_(col.name >= 0 ? row[col.name] : '');
      if (!company) return;
      if (!bag[company]) bag[company] = {};

      for (let c = 0; c < lastCol; c++) {
        if (c === col.merge || c === col.status) continue;
        const head = crmNormHeader_(header[c] || '');
        const value = crmNormSpaces_(row[c]);
        if (value && !crmIsPlaceholderValue_(value) && !bag[company][head]) {
          bag[company][head] = value;
        }
      }
    });
  });

  return bag;
}

function crmExtractValidEmail_(text) {
  const raw = String(text || '').toLowerCase();
  const match = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  if (!match) return '';
  return match[0];
}

function crmCheckEmailInWeb_(email, cache) {
  const domain = crmExtractDomain_(email);
  if (!domain) return { ok: false };
  const key = `WEB_${domain}`;

  if (cache[key]) return cache[key];

  const count = Number(cache.__count || 0);
  if (count >= CRM_CFG.MAX_WEB_CHECKS) {
    const limited = { ok: false, skipped: true };
    cache[key] = limited;
    return limited;
  }

  cache.__count = count + 1;

  const urls = [`https://${domain}`, `http://${domain}`];
  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], {
        muteHttpExceptions: true,
        followRedirects: true,
        validateHttpsCertificates: false,
      });
      const code = resp.getResponseCode();
      const ok = (code >= 200 && code < 400) || code === 401 || code === 403;
      if (ok) {
        const out = { ok: true };
        cache[key] = out;
        return out;
      }
      // Intentamos siguiente URL alternativa (http/https) antes de dar por fallido.
      if (code >= 400 && code < 500) continue;
    } catch (err) {
      // seguimos con la siguiente URL
    }
  }

  const fail = { ok: false };
  cache[key] = fail;
  return fail;
}

function crmFindAlternateEmailWeb_(company, sourceEmail, cache, currentEmail) {
  const current = crmExtractValidEmail_(currentEmail || sourceEmail);

  const directDomain = crmExtractDomain_(sourceEmail);
  if (directDomain) {
    const foundFromDomain = crmScrapeEmailFromDomain_(directDomain, cache);
    if (foundFromDomain && foundFromDomain !== current) return foundFromDomain;
  }

  const cleanCompany = crmNormSpaces_(company).replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  if (!cleanCompany) return '';

  const slug = cleanCompany
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 3)
    .join('');

  if (!slug) return '';

  const candidates = [`${slug}.com`, `${slug}.es`, `${slug}.net`];
  for (let i = 0; i < candidates.length; i++) {
    const found = crmScrapeEmailFromDomain_(candidates[i], cache);
    if (found && found !== current) return found;
  }

  return '';
}

function crmScrapeEmailFromDomain_(domain, cache) {
  if (!domain) return '';
  const key = `SCRAPE_${domain}`;
  if (cache[key]) return cache[key];

  const count = Number(cache.__count || 0);
  if (count >= CRM_CFG.MAX_WEB_CHECKS) {
    cache[key] = '';
    return '';
  }

  cache.__count = count + 1;
  const paths = ['', '/contacto', '/contact', '/about', '/sobre-nosotros'];

  for (let i = 0; i < paths.length; i++) {
    const url = `https://${domain}${paths[i]}`;
    try {
      const resp = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        validateHttpsCertificates: false,
      });
      const code = resp.getResponseCode();
      if (code < 200 || code >= 500) continue;

      const html = String(resp.getContentText() || '').toLowerCase();
      const match = html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
      if (match && match[0]) {
        cache[key] = match[0];
        return match[0];
      }
    } catch (err) {
      // continuamos
    }
  }

  cache[key] = '';
  return '';
}

function crmGetColumnMap_(header) {
  const norm = header.map((h) => crmNormHeader_(h));
  let status = norm.findIndex((h) => h === crmNormHeader_(CRM_CFG.STATUS_HEADER));

  if (status < 0) {
    status = norm.length - 1;
  }

  return {
    name: norm.findIndex((h) => h.indexOf('NOMBRE') === 0 && h.indexOf('CONTACTO') === -1),
    email: norm.findIndex((h) => h === 'EMAIL'),
    phone: norm.findIndex((h) => h.indexOf('TELEFONO') >= 0),
    status,
    merge: norm.findIndex((h) => h === crmNormHeader_(CRM_CFG.MERGE_HEADER)),
  };
}

function crmApplyCorporateHeader_(sheet, colCount) {
  const rg = sheet.getRange(1, 1, 1, colCount);
  rg.setBackground(CRM_CFG.COLORS.HEADER_RED)
    .setFontColor(CRM_CFG.COLORS.HEADER_TEXT)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setBorder(true, true, true, true, true, true, CRM_CFG.COLORS.HEADER_YELLOW, SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeight(1, 34);
}

function crmApplySummaryWidths_(sheet) {
  const widths = [180, 130, 170, 110, 140, 110, 220, 260];
  for (let i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
}

function crmApplyAuditWidths_(sheet) {
  const widths = [170, 110, 110, 240, 260, 120, 230, 110, 190, 130];
  for (let i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
}

function crmStatusValidationRule_() {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(CRM_CFG.STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
}

function crmColorByStatus_(status) {
  const s = crmNormHeader_(status);
  if (s === 'BIEN') return CRM_CFG.COLORS.BIEN;
  if (s === 'CORREGIDO' || s === 'CAMBIADO') return CRM_CFG.COLORS.CORREGIDO;
  return CRM_CFG.COLORS.MAL;
}

function crmEnsureSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function crmNormSpaces_(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function crmNorm_(value) {
  return crmNormSpaces_(value).toLowerCase();
}

function crmIsSheetErrorValue_(value) {
  const raw = crmNormSpaces_(value).toUpperCase();
  return raw.indexOf('#ERROR') === 0 || raw.indexOf('#N/A') === 0 || raw.indexOf('#REF') === 0;
}

function crmIsPlaceholderValue_(value) {
  const raw = crmNormHeader_(value);
  return raw === 'IA NO ENCUENTRA' || raw === 'NO ENCONTRADO' || raw === 'N/A' || raw === 'NA';
}

function crmNormHeader_(value) {
  return crmNormSpaces_(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function crmExtractDomain_(email) {
  const v = crmNormSpaces_(email).toLowerCase();
  const parts = v.split('@');
  if (parts.length !== 2) return '';
  return parts[1].trim();
}

function crmActualizarResumenVisual() {
  const visual = crmActualizarResumenVisual_();
  SpreadsheetApp.getActive().toast('Resumen visual actualizado.', CRM_CFG.PANEL_TITLE, 6);
  return visual;
}

function crmActualizarResumenVisual_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const nowIso = new Date().toISOString();
  const rows = [];

  let totalRows = 0;
  let totalBien = 0;
  let totalCorregido = 0;
  let totalMal = 0;

  CRM_CFG.TARGET_SHEETS.forEach((sheetName) => {
    const sh = ss.getSheetByName(sheetName);
    if (!sh) return;
    crmEnsureStatusColumn_(sh);
    crmEnsureMergeStatusLast_(sh);

    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return;

    const header = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    const col = crmGetColumnMap_(header);
    if (col.status < 0) return;

    const statuses = sh.getRange(2, col.status + 1, lastRow - 1, 1).getDisplayValues();
    let bien = 0;
    let corregido = 0;
    let mal = 0;

    statuses.forEach((s) => {
      const val = crmNormHeader_(s[0] || '');
      if (val === 'BIEN') bien++;
      else if (val === 'CORREGIDO' || val === 'CAMBIADO') corregido++;
      else mal++;
    });

    rows.push([nowIso, sheetName, statuses.length, bien, corregido, mal, 0, 'OK']);
    totalRows += statuses.length;
    totalBien += bien;
    totalCorregido += corregido;
    totalMal += mal;
  });

  rows.push([nowIso, 'TOTAL', totalRows, totalBien, totalCorregido, totalMal, 0, `App: ${CRM_CFG.COMPANY}`]);

  const sheet = crmEnsureSheet_(ss, CRM_CFG.SUMMARY_SHEET);
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

  const values = [header].concat(rows);
  sheet.clear();
  sheet.getRange(1, 1, values.length, header.length).setValues(values);
  crmApplyQuickVisualSheet_(sheet, 1);
  crmApplySummaryWidths_(sheet);

  const charts = sheet.getCharts();
  charts.forEach((chart) => sheet.removeChart(chart));

  const helperRow = values.length + 2;
  sheet.getRange(helperRow, 1, 4, 2).setValues([
    ['ESTADO', 'TOTAL'],
    ['BIEN', totalBien],
    ['CORREGIDO', totalCorregido],
    ['MAL', totalMal],
  ]);

  const pie = sheet
    .newChart()
    .asPieChart()
    .addRange(sheet.getRange(helperRow, 1, 4, 2))
    .setPosition(7, 1, 0, 0)
    .setOption('title', 'Estado Global de Emails')
    .setOption('legend.position', 'right')
    .build();
  sheet.insertChart(pie);

  const rowEnd = 1 + CRM_CFG.TARGET_SHEETS.length;
  if (rowEnd >= 2) {
    const bar = sheet
      .newChart()
      .asColumnChart()
      .addRange(sheet.getRange(`B1:B${rowEnd}`))
      .addRange(sheet.getRange(`D1:F${rowEnd}`))
      .setPosition(7, 8, 0, 0)
      .setOption('title', 'Estado por Pestana')
      .setOption('legend.position', 'bottom')
      .build();
    sheet.insertChart(bar);
  }

  if (sheet.getMaxColumns() > 8) {
    sheet.showColumns(1, 8);
    sheet.hideColumns(9, sheet.getMaxColumns() - 8);
  }

  return { totalRows, totalBien, totalCorregido, totalMal };
}

function crmWriteAuditSheet_(sheet, rows) {
  const header = [
    'FECHA_ANALISIS_UTC',
    'PESTANA',
    'FILA_ORIGINAL',
    'EMPRESA',
    'EMAIL',
    'ESTADO',
    'MOTIVO',
    'DUPLICADO',
    'ACCION',
    'IR_A_FILA',
  ];

  const sorted = rows.slice().sort((a, b) => {
    const rankA = crmStatusRank_(a[5]);
    const rankB = crmStatusRank_(b[5]);
    if (rankA !== rankB) return rankA - rankB;
    const tab = String(a[1]).localeCompare(String(b[1]));
    if (tab !== 0) return tab;
    return Number(a[2]) - Number(b[2]);
  });

  const values = [header].concat(sorted);
  sheet.clear();
  sheet.getRange(1, 1, values.length, header.length).setValues(values);

  crmApplyQuickVisualSheet_(sheet, 2);
  crmApplyAuditWidths_(sheet);

  if (sorted.length > 0) {
    const bgs = sorted.map((r) => {
      const color = crmColorByStatus_(r[5]);
      const row = [];
      for (let c = 0; c < header.length; c++) row.push(color);
      return row;
    });
    sheet.getRange(2, 1, sorted.length, header.length).setBackgrounds(bgs);
  }

  if (sheet.getMaxColumns() > header.length) {
    sheet.showColumns(1, header.length);
    sheet.hideColumns(header.length + 1, sheet.getMaxColumns() - header.length);
  }
}

function crmStatusRank_(status) {
  const s = crmNormHeader_(status);
  if (s === 'MAL') return 0;
  if (s === 'CORREGIDO' || s === 'CAMBIADO') return 1;
  return 2;
}

function crmDefaultState_() {
  return {
    jobId: '',
    mode: 'AUDIT',
    status: 'IDLE',
    progress: 0,
    message: 'Esperando inicio.',
    error: '',
    startedAt: '',
    finishedAt: '',
    triggerId: '',
    totalRows: 0,
    processedRows: 0,
    totalMal: 0,
    totalCorregido: 0,
    totalBien: 0,
    totalAutocompleteFilled: 0,
    totalAutocompleteNoFind: 0,
    sheets: [],
    activity: [],
  };
}

function crmGetState_() {
  const raw = PropertiesService.getDocumentProperties().getProperty(CRM_CFG.STATE_KEY);
  if (!raw) return crmDefaultState_();
  try {
    return Object.assign(crmDefaultState_(), JSON.parse(raw));
  } catch (err) {
    return crmDefaultState_();
  }
}

function crmSaveState_(state) {
  PropertiesService.getDocumentProperties().setProperty(CRM_CFG.STATE_KEY, JSON.stringify(state));
  return state;
}

function crmUpdateState_(patch) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(5000);
  try {
    const current = crmGetState_();
    const next = Object.assign({}, current, patch || {});
    return crmSaveState_(next);
  } finally {
    lock.releaseLock();
  }
}

function crmSetProgress_(jobId, progress, message, processedRows, totalRows) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(5000);
  try {
    const current = crmGetState_();
    if (current.jobId !== jobId || current.status !== 'RUNNING') return current;

    const next = Object.assign({}, current, {
      progress: Math.max(0, Math.min(100, Number(progress || 0))),
      message: String(message || current.message || ''),
      processedRows: processedRows === undefined ? Number(current.processedRows || 0) : Number(processedRows),
      totalRows: totalRows === undefined ? Number(current.totalRows || 0) : Number(totalRows),
    });

    return crmSaveState_(next);
  } finally {
    lock.releaseLock();
  }
}

function crmAppendActivity_(jobId, message) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(5000);
  try {
    const current = crmGetState_();
    if (current.jobId !== jobId) return current;

    const list = Array.isArray(current.activity) ? current.activity.slice(-30) : [];
    const now = new Date().toISOString();
    list.push(`${now} | ${message}`);

    return crmSaveState_(Object.assign({}, current, { activity: list.slice(-35) }));
  } finally {
    lock.releaseLock();
  }
}

function crmLockWorkbook_(jobId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const me = Session.getEffectiveUser().getEmail();
  const tag = CRM_CFG.LOCK_PREFIX + jobId;

  ss.getSheets().forEach((sheet) => {
    const p = sheet.protect().setDescription(`${tag}_${sheet.getName()}`);
    p.setWarningOnly(false);

    try {
      const editors = p.getEditors();
      if (editors && editors.length) p.removeEditors(editors);
    } catch (err) {
      // Ignorado.
    }

    if (me) {
      try {
        p.addEditor(me);
      } catch (err) {
        // Ignorado.
      }
    }

    try {
      if (p.canDomainEdit()) p.setDomainEdit(false);
    } catch (err) {
      // Ignorado.
    }
  });
}

function crmUnlockWorkbook_(jobId) {
  if (!jobId) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tag = CRM_CFG.LOCK_PREFIX + jobId;

  ss.getSheets().forEach((sheet) => {
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    protections.forEach((p) => {
      const desc = String(p.getDescription() || '');
      if (desc.indexOf(tag) === 0) {
        try {
          p.remove();
        } catch (err) {
          // Ignorado.
        }
      }
    });
  });
}

function crmRemoveFunctionTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function crmDeleteTriggerById_(triggerId) {
  if (!triggerId) return;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getUniqueId && t.getUniqueId() === triggerId) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// Compatibilidad con funciones anteriores
function crmEjecutarAnalisisCompleto() {
  return crmStartProcess_('AUDIT');
}

function crmEjecutarAuditoriaContactos() {
  return crmStartProcess_('AUDIT');
}
