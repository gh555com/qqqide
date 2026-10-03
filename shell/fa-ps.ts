// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// fa-ps.ts — 系统默认播放器（文件关联）PowerShell 脚本（纯文本，零依赖）
//   由 ipc-fileassoc.ts 经 stdin 执行（行协议 QQQIDE_FA_*；$mode=apply——check/remove 已废：
//   无状态角标、无解除逻辑〔2026-10-03 定案〕）；探针可整体导入本文件、
//   替换四个注册表根变量 + $verifyMode 后在沙箱命名空间做全链验证。
//
//   UserChoice hash 算法与 Deny-ACL 突破 = ipc-syspy.ts 同源（Windows UserChoice 公开逆向格式
//   1803+ 主版 v1）；PS 2.0 兼容（Win7 出厂）：零 3.0+ cmdlet，全程 ASCII 脚本体。
//
//   ★ 探针替换点（保持单行精确格式，勿改）：
//     $clsRoot = 'Software\Classes'
//     $capRoot = 'Software\qqqide'
//     $raRoot = 'Software\RegisteredApplications'
//     $ucBase = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts'
//     $verifyMode = 'assoc'
// ============================================================================

export const FA_PS = String.raw`
$ErrorActionPreference = 'Continue'
$mode = $env:QQQIDE_FA_MODE
$progId = 'qqqide.player'
$cmdLine = $env:QQQIDE_FA_CMD
$icon = $env:QQQIDE_FA_ICON
$appName = $env:QQQIDE_FA_NAME
$desc = $env:QQQIDE_FA_DESC
if (-not $appName) { $appName = 'qd (qqqide)' }
$exts = @()
if ($env:QQQIDE_FA_EXTS) {
  foreach ($e in ($env:QQQIDE_FA_EXTS -split ';')) { $t = $e.Trim(); if ($t -ne '') { $exts += $t } }
}
$clsRoot = 'Software\Classes'
$capRoot = 'Software\qqqide'
$raRoot = 'Software\RegisteredApplications'
$ucBase = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts'
$verifyMode = 'assoc'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function OutKV([string]$k, [string]$v) { Write-Output ('QQQIDE_FA_' + $k + '=' + $v) }
function B64([string]$s) { if ($null -eq $s) { $s = '' }; return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
function UcPathOf([string]$e) { return ($ucBase + '\' + $e + '\UserChoice') }

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
  public static string FmtV1(string ext, string sid, string progId, long ft) {
    long f = (ft / 600000000L) * 600000000L;
    return (ext + sid + progId + ((uint)((ulong)f >> 32)).ToString("x8") + ((uint)((ulong)f & 0xFFFFFFFFu)).ToString("x8")
      + "User Choice set via Windows User Experience {D18B6DD5-6124-4341-9318-804003BAFA0B}").ToLowerInvariant();
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  public static extern int RegQueryInfoKey(IntPtr hKey, IntPtr a, IntPtr b, IntPtr c, IntPtr d, IntPtr e, IntPtr f, IntPtr g, IntPtr h, IntPtr i, IntPtr j, out long ft);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  public static extern int AssocQueryString(int flags, int str, string assoc, string extra, StringBuilder outBuf, ref int outLen);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
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
function Read-Value([string]$p, [string]$name) {
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p)
    if ($k) { $v = $k.GetValue($name); $k.Close(); if ($null -ne $v) { return [string]$v } }
  } catch { }
  return ''
}
function Get-AssocCmd([string]$e) {
  $sb = New-Object System.Text.StringBuilder 4096
  $n = 4096
  $rc = [QS]::AssocQueryString(0, 1, $e, 'open', $sb, [ref]$n)
  if ($rc -ne 0) { return '' }
  return $sb.ToString()
}
function Open-UcWrite([string]$p) {
  try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p, $true); if ($k) { return $k } } catch { }
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [System.Security.AccessControl.RegistryRights]::ChangePermissions)
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
  try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p, $true); if ($k) { return $k } } catch { }
  return $null
}
function Write-Uc([string]$e) {
  $uc = UcPathOf $e
  $k = Open-UcWrite $uc
  if (-not $k) { try { $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($uc) } catch { } }
  if (-not $k) { return $false }
  $k.SetValue('ProgId', $progId, 'String')
  $k.Close()
  for ($i = 0; $i -lt 4; $i++) {
    $ft = Get-KeyFT $uc
    $h = [QS]::HashString([QS]::FmtV1($e, $sid, $progId, $ft))
    $k = Open-UcWrite $uc
    if (-not $k) { break }
    $k.SetValue('Hash', $h, 'String')
    $k.Close()
    $ft2 = Get-KeyFT $uc
    $h2 = [QS]::HashString([QS]::FmtV1($e, $sid, $progId, $ft2))
    if ($h2 -eq $h) { return $true }
    $k = Open-UcWrite $uc
    if ($k) { $k.SetValue('ProgId', $progId, 'String'); $k.Close() }
  }
  return $false
}
function Verify-Ext([string]$e) {
  if ($verifyMode -eq 'reg') {
    $uc = Read-Value (UcPathOf $e) 'ProgId'
    return ($uc -eq $progId)
  }
  $aq = Get-AssocCmd $e
  return (($aq -ne '') -and ($aq.ToLower().Contains('--qqqide-play')))
}

if ($mode -eq 'apply') {
  if (-not $cmdLine) { OutKV 'OK' '0'; OutKV 'CODE' 'no-cmd'; exit 0 }
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($clsRoot + '\' + $progId)
    $k.SetValue('', $appName, 'String')
    $k.Close()
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($clsRoot + '\' + $progId + '\shell\open')
    # MultiSelectModel=Player: Explorer multi-select open -> shell passes ALL files in ONE call
    # (player semantics; host argv collects all files -> single window). Shell-level batch merge is fallback.
    # SCRIPT BODY MUST STAY PURE ASCII: this script rides stdin into PS 5.1, which decodes stdin as
    #   the OEM codepage (GBK on zh-CN) -- a non-ASCII comment ending with a lead byte swallows the
    #   following newline (0x0A pairs as a bogus GBK char) and eats the NEXT CODE LINE. ASCII only.
    $k.SetValue('MultiSelectModel', 'Player', 'String')
    $k.Close()
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($clsRoot + '\' + $progId + '\shell\open\command')
    $k.SetValue('', $cmdLine, 'String')
    $k.Close()
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($clsRoot + '\' + $progId + '\DefaultIcon')
    $k.SetValue('', $icon, 'String')
    $k.Close()
  } catch { }
  try {
    $cap = $capRoot + '\PlayerCapabilities'
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($cap)
    $k.SetValue('ApplicationName', $appName, 'String')
    $k.SetValue('ApplicationDescription', $desc, 'String')
    $k.SetValue('ApplicationIcon', $icon, 'String')
    $k.Close()
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($cap + '\FileAssociations')
    foreach ($e in $exts) { $k.SetValue($e, $progId, 'String') }
    $k.Close()
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($raRoot)
    $k.SetValue($appName, $cap, 'String')
    $k.Close()
  } catch { }
  $total = 0
  $taken = 0
  $fails = ''
  foreach ($e in $exts) {
    $total++
    try {
      $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($clsRoot + '\' + $e + '\OpenWithProgids')
      if ($k) { $k.SetValue($progId, [byte[]]@(), 'Binary'); $k.Close() }
    } catch { }
    Write-Uc $e | Out-Null
    if (Verify-Ext $e) { $taken++ } else { $fails = $fails + $e + ';' }
  }
  [QS]::NotifyAssocChanged()
  OutKV 'OK' $(if ($taken -gt 0) { '1' } else { '0' })
  OutKV 'CODE' $(if ($taken -eq $total) { 'ok' } elseif ($taken -gt 0) { 'partial' } else { 'verify-failed' })
  OutKV 'TOTAL' ([string]$total)
  OutKV 'TAKEN' ([string]$taken)
  OutKV 'FAILS' (B64 $fails)
  if ($Error.Count -gt 0) { OutKV 'PSERR' (B64 (($Error | Select-Object -First 3 | ForEach-Object { $_.ToString() }) -join ' | ')) }
  exit 0
}

OutKV 'OK' '0'
OutKV 'CODE' 'bad-mode'
exit 0
`;
