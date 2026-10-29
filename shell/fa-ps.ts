// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// fa-ps.ts — 文件关联（打开方式）PowerShell 脚本（纯文本，零依赖）
//   由 ipc-fileassoc.ts（播放器域）/ fa-editor.ts（编辑器域）经 stdin 执行（行协议 QQQIDE_FA_*）。
//   $mode=apply|register|release|state：
//     apply    = 注册面全量 + UserChoice hash 强写（夺默认；播放器 ★ 钮 / 设置行〔设为默认〕）
//     register = 仅注册面（ProgID + OpenWithProgids + Capabilities/RegisteredApplications
//                + Applications 块）——不碰系统默认（编辑器域 A+ 启动自愈静默路径）
//     release  = 族内退出归还（撤候选面；默认槽位是我方 → 网页族回写已装浏览器 / 其余删 UserChoice）
//     state    = 只读快照（逐扩展 taken|cand|free——`1 by 1` 明细面板的角标真相）
//   探针可整体导入本文件、替换四个注册表根变量 + $verifyMode 后在沙箱命名空间做全链验证。
//   ProgID / 验证标记 / 应用级命令均经环境注入（缺省 = 播放器域旧值，行为零回归）。
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
$progId = $env:QQQIDE_FA_PROGID
if (-not $progId) { $progId = 'qqqide.player' }
$mark = $env:QQQIDE_FA_MARK
if (-not $mark) { $mark = '--qqqide-play' }
$cmdLine = $env:QQQIDE_FA_CMD
$icon = $env:QQQIDE_FA_ICON
$appName = $env:QQQIDE_FA_NAME
$desc = $env:QQQIDE_FA_DESC
if (-not $appName) { $appName = 'qd (qqqide)' }
$appFriend = $env:QQQIDE_FA_APPFRIEND
if (-not $appFriend) { $appFriend = $appName }
$appExe = $env:QQQIDE_FA_APPEXE
$appCmd = $env:QQQIDE_FA_APPCMD
$appTypes = $env:QQQIDE_FA_APPTYPES
$capName = $env:QQQIDE_FA_CAPNAME
if (-not $capName) { $capName = 'PlayerCapabilities' }
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
function Has-Value([string]$p, [string]$name) {
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p)
    if ($k) { $names = $k.GetValueNames(); $k.Close(); foreach ($n in $names) { if ($n -eq $name) { return $true } } }
  } catch { }
  return $false
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
function Write-UcTarget([string]$e, [string]$vid) {
  $uc = UcPathOf $e
  $k = Open-UcWrite $uc
  if (-not $k) { try { $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($uc) } catch { } }
  if (-not $k) { return $false }
  $k.SetValue('ProgId', $vid, 'String')
  $k.Close()
  for ($i = 0; $i -lt 4; $i++) {
    $ft = Get-KeyFT $uc
    $h = [QS]::HashString([QS]::FmtV1($e, $sid, $vid, $ft))
    $k = Open-UcWrite $uc
    if (-not $k) { break }
    $k.SetValue('Hash', $h, 'String')
    $k.Close()
    $ft2 = Get-KeyFT $uc
    $h2 = [QS]::HashString([QS]::FmtV1($e, $sid, $vid, $ft2))
    if ($h2 -eq $h) { return $true }
    $k = Open-UcWrite $uc
    if ($k) { $k.SetValue('ProgId', $vid, 'String'); $k.Close() }
  }
  return $false
}
function Write-Uc([string]$e) { return (Write-UcTarget $e $progId) }
function Del-Value([string]$p, [string]$name) {
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p, $true)
    if ($k) { try { $k.DeleteValue($name, $false) } catch { }; $k.Close() }
  } catch { }
}
function Delete-Uc([string]$e) {
  $parent = $ucBase + '\' + $e
  $uc = $parent + '\UserChoice'
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($uc, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [System.Security.AccessControl.RegistryRights]::ChangePermissions)
    if ($k) {
      $acl = $k.GetAccessControl('Access')
      foreach ($ace in @($acl.Access)) {
        if ($ace.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) { $acl.RemoveAccessRuleSpecific($ace) | Out-Null }
      }
      $k.SetAccessControl($acl)
      $k.Close()
    }
  } catch { }
  try {
    $p = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($parent, $true)
    if ($p) { $p.DeleteSubKeyTree('UserChoice', $false); $p.Close(); return $true }
  } catch { }
  return $false
}
function Cmd-Of([string]$pg) {
  $v = ''
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($clsRoot + '\' + $pg + '\shell\open\command')
    if ($k) { $v = [string]$k.GetValue(''); $k.Close() }
  } catch { }
  if (-not $v) {
    try {
      $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($clsRoot + '\' + $pg + '\shell\open\command')
      if ($k) { $v = [string]$k.GetValue(''); $k.Close() }
    } catch { }
  }
  return $v
}
function Exe-Of([string]$c) {
  $s = ([string]$c).Trim()
  if ($s -eq '') { return '' }
  if ($s.Substring(0, 1) -eq '"') {
    $i = $s.IndexOf('"', 1)
    if ($i -gt 1) { return $s.Substring(1, $i - 1) }
    return ''
  }
  $j = $s.IndexOf(' ')
  if ($j -gt 0) { return $s.Substring(0, $j) }
  return $s
}
function Mru-Exes([string]$e) {
  $out = @()
  $k = $null
  try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ucBase + '\' + $e + '\OpenWithList') } catch { }
  if (-not $k) { return $out }
  $mru = ''
  try { $mru = [string]$k.GetValue('MRUList') } catch { }
  if ($mru) {
    for ($i = 0; $i -lt $mru.Length; $i++) {
      $c = $mru.Substring($i, 1)
      $v = $null
      try { $v = $k.GetValue($c) } catch { }
      if ($v) { $out += ([string]$v).ToLowerInvariant() }
    }
  }
  $k.Close()
  return $out
}
$script:faAllCls = $null
function All-ClassNames() {
  if ($null -ne $script:faAllCls) { return $script:faAllCls }
  $out = @()
  try {
    $r = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($clsRoot)
    if ($r) { $out += $r.GetSubKeyNames(); $r.Close() }
  } catch { }
  try {
    $r = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($clsRoot)
    if ($r) { $out += $r.GetSubKeyNames(); $r.Close() }
  } catch { }
  $script:faAllCls = $out
  return $out
}
# Browser ProgID discovery: MRU history of the extension wins (that is what the user used before),
# then a fixed install-priority list. Only ProgIDs whose executable really exists are accepted.
$faBrowserProgIds = @('ChromeHTML','MSEdgeHTM','FirefoxHTML','BraveHTML','VivaldiHTML','OperaStable','360chromeHTML','360seHTML','QQBrowserHTML','SogouExplorerHTML','UCBrowserHTML','LiebaoHTML','2345ExplorerHTML','Maxthon3HTML')
$faWebExts = @('.html','.htm','.xhtml','.shtml','.mht','.mhtml')
function Find-BrowserProgId([string]$e) {
  $mru = Mru-Exes $e
  $names = All-ClassNames
  $best = ''
  $bestRank = 1000000
  $pi = 0
  foreach ($pre in $faBrowserProgIds) {
    foreach ($n in $names) {
      if (-not $n.StartsWith($pre)) { continue }
      $exe = Exe-Of (Cmd-Of $n)
      if ($exe -eq '') { continue }
      if (-not (Test-Path -LiteralPath $exe)) { continue }
      $bn = [System.IO.Path]::GetFileName($exe).ToLowerInvariant()
      $rank = 100 + $pi
      for ($i = 0; $i -lt $mru.Count; $i++) { if ($mru[$i] -eq $bn) { $rank = $i; break } }
      if ($rank -lt $bestRank) { $bestRank = $rank; $best = $n }
    }
    $pi++
  }
  return $best
}
function Verify-Ext([string]$e) {
  if ($mode -eq 'register') {
    return (Has-Value ($clsRoot + '\' + $e + '\OpenWithProgids') $progId)
  }
  if ($verifyMode -eq 'reg') {
    $uc = Read-Value (UcPathOf $e) 'ProgId'
    return ($uc -eq $progId)
  }
  $aq = Get-AssocCmd $e
  return (($aq -ne '') -and ($aq.ToLower().Contains($mark)))
}

# --------------------------------------------------------------- cleanup mode
# Remove stale app-level blocks written by a former development instance: Applications\<exe>
# (name independent of the package) whose open command carries our mark AND points at an electron
# binary. They surface as duplicate entries in the "Open with" list. Current exe is never touched.
if ($mode -eq 'cleanup') {
  $removed = ''
  $appsRoot = $clsRoot + '\Applications'
  try {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($appsRoot)
    if ($k) {
      $names = $k.GetSubKeyNames()
      $k.Close()
      foreach ($n in $names) {
        if ($appExe -and ($n -eq $appExe)) { continue }
        $c = Read-Value ($appsRoot + '\' + $n + '\shell\open\command') ''
        $cl = $c.ToLower()
        if (($cl -ne '') -and $cl.Contains($mark) -and $cl.Contains('electron')) {
          try {
            [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($appsRoot + '\' + $n)
            $removed = $removed + $n + ';'
          } catch { }
        }
      }
    }
  } catch { }
  OutKV 'OK' '1'
  OutKV 'CODE' 'ok'
  OutKV 'DETAIL' (B64 $removed)
  if ($Error.Count -gt 0) { OutKV 'PSERR' (B64 (($Error | Select-Object -First 3 | ForEach-Object { $_.ToString() }) -join ' | ')) }
  exit 0
}

# --------------------------------------------------------------- state mode
# Read-only snapshot for the settings panel's per-extension card:
#   taken = the effective handler is us (mark inside the association command)
#   cand  = we are listed in the "Open with" candidate surface
#   free  = neither
if ($mode -eq 'state') {
  $detail = ''
  $n = 0
  foreach ($e in $exts) {
    $n++
    $st = 'free'
    if (Has-Value ($clsRoot + '\' + $e + '\OpenWithProgids') $progId) { $st = 'cand' }
    $aq = Get-AssocCmd $e
    if (($aq -ne '') -and ($aq.ToLower().Contains($mark))) { $st = 'taken' }
    $detail = $detail + $e + '=' + $st + ';'
  }
  OutKV 'OK' '1'
  OutKV 'CODE' 'ok'
  OutKV 'TOTAL' ([string]$n)
  OutKV 'TAKEN' '0'
  OutKV 'DETAIL' (B64 $detail)
  if ($Error.Count -gt 0) { OutKV 'PSERR' (B64 (($Error | Select-Object -First 3 | ForEach-Object { $_.ToString() }) -join ' | ')) }
  exit 0
}

if ($mode -eq 'apply' -or $mode -eq 'register') {
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
    $cap = $capRoot + '\' + $capName
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
    # Migration: this domain used to share ONE Capabilities block with the other domain (only one
    #   ApplicationName can live there, so the two entries overwrote each other's display name).
    #   Drop OUR extensions from that shared table (the two domains have zero extension overlap),
    #   so each domain now owns its own block.
    if ($capName -ne 'PlayerCapabilities') {
      $oldCap = $capRoot + '\PlayerCapabilities\FileAssociations'
      foreach ($e in $exts) { Del-Value $oldCap $e }
    }
  } catch { }
  if ($appExe -and $appCmd) {
    # App-level candidate surface: Applications\<exe> (FriendlyAppName + SupportedTypes + command).
    # Command = --qqqide-open (routes by extension: text -> editor, media -> player).
    # SCRIPT BODY MUST STAY PURE ASCII (see note in the main apply block below).
    try {
      $appKey = $clsRoot + '\Applications\' + $appExe
      $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($appKey)
      $k.SetValue('FriendlyAppName', $appFriend, 'String')
      $k.Close()
      $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($appKey + '\shell\open\command')
      $k.SetValue('', $appCmd, 'String')
      $k.Close()
      if ($icon) {
        $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($appKey + '\DefaultIcon')
        $k.SetValue('', $icon, 'String')
        $k.Close()
      }
      if ($appTypes) {
        $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($appKey + '\SupportedTypes')
        foreach ($t in ($appTypes -split ';')) { $tv = $t.Trim(); if ($tv -ne '') { $k.SetValue($tv, '', 'String') } }
        $k.Close()
      }
    } catch { }
  }
  $total = 0
  $taken = 0
  $fails = ''
  foreach ($e in $exts) {
    $total++
    try {
      $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($clsRoot + '\' + $e + '\OpenWithProgids')
      if ($k) { $k.SetValue($progId, [byte[]]@(), 'Binary'); $k.Close() }
    } catch { }
    if ($mode -ne 'register') { Write-Uc $e | Out-Null }
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

# --------------------------------------------------------------- release mode
# Give extensions back: drop our candidate surface, and if we own the default slot hand it back
# (web family -> an installed browser ProgID; anything else -> delete UserChoice; shell decides again).
if ($mode -eq 'release') {
  $total = 0
  $taken = 0
  $fails = ''
  $detail = ''
  foreach ($e in $exts) {
    $total++
    $ok = $true
    Del-Value ($clsRoot + '\' + $e + '\OpenWithProgids') $progId
    Del-Value ($capRoot + '\' + $capName + '\FileAssociations') $e
    if ($appExe) { Del-Value ($clsRoot + '\Applications\' + $appExe + '\SupportedTypes') $e }
    $act = 'free'
    $cur = Read-Value (UcPathOf $e) 'ProgId'
    $aqNow = Get-AssocCmd $e
    # Ours = UserChoice ProgId or the app-level ProgId (Applications\<exe>) whose command carries our mark.
    $oursNow = ($cur -eq $progId)
    if (($aqNow -ne '') -and ($aqNow.ToLower().Contains($mark))) { $oursNow = $true }
    if ($oursNow) {
      $target = ''
      $isWeb = $false
      foreach ($we in $faWebExts) { if ($we -eq $e) { $isWeb = $true } }
      if ($isWeb) { $target = Find-BrowserProgId $e }
      if ($target -ne '') {
        if (Write-UcTarget $e $target) { $act = 'to:' + $target } else { $act = 'write-failed'; $ok = $false }
      } else {
        if (Delete-Uc $e) { $act = 'cleared' } else { $act = 'clear-failed'; $ok = $false }
      }
    }
    if ($ok) { $taken++ } else { $fails = $fails + $e + ';' }
    $detail = $detail + $e + '=' + $act + ';'
  }
  [QS]::NotifyAssocChanged()
  OutKV 'OK' $(if ($taken -eq $total) { '1' } else { '0' })
  OutKV 'CODE' $(if ($taken -eq $total) { 'ok' } else { 'partial' })
  OutKV 'TOTAL' ([string]$total)
  OutKV 'TAKEN' ([string]$taken)
  OutKV 'FAILS' (B64 $fails)
  OutKV 'DETAIL' (B64 $detail)
  if ($Error.Count -gt 0) { OutKV 'PSERR' (B64 (($Error | Select-Object -First 3 | ForEach-Object { $_.ToString() }) -join ' | ')) }
  exit 0
}

OutKV 'OK' '0'
OutKV 'CODE' 'bad-mode'
exit 0
`;
