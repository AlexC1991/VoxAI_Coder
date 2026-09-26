// Builds resources/uia/voxai-uia.exe from native/VoxUia.cs with the C# compiler that ships with Windows
// (.NET Framework 4, C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe): nothing to download.
//   node scripts/build-uia.js
// Skipped (with a note) when not on Windows or the compiler is missing: desktop control then works from
// screenshots and coordinates only, without the list of a window's controls. Ported from Byte (Desktop3D).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'native', 'VoxUia.cs');
const OUT_DIR = path.join(ROOT, 'resources', 'uia');
const OUT = path.join(OUT_DIR, 'voxai-uia.exe');
const FW = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const CSC = path.join(FW, 'csc.exe');

if (process.platform !== 'win32' || !fs.existsSync(CSC)) {
  console.log('build-uia: no .NET Framework C# compiler here, skipping (desktop control works without the control list)');
  process.exit(0);
}
if (fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs > fs.statSync(SRC).mtimeMs) {
  console.log('build-uia: up to date');
  process.exit(0);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
// --strict (release builds): a helper that could not be rebuilt must not ship. Otherwise (npm start) a
// helper still held by a running copy of the app is kept, with a note, instead of failing the start.
const strict = process.argv.includes('--strict');
try {
  execFileSync(CSC, [
    '/nologo', '/optimize+', '/platform:anycpu', '/target:exe', `/out:${OUT}`,
    `/r:${path.join(FW, 'WPF', 'UIAutomationClient.dll')}`, `/r:${path.join(FW, 'WPF', 'UIAutomationTypes.dll')}`,
    `/r:${path.join(FW, 'WPF', 'WindowsBase.dll')}`, `/r:${path.join(FW, 'System.Web.Extensions.dll')}`,
    SRC,
  ], { stdio: 'inherit' });
} catch (e) {
  if (strict || !fs.existsSync(OUT)) throw e;
  console.log('build-uia: the helper is in use (VoxAI Coder is running), so the existing one is kept -- close the app and start again to rebuild');
  process.exit(0);
}
console.log(`build-uia: built ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
