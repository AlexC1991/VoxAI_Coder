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
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  // Top-level windows a person can see, front to back: visible, titled, not owned
  // (dialogs and tool windows ride with their owner), and not cloaked (the hidden
  // Store-app windows Windows keeps "visible" in the background).
  public static System.Collections.Generic.List<IntPtr> TopWindows() {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, l) => {
      int cloaked = 0;
      if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && GetWindow(h, 4) == IntPtr.Zero
          && !(DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  // The window as it is drawn, without the invisible resize border GetWindowRect includes.
  public static RECT Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r);
    return r;
  }
}
"@
# Real pixels on a scaled display, so screenshots, window positions and clicks all agree.
try { [CU32]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { }
$acc = [System.Windows.Automation.AutomationElement]

function Emit($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 8) }

# Every window a person can see, front to back, with its handle. It used to be one
# window per process (MainWindowHandle), so a second Chrome or Explorer window could
# not be found at all.
function Get-Windows {
  $apps = @{}
  foreach ($h in [CU32]::TopWindows()) {
    $sb = New-Object System.Text.StringBuilder 512
    [CU32]::GetWindowText($h, $sb, 512) | Out-Null
    [uint32]$wpid = 0; [CU32]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    if (-not $apps.ContainsKey($wpid)) { $apps[$wpid] = try { [System.Diagnostics.Process]::GetProcessById([int]$wpid).ProcessName } catch { '' } }
    if ($apps[$wpid] -eq 'explorer' -and $sb.ToString() -eq 'Program Manager') { continue }   # the desktop itself
    $r = [CU32]::Frame($h)
    [pscustomobject]@{ hwnd = [int64]$h; pid = [int]$wpid; title = $sb.ToString(); app = [string]$apps[$wpid];
      x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T); minimised = [CU32]::IsIconic($h) }
  }
}
function Ps-List { Emit @{ ok = $true; windows = @(Get-Windows) } }

# The window a screenshot asks for: by handle, by part of its title or its app name
# (the frontmost match), or by process id.
function Find-Window($Prm) {
  $all = @(Get-Windows)
  if ([int64]$Prm.hwnd -ne 0) { return $all | Where-Object { $_.hwnd -eq [int64]$Prm.hwnd } | Select-Object -First 1 }
  $want = [string]$Prm.window
  if ($want) {
    $w = $want.ToLower()
    $hit = $all | Where-Object { $_.title.ToLower() -eq $w -or $_.app.ToLower() -eq $w } | Select-Object -First 1
    if (-not $hit) { $hit = $all | Where-Object { $_.title.ToLower().Contains($w) -or $_.app.ToLower().Contains($w) } | Select-Object -First 1 }
    return $hit
  }
  if ([int]$Prm.pid -gt 0) { return $all | Where-Object { $_.pid -eq [int]$Prm.pid } | Select-Object -First 1 }
  return $null
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

# Is a capture blank (all one colour)? PrintWindow gives black for the few windows
# that draw outside its reach.
function Test-Blank($Bmp) {
  $first = $Bmp.GetPixel(0, 0).ToArgb()
  for ($i = 1; $i -le 12; $i++) { for ($j = 1; $j -le 12; $j++) {
    if ($Bmp.GetPixel([int]($Bmp.Width * $i / 13), [int]($Bmp.Height * $j / 13)).ToArgb() -ne $first) { return $false } } }
  return $true
}

# One window, or the whole desktop. A window is drawn by itself (PrintWindow), so
# windows in front of it are not in the picture -- the old capture copied that part
# of the screen, and got whatever covered it.
function Ps-Shot {
  param($Prm, [string]$ShotPath)
  $asked = ([int64]$Prm.hwnd -ne 0) -or [string]$Prm.window -or ([int]$Prm.pid -gt 0)
  if ($asked) {
    $win = Find-Window $Prm
    if (-not $win) {
      $names = @(Get-Windows | Where-Object { -not $_.minimised } | Select-Object -First 15 | ForEach-Object { '"' + $_.title + '" (' + $_.app + ')' }) -join ', '
      Emit @{ ok = $false; error = "No open window matches that. Windows open now: $names" }; return
    }
    $h = [IntPtr]$win.hwnd
    if ([CU32]::IsIconic($h)) { Emit @{ ok = $false; error = ('"' + $win.title + '" is minimised, and Windows does not draw a minimised window. Ask the user to restore it, then try again.') }; return }
    $wr = New-Object CU32+RECT; [CU32]::GetWindowRect($h, [ref]$wr) | Out-Null
    $fw = $wr.R - $wr.L; $fh = $wr.B - $wr.T
    $full = New-Object System.Drawing.Bitmap $fw, $fh
    $g = [System.Drawing.Graphics]::FromImage($full)
    $hdc = $g.GetHdc()
    # PrintWindow asks the window's own thread to draw. Not for a window of the process
    # waiting on this script (VoxAI Coder itself: that thread is blocked here, and it
    # hung for the full time limit), nor for one that is not responding.
    $own = ([int]$Prm.self -gt 0 -and $win.pid -eq [int]$Prm.self)
    $hung = [CU32]::IsHungAppWindow($h)
    $printed = $false
    if (-not $own -and -not $hung) { $printed = [CU32]::PrintWindow($h, $hdc, 2) }   # PW_RENDERFULLCONTENT: GPU-drawn apps too
    $g.ReleaseHdc($hdc); $g.Dispose()
    # Crop to the window as drawn (the frame inside the invisible border).
    $cx = [Math]::Max(0, $win.x - $wr.L); $cy = [Math]::Max(0, $win.y - $wr.T)
    $cw = [Math]::Min($win.w, $fw - $cx); $ch = [Math]::Min($win.h, $fh - $cy)
    $bmp = $full.Clone((New-Object System.Drawing.Rectangle $cx, $cy, $cw, $ch), $full.PixelFormat)
    $full.Dispose()
    $method = 'window'; $note = ''
    if (-not $printed -or (Test-Blank $bmp)) {
      # Fall back to the screen, and say what that means.
      $g2 = [System.Drawing.Graphics]::FromImage($bmp)
      $g2.CopyFromScreen($win.x, $win.y, 0, 0, $bmp.Size); $g2.Dispose()
      $why = if ($own) { 'This is VoxAI Coder''s own window' } elseif ($hung) { 'This window is not responding' } else { 'This window could not draw itself' }
      $method = 'screen'; $note = $why + ', so this is the screen where it is: anything covering it is in the picture.'
    }
    $bmp.Save($ShotPath, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Emit @{ ok = $true; path = $ShotPath; x = $win.x; y = $win.y; w = $cw; h = $ch; hwnd = $win.hwnd; pid = $win.pid; title = $win.title; app = $win.app; method = $method; note = $note }
    return
  }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
  $bmp.Save($ShotPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Emit @{ ok = $true; path = $ShotPath; x = $vs.X; y = $vs.Y; w = $vs.Width; h = $vs.Height; method = 'desktop'; dpi = [CU32]::GetAwarenessFromDpiAwarenessContext([CU32]::GetThreadDpiAwarenessContext()) }
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
  'shot'   { Ps-Shot -Prm $prm -ShotPath ([string]$prm.path) }
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
/**
 * A screenshot of the desktop, or of one window: `target` is a pid, or
 * { window: "part of a title or an app name", hwnd, pid }. A window is captured on its
 * own, even with other windows in front of it. `x`, `y` say where the image's top-left
 * corner is on screen, for clicking inside it.
 */
function screenshot(target) {
  const t = typeof target === 'object' && target ? target : { pid: Number(target) || 0 };
  const p = path.join(os.tmpdir(), `voxai-cu-shot-${Date.now()}-${process.pid}.png`);
  const r = runScript(['shot', { pid: Number(t.pid) || 0, hwnd: Number(t.hwnd) || 0, window: String(t.window || ''), self: process.pid, path: p }]);
  try {
    if (r && r.ok && fs.existsSync(p)) {
      const { ok, path: _p, ...info } = r;
      return { ok: true, dataUrl: 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'), ...info };
    }
    return { ok: false, error: (r && r.error) || 'screenshot failed' };
  } finally {
    // Only the hand-off from PowerShell: every capture used to stay in Temp for good.
    try { fs.unlinkSync(p); } catch {}
  }
}
function click(x, y) { return runScript(['click', { x, y }]); }
function move(x, y) { return runScript(['move', { x, y }]); }
function typeText(text) { return runScript(['type', { text }]); }
function press(key) { return runScript(['press', { key }]); }
function scroll(x, y, delta) { return runScript(['scroll', { x, y, delta }]); }
function launch(exe, args) { return runScript(['launch', { path: exe, args }]); }

module.exports = { listWindows, buildA11y, clickElement, screenshot, click, move, typeText, press, scroll, launch, isWindows, runScript };
