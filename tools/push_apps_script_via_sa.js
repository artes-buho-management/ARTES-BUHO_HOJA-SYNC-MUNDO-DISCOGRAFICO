const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLASP_PATH = path.join(PROJECT_ROOT, '.clasp.json');
const DEFAULT_KEY_PATH = path.resolve(__dirname, '../../../secrets/robot-codex-key-20260308-220232.json');

const PUSH_FILES = [
  'appsscript.json',
  'Code.js',
  'INSPECCION_HOJA.js',
  'CRM_AUDITORIA_MENU.js',
  'CRM_PANEL.html',
];

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

function fileTypeByName(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.js' || ext === '.gs') return 'SERVER_JS';
  if (ext === '.html') return 'HTML';
  if (ext === '.json') return 'JSON';
  throw new Error(`Tipo de archivo no soportado: ${fileName}`);
}

function buildAppsScriptFiles() {
  return PUSH_FILES.map((relativePath) => {
    const abs = path.resolve(PROJECT_ROOT, relativePath);
    const source = fs.readFileSync(abs, 'utf8');
    const ext = path.extname(relativePath);
    const name = path.basename(relativePath, ext);
    const type = fileTypeByName(relativePath);
    return { name, type, source };
  });
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

async function main() {
  const args = parseArgs(process.argv);
  const clasp = JSON.parse(fs.readFileSync(CLASP_PATH, 'utf8'));
  const scriptId = args.scriptId || clasp.scriptId;
  const keyPath = args.key || DEFAULT_KEY_PATH;
  const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

  const token = await getAccessToken(sa, ['https://www.googleapis.com/auth/script.projects']);
  const files = buildAppsScriptFiles();

  await apiPutJson(
    `https://script.googleapis.com/v1/projects/${encodeURIComponent(scriptId)}/content`,
    token,
    { scriptId, files }
  );

  const remote = await apiGetJson(
    `https://script.googleapis.com/v1/projects/${encodeURIComponent(scriptId)}/content`,
    token
  );

  const remoteNames = (remote.files || []).map((f) => `${f.name}.${f.type}`);
  console.log(
    JSON.stringify(
      {
        ok: true,
        scriptId,
        pushedFiles: files.map((f) => `${f.name}.${f.type}`),
        remoteFileCount: remoteNames.length,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
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
