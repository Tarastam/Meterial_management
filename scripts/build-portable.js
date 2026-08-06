const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const defaultOutputDirectory = path.join(projectRoot, 'dist', 'MaterialManagement-Portable');

function readOutputDirectory() {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex === -1) return defaultOutputDirectory;

  const outputArgument = process.argv[outputIndex + 1];
  if (!outputArgument) throw new Error('Missing directory after --output.');
  return path.resolve(outputArgument);
}

function ensureEmptyOutputDirectory(outputDirectory) {
  if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length > 0) {
    throw new Error(`Output directory is not empty: ${outputDirectory}`);
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
}

function copyFile(relativePath, appDirectory) {
  const sourcePath = path.join(projectRoot, relativePath);
  const destinationPath = path.join(appDirectory, relativePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyDirectory(relativePath, appDirectory) {
  fs.cpSync(path.join(projectRoot, relativePath), path.join(appDirectory, relativePath), { recursive: true });
}

function writeLauncherFiles(outputDirectory) {
  const startScript = [
    '@echo off',
    'setlocal',
    '',
    'if not exist "%~dp0app\\.env" (',
    '  call "%~dp0Configure-Material-Management.cmd"',
    '  if errorlevel 1 exit /b 1',
    ')',
    '',
    'cd /d "%~dp0app"',
    'set "PORT=8000"',
    'set "HOST=127.0.0.1"',
    'echo Starting Material Management on TCP 8000. Press Ctrl+C to stop.',
    'echo.',
    '"%~dp0runtime\\node.exe" server.js',
    'set "EXIT_CODE=%ERRORLEVEL%"',
    'echo.',
    'echo Server stopped with exit code %EXIT_CODE%.',
    'pause',
    'exit /b %EXIT_CODE%',
    '',
  ].join('\r\n');
  const configurationCommand = [
    '$settings = [ordered]@{}',
    "$settings['DB_SERVER'] = Read-Host 'SQL Server hostname or IP'",
    "$settings['DB_PORT'] = Read-Host 'SQL Server TCP port (leave blank for default)'",
    "$settings['DB_NAME'] = Read-Host 'Database name'",
    "$settings['DB_USER'] = Read-Host 'SQL Server user'",
    "$settings['DB_PASSWORD'] = Read-Host 'SQL Server password' -AsSecureString",
    "$settings['DB_INSTANCE'] = Read-Host 'SQL Server instance (leave blank for default)'",
    "$settings['DB_TRUST_SERVER_CERT'] = Read-Host 'Trust SQL Server certificate? true/false [false]'",
    "if ([string]::IsNullOrWhiteSpace($settings['DB_TRUST_SERVER_CERT'])) { $settings['DB_TRUST_SERVER_CERT'] = 'false' } else { $settings['DB_TRUST_SERVER_CERT'] = $settings['DB_TRUST_SERVER_CERT'].ToLowerInvariant() }",
    "$settings['ADMIN_PASSWORD'] = Read-Host 'New application admin password' -AsSecureString",
    "$settings['HOST'] = '127.0.0.1'",
    "$settings['COOKIE_SECURE'] = 'false'",
    "foreach ($name in @('DB_PASSWORD', 'ADMIN_PASSWORD')) { $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($settings[$name]); try { $settings[$name] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) } }",
    "foreach ($name in @('DB_SERVER', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'ADMIN_PASSWORD')) { if ([string]::IsNullOrWhiteSpace($settings[$name])) { throw ($name + ' is required.') } }",
    "if (-not [string]::IsNullOrWhiteSpace($settings['DB_PORT'])) { [int]$parsedPort = 0; if (-not [int]::TryParse($settings['DB_PORT'], [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) { throw 'DB_PORT must be a number from 1 to 65535.' } }",
    "if ($settings['DB_TRUST_SERVER_CERT'] -notin @('true', 'false')) { throw 'DB_TRUST_SERVER_CERT must be true or false.' }",
    `$lines = $settings.GetEnumerator() | ForEach-Object { if ($_.Value.Contains([Environment]::NewLine)) { throw ($_.Key + ' cannot contain a line break.') }; $escapedValue = $_.Value.Replace('\\', '\\\\').Replace('"', '\\"'); '{0}="{1}"' -f $_.Key, $escapedValue }`,
    "[System.IO.File]::WriteAllLines((Join-Path (Get-Location) '.env'), [string[]]$lines)",
    "Write-Host 'Configuration saved to app\\.env.'",
  ].join('; ');
  const configureScript = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0app"',
    'echo Configure Material Management database connection',
    'echo.',
    `powershell -NoProfile -Command "${configurationCommand}"`,
    'if errorlevel 1 (',
    '  echo [!] Configuration was not saved.',
    '  pause',
    '  exit /b 1',
    ')',
    'exit /b 0',
    '',
  ].join('\r\n');
  const firewallScript = `@echo off\r\nnet session >nul 2>&1\r\nif errorlevel 1 (\r\n  echo [!] Run this file as Administrator to add the firewall rule.\r\n  pause\r\n  exit /b 1\r\n)\r\n\r\nnetsh advfirewall firewall show rule name="Material Management 8000" >nul 2>&1\r\nif errorlevel 1 (\r\n  netsh advfirewall firewall add rule name="Material Management 8000" dir=in action=allow protocol=TCP localport=8000 profile=private remoteip=LocalSubnet\r\n) else (\r\n  echo Firewall rule already exists.\r\n)\r\npause\r\n`;
  const readme = `Material Management - Portable Deployment\r\n\r\n1. Copy this entire folder to the host PC or a trusted USB drive.\r\n2. In app\\.env, enter the SQL Server and ADMIN_PASSWORD values. Do not share this file.\r\n3. Run Start-Material-Management.cmd. Keep its window open while hosting.\r\n\r\nThe portable host uses TCP port 8000 and binds only to this computer by default. This package contains Node.js and all application dependencies. The host does not need Node.js, npm, or internet access. SQL Server must be reachable from the host PC. To expose the app to a network, place it behind HTTPS, set HOST to the desired interface, and set COOKIE_SECURE=true.\r\n`;

  fs.writeFileSync(path.join(outputDirectory, 'Start-Material-Management.cmd'), startScript, 'utf8');
  fs.writeFileSync(path.join(outputDirectory, 'Configure-Material-Management.cmd'), configureScript, 'utf8');
  fs.writeFileSync(path.join(outputDirectory, 'Setup-Firewall-8000-Admin.cmd'), firewallScript, 'utf8');
  fs.writeFileSync(path.join(outputDirectory, 'README.txt'), readme, 'utf8');
}

function buildPortablePackage() {
  const outputDirectory = readOutputDirectory();
  ensureEmptyOutputDirectory(outputDirectory);

  const appDirectory = path.join(outputDirectory, 'app');
  const runtimeDirectory = path.join(outputDirectory, 'runtime');
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });

  ['server.js', 'package.json', 'package-lock.json', '.env.example'].forEach((file) => copyFile(file, appDirectory));
  ['src', 'views', 'static', 'node_modules'].forEach((directory) => copyDirectory(directory, appDirectory));
  fs.copyFileSync(process.execPath, path.join(runtimeDirectory, 'node.exe'));
  writeLauncherFiles(outputDirectory);

  console.log(`Portable package created: ${outputDirectory}`);
}

try {
  buildPortablePackage();
} catch (error) {
  console.error(`Portable build failed: ${error.message}`);
  process.exitCode = 1;
}
