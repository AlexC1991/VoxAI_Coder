/**
 * native.js — Windows native computer-use controller for VoxAI Coder.
 * Mirrors Codex's "@oai/sky" surface: list windows, build an indexed
 * accessibility (UI Automation) element tree, capture screenshots, and drive
 * input — click by element index, click by coordinate, type, press, scroll,
 * launch. The a11y tree is what lets the model "see"/target native UI elements
 * (sky-style) instead of blind coordinates.
 *
 * Implemented as a Node wrapper over a single bundled PowerShell script (the
 * dependency-free way to reach Win32 + UIA from plain Node on Windows). Falls
 * back gracefully on non-Windows / missing powershell.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Lazily instantiated singleton PS script path (written once to temp).
const PS_BODY = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CU32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowText(IntPtr h, System.Text.StringBuilder sb, int max);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$acc = [System.Windows.Automation.AutomationElement]

function Emit($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 8) }

function Ps-List {
  $items = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
    $h = $_.MainWindowHandle; $rect = New-Object CU32+RECT
    [CU32]::GetWindowRect($h, [ref]$rect) | Out-Null
    $sb = New-Object System.Text.StringBuilder 512
    [CU32]::GetWindowText($h, $sb, 512) | Out-Null
    [pscustomobject]@{ pid = $_.Id; title = $sb.ToString(); app = $_.ProcessName;
      x = $rect.L; y = $rect.T; w = ($rect.R - $rect.L); h = ($rect.B - $rect.T) }
  }
  Emit @{ ok = $true; windows = @($items) }
}

# Walk the UIA tree for a window (by pid) and produce an indexed actionable list.
function Get-A11y($Root) {
  $out = New-Object System.Collections.Generic.List[object]
  $idx = 0
  function Walk($node, $depth) {
    if ($depth -gt 40 -or $out.Count -ge 400) { return }
    $ct = $null
    try { $ct = $node.Current } catch { }
    if (-not $ct) { return }
    $cp = $node.Current.ControlType.ProgrammaticName -replace '^ControlType\.',''
    # Key: only actionable/visible leaf-ish controls
    $actRole = @('Button','Edit','ComboBox','ListItem','MenuItem','Hyperlink','CheckBox','RadioButton','TabItem','TreeItem','DataItem','Header','Text')
    $isAct = $false
    foreach ($r in $actRole) { if ($cp -like "*$r*") { $isAct = $true; break } }
    if ($isAct -and $node.Current.IsEnabled -and $node.Current.IsOffscreen -eq $false) {
      $name = $node.Current.Name
      if ($name -and $name.Trim()) {
        $rect = $node.Current.BoundingRectangle
        $out.Add([pscustomobject]@{
          index = $idx
          role = $cp
          label = ($name.Trim() | Out-String).Trim()
          x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height
        })
        $idx++
      }
    }
    $children = $null
    try { $children = $node.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return }
    if ($children) { foreach ($c in $children) { Walk $c ($depth + 1) } }
  }
  Walk $Root 0
  return $out
}

function Get-RootByPid($ThePid) {
  $p = Get-Process -Id $ThePid -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq 0) { return $null }
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
  return $el
}

function Ps-A11y {
  param([int]$TargetPid)
  $root = Get-RootByPid $TargetPid
  if (-not $root) { Emit @{ ok = $false; error = 'no window for pid' }; return }
  $els = Get-A11y $root
  # window level info
  $r = $root.Current.BoundingRectangle
  Emit @{ ok = $true; pid = $TargetPid; title = $root.Current.Name; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; elements = @($els) }
}

# Click by element index: focus + invoke the element.
function Ps-ClickElem {
  param([int]$TargetPid, [int]$Index)
  $root = Get-RootByPid $TargetPid
  if (-not $root) { Emit @{ ok = $false; error = 'no window for pid' }; return }
  $els = Get-A11y $root
  if ($Index -lt 0 -or $Index -ge $els.Count) { Emit @{ ok = $false; error = 'element index out of range' }; return }
  $e = $els[$Index]
  $f = $null
  try { $f = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $e.label) -band (New-Object System.Windows.Automation.AndCondition (
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $e.role)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $e.label)))))
  } catch { $f = $null }
  if (-not $f) {
    # fall back to bounding-rect center click
    $cx = [int]($e.x + $e.w/2); $cy = [int]($e.y + $e.h/2)
    [CU32]::SetCursorPos($cx, $cy) | Out-Null
    [CU32]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [CU32]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
    Emit @{ ok = $true; method = 'coordinate'; x = $cx; y = $cy; index = $Index }
    return
  }
  try { $p = $f.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch { $p = $null }
  if ($p) { try { $p.Invoke(); Emit @{ ok = $true; method = 'invoke'; index = $Index }; return } catch {} }
  $cx = [int]($e.x + $e.w/2); $cy = [int]($e.y + $e.h/2)
  $f.SetFocus(); [CU32]::SetCursorPos($cx, $cy) | Out-Null
  [CU32]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [CU32]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
  Emit @{ ok = $true; method = 'focus-click'; x = $cx; y = $cy; index = $Index }
}

function Ps-Shot {
  param([int]$WinPid, [string]$ShotPath)
  $x = 0; $y = 0; $w = 0; $h = 0
  if ($WinPid -gt 0) {
    $p = Get-Process -Id $WinPid -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) {
      $rect = New-Object CU32+RECT
      [CU32]::GetWindowRect($p.MainWindowHandle, [ref]$rect) | Out-Null
      $x = $rect.L; $y = $rect.T; $w = ($rect.R - $rect.L); $h = ($rect.B - $rect.T)
    }
  }
  if ($w -le 0) { $x = 0; $y = 0; $w = [System.Windows.Forms.SystemInformation]::VirtualScreen.Width; $h = [System.Windows.Forms.SystemInformation]::VirtualScreen.Height }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $bmp.Save($ShotPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Emit @{ ok = $true; path = $ShotPath; x = $x; y = $y; w = $w; h = $h }
}

function Ps-Click { param([int]$X, [int]$Y)
  [CU32]::SetCursorPos($X, $Y) | Out-Null
  [CU32]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [CU32]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
  Emit @{ ok = $true; x = $X; y = $Y }
}
function Ps-Move { param([int]$X, [int]$Y)
  [CU32]::SetCursorPos($X, $Y) | Out-Null; Emit @{ ok = $true; x = $X; y = $Y }
}
function Ps-Type { param([string]$InText)
  $ws = New-Object -ComObject WScript.Shell; $ws.SendKeys($InText); Emit @{ ok = $true; text = $InText }
}
function Ps-Press { param([string]$Key)
  $map = @{ Enter='{ENTER}'; Return='{ENTER}'; Tab='{TAB}'; Escape='{ESC}'; Esc='{ESC}'; Home='{HOME}'; End='{END}'; PageUp='{PGUP}'; PageDown='{PGDN}'; ArrowUp='{UP}'; ArrowDown='{DOWN}'; ArrowLeft='{LEFT}'; ArrowRight='{RIGHT}'; Backspace='{BACKSPACE}'; Delete='{DELETE}'; F5='{F5}'; Control='^'; Ctrl='^'; Alt='%'; Shift='+' }
  $out = ''
  foreach ($p in ($Key -split '\+' | ForEach-Object { $_.Trim() }) | Where-Object { $_ }) {
    if ($map.ContainsKey($p)) { $out += $map[$p] } elseif ($p.Length -eq 1) { $out += $p } else { $out += '{' + $p + '}' }
  }
  $ws = New-Object -ComObject WScript.Shell; $ws.SendKeys($out); Emit @{ ok = $true; key = $Key; sent = $out }
}
function Ps-Scroll { param([int]$X, [int]$Y, [int]$ScrollD)
  if ($X -ge 0 -and $Y -ge 0) { [CU32]::SetCursorPos($X, $Y) | Out-Null }
  [CU32]::mouse_event(0x0800, 0, 0, [uint32]$ScrollD, [UIntPtr]::Zero); Emit @{ ok = $true; x = $X; y = $Y; delta = $ScrollD }
}
function Ps-Launch { param([string]$FilePath, [string]$WinArgs)
  if ($WinArgs) { Start-Process -FilePath $FilePath -ArgumentList $WinArgs } else { Start-Process -FilePath $FilePath }
  Emit @{ ok = $true; path = $FilePath; args = $WinArgs }
}

$op = $args[0]; $prm = @{}
if ($args.Length -gt 1 -and $args[1]) { $prm = ($args[1] | ConvertFrom-Json) }
switch ($op) {
  'list'   { Ps-List }
  'a11y'   { Ps-A11y -TargetPid ([int]$prm.pid) }
  'cele'   { Ps-ClickElem -TargetPid ([int]$prm.pid) -Index ([int]$prm.index) }
  'shot'   { Ps-Shot -WinPid ([int]$prm.pid) -ShotPath ([string]$prm.path) }
  'click'  { Ps-Click -X ([int]$prm.x) -Y ([int]$prm.y) }
  'move'   { Ps-Move -X ([int]$prm.x) -Y ([int]$prm.y) }
  'type'   { Ps-Type -InText ([string]$prm.text) }
  'press'  { Ps-Press -Key ([string]$prm.key) }
  'scroll' { Ps-Scroll -X ([int]$prm.x) -Y ([int]$prm.y) -ScrollD ([int]$prm.delta) }
  'launch' { Ps-Launch -FilePath ([string]$prm.path) -WinArgs ([string]$prm.args) }
  default  { Emit @{ ok = $false; error = "unknown op: $op" } }
}
`;

const PS_PATH = path.join(os.tmpdir(), 'voxai-cu-native.ps1');

function ensureScript() {
  if (!fs.existsSync(PS_PATH)) fs.writeFileSync(PS_PATH, PS_BODY, 'utf8');
}
function isWindows() { return process.platform === 'win32'; }

function runScript([op, arg]) {
  if (!isWindows()) return { ok: false, error: 'native computer-use is Windows-only' };
  ensureScript();
  // re-write each run so edits take effect
  try { fs.writeFileSync(PS_PATH, PS_BODY, 'utf8'); } catch {}
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', PS_PATH, op, JSON.stringify(arg || {}),
  ], { encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };
  const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(lines[i]); if (o && typeof o === 'object') return o; } catch {}
  }
  return { ok: false, error: (r.stderr || 'native script produced no JSON').slice(0, 500) };
}

// ---- public API ----
function listWindows() { return runScript(['list', {}]); }
function buildA11y(pid) { return runScript(['a11y', { pid: pid || 0 }]); }
function clickElement(pid, index) { return runScript(['cele', { pid: pid || 0, index: index || 0 }]); }
function screenshot(pid, outPath) {
  const p = outPath || path.join(os.tmpdir(), `voxai-cu-shot-${Date.now()}.png`);
  const r = runScript(['shot', { pid: pid || 0, path: p }]);
  if (r && r.ok && fs.existsSync(p)) return { ok: true, dataUrl: 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'), path: p };
  return { ok: false, error: (r && r.error) || 'screenshot failed', raw: r };
}
function click(x, y) { return runScript(['click', { x, y }]); }
function move(x, y) { return runScript(['move', { x, y }]); }
function typeText(text) { return runScript(['type', { text }]); }
function press(key) { return runScript(['press', { key }]); }
function scroll(x, y, delta) { return runScript(['scroll', { x, y, delta }]); }
function launch(exe, args) { return runScript(['launch', { path: exe, args }]); }

module.exports = { listWindows, buildA11y, clickElement, screenshot, click, move, typeText, press, scroll, launch, isWindows, runScript };
