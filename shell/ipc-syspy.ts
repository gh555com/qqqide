// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
//
// ipc-syspy.ts — 系统解释器机器（设置面板「系统解释器」行：Node / Python 两按钮后端）
//
// ★ 双目标（2026-09-26）：
//   python：把 .py 关联一次性指向绿色包内置 Python（双击 = python -i，跑完窗口不关）
//   node：把 .js 关联一次性指向「引擎同源 Node 门面」（engines/node/node.exe[win] / engines/node/node[mac]，
//     = Electron 的 ELECTRON_RUN_AS_NODE；双击 = cmd 包裹 + pause，跑完窗口不关；零下载零维护）
//
// ★ 双平台（2026-09-26）：
//   win32：把 .py/.js 关联一次性指向内置解释器，只管当：
//     ① HKCU\Software\Classes（Python.File 命令 + .py 默认值）
//     ② UserChoice：hash 强写（Deny ACL 突破 → 写 ProgId + 重算 hash，防跨分钟重试）
//     ③ HKCU PATH 前置内置 Python 目录（去重后置顶——WindowsApps 假存根恒被压后）
//     ④ AssocQueryString 验证；失败逐级回退：旧版 hash → 删 UserChoice → 清 FileExts 遗留（Win7）→ UAC 写 HKLM
//     ⑤ .pyw 第二遍（Python.NoConFile + pythonw，无控制台，与 python.org 官方语义一致）；成功后 SHChangeNotify 通知外壳立即刷新
//   darwin：osacompile 生成 Launcher.app（{hostDir}/syspy/qqqide-syspy.app）→ lsregister 注册
//     → LSSetDefaultRoleHandlerForContentType 设默认 → NSWorkspace 回读验证；双击 .py
//     → Launcher on open → run.sh → Terminal 窗口 → 内置 Python -i（跑完窗口不关）。
//     免管理员/无 UAC；PATH 前置 ~/.zprofile（bash 用户 ~/.bash_profile）；
//     runner 钉清单稳定路径 bin/python3（symlink）——引擎目录内升级不断链。
// 只管当：不维护、不追搬迁；用户再点一次 = 幂等刷新重写。
// hash 算法 = Windows UserChoice 公开逆向格式（1803+ 主版 + 1507 旧版回退）。
//
// PS2.0 兼容（Win7 出厂）：不用 ConvertTo-Json，输出 QQQIDE_SYSPY_* 行协议；
// 脚本经 stdin（-Command -）传入，全程 ASCII，零临时脚本文件（UAC 兜底除外）。
//
// IPC：qqqide:syspy:check / qqqide:syspy:apply → preload bridge.sysPy

import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getComponentBin } from './component-checker';
import { getHostDir } from './portable-paths';

// ── PS 脚本（公共头：C# 算法 + 辅助函数） ──
const PS_HEAD = String.raw`
$ErrorActionPreference = 'Continue'
$mode = $env:QQQIDE_SYSPY_MODE
$exe  = $env:QQQIDE_SYSPY_EXE
$dir  = $env:QQQIDE_SYSPY_DIR
$ext = $env:QQQIDE_SYSPY_EXT
if (-not $ext) { $ext = '.py' }
$progId = $env:QQQIDE_SYSPY_PROGID
if (-not $progId) { $progId = 'Python.File' }
$flags = $env:QQQIDE_SYSPY_FLAGS
if ($null -eq $flags) { $flags = '-i' }
if ($flags -eq 'none') { $flags = '' }
$match = $env:QQQIDE_SYSPY_MATCH
if (-not $match) { $match = 'python' }
$wrap = $env:QQQIDE_SYSPY_WRAP
if ($null -eq $wrap) { $wrap = '' }
$ucPath = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext + '\UserChoice'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function OutKV([string]$k, [string]$v) { Write-Output ('QQQIDE_SYSPY_' + $k + '=' + $v) }
function B64([string]$s) { if ($null -eq $s) { $s = '' }; return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public static class QS {
  static uint WordSwap(uint v) { return (v >> 16) | (v << 16); }
  public static string HashString(string inputString) {
    byte[] inputBytes = Encoding.Unicode.GetBytes(inputString + "\0");
    int blockCount = inputBytes.Length / 8;
    if (blockCount == 0) return null;
    byte[] md5;
    using (MD5 m = MD5.Create()) md5 = m.ComputeHash(inputBytes);
    uint m0 = BitConverter.ToUInt32(md5, 0);
    uint m1 = BitConverter.ToUInt32(md5, 4);
    uint[][] C0s = new uint[][] {
      new uint[] { m0 | 1, 0xCF98B111u, 0x87085B9Fu, 0x12CEB96Du, 0x257E1D83u },
      new uint[] { m1 | 1, 0xA27416F5u, 0xD38396FFu, 0x7C932B89u, 0xBFA49F69u }
    };
    uint[][] C1s = new uint[][] {
      new uint[] { m0 | 1, 0xEF0569FBu, 0x689B6B9Fu, 0x79F8A395u, 0xC3EFEA97u },
      new uint[] { m1 | 1, 0xC31713DBu, 0xDDCD1F0Fu, 0x59C3AF2Du, 0x35BD1EC9u }
    };
    uint h0 = 0, h1 = 0, h0Acc = 0, h1Acc = 0;
    for (int i = 0; i < blockCount; i++) {
      for (int j = 0; j < 2; j++) {
        uint[] C0 = C0s[j]; uint[] C1 = C1s[j];
        uint input = BitConverter.ToUInt32(inputBytes, (i * 2 + j) * 4);
        h0 += input;
        h0 *= C0[0];
        h0 = WordSwap(h0) * C0[1];
        h0 = WordSwap(h0) * C0[2];
        h0 = WordSwap(h0) * C0[3];
        h0 = WordSwap(h0) * C0[4];
        h0Acc += h0;
        h1 += input;
        h1 = WordSwap(h1) * C1[1] + h1 * C1[0];
        h1 = (h1 >> 16) * C1[2] + h1 * C1[3];
        h1 = WordSwap(h1) * C1[4] + h1;
        h1Acc += h1;
      }
    }
    byte[] outb = new byte[8];
    BitConverter.GetBytes(h0 ^ h1).CopyTo(outb, 0);
    BitConverter.GetBytes(h0Acc ^ h1Acc).CopyTo(outb, 4);
    return Convert.ToBase64String(outb);
  }
  // v1 (1803+): ext + sid + progId + %08lx hi + %08lx lo (minute-truncated) + UE string
  public static string FmtV1(string ext, string sid, string progId, long ft) {
    long f = (ft / 600000000L) * 600000000L;
    return (ext + sid + progId + ((uint)((ulong)f >> 32)).ToString("x8") + ((uint)((ulong)f & 0xFFFFFFFFu)).ToString("x8")
      + "User Choice set via Windows User Experience {D18B6DD5-6124-4341-9318-804003BAFA0B}").ToLowerInvariant();
  }
  // v0 (Win10 1507 legacy): ext + sid + progId (no timestamp, no UE string)
  public static string FmtV0(string ext, string sid, string progId) {
    return (ext + sid + progId).ToLowerInvariant();
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  public static extern int RegQueryInfoKey(IntPtr hKey, IntPtr a, IntPtr b, IntPtr c, IntPtr d, IntPtr e, IntPtr f, IntPtr g, IntPtr h, IntPtr i, IntPtr j, out long ft);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  public static extern int AssocQueryString(int flags, int str, string assoc, string extra, StringBuilder outBuf, ref int outLen);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
  public static void BroadcastEnv() {
    UIntPtr res;
    SendMessageTimeoutW(new IntPtr(0xFFFF), 0x1A, IntPtr.Zero, "Environment", 2, 3000, out res);
  }
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);
  public static void NotifyAssocChanged() {
    SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
  }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'QS').Type) { OutKV 'OK' '0'; OutKV 'CODE' 'ps-init-failed'; exit 0 }

function Get-KeyFT([string]$p) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p)
  if (-not $k) { return [long]0 }
  $ft = [long]0
  $rc = [QS]::RegQueryInfoKey($k.Handle.DangerousGetHandle(), [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$ft)
  $k.Close()
  if ($rc -ne 0) { return [long]0 }
  return $ft
}
function Get-AssocCmd([string]$e) {
  $sb = New-Object System.Text.StringBuilder 4096
  $n = 4096
  $rc = [QS]::AssocQueryString(0, 1, $e, 'open', $sb, [ref]$n)
  if ($rc -ne 0) { return '' }
  return $sb.ToString()
}
function Read-Value([string]$p, [string]$name) {
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p)
    if ($k) { $v = $k.GetValue($name); $k.Close(); if ($null -ne $v) { return [string]$v } }
  } catch { }
  return ''
}
# UserChoice write handle: direct open -> ACL bypass (remove Deny-SELF SetValue) -> reopen
function Open-UcWrite() {
  try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ucPath, $true); if ($k) { return $k } } catch { }
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ucPath, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [System.Security.AccessControl.RegistryRights]::ChangePermissions)
    if ($k) {
      $acl = $k.GetAccessControl('Access')
      $removed = 0
      foreach ($ace in @($acl.Access)) {
        if ($ace.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) {
          $acl.RemoveAccessRuleSpecific($ace) | Out-Null
          $removed++
        }
      }
      if ($removed -gt 0) { $k.SetAccessControl($acl) }
      $k.Close()
    }
  } catch { }
  try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ucPath, $true); if ($k) { return $k } } catch { }
  return $null
}
`;

// ── 模式主体 ──
const PS_BODY = String.raw`
if ($mode -eq 'check') {
  $exeOk = $false
  if ($exe -and (Test-Path $exe)) { $exeOk = $true }
  $aq = Get-AssocCmd $ext
  $ucProgId = Read-Value $ucPath 'ProgId'
  $clsCmd = Read-Value ('Software\Classes\' + $progId + '\shell\open\command')
  $pathRaw = ''
  try {
    $ek = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    if ($ek) { $pathRaw = [string]$ek.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $ek.Close() }
  } catch { }
  $hasPathPy = $false
  foreach ($p in ($pathRaw -split ';')) { if ($p -match ('(?i)' + $match)) { $hasPathPy = $true } }
  $aqHasOurs = $false
  if ($exeOk -and $aq -ne '') { $aqHasOurs = $aq.ToLower().Contains($exe.ToLower()) }
  $hasAny = ($aq -ne '') -or ($ucProgId -ne '') -or ($clsCmd -ne '') -or $hasPathPy
  $code = 'none'
  if ($aqHasOurs) { $code = 'ours' } elseif ($hasAny) { $code = 'other' }
  OutKV 'OK' '1'
  OutKV 'CODE' $code
  OutKV 'EXE_OK' $(if ($exeOk) { '1' } else { '0' })
  OutKV 'AQ' (B64 $aq)
  exit 0
}

if ($mode -eq 'apply') {
  # 0. bundled python existence
  if (-not ($exe -and (Test-Path $exe))) { OutKV 'OK' '0'; OutKV 'CODE' 'no-python'; exit 0 }
  $mid = ''
  if ($flags -ne '') { $mid = ' ' + $flags }
  $cmdline = '"' + $exe + '"' + $mid + ' "%1" %*'
  # node wrapper: cmd /c + pause (keeps the output window open after the run; node -i does not drop to REPL after a script)
  if ($wrap -eq 'pause') { $cmdline = 'cmd.exe /d /s /c "' + '"' + $exe + '"' + $mid + ' "%1" %* & pause"' }

  # 1. HKCU\Software\Classes (backup old -> write)
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\' + $progId + '\shell\open\command')
  $oldCmd = [string]$k.GetValue(''); $k.SetValue('', $cmdline, 'String'); $k.Close()
  OutKV 'OLD_CLASSES_CMD' (B64 $oldCmd)
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\' + $progId + '\DefaultIcon')
    $k.SetValue('', ('"' + $exe + '",0'), 'String'); $k.Close()
  } catch { }
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\' + $ext)
  $oldPy = [string]$k.GetValue(''); $k.SetValue('', $progId, 'String'); $k.Close()
  OutKV 'OLD_PY_DEFAULT' (B64 $oldPy)

  # 2. UserChoice (backup -> write handle [with bypass] -> touch -> hash v1, minute retry)
  $oldProgId = Read-Value $ucPath 'ProgId'
  $oldHash = Read-Value $ucPath 'Hash'
  OutKV 'OLD_UC_PROGID' (B64 $oldProgId)
  OutKV 'OLD_UC_HASH' (B64 $oldHash)
  $k = Open-UcWrite
  if (-not $k) { try { $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ucPath) } catch { } }
  if (-not $k) { OutKV 'OK' '0'; OutKV 'CODE' 'denied'; exit 0 }
  $k.SetValue('ProgId', $progId, 'String')
  $k.Close()
  $vc = 'v1'
  $hOk = $false
  for ($i = 0; $i -lt 4; $i++) {
    $ft = Get-KeyFT $ucPath
    $h = [QS]::HashString([QS]::FmtV1($ext, $sid, $progId, $ft))
    $k = Open-UcWrite
    if (-not $k) { break }
    $k.SetValue('Hash', $h, 'String')
    $k.Close()
    $ft2 = Get-KeyFT $ucPath
    $h2 = [QS]::HashString([QS]::FmtV1($ext, $sid, $progId, $ft2))
    if ($h2 -eq $h) { $hOk = $true; break }
    $k = Open-UcWrite
    if (-not $k) { break }
    $k.SetValue('ProgId', $progId, 'String')
    $k.Close()
  }
  if (-not $hOk) { $vc = 'v1-retry-fail' }

  # 3. HKCU PATH prepend (dedupe -> front; idempotent)
  $pathRaw = ''
  $pathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  try {
    $ek = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if (-not $ek) { $ek = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
    $pathRaw = [string]$ek.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    try { $pathKind = $ek.GetValueKind('Path') } catch { }
    if ($pathKind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString -and $pathKind -ne [Microsoft.Win32.RegistryValueKind]::String) { $pathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    OutKV 'OLD_PATH' (B64 $pathRaw)
    if ($dir) {
      $parts = @()
      foreach ($p in ($pathRaw -split ';')) {
        $t = $p.Trim()
        if ($t -eq '') { continue }
        if ($t.TrimEnd('\') -ieq $dir.TrimEnd('\')) { continue }
        $parts += $t
      }
      $newPath = $dir
      if ($parts.Count -gt 0) { $newPath = $dir + ';' + ($parts -join ';') }
      if ($newPath -ne $pathRaw) { $ek.SetValue('Path', $newPath, $pathKind) }
    }
    $ek.Close()
  } catch { }
  [QS]::BroadcastEnv()

  # 4. verify (AssocQueryString contains bundled python.exe) -> fallback ladder
  $exeLower = $exe.ToLower()
  $aq = Get-AssocCmd $ext
  $pass = ($aq -ne '') -and ($aq.ToLower().Contains($exeLower))

  if (-not $pass) {
    # fallback 1: legacy hash (Win8 / early Win10)
    $vc = 'v0'
    $k = Open-UcWrite
    if ($k) {
      $k.SetValue('ProgId', $progId, 'String')
      $k.Close()
      $h0 = [QS]::HashString([QS]::FmtV0($ext, $sid, $progId))
      $k = Open-UcWrite
      if ($k) { $k.SetValue('Hash', $h0, 'String'); $k.Close() }
    }
    $aq = Get-AssocCmd $ext
    $pass = ($aq -ne '') -and ($aq.ToLower().Contains($exeLower))
  }

  if (-not $pass) {
    # fallback 2: delete UserChoice (Classes chain takes over, no hash check)
    $vc = 'nouc'
    try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($ucPath) } catch { }
    $aq = Get-AssocCmd $ext
    $pass = ($aq -ne '') -and ($aq.ToLower().Contains($exeLower))
  }

  if (-not $pass) {
    # fallback 2.5: legacy per-user carriers (Win7 era) under FileExts\{ext} - drop legacy Application value
    $vc = 'fex'
    $fxPath = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext
    try {
      $fk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($fxPath, $true)
      if ($fk) {
        $appv = [string]$fk.GetValue('Application')
        OutKV 'OLD_FEX_APP' (B64 $appv)
        if ($appv -ne '') { $fk.DeleteValue('Application', $false) }
        $fk.Close()
      }
    } catch { }
    try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($fxPath + '\Application') } catch { }
    $aq = Get-AssocCmd $ext
    $pass = ($aq -ne '') -and ($aq.ToLower().Contains($exeLower))
  }

  if (-not $pass) {
    # fallback 3: UAC -> HKLM (machine-wide assoc incl. default value + OpenWithProgids)
    $vc = 'hklm'
    $tmpReg = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('qqqide-syspy-' + $PID + '.reg'))
    $esc = $cmdline.Replace('\', '\\').Replace('"', '\"')
    $crlf = [string][char]13 + [string][char]10
    $q = [string][char]34
    $regText = 'Windows Registry Editor Version 5.00' + $crlf + $crlf + '[HKEY_LOCAL_MACHINE\Software\Classes\' + $progId + '\shell\open\command]' + $crlf + '@=' + $q + $esc + $q + $crlf + $crlf + '[HKEY_LOCAL_MACHINE\Software\Classes\' + $ext + ']' + $crlf + '@=' + $q + $progId + $q + $crlf + $crlf + '[HKEY_LOCAL_MACHINE\Software\Classes\' + $ext + '\OpenWithProgids]' + $crlf + $q + $progId + $q + '=hex(0):' + $crlf
    $regText | Out-File -FilePath $tmpReg -Encoding Unicode
    $uacOk = $false
    try {
      $uac = Start-Process -FilePath 'reg.exe' -ArgumentList @('import', ('"' + $tmpReg + '"')) -Verb RunAs -Wait -PassThru
      if ($uac -and $uac.ExitCode -eq 0) { $uacOk = $true }
    } catch { $uacOk = $false }
    Remove-Item $tmpReg -ErrorAction SilentlyContinue
    if (-not $uacOk) { OutKV 'OK' '0'; OutKV 'CODE' 'uac-cancelled'; exit 0 }
    [QS]::BroadcastEnv()
    $aq = Get-AssocCmd $ext
    $pass = ($aq -ne '') -and ($aq.ToLower().Contains($exeLower))
  }

  if ($pass) { [QS]::NotifyAssocChanged() }

  OutKV 'OK' $(if ($pass) { '1' } else { '0' })
  OutKV 'CODE' $(if ($pass) { 'ok' } else { 'verify-failed' })
  OutKV 'VIA' $vc
  OutKV 'AQ' (B64 $aq)
  exit 0
}

if ($mode -eq 'remove') {
  # Pure uninstall: clear our footprint back to a blank state. One-shot trade: NO restore of old values.
  $exeLower = ''
  if ($exe) { $exeLower = $exe.ToLower() }
  $dirNorm = ''
  if ($dir) { $dirNorm = $dir.TrimEnd('\') }
  $clean = ''
  # 1) UserChoice: delete key (DACL-bypass retry); if still undeletable, clear ProgId+Hash (invalid hash = system ignores it)
  $ucGone = $false
  try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($ucPath); $ucGone = $true } catch { }
  if (-not $ucGone) {
    $k = Open-UcWrite
    if ($k) {
      $k.Close()
      try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($ucPath); $ucGone = $true } catch { }
    }
  }
  if ($ucGone) { $clean = $clean + 'uc;' }
  else {
    $k = Open-UcWrite
    if ($k) {
      try { $k.DeleteValue('ProgId', $false) } catch { }
      try { $k.DeleteValue('Hash', $false) } catch { }
      $k.Close()
      $clean = $clean + 'uc-clr;'
    }
  }
  # 2) HKCU Classes: our command/icon values (fingerprint) + ext default (== progId) + own progId tree (qqqide.*)
  $cmdKey = 'Software\Classes\' + $progId + '\shell\open\command'
  $cur = Read-Value $cmdKey ''
  if (($exeLower -ne '') -and ($cur -ne '') -and $cur.ToLower().Contains($exeLower)) {
    try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($cmdKey, $true); if ($k) { $k.DeleteValue('', $false); $k.Close(); $clean = $clean + 'cmd;' } } catch { }
  }
  $diKey = 'Software\Classes\' + $progId + '\DefaultIcon'
  $curIcon = Read-Value $diKey ''
  if (($exeLower -ne '') -and ($curIcon -ne '') -and $curIcon.ToLower().Contains($exeLower)) {
    try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($diKey, $true); if ($k) { $k.DeleteValue('', $false); $k.Close(); $clean = $clean + 'icon;' } } catch { }
  }
  $curDef = Read-Value ('Software\Classes\' + $ext) ''
  if ($curDef -eq $progId) {
    try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes\' + $ext, $true); if ($k) { $k.DeleteValue('', $false); $k.Close(); $clean = $clean + 'ext;' } } catch { }
  }
  if ($progId.StartsWith('qqqide.')) {
    try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\Classes\' + $progId); $clean = $clean + 'prog;' } catch { }
  }
  # 3) FileExts Application leftover (fingerprint)
  $fxKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext
  $fxApp = Read-Value $fxKey 'Application'
  if (($exeLower -ne '') -and ($fxApp -ne '') -and $fxApp.ToLower().Contains($exeLower)) {
    try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($fxKey, $true); if ($k) { $k.DeleteValue('Application', $false); $k.Close(); $clean = $clean + 'fex;' } } catch { }
  }
  # 4) PATH: drop entries equal to our dir
  if ($dirNorm -ne '') {
    try {
      $ek = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      if ($ek) {
        $pathRaw2 = [string]$ek.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kind2 = [Microsoft.Win32.RegistryValueKind]::ExpandString
        try { $kind2 = $ek.GetValueKind('Path') } catch { }
        if ($kind2 -ne [Microsoft.Win32.RegistryValueKind]::ExpandString -and $kind2 -ne [Microsoft.Win32.RegistryValueKind]::String) { $kind2 = [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $parts2 = @()
        $hit2 = 0
        foreach ($p2 in ($pathRaw2 -split ';')) {
          $t2 = $p2.Trim()
          if ($t2 -eq '') { continue }
          if ($t2.TrimEnd('\') -ieq $dirNorm) { $hit2++; continue }
          $parts2 = $parts2 + $t2
        }
        if ($hit2 -gt 0) { $ek.SetValue('Path', ($parts2 -join ';'), $kind2); $clean = $clean + 'path;' }
        $ek.Close()
      }
    } catch { }
  }
  [QS]::BroadcastEnv()
  # 5) HKLM leftovers (apply's UAC path wrote them; only when fingerprint present)
  $mkKey = 'Software\Classes\' + $progId + '\shell\open\command'
  $hklmCmd = ''
  try { $mk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($mkKey); if ($mk) { $hklmCmd = [string]$mk.GetValue(''); $mk.Close() } } catch { }
  if (($exeLower -ne '') -and ($hklmCmd -ne '') -and $hklmCmd.ToLower().Contains($exeLower)) {
    $hklmOk = $false
    try {
      $mk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($mkKey, $true)
      if ($mk) { $mk.DeleteValue('', $false); $mk.Close(); $hklmOk = $true }
    } catch { }
    if ($hklmOk) {
      try {
        $mk2 = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('Software\Classes\' + $ext, $true)
        if ($mk2) {
          $v2 = [string]$mk2.GetValue('')
          if ($v2 -eq $progId) { $mk2.DeleteValue('', $false) }
          $mk2.Close()
        }
      } catch { }
      try {
        $mk3 = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('Software\Classes\' + $ext + '\OpenWithProgids', $true)
        if ($mk3) {
          if ($mk3.GetValue($progId) -ne $null) { $mk3.DeleteValue($progId, $false) }
          $mk3.Close()
        }
      } catch { }
    } else {
      $tmpReg2 = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('qqqide-syspy-rm-' + $PID + '.reg'))
      $crlf2 = [string][char]13 + [string][char]10
      $q3 = [string][char]34
      $regText2 = 'Windows Registry Editor Version 5.00' + $crlf2 + $crlf2 + '[HKEY_LOCAL_MACHINE\Software\Classes\' + $progId + '\shell\open\command]' + $crlf2 + '@=-' + $crlf2 + $crlf2 + '[HKEY_LOCAL_MACHINE\Software\Classes\' + $ext + '\OpenWithProgids]' + $crlf2 + $q3 + $progId + $q3 + '=-' + $crlf2
      $mkExtDef = ''
      try { $mkExt = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('Software\Classes\' + $ext); if ($mkExt) { $mkExtDef = [string]$mkExt.GetValue(''); $mkExt.Close() } } catch { }
      if ($mkExtDef -eq $progId) { $regText2 = $regText2 + $crlf2 + '[HKEY_LOCAL_MACHINE\Software\Classes\' + $ext + ']' + $crlf2 + '@=-' + $crlf2 }
      $regText2 | Out-File -FilePath $tmpReg2 -Encoding Unicode
      try {
        $uac2 = Start-Process -FilePath 'reg.exe' -ArgumentList @('import', ('"' + $tmpReg2 + '"')) -Verb RunAs -Wait -PassThru
        if ($uac2 -and $uac2.ExitCode -eq 0) { $hklmOk = $true }
      } catch { $hklmOk = $false }
      Remove-Item $tmpReg2 -ErrorAction SilentlyContinue
    }
    if ($hklmOk) { $clean = $clean + 'hklm;' }
    else { OutKV 'OK' '0'; OutKV 'CODE' 'uac-cancelled'; OutKV 'CLEANED' $clean; exit 0 }
  }
  [QS]::NotifyAssocChanged()
  OutKV 'OK' '1'
  OutKV 'CODE' 'ok'
  OutKV 'CLEANED' $clean
  exit 0
}

OutKV 'OK' '0'
OutKV 'CODE' 'bad-mode'
exit 0
`;

// ── PS 执行（异步，行协议解析） ──
interface PsResult {
    ok: boolean;
    fields: Record<string, string>;
    raw: string;
}

function runPs(script: string, env: Record<string, string>, timeoutMs: number): Promise<PsResult> {
    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
                env: { ...process.env, ...env } as NodeJS.ProcessEnv,
                windowsHide: true,
            });
        } catch (e: any) {
            resolve({ ok: false, fields: { CODE: 'spawn-failed', ERR: String(e && e.message || e) }, raw: '' });
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill(); } catch { /* ignore */ }
            resolve({ ok: false, fields: { CODE: 'timeout' }, raw: stdout + '\n' + stderr });
        }, timeoutMs);
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        child.on('error', (e: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, fields: { CODE: 'spawn-failed', ERR: String(e && e.message || e) }, raw: '' });
        });
        child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const fields: Record<string, string> = {};
            for (const line of stdout.split(/\r?\n/)) {
                const m = /^QQQIDE_SYSPY_([A-Z0-9_]+)=(.*)$/.exec(line.trim());
                if (m) fields[m[1]] = m[2];
            }
            if (!fields.CODE && stderr) fields.ERR = stderr.slice(0, 400);
            resolve({ ok: fields.OK === '1', fields, raw: stdout + '\n' + stderr });
        });
        try { child.stdin.write(script); child.stdin.end(); } catch { /* ignore */ }
    });
}

function b64d(v: string | undefined): string {
    if (!v) return '';
    try { return Buffer.from(v, 'base64').toString('utf8'); } catch { return ''; }
}

// ── Node 门面（静态资产 engines/node/，随引擎发布；win=node.exe C 小启动器 / mac=node sh 脚本）──
//   门面本体把调用转交本包 Electron（ELECTRON_RUN_AS_NODE=1）——零下载、离线可用、与 IDE 同源（Node 16）、Win7-11 全覆盖
function resolveEnginesRoot(portableRoot: string): string | null {
    try {
        const pyBin = getComponentBin(portableRoot, 'python');
        if (!pyBin) return null;
        let root = path.dirname(pyBin);
        root = path.dirname(root);                                     // win: engines/python -> engines
        if (process.platform === 'darwin') root = path.dirname(root);  // mac: engines/python/bin -> engines
        return root;
    } catch { return null; }
}

function nodeFacadePath(portableRoot: string): string | null {
    const root = resolveEnginesRoot(portableRoot);
    if (!root) return null;
    return path.join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
}

function nodeEnv(facade: string, ext: string): Record<string, string> {
    return {
        QQQIDE_SYSPY_EXE: facade,
        QQQIDE_SYSPY_DIR: path.dirname(facade),
        QQQIDE_SYSPY_EXT: ext,
        QQQIDE_SYSPY_PROGID: 'qqqide.NodeScript',
        QQQIDE_SYSPY_FLAGS: 'none',
        QQQIDE_SYSPY_MATCH: 'node',
        QQQIDE_SYSPY_WRAP: 'pause',
    };
}

// Windows node apply：门面预检 → sidecar（目标 = 运行中的 Electron 本体，搬迁失效回退相对路径）→
// PS 主通（.js）→ .mjs/.cjs 尽力而为 → 首写备份（sysnode-backup.json）
async function winNodeApply(portableRoot: string): Promise<{ ok: boolean; code: string; via?: string }> {
    const facade = nodeFacadePath(portableRoot);
    if (!facade || !fs.existsSync(facade)) return { ok: false, code: 'no-node' };
    try { fs.writeFileSync(path.join(path.dirname(facade), 'node-target.txt'), process.execPath + '\n', 'utf8'); } catch { /* 容错 */ }
    const r = await runPs(PS_HEAD + PS_BODY, { ...nodeEnv(facade, '.js'), QQQIDE_SYSPY_MODE: 'apply' }, 300000);
    for (const ext of ['.mjs', '.cjs']) {
        try { await runPs(PS_HEAD + PS_BODY, { ...nodeEnv(facade, ext), QQQIDE_SYSPY_MODE: 'apply' }, 300000); } catch { /* 尽力而为 */ }
    }
    try {
        const bakPath = path.join(portableRoot, 'Data', 'alphal', 'sysnode-backup.json');
        if (!fs.existsSync(bakPath)) {
            fs.mkdirSync(path.dirname(bakPath), { recursive: true });
            const bak: Record<string, any> = {
                ts: new Date().toISOString(),
                nodeFacade: facade,
                oldClassesCmd: b64d(r.fields.OLD_CLASSES_CMD),
                oldJsDefault: b64d(r.fields.OLD_PY_DEFAULT),
                oldUserChoiceProgId: b64d(r.fields.OLD_UC_PROGID),
                oldUserChoiceHash: b64d(r.fields.OLD_UC_HASH),
                oldPath: b64d(r.fields.OLD_PATH),
            };
            fs.writeFileSync(bakPath, JSON.stringify(bak, null, 2), 'utf8');
        }
    } catch { /* 备份失败不影响主流程 */ }
    if (r.ok) return { ok: true, code: 'ok', via: r.fields.VIA || '' };
    const code = r.fields.CODE === 'no-python' ? 'no-node' : (r.fields.CODE || 'verify-failed');
    console.warn('[syspy] node apply fail:', r.fields.CODE, (r.fields.ERR || '').slice(0, 300));
    return { ok: false, code };
}

// ══════════════════════════════════════════════════════════════
// macOS 分支（2026-09-26）——同一按钮、另一套系统机制（免管理员，无 UAC）
//   机制链：osacompile 生成 Launcher.app（{hostDir}/syspy/qqqide-syspy.app）
//     → lsregister 注册 → LSSetDefaultRoleHandlerForContentType 设默认
//     → NSWorkspace.URLForApplicationToOpenURL 回读（唯一验证器）
//   双击/⌘O 链路：.py → Launcher(on open) → run.sh → 一次性 .command
//     → Terminal 窗口 → 内置 Python -i（看得见输出、跑完窗口不关——与 Windows 同款语义；
//     思路同 python.org 官方 Python Launcher，但直接复用内置 Python）。
//   只读检查：回读已解析默认程序 + 登录 shell PATH 探查（排除 Apple /usr/bin 桩与驻场路径）。
//   只管当：不维护不追搬迁；再点一次 = 幂等重写。
// ══════════════════════════════════════════════════════════════
const MAC_BUNDLE_ID = 'com.qqqide.syspy';
const MAC_APP_NAME = 'qqqide-syspy.app';
const MAC_PLISTBUDDY = '/usr/libexec/PlistBuddy';
const MAC_PATH_BEGIN = '# >>> qqqide syspy >>>';
const MAC_PATH_END = '# <<< qqqide syspy <<<';
const MAC_LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

interface CmdResult { code: number | null; out: string; err: string; }

function runCmd(bin: string, args: string[], timeoutMs: number): Promise<CmdResult> {
    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try { child = spawn(bin, args, { windowsHide: true }); }
        catch (e: any) { resolve({ code: -1, out: '', err: String((e && e.message) || e) }); return; }
        let out = ''; let err = ''; let settled = false;
        const timer = setTimeout(() => {
            if (settled) return; settled = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve({ code: null, out, err });
        }, timeoutMs);
        child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
        child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
        child.on('error', (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code: -1, out, err: err + String(((e as any) && (e as any).message) || e) }); });
        child.on('close', (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, out, err }); });
    });
}

function normPath(p: string): string {
    let s = String(p || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    try { s = fs.realpathSync(s); } catch { /* keep */ }
    return s.toLowerCase();
}

/** NSWorkspace 回读：该 .py 此刻会被哪个 app 打开（= 双击的真实答案）。 */
function jxaResolveApp(probePath: string): Promise<string> {
    const js = 'ObjC.import("AppKit"); var ws=$.NSWorkspace.sharedWorkspace; var u=$.NSURL.fileURLWithPath(' + JSON.stringify(probePath) + '); var a=ws.URLForApplicationToOpenURL(u); a ? ObjC.unwrap(a.path) : "";';
    return runCmd('osascript', ['-l', 'JavaScript', '-e', js], 15000).then(r => (r.out || '').trim());
}

/** LSSetDefaultRoleHandlerForContentType：设默认打开程序（返回 OSStatus，0 = OK）。 */
function jxaSetHandler(uti: string, bundleId: string): Promise<number | null> {
    const js = 'ObjC.import("CoreServices"); var r=$.LSSetDefaultRoleHandlerForContentType($(' + JSON.stringify(uti) + '), -1, $(' + JSON.stringify(bundleId) + ')); r;';
    return runCmd('osascript', ['-l', 'JavaScript', '-e', js], 15000).then(r => {
        const n = parseInt((r.out || '').trim(), 10);
        return Number.isFinite(n) ? n : null;
    });
}

/** 探针文件（LS 回读需要一个真实存在的 .py 路径）。 */
function macEnsureProbe(hostDir: string): string {
    const dir = path.join(hostDir, 'syspy');
    const probe = path.join(dir, 'probe.py');
    try {
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(probe)) fs.writeFileSync(probe, '# qqqide syspy probe\n', 'utf8');
    } catch { /* 容错：读不到 → 空结果 */ }
    return probe;
}

/** 探针文件（node：LS 回读需要一个真实存在的 .js 路径）。 */
function macEnsureProbeJs(hostDir: string): string {
    const dir = path.join(hostDir, 'syspy');
    const probe = path.join(dir, 'probe.js');
    try {
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(probe)) fs.writeFileSync(probe, '// qqqide sysnode probe\n', 'utf8');
    } catch { /* 容错：读不到 → 空结果 */ }
    return probe;
}

/** 登录 shell PATH 探查：是否存在第三方解析器（排除 Apple /usr/bin 桩与驻场路径）。 */
async function macThirdPartyTool(target: 'python' | 'node'): Promise<boolean> {
    let sh = '/bin/zsh';
    try { const u = os.userInfo(); if (u && (u as any).shell) sh = (u as any).shell; } catch { /* ignore */ }
    const probeCmd = (target === 'node')
        ? 'command -v node 2>/dev/null; command -v nodejs 2>/dev/null'
        : 'command -v python3 2>/dev/null; command -v python 2>/dev/null';
    const r = await runCmd(sh, ['-lc', probeCmd], 8000);
    const host = normPath(getHostDir());
    for (const raw of (r.out || '').split(/\r?\n/)) {
        const p = raw.trim();
        if (!p) continue;
        const n = normPath(p);
        if (n.startsWith('/usr/bin/') || n.startsWith('/bin/') || n.startsWith('/system/') || n.startsWith('/usr/libexec/')) continue;
        if (host && n.startsWith(host + '/')) continue;
        return true;
    }
    return false;
}

/** Launcher 内嵌 AppleScript —— on open = 双击/⌘O 入口。 */
function macAppleScript(runnerPath: string): string {
    const lit = '"' + runnerPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return [
        'on open theFiles',
        '\trepeat with f in theFiles',
        '\t\tset fp to POSIX path of f',
        '\t\tdo shell script quoted form of ' + lit + ' & " " & quoted form of fp',
        '\tend repeat',
        '\tquit',
        'end open',
        '',
    ].join('\n');
}

/** Launcher run.sh —— 生成一次性 .command → Terminal 窗口 → 内置 Python -i。 */
function macRunner(enginesRoot: string): string {
    const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const pyExe = enginesRoot + '/python/bin/python3';
    const nodeExe = enginesRoot + '/node/node';
    return [
        '#!/bin/bash',
        '# qqqide interpreter runner — argv1 = 脚本路径（.js/.mjs/.cjs → 内置 Node；其余 → 内置 Python；可重新生成覆盖）',
        'SRC="$1"; [ -n "$SRC" ] || exit 0',
        'case "$SRC" in',
        '  *.js|*.mjs|*.cjs) EXE=' + sq(nodeExe) + '; LABEL="Node" ;;',
        '  *) EXE=' + sq(pyExe) + '; LABEL="Python" ;;',
        'esac',
        'if [ ! -x "$EXE" ]; then',
        '  /usr/bin/osascript -e ' + sq('display dialog "内置解释器已失效（安装目录可能被移动）：请在 qd (qqqide) 设置里重新点击「做系统 Node 解释器」或「做系统 Python 解释器」" buttons {"好"} default button 1 with icon caution with title "qd (qqqide)"') + ' >/dev/null 2>&1',
        '  exit 1',
        'fi',
        'CACHE="$HOME/Library/Caches/qqqide-syspy"; mkdir -p "$CACHE" 2>/dev/null',
        'find "$CACHE" -name "run-*.command" -mtime +7 -delete 2>/dev/null',
        'CMD="$CACHE/run-$(date +%s)-$$.command"',
        '{',
        '  echo "#!/bin/bash"',
        "  printf 'echo %q\\n' \"* qd (qqqide) · 内置 $LABEL · $SRC\"",
        '  printf "exec %q -i %q\\n" "$EXE" "$SRC"',
        '} > "$CMD"',
        'chmod 755 "$CMD" 2>/dev/null',
        'exec /usr/bin/open -a Terminal "$CMD"',
        '',
    ].join('\n');
}

/** Info.plist 补丁（Set 失败自动 Add；文档类型整树重建，幂等）。 */
async function macPlistPatch(plist: string): Promise<void> {
    const pb = async (cmd: string) => (await runCmd(MAC_PLISTBUDDY, ['-c', cmd, plist], 10000)).code === 0;
    if (!(await pb('Set :CFBundleIdentifier ' + MAC_BUNDLE_ID))) await pb('Add :CFBundleIdentifier string ' + MAC_BUNDLE_ID);
    if (!(await pb('Set :LSUIElement true'))) await pb('Add :LSUIElement bool true');
    if (!(await pb('Set :CFBundleDisplayName "qd (qqqide) Interpreter"'))) await pb('Add :CFBundleDisplayName string "qd (qqqide) Interpreter"');
    await pb('Delete :CFBundleDocumentTypes');
    await pb('Add :CFBundleDocumentTypes array');
    await pb('Add :CFBundleDocumentTypes:0 dict');
    await pb('Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array');
    await pb('Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0 string py');
    await pb('Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer');
    await pb('Add :CFBundleDocumentTypes:0:LSHandlerRank string Default');
    await pb('Add :CFBundleDocumentTypes:0:LSItemContentTypes array');
    await pb('Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string public.python-script');
    await pb('Add :CFBundleDocumentTypes:1 dict');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeExtensions array');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeExtensions:0 string js');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeExtensions:1 string mjs');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeExtensions:2 string cjs');
    await pb('Add :CFBundleDocumentTypes:1:CFBundleTypeRole string Viewer');
    await pb('Add :CFBundleDocumentTypes:1:LSHandlerRank string Default');
    await pb('Add :CFBundleDocumentTypes:1:LSItemContentTypes array');
    await pb('Add :CFBundleDocumentTypes:1:LSItemContentTypes:0 string com.netscape.javascript-source');
}

/** PATH 追加（登录 shell profile；幂等块；只写 zsh/bash，其余 shell 跳过并如实记录）。 */
function macAppendPath(enginesRoot: string): Record<string, any> {
    const pyDir = enginesRoot + '/python/bin';
    const nodeDir = enginesRoot + '/node';
    const home = os.homedir();
    let sh = '/bin/zsh';
    try { const u = os.userInfo(); if (u && (u as any).shell) sh = (u as any).shell; } catch { /* ignore */ }
    const base = path.basename(sh).toLowerCase();
    let file = '';
    if (base.indexOf('zsh') >= 0) file = path.join(home, '.zprofile');
    else if (base.indexOf('bash') >= 0) file = path.join(home, '.bash_profile');
    const backup: Record<string, any> = { shell: sh, profileFile: file || null, profileExisted: false, profileContentB64: '' };
    if (!file) return backup;
    const BEGIN = MAC_PATH_BEGIN;
    const END = MAC_PATH_END;
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch { /* 不存在 */ }
    backup.profileExisted = !!prev;
    backup.profileContentB64 = Buffer.from(prev, 'utf8').toString('base64');
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let next = prev.replace(new RegExp(esc(BEGIN) + '[\\s\\S]*?' + esc(END) + '\\n?', 'g'), '');
    if (next && !next.endsWith('\n')) next += '\n';
    next += BEGIN + '\n' + 'export PATH="' + pyDir + ':$PATH"\n' + 'export PATH="' + nodeDir + ':$PATH"\n' + END + '\n';
    try { fs.writeFileSync(file, next, 'utf8'); } catch { /* 失败不阻塞主流程 */ }
    return backup;
}

async function macSysInterpCheck(portableRoot: string, target: 'python' | 'node'): Promise<{ ok: boolean; mode: string; exeOk: boolean; aq: string }> {
    const hostDir = getHostDir();
    const appDir = path.join(hostDir, 'syspy', MAC_APP_NAME);
    let exe: string | null = null;
    if (target === 'node') exe = nodeFacadePath(portableRoot);
    else { try { exe = getComponentBin(portableRoot, 'python'); } catch { exe = null; } }
    const exeOk = !!exe && fs.existsSync(exe);
    const probe = (target === 'node') ? macEnsureProbeJs(hostDir) : macEnsureProbe(hostDir);
    let resolved = '';
    try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
    const ours = !!resolved && normPath(resolved) === normPath(appDir) && fs.existsSync(appDir);
    let mode = 'none';
    if (ours) mode = 'ours';
    else if (resolved || (await macThirdPartyTool(target))) mode = 'other';
    return { ok: true, mode, exeOk, aq: resolved };
}

async function macSysInterpApply(portableRoot: string, target: 'python' | 'node'): Promise<{ ok: boolean; code: string; via?: string }> {
    const hostDir = getHostDir();
    const enginesRoot = resolveEnginesRoot(portableRoot);
    let exe: string | null = null;
    if (target === 'node') exe = nodeFacadePath(portableRoot);
    else { try { exe = getComponentBin(portableRoot, 'python'); } catch { exe = null; } }
    if (!enginesRoot || !exe || !fs.existsSync(exe)) return { ok: false, code: target === 'node' ? 'no-node' : 'no-python' };
    if (target === 'node') {
        try { fs.chmodSync(exe, 0o755); } catch { /* ignore */ }
        // sidecar：门面目标 = 运行中的 Electron 本体（precise，胜过任何相对回退）
        try { fs.writeFileSync(path.join(path.dirname(exe), 'node-target.txt'), process.execPath + '\n', 'utf8'); } catch { /* 容错 */ }
    }
    // ★ 稳定路径：python 清单 bin_unix = bin/python3（相对符号链接）——引擎目录内升级（3.11→3.12）后依然有效；
    //   禁 realpath 钉死小版本（python3.11 硬化路径 → 引擎升级即断链 → 双击弹「已失效」提示）。

    const syspyDir = path.join(hostDir, 'syspy');
    const appDir = path.join(syspyDir, MAC_APP_NAME);
    const contentsDir = path.join(appDir, 'Contents');
    const runnerPath = path.join(contentsDir, 'Resources', 'run.sh');
    const plistPath = path.join(contentsDir, 'Info.plist');
    const probe = (target === 'node') ? macEnsureProbeJs(hostDir) : macEnsureProbe(hostDir);

    // 0. 首写快照（备份原值，供人工还原）——改动任何状态之前采集
    const bakPath = path.join(hostDir, 'Data', 'alphal', 'syspy-backup.json');
    let needBackup = false;
    if (target === 'python') { needBackup = !fs.existsSync(bakPath); }
    else {
        let bakObj: any = null;
        try { bakObj = JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch { bakObj = null; }
        needBackup = !(bakObj && bakObj.node);
    }
    let prevResolved = '';
    if (needBackup) { try { prevResolved = await jxaResolveApp(probe); } catch { /* ignore */ } }

    // 1. 重建 Launcher.app（幂等：每次全量重建；先停残留旧实例——旧脚本驻留内存）
    try { fs.mkdirSync(syspyDir, { recursive: true }); } catch { /* ignore */ }
    await runCmd('/usr/bin/pkill', ['-f', appDir + '/Contents/MacOS/droplet'], 5000);
    try { fs.rmSync(appDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const asSrc = path.join(syspyDir, 'launcher.applescript');
    try { fs.writeFileSync(asSrc, macAppleScript(runnerPath), 'utf8'); } catch { return { ok: false, code: 'verify-failed' }; }
    const c1 = await runCmd('/usr/bin/osacompile', ['-o', appDir, asSrc], 60000);
    if (c1.code !== 0 || !fs.existsSync(path.join(contentsDir, 'MacOS', 'droplet'))) return { ok: false, code: 'verify-failed' };
    try {
        fs.writeFileSync(runnerPath, macRunner(enginesRoot), 'utf8');
        fs.chmodSync(runnerPath, 0o755);
    } catch { return { ok: false, code: 'verify-failed' }; }
    await macPlistPatch(plistPath);

    // 2. 注册 + 设默认 + 回读验证（失配自动重试一轮）
    if ((await runCmd(MAC_LSREGISTER, ['-f', appDir], 30000)).code !== 0) return { ok: false, code: 'verify-failed' };
    const uti = (target === 'node') ? 'com.netscape.javascript-source' : 'public.python-script';
    let setRc = await jxaSetHandler(uti, MAC_BUNDLE_ID);
    let resolved = '';
    try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
    if (setRc !== 0 || normPath(resolved) !== normPath(appDir)) {
        await runCmd(MAC_LSREGISTER, ['-f', appDir], 30000);
        setRc = await jxaSetHandler(uti, MAC_BUNDLE_ID);
        try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
    }
    const pass = normPath(resolved) === normPath(appDir);

    // 3. PATH（幂等；失败不阻塞）
    const profBackup = macAppendPath(enginesRoot);

    // 4. 备份落盘（python：首写快照；node：并入 node 分区不覆盖既有——与 Windows 同语义）
    if (needBackup) {
        try {
            fs.mkdirSync(path.dirname(bakPath), { recursive: true });
            if (target === 'python') {
                fs.writeFileSync(bakPath, JSON.stringify(Object.assign({
                    ts: new Date().toISOString(),
                    platform: 'darwin',
                    pythonExe: exe,
                    launcherApp: appDir,
                    prevHandlerPath: prevResolved,
                }, profBackup), null, 2), 'utf8');
            } else {
                let bakObj: any = null;
                try { bakObj = JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch { bakObj = null; }
                if (!bakObj || typeof bakObj !== 'object') bakObj = {};
                bakObj.node = { ts: new Date().toISOString(), nodeFacade: exe, prevHandlerPath: prevResolved };
                fs.writeFileSync(bakPath, JSON.stringify(bakObj, null, 2), 'utf8');
            }
        } catch { /* 备份失败不影响主流程 */ }
    }

    if (pass) return { ok: true, code: 'ok', via: 'mac' };
    console.warn('[syspy] mac verify failed:', 'target=' + target, 'setRc=' + setRc, 'resolved=' + resolved, 'appDir=' + appDir);
    return { ok: false, code: 'verify-failed' };
}

// ══════════════════════════════════════════════════════════════
// 解除（双平台）——纯清空一锤子买卖：只拆我们的手印，绝不还原旧值（白板化）。
//   win：UserChoice 删键（DACL 突破重试；退路=清 ProgId+Hash 让系统忽略）→ Classes 手印（指纹校验）
//        → 自有 ProgId 树（qqqide.*）→ FileExts 遗留 → PATH 去项 → HKLM 手印（UAC 兜底）；SHChangeNotify。
//   mac：LSHandler 偏好条目移除（实证：移除 + killall lsd 即回落系统下一处理器）+ PATH 块重建；
//        末位解除 → lsregister -u + 删 syspy 目录 + 清运行缓存；共享 Launcher.app 在另一目标仍接管时保留。
// ══════════════════════════════════════════════════════════════
function pyEnv(exe: string | null, ext: string, progId: string, flags: string): Record<string, string> {
    return {
        QQQIDE_SYSPY_EXE: exe || '',
        QQQIDE_SYSPY_DIR: exe ? path.dirname(exe) : '',
        QQQIDE_SYSPY_EXT: ext,
        QQQIDE_SYSPY_PROGID: progId,
        QQQIDE_SYSPY_FLAGS: flags,
    };
}

/** PATH 块重建（登录 shell profile；只保留仍由我们接管的目标；全不归 → 整块删除）。 */
function macRewritePathBlock(enginesRoot: string, keepPy: boolean, keepNode: boolean): void {
    let sh = '/bin/zsh';
    try { const u = os.userInfo(); if (u && (u as any).shell) sh = (u as any).shell; } catch { /* ignore */ }
    const base = path.basename(sh).toLowerCase();
    let file = '';
    if (base.indexOf('zsh') >= 0) file = path.join(os.homedir(), '.zprofile');
    else if (base.indexOf('bash') >= 0) file = path.join(os.homedir(), '.bash_profile');
    if (!file) return;
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch { return; }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let next = prev.replace(new RegExp(esc(MAC_PATH_BEGIN) + '[\\s\\S]*?' + esc(MAC_PATH_END) + '\\n?', 'g'), '');
    const lines: string[] = [];
    if (keepPy && enginesRoot) lines.push('export PATH="' + enginesRoot + '/python/bin:$PATH"');
    if (keepNode && enginesRoot) lines.push('export PATH="' + enginesRoot + '/node:$PATH"');
    if (lines.length) {
        if (next && !next.endsWith('\n')) next += '\n';
        next += MAC_PATH_BEGIN + '\n' + lines.join('\n') + '\n' + MAC_PATH_END + '\n';
    }
    if (next !== prev) { try { fs.writeFileSync(file, next, 'utf8'); } catch { /* ignore */ } }
}

/** 从 LSHandler 偏好（secure plist）移除指定 UTI 的全部条目（解除「默认程序」设定；倒序删保索引稳定）。 */
async function macRemoveLsHandler(uti: string): Promise<number> {
    const pl = path.join(os.homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
    if (!fs.existsSync(pl)) return 0;
    const r = await runCmd(MAC_PLUTIL, ['-convert', 'json', '-o', '-', pl], 15000);
    if (r.code !== 0) return 0;
    let arr: any[] = [];
    try {
        const obj = JSON.parse(r.out || '{}');
        if (obj && Array.isArray(obj.LSHandlers)) arr = obj.LSHandlers;
    } catch { return 0; }
    let removed = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        const h = arr[i];
        if (h && h.LSHandlerContentType === uti) {
            const rm = await runCmd(MAC_PLUTIL, ['-remove', 'LSHandlers.' + i, pl], 15000);
            if (rm.code === 0) removed++;
        }
    }
    return removed;
}

async function macSysInterpRemove(portableRoot: string, target: 'python' | 'node'): Promise<{ ok: boolean; code: string }> {
    const hostDir = getHostDir();
    const appDir = path.join(hostDir, 'syspy', MAC_APP_NAME);
    const enginesRoot = resolveEnginesRoot(portableRoot) || '';
    const uti = (target === 'node') ? 'com.netscape.javascript-source' : 'public.python-script';
    const probe = (target === 'node') ? macEnsureProbeJs(hostDir) : macEnsureProbe(hostDir);
    const otherProbe = (target === 'node') ? macEnsureProbe(hostDir) : macEnsureProbeJs(hostDir);

    // 1. 停掉驻留的 Launcher 实例
    await runCmd('/usr/bin/pkill', ['-f', appDir + '/Contents/MacOS/droplet'], 5000);

    // 2. 移除本目标的默认程序偏好条目（白板：不还原旧 handler）
    await macRemoveLsHandler(uti);

    // 3. 另一目标是否仍由我们接管？（决定共享 Launcher.app 的去留）
    let otherOurs = false;
    try {
        const r = await jxaResolveApp(otherProbe);
        otherOurs = !!r && normPath(r) === normPath(appDir) && fs.existsSync(appDir);
    } catch { /* ignore */ }

    // 4. 末位解除 → 全拆：注销 + 删整个 syspy 目录 + 清运行缓存（另一目标仍在 → 保留共享 Launcher.app）
    if (!otherOurs) {
        await runCmd(MAC_LSREGISTER, ['-u', appDir], 30000);
        try { fs.rmSync(path.join(hostDir, 'syspy'), { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(path.join(os.homedir(), 'Library', 'Caches', 'qqqide-syspy'), { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // 5. PATH 块重建（只保留仍归我们的目标；全不归 → 整块删除）
    macRewritePathBlock(enginesRoot, (target === 'python') ? false : otherOurs, (target === 'node') ? false : otherOurs);

    // 6. 刷 LS 缓存（lsd 内存映射表）+ 回读验证（失配重试一轮）
    await runCmd('/usr/bin/killall', ['cfprefsd'], 5000);
    await runCmd('/usr/bin/killall', ['lsd'], 5000);
    let resolved = '';
    try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
    let pass = !(!!resolved && normPath(resolved) === normPath(appDir));
    if (!pass) {
        await new Promise((r2) => setTimeout(r2, 800));
        await runCmd('/usr/bin/killall', ['lsd'], 5000);
        try { resolved = await jxaResolveApp(probe); } catch { /* ignore */ }
        pass = !(!!resolved && normPath(resolved) === normPath(appDir));
    }
    if (pass) return { ok: true, code: 'ok' };
    console.warn('[syspy] mac remove verify failed:', 'target=' + target, 'resolved=' + resolved, 'appDir=' + appDir);
    return { ok: false, code: 'verify-failed' };
}

// Windows 解除：python = .py + .pyw 两遍；node = .js + .mjs/.cjs 尽力而为
async function winSysInterpRemove(portableRoot: string, target: 'python' | 'node'): Promise<{ ok: boolean; code: string }> {
    if (target === 'node') {
        const facade = nodeFacadePath(portableRoot);
        const exeArg = (facade && fs.existsSync(facade)) ? facade : '';
        const env = (exeArg)
            ? nodeEnv(exeArg, '.js')
            : { QQQIDE_SYSPY_EXE: '', QQQIDE_SYSPY_DIR: '', QQQIDE_SYSPY_EXT: '.js', QQQIDE_SYSPY_PROGID: 'qqqide.NodeScript', QQQIDE_SYSPY_FLAGS: 'none', QQQIDE_SYSPY_MATCH: 'node', QQQIDE_SYSPY_WRAP: 'pause' };
        const r = await runPs(PS_HEAD + PS_BODY, { ...env, QQQIDE_SYSPY_MODE: 'remove' }, 300000);
        for (const ext of ['.mjs', '.cjs']) {
            try { await runPs(PS_HEAD + PS_BODY, { ...env, QQQIDE_SYSPY_EXT: ext, QQQIDE_SYSPY_MODE: 'remove' }, 300000); } catch { /* 尽力而为 */ }
        }
        if (r.fields.OK === '1') return { ok: true, code: 'ok' };
        console.warn('[syspy] node remove fail:', r.fields.CODE, (r.fields.ERR || '').slice(0, 300));
        return { ok: false, code: r.fields.CODE || 'remove-failed' };
    }
    let exe = '';
    try { exe = getComponentBin(portableRoot, 'python') || ''; } catch { exe = ''; }
    const r1 = await runPs(PS_HEAD + PS_BODY, { ...pyEnv(exe, '.py', 'Python.File', '-i'), QQQIDE_SYSPY_MODE: 'remove' }, 300000);
    try {
        const pyw = exe ? path.join(path.dirname(exe), 'pythonw.exe') : '';
        if (pyw && fs.existsSync(pyw)) {
            await runPs(PS_HEAD + PS_BODY, { ...pyEnv(pyw, '.pyw', 'Python.NoConFile', 'none'), QQQIDE_SYSPY_MODE: 'remove' }, 300000);
        }
    } catch { /* 尽力而为 */ }
    if (r1.fields.OK === '1') return { ok: true, code: 'ok' };
    console.warn('[syspy] remove fail:', r1.fields.CODE, (r1.fields.ERR || '').slice(0, 300));
    return { ok: false, code: r1.fields.CODE || 'remove-failed' };
}

// ── IPC 注册 ──
let _inFlight = false;

export function registerSysPyIpc(portableRoot: string): void {
    const resolvePython = () => {
        try { return getComponentBin(portableRoot, 'python'); } catch { return null; }
    };

    ipcMain.handle('qqqide:syspy:check', async (_e: any, target?: string) => {
        const t: 'python' | 'node' = target === 'node' ? 'node' : 'python';
        if (process.platform === 'darwin') {
            if (_inFlight) return { ok: false, code: 'busy' };
            _inFlight = true;
            try { return await macSysInterpCheck(portableRoot, t); }
            catch (e: any) { console.warn('[syspy] mac check err:', (e && e.message) || e); return { ok: false, code: 'check-failed' }; }
            finally { _inFlight = false; }
        }
        if (process.platform !== 'win32') return { ok: true, mode: 'unsupported' };
        if (_inFlight) return { ok: false, code: 'busy' };
        _inFlight = true;
        try {
            const env = (t === 'node')
                ? nodeEnv(nodeFacadePath(portableRoot) || 'node.exe', '.js')
                : pyEnv(resolvePython(), '.py', 'Python.File', '-i');
            const r = await runPs(PS_HEAD + PS_BODY, { ...env, QQQIDE_SYSPY_MODE: 'check' }, 60000);
            if (!r.fields.CODE) {
                console.warn('[syspy] check raw:', r.raw.slice(0, 600));
                return { ok: false, code: 'check-failed' };
            }
            return {
                ok: true,
                mode: r.fields.CODE,                       // 'none' | 'other' | 'ours'
                exeOk: r.fields.EXE_OK === '1',
                aq: b64d(r.fields.AQ),
            };
        } finally {
            _inFlight = false;
        }
    });

    ipcMain.handle('qqqide:syspy:apply', async (_e: any, target?: string) => {
        const t: 'python' | 'node' = target === 'node' ? 'node' : 'python';
        if (process.platform === 'darwin') {
            if (_inFlight) return { ok: false, code: 'busy' };
            _inFlight = true;
            try { return await macSysInterpApply(portableRoot, t); }
            catch (e: any) { console.warn('[syspy] mac apply err:', (e && e.message) || e); return { ok: false, code: 'verify-failed' }; }
            finally { _inFlight = false; }
        }
        if (process.platform !== 'win32') return { ok: false, code: 'unsupported' };
        if (_inFlight) return { ok: false, code: 'busy' };
        _inFlight = true;
        try {
            if (t === 'node') return await winNodeApply(portableRoot);
            const exe = resolvePython();
            if (!exe) return { ok: false, code: 'no-python' };
            const r = await runPs(PS_HEAD + PS_BODY, { ...pyEnv(exe, '.py', 'Python.File', '-i'), QQQIDE_SYSPY_MODE: 'apply' }, 300000);
            // ★ .pyw 第二遍（Python.NoConFile + pythonw，无控制台——与 python.org 官方语义一致）
            //   尽力而为：只记日志，不影响 .py 主结论
            let r2: PsResult | null = null;
            let pywExe = '';
            try {
                const cand = path.join(path.dirname(exe), 'pythonw.exe');
                if (fs.existsSync(cand)) {
                    pywExe = cand;
                    r2 = await runPs(PS_HEAD + PS_BODY, { ...pyEnv(cand, '.pyw', 'Python.NoConFile', 'none'), QQQIDE_SYSPY_MODE: 'apply' }, 300000);
                    if (!r2.ok) console.warn('[syspy] pyw pass:', r2.fields.CODE, (r2.fields.ERR || '').slice(0, 200));
                }
            } catch (e: any) { console.warn('[syspy] pyw pass err:', (e && e.message) || e); }
            // 备份原值（首写快照，不覆盖已存在文件）——留作将来人工还原之据
            try {
                const bakPath = path.join(portableRoot, 'Data', 'alphal', 'syspy-backup.json');
                if (!fs.existsSync(bakPath)) {
                    fs.mkdirSync(path.dirname(bakPath), { recursive: true });
                    const bak: Record<string, any> = {
                        ts: new Date().toISOString(),
                        pythonExe: exe,
                        oldClassesCmd: b64d(r.fields.OLD_CLASSES_CMD),
                        oldPyDefault: b64d(r.fields.OLD_PY_DEFAULT),
                        oldUserChoiceProgId: b64d(r.fields.OLD_UC_PROGID),
                        oldUserChoiceHash: b64d(r.fields.OLD_UC_HASH),
                        oldPath: b64d(r.fields.OLD_PATH),
                    };
                    if (r2) {
                        bak.pyw = {
                            pythonwExe: pywExe,
                            oldClassesCmd: b64d(r2.fields.OLD_CLASSES_CMD),
                            oldPyDefault: b64d(r2.fields.OLD_PY_DEFAULT),
                            oldUserChoiceProgId: b64d(r2.fields.OLD_UC_PROGID),
                            oldUserChoiceHash: b64d(r2.fields.OLD_UC_HASH),
                        };
                    }
                    fs.writeFileSync(bakPath, JSON.stringify(bak, null, 2), 'utf8');
                }
            } catch { /* 备份失败不影响主流程 */ }
            if (r.ok) return { ok: true, code: 'ok', via: r.fields.VIA || '' };
            console.warn('[syspy] apply fail:', r.fields.CODE, (r.fields.ERR || '').slice(0, 300));
            return { ok: false, code: r.fields.CODE || 'verify-failed' };
        } finally {
            _inFlight = false;
        }
    });

    // ★ 解除（纯清空白板化；不还原旧值）
    ipcMain.handle('qqqide:syspy:remove', async (_e: any, target?: string) => {
        const t: 'python' | 'node' = target === 'node' ? 'node' : 'python';
        if (process.platform === 'darwin') {
            if (_inFlight) return { ok: false, code: 'busy' };
            _inFlight = true;
            try { return await macSysInterpRemove(portableRoot, t); }
            catch (e: any) { console.warn('[syspy] mac remove err:', (e && e.message) || e); return { ok: false, code: 'remove-failed' }; }
            finally { _inFlight = false; }
        }
        if (process.platform !== 'win32') return { ok: false, code: 'unsupported' };
        if (_inFlight) return { ok: false, code: 'busy' };
        _inFlight = true;
        try { return await winSysInterpRemove(portableRoot, t); }
        catch (e: any) { console.warn('[syspy] remove err:', (e && e.message) || e); return { ok: false, code: 'remove-failed' }; }
        finally { _inFlight = false; }
    });
}
