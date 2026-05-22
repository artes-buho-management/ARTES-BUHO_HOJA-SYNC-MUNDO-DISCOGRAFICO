# CRM IA - MUNDO DISCOGRAFICO

Aplicacion Apps Script vinculada a la hoja:
`https://docs.google.com/spreadsheets/d/REPLACE_WITH_SHEET_ID/edit`

## Identidad del proyecto
- Empresa: **ARTES BUHO**
- Desarrollador: **RUBEN COTON**
- Objetivo: auditoria IA de contactos + autocompletado IA de celdas, con trazabilidad visual en tiempo real.

## Funcionalidades principales
- Menu superior `CRM Mundo Discografico` con 2 acciones:
  1. `Auditar contactos de la hoja (IA)`
  2. `Autocompletado de celdas (IA)`
- Ventana emergente futurista con:
  - progreso en vivo de `0%` a `100%`
  - mensajes de estado en tiempo real
  - log de actividad en tiempo real
- Bloqueo temporal de la hoja mientras se ejecuta un proceso IA.
- Desbloqueo automatico al terminar o al fallar.
- Formato visual rapido al abrir la hoja (disenado para ser ligero).

## Reglas de auditoria de email
La auditoria SIEMPRE sobreescribe el estado previo y recalcula por fila:
- `BIEN`: email valido y dominio comprobado en web.
- `MAL`: email invalido o sin alternativa.
- `CORREGIDO`: se encuentra email alternativo valido.

Validacion web (version robusta):
- `200-399`, `401` y `403` se consideran dominio accesible.
- `404` ya NO se considera valido para marcar `BIEN`.

Color de fila completo:
- `BIEN` -> verde
- `MAL` -> rojo
- `CORREGIDO` -> azul

## Regla critica de columnas
- `Merge status` debe ser siempre la **ultima columna**.
- El contenido de `Merge status` **no se modifica** (uso reservado para YAMM/emailing).

## Reglas de autocompletado IA
- Rellena celdas vacias usando:
  - datos existentes por empresa en el CRM
  - busqueda web basica para email alternativo
- Si no encuentra informacion: escribe `IA NO ENCUENTRA`.

## Regla de deduplicado (auditoria profunda)
- Deduplicado inteligente en `DISCOGR`, `EDIT`, `DISTRI`.
- Clave principal: `NOMBRE + EMAIL` (normalizado).
- Clave secundaria: `NOMBRE + TELEFONO` cuando falta email.
- Si hay conflicto, se conserva la fila de mayor calidad de datos.

## Archivos clave
- `Code.js`: menu y trigger `onOpen`.
- `CRM_AUDITORIA_MENU.js`: motor principal IA (auditoria, autocompletado, progreso, bloqueo, resumen).
- `CRM_PANEL.html`: UI emergente futurista con progreso/log en tiempo real.
- `INSPECCION_HOJA.js`: inspeccion integral.

## Flujo tecnico resumido
1. Usuario lanza una accion desde menu.
2. Se abre ventana modal y arranca proceso IA.
3. Se guarda estado global en `DocumentProperties`.
4. Se crea trigger temporal en segundo plano.
5. El proceso actualiza hoja y estado en tiempo real.
6. La UI consulta estado periodicamente y refleja progreso.
7. Al final, actualiza resumen, libera bloqueo y elimina trigger temporal.

## Comandos utiles
- `npm install`
- `npm run gas:push`
- `npm run gas:pull`
- `npm run gas:status`
- `npm run inspect:sheet`
- `node tools/push_apps_script_via_sa.js`
- `node tools/run_autocomplete_via_sa.js`
- `node tools/generate_mal_cleanup_report.js`
- `node tools/generate_mal_cleanup_report.js --publishSheet true --limit 1200`
- `powershell -ExecutionPolicy Bypass -File .\publish_sync.ps1`

## Publicacion del Script (modo robusto)
- Si `clasp push` falla por reautenticacion (`invalid_rapt`), usar:
  - `node tools/push_apps_script_via_sa.js`
- Requisito para ese modo:
  - la cuenta/robot debe tener activada Apps Script API.

## Flujo remoto recomendado (auditoria profunda)
1. `node tools/apply_crm_artebook_updates.js`
2. `node tools/run_autocomplete_via_sa.js`
3. `node tools/generate_mal_cleanup_report.js --publishSheet true --limit 1200`
4. `node tools/inspect_sheet_via_sa.js --noSubject`

Atajo con un solo comando:
- `npm run crm:remote:all`

### Comportamiento inteligente del atajo remoto
- `crm:remote:all` usa `tools/remote_audit_orchestrator.js`.
- Si detecta error de permisos de escritura (`API_PUT_403`), activa modo degradado:
  1. genera auditoria profunda en solo lectura;
  2. ejecuta inspeccion completa de hoja;
  3. devuelve recomendacion clara de permisos.

## Nota de rendimiento
Para mantener apertura rapida de hoja:
- el formateo automatico en `onOpen` es ligero (sin recorridos masivos profundos);
- los procesos pesados se ejecutan solo cuando el usuario pulsa un boton IA.

## CIERRE MIGRACION CLOUD

- Fecha: 2026-04-08
- Estado: preparado para retomar desde nuevo sistema


## CIERRE CLOUD 2026-04-08
- Estado: sincronizado para migracion a nuevo PC/sistema.
- Preparado para retomar desde GitHub.
- Ultima revision: 2026-04-08 15:26:05 +02:00

<!-- MIGRACION_CLOUD_START -->
## ESTADO MIGRACION CLOUD
- Revisado: 2026-04-08
- Repo listo para continuar en otro sistema.
- Estado Git al cerrar: sincronizado en GitHub.
<!-- MIGRACION_CLOUD_END -->
