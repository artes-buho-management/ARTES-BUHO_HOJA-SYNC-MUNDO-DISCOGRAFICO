const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_BASE_DELAY_MS = 20000;

function sleepMs(ms) {
  const safeMs = Math.max(0, Number(ms || 0));
  if (safeMs <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, safeMs);
}

function runStep(step) {
  const scriptPath = path.resolve(ROOT, step.script);
  const args = [scriptPath].concat(step.args || []);
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });

  return {
    name: step.name,
    script: step.script,
    args: step.args || [],
    exitCode: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    ok: res.status === 0,
  };
}

function isWritePermissionError(stepResult) {
  const text = `${stepResult.stdout}\n${stepResult.stderr}`.toUpperCase();
  return (
    text.includes('API_PUT_403') ||
    text.includes('PERMISSION_DENIED') ||
    text.includes('THE CALLER DOES NOT HAVE PERMISSION')
  );
}

function isRateLimitError(stepResult) {
  const text = `${stepResult.stdout}\n${stepResult.stderr}`.toUpperCase();
  return (
    text.includes('API_GET_429') ||
    text.includes('RESOURCE_EXHAUSTED') ||
    text.includes('RATE_LIMIT_EXCEEDED') ||
    text.includes('QUOTA EXCEEDED')
  );
}

function runStepWithRetry(step) {
  let attempt = 1;
  let result = runStep(step);
  result.attempt = attempt;

  while (!result.ok && isRateLimitError(result) && attempt < RATE_LIMIT_MAX_ATTEMPTS) {
    const waitMs = RATE_LIMIT_BASE_DELAY_MS * attempt;
    sleepMs(waitMs);
    attempt += 1;
    result = runStep(step);
    result.attempt = attempt;
  }

  return result;
}

function summarizeStep(stepResult) {
  return {
    name: stepResult.name,
    ok: stepResult.ok,
    exitCode: stepResult.exitCode,
    attempts: Number(stepResult.attempt || 1),
  };
}

function printJson(obj, useError) {
  const out = JSON.stringify(obj, null, 2);
  if (useError) console.error(out);
  else console.log(out);
}

function stepErrorType(stepResult) {
  if (isWritePermissionError(stepResult)) return 'PERMISSION';
  if (isRateLimitError(stepResult)) return 'RATE_LIMIT';
  return 'OTHER';
}

function stepErrorDetails(stepResult) {
  const raw = String(stepResult.stderr || stepResult.stdout || '').trim();
  if (!raw) return 'ERROR_DESCONOCIDO';
  return raw.slice(0, 5000);
}

function main() {
  const startedAt = new Date().toISOString();
  const summary = {
    ok: true,
    degradedMode: false,
    startedAt,
    finishedAt: '',
    mode: 'FULL_REMOTE',
    steps: [],
    recommendation: '',
  };

  const writeSteps = [
    { name: 'APLICAR_OPTIMIZACION_CRM', script: 'tools/apply_crm_artebook_updates.js' },
    { name: 'AUTOCOMPLETAR_CELDAS', script: 'tools/run_autocomplete_via_sa.js' },
    {
      name: 'PUBLICAR_LIMPIEZA_PRIORIZADA',
      script: 'tools/generate_mal_cleanup_report.js',
      args: ['--publishSheet', 'true', '--limit', '1200'],
    },
    { name: 'INSPECCION_FINAL_HOJA', script: 'tools/inspect_sheet_via_sa.js', args: ['--noSubject'] },
  ];

  const fallbackReadOnlySteps = [
    {
      name: 'AUDITORIA_MAL_SOLO_LECTURA',
      script: 'tools/generate_mal_cleanup_report.js',
      args: ['--limit', '1200'],
    },
    { name: 'INSPECCION_SOLO_LECTURA', script: 'tools/inspect_sheet_via_sa.js', args: ['--noSubject'] },
  ];

  for (let i = 0; i < writeSteps.length; i++) {
    const result = runStepWithRetry(writeSteps[i]);
    summary.steps.push(summarizeStep(result));

    if (result.ok) continue;

    if (i === 0 && isWritePermissionError(result)) {
      summary.degradedMode = true;
      summary.mode = 'READ_ONLY_FALLBACK';
      summary.writeStepError = {
        type: stepErrorType(result),
        details: stepErrorDetails(result),
      };
      summary.recommendation =
        'Dar permisos de editor al service account en la hoja y reactivar Apps Script API para publicar el script.';

      for (const fbStep of fallbackReadOnlySteps) {
        const fbResult = runStepWithRetry(fbStep);
        summary.steps.push(summarizeStep(fbResult));
        if (!fbResult.ok) {
          summary.ok = false;
          summary.finishedAt = new Date().toISOString();
          printJson(
            {
              ...summary,
              failedStep: fbStep.name,
              lastError: fbResult.stderr || fbResult.stdout || 'ERROR_DESCONOCIDO',
            },
            true
          );
          process.exit(1);
        }
      }

      summary.finishedAt = new Date().toISOString();
      printJson(summary, false);
      process.exit(0);
    }

    summary.ok = false;
    summary.finishedAt = new Date().toISOString();
    printJson(
      {
        ...summary,
        failedStep: writeSteps[i].name,
        failedStepErrorType: stepErrorType(result),
        lastError: result.stderr || result.stdout || 'ERROR_DESCONOCIDO',
      },
      true
    );
    process.exit(1);
  }

  summary.finishedAt = new Date().toISOString();
  printJson(summary, false);
}

main();
