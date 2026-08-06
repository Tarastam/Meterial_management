const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const buildScript = path.join(projectRoot, 'scripts', 'build-portable.js');
const databaseModule = path.join(projectRoot, 'src', 'db.js');

test('build-portable creates a self-contained Windows launcher', () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'material-management-portable-'));

  try {
    execFileSync(process.execPath, [buildScript, '--output', outputDirectory], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    assert.ok(fs.existsSync(path.join(outputDirectory, 'app', 'server.js')));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'app', 'node_modules', 'express')));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'runtime', 'node.exe')));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'Start-Material-Management.cmd')));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'Configure-Material-Management.cmd')));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'Setup-Firewall-8000-Admin.cmd')));
    assert.ok(fs.existsSync(path.join(outputDirectory, 'app', '.env.example')));
    assert.match(fs.readFileSync(path.join(outputDirectory, 'Start-Material-Management.cmd'), 'utf8'), /set "PORT=8000"/);
    assert.match(fs.readFileSync(path.join(outputDirectory, 'Start-Material-Management.cmd'), 'utf8'), /set "HOST=127\.0\.0\.1"/);
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test('server refuses to start without required deployment settings', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      DB_SERVER: '',
      DB_NAME: '',
      DB_USER: '',
      DB_PASSWORD: '',
      ADMIN_PASSWORD: '',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required environment settings: DB_SERVER, DB_NAME, DB_USER, DB_PASSWORD, ADMIN_PASSWORD/);
});

test('schema provisions indexes for transaction history and usage calculation logs', () => {
  const schemaSource = fs.readFileSync(databaseModule, 'utf8');

  assert.match(schemaSource, /IX_issue_entries_active_material_date_id/);
  assert.match(schemaSource, /WHERE voided = 0/);
});
