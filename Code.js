const APP_META = {
  name: 'Hoja Sync 1VI74M',
  spreadsheetId: 'REPLACE_WITH_SHEET_ID',
  version: '1.0.0'
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CRM Mundo Discografico')
    .addItem('Auditar contactos de la hoja (IA)', 'crmAbrirVentanaAuditoria')
    .addItem('Autocompletado de celdas (IA)', 'crmAbrirVentanaAutocompletado')
    .addToUi();

  try {
    if (typeof crmAplicarFormatoVisualAlAbrir_ === 'function') {
      crmAplicarFormatoVisualAlAbrir_();
    }
  } catch (err) {
    console.error('Error aplicando formato visual rapido:', err);
  }
}
