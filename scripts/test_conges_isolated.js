'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 3347);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tala-conges-'));
const dbPath = path.join(tempDir, 'smi-test.db');
const logPath = path.join(tempDir, 'server.log');

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(port),
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  DB_DRIVER: 'sqlite',
  DB_PATH: dbPath,
  TEST_BASE_URL: `http://127.0.0.1:${port}/api`,
};

let server;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealth() {
  const url = `${env.TEST_BASE_URL}/health`;

  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {
      // serveur pas encore prêt
    }

    await sleep(250);
  }

  throw new Error(`Serveur non disponible sur ${url}`);
}

function runNode(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd: root,
      env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${file} terminé avec le code ${code}`));
    });
  });
}

async function stopServer() {
  if (!server || server.killed) return;

  server.kill('SIGTERM');

  await Promise.race([
    new Promise(resolve => server.once('exit', resolve)),
    sleep(3000),
  ]);

  if (!server.killed) server.kill('SIGKILL');
}

async function main() {
  const log = fs.openSync(logPath, 'a');

  server = spawn(process.execPath, ['backend/server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', log, log],
  });

  server.on('exit', code => {
    if (code && code !== 0) {
      console.error(`Serveur de test arrêté avec le code ${code}`);
    }
  });

  await waitForHealth();
  await runNode('tests/conges_full_test.js');

  console.log(`Test congés isolé réussi. Base temporaire : ${dbPath}`);
}

main()
  .catch(error => {
    console.error(error.stack || error.message);

    if (fs.existsSync(logPath)) {
      console.error('\n--- Logs serveur ---');
      console.error(fs.readFileSync(logPath, 'utf8'));
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();

    if (process.exitCode !== 1) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      console.error(`Artefacts conservés pour diagnostic : ${tempDir}`);
    }
  });
