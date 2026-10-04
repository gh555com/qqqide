// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
//
// syspy-ps.ts — 系统解释器机器（ipc-syspy.ts）的 PowerShell 脚本体（纯常量，只搬移不加工）。
//
// ⚠ 兼容铁律（与 ipc-syspy.ts 头注释同源；改脚本必须复核）：
//   PS2.0 兼容（Win7 出厂）：禁 PS3.0+ 构造（PSTypeName 等）；禁 .NET4 API（RegistryKey.Handle 等）——
//   注册表 FT 读取走原生 RegOpenKeyExW（QS.GetKeyFT）；脚本恒经 stdin（-Command -）传入（PS2 引擎仅此
//   模式正常执行并退出），全程 ASCII；输出 QQQIDE_SYSPY_* 行协议（-Command - 携带前缀参数）。

// ── PS 脚本（公共头：C# 算法 + 辅助函数） ──
export const PS_HEAD = String.raw`
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
$script:aqRc = -1
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
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  public static extern int RegOpenKeyExW(IntPtr hKey, string lpSubKey, int ulOptions, int samDesired, out IntPtr phkResult);
  [DllImport("advapi32.dll")]
  public static extern int RegCloseKey(IntPtr hKey);
  public static int Ping() { return 1; }
  // Key last-write FILETIME via native open (CLR2-safe: RegistryKey.Handle is .NET 4.0-only and
  // breaks under Windows PowerShell 2.0 / Win7 in-box).
  public static long GetKeyFT(string subKey) {
    IntPtr hk = IntPtr.Zero;
    int rc = RegOpenKeyExW(new IntPtr(unchecked((int)0x80000001)), subKey, 0, 0x20019, out hk);
    if (rc != 0) { return 0; }
    long ft = 0;
    RegQueryInfoKey(hk, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out ft);
    RegCloseKey(hk);
    return ft;
  }
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
$qsOk = $true
try { $null = [QS]::Ping() } catch { $qsOk = $false }
if (-not $qsOk) { OutKV 'OK' '0'; OutKV 'CODE' 'ps-init-failed'; exit 0 }

function Get-KeyFT([string]$p) {
  try { return [QS]::GetKeyFT($p) } catch { }
  return [long]0
}
function Get-AssocCmd([string]$e) {
  $sb = New-Object System.Text.StringBuilder 4096
  $n = 4096
  $rc = [QS]::AssocQueryString(0, 1, $e, 'open', $sb, [ref]$n)
  $script:aqRc = $rc
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
export const PS_BODY = String.raw`
if ($mode -eq 'check') {
  $exeOk = $false
  if ($exe -and (Test-Path $exe)) { $exeOk = $true }
  $aq = Get-AssocCmd $ext
  $ucProgId = Read-Value $ucPath 'ProgId'
  $uclProgId = Read-Value ('Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext + '\UserChoiceLatest\ProgId') 'ProgId'
  # Classification semantics (2026-10-02): mode reflects what the system REALLY resolves.
  # System-level defaults (exe under %SystemRoot% / OpenWith.exe / dead path) are NOT an
  # "existing interpreter" -> none (no bogus overwrite confirmation); only a real
  # third-party handler -> other. Our own leftover registration never counts as other.
  $aqL = $aq.ToLower()
  $exeL = ''
  if ($exe) { $exeL = $exe.ToLower() }
  $ours = $false
  if ($exeOk -and $aq -ne '') {
    if ($aqL.Contains($exeL)) { $ours = $true }
    elseif ($aqL -match '\\engines\\(python|node)\\') { $ours = $true }
  }
  $code = 'none'
  if ($ours) { $code = 'ours' }
  elseif ($aq -ne '') {
    $aqExe = ''
    if ($aq -match '^\s*"([^"]+\.exe)"') { $aqExe = $Matches[1] }
    elseif ($aq -match '^\s*([^\s"]+\.exe)') { $aqExe = $Matches[1] }
    if ($aqExe -ne '') {
      $aqExeL = $aqExe.ToLower()
      $isSys = $false
      if ($env:SystemRoot -and $aqExeL.StartsWith(($env:SystemRoot.ToLower() + '\'))) { $isSys = $true }
      if ($aqExeL.EndsWith('openwith.exe')) { $isSys = $true }
      if (-not (Test-Path $aqExe)) { $isSys = $true }
      if (-not $isSys) { $code = 'other' }
    }
  }
  OutKV 'OK' '1'
  OutKV 'CODE' $code
  OutKV 'EXE_OK' $(if ($exeOk) { '1' } else { '0' })
  OutKV 'AQ' (B64 $aq)
  OutKV 'AQRC' ([string]$script:aqRc)
  $ucEx = '0'
  try { $uk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ucPath); if ($uk) { $ucEx = '1'; $uk.Close() } } catch { }
  OutKV 'UC_EXISTS' $ucEx
  $uclEx = '0'
  try { $uk2 = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext + '\UserChoiceLatest'); if ($uk2) { $uclEx = '1'; $uk2.Close() } } catch { }
  OutKV 'UCL_EXISTS' $uclEx
  $ucOut = $uclProgId
  if (-not $ucOut) { $ucOut = $ucProgId }
  OutKV 'UC_PROGID' (B64 $ucOut)
  exit 0
}

if ($mode -eq 'apply') {
  # 0. bundled python existence
  if (-not ($exe -and (Test-Path $exe))) { OutKV 'OK' '0'; OutKV 'CODE' 'no-python'; exit 0 }
  $blocked = $false
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
    if ($ft -le 0) { $vc = 'no-ft'; break }
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
  if (-not $hOk -and $vc -eq 'v1') { $vc = 'v1-retry-fail' }

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
    # fallback 2.9 (2026-10-02): system user-choice protection - our full HKCU state is in place
    # yet the system ignores it (.js on Win11 25H2; also Win10 builds carrying the UCPD back-port):
    # a UAC/HKLM write is lower-priority and equally useless -> skip it, flag blocked, let the
    # guided flow ask the user to pick once.
    $cmdNow = Read-Value ('Software\Classes\' + $progId + '\shell\open\command') ''
    $defNow = Read-Value ('Software\Classes\' + $ext) ''
    $buildN = 0
    try { $buildN = [int][Environment]::OSVersion.Version.Build } catch { }
    $ucpd = $false
    try { if ($env:SystemRoot) { $ucpd = Test-Path ($env:SystemRoot + '\System32\drivers\UCPD.sys') } } catch { }
    if (($cmdNow -eq $cmdline) -and ($defNow -eq $progId) -and (($buildN -ge 22000) -or $ucpd)) {
      $blocked = $true
      $vc = 'blocked'
    }
  }

  if (-not $pass -and -not $blocked) {
    # fallback 3: UAC -> HKLM (machine-wide assoc incl. default value + OpenWithProgids)
    $vc = 'hklm'
    $tmpReg = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('qqqide-syspy-' + $PID + '.reg'))
    $esc = $cmdline.Replace('\', '\\').Replace('"', '\"')
    $crlf = [string][char]13 + [string][char]10
    $q = [string][char]34
    $regText = 'Windows Registry Editor Version 5.00' + $crlf + $crlf + '[HKEY_LOCAL_MACHINE\Software\Classes\' + $progId + '\shell\open\command]' + $crlf + '@=' + $q + $esc + $q + $crlf + $crlf + '[HKEY_LOCAL_MACHINE\Software\Classes\' + $ext + ']' + $crlf + '@=' + $q + $progId + $q + $crlf + $crlf + '[HKEY_LOCAL_MACHINE\Software\Classes\' + $ext + '\OpenWithProgids]' + $crlf + $q + $progId + $q + '=hex(0):' + $crlf
    $regText | Out-File -FilePath $tmpReg -Encoding Unicode
    $uacRc = -1
    try {
      $uac = Start-Process -FilePath 'reg.exe' -ArgumentList @('import', ('"' + $tmpReg + '"')) -Verb RunAs -Wait -PassThru
      if ($uac) { try { $ec = $uac.ExitCode; if ($null -ne $ec) { $uacRc = [int]$ec } } catch { } }
    } catch { $uacRc = -2 }
    Remove-Item $tmpReg -ErrorAction SilentlyContinue
    # UAC truth readback (2026-10-02): RunAs+PassThru ExitCode may be unavailable (null) -- HKLM command already written => treat as authorized (read-back truth, zero false positive)
    if ($uacRc -ne 0) {
      $hklmNow = ''
      try { $hk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('Software\Classes\' + $progId + '\shell\open\command'); if ($hk) { $hklmNow = [string]$hk.GetValue(''); $hk.Close() } } catch { }
      if ($hklmNow -eq $cmdline) { $uacRc = 0 }
    }
    OutKV 'UAC_RC' ([string]$uacRc)
    if ($uacRc -ne 0) { OutKV 'OK' '0'; OutKV 'CODE' 'uac-cancelled'; exit 0 }
    [QS]::BroadcastEnv()
    $aq = Get-AssocCmd $ext
    $pass = ($aq -ne '') -and ($aq.ToLower().Contains($exeLower))
  }

  if ($pass) { [QS]::NotifyAssocChanged() }

  OutKV 'OK' $(if ($pass) { '1' } else { '0' })
  OutKV 'CODE' $(if ($pass) { 'ok' } else { 'verify-failed' })
  OutKV 'VIA' $vc
  OutKV 'BLOCKED' $(if ($blocked) { '1' } else { '0' })
  OutKV 'AQ' (B64 $aq)
  OutKV 'AQRC' ([string]$script:aqRc)
  OutKV 'UC_PROGID2' (B64 (Read-Value $ucPath 'ProgId'))
  $hh = '0'
  if ((Read-Value $ucPath 'Hash') -ne '') { $hh = '1' }
  OutKV 'UC_HASH2' $hh
  OutKV 'EXT_DEF2' (B64 (Read-Value ('Software\Classes\' + $ext) ''))
  if ($Error.Count -gt 0) { OutKV 'PSERR' (B64 (($Error | Where-Object { $_.ToString() -notmatch 'DeleteSubKeyTree|ReadLine|IncompleteParseException' } | Select-Object -First 3 | ForEach-Object { $_.ToString() }) -join ' | ')) }
  exit 0
}

if ($mode -eq 'picker' -or $mode -eq 'finalize') {
  # Guided flow (2026-10-02): register the app so it is visible in the system picker, then either
  # open the picker (mode=picker) or only re-normalize our registration (mode=finalize, idempotent).
  if (-not ($exe -and (Test-Path $exe))) { OutKV 'OK' '0'; OutKV 'CODE' 'no-python'; exit 0 }
  $mid = ''
  if ($flags -ne '') { $mid = ' ' + $flags }
  $cmdline = '"' + $exe + '"' + $mid + ' "%1" %*'
  if ($wrap -eq 'pause') { $cmdline = 'cmd.exe /d /s /c "' + '"' + $exe + '"' + $mid + ' "%1" %* & pause"' }
  # Visibility rule (2026-10-02, isolated via the OS recommended-handlers API): the system picker
  # only lists a DIRECT command; a cmd-wrapped command hides the whole entry from the user.
  # So the picker phase writes the direct form (visible to the user) and finalize then normalizes
  # back to the wrapped form (run-window stays open). The association only points at this key, so
  # the rewrite after the user's pick is honored (verified on a real 25H2 machine).
  $cmdDirect = '"' + $exe + '"' + $mid + ' "%1" %*'
  $appCmd = $cmdline
  if ($mode -eq 'picker') { $appCmd = $cmdDirect }
  $appName = $env:QQQIDE_SYSPY_APPNAME
  if (-not $appName) { $appName = 'Node (qd)' }
  $appDesc = $env:QQQIDE_SYSPY_APPDESC
  if (-not $appDesc) { $appDesc = 'Run scripts with the built-in interpreter of qd (qqqide)' }
  $appKey = [System.IO.Path]::GetFileName($exe)
  $allex = @()
  if ($env:QQQIDE_SYSPY_ALLEXT) { foreach ($e2 in ($env:QQQIDE_SYSPY_ALLEXT -split ';')) { if ($e2) { $allex += $e2 } } }
  if ($allex.Count -eq 0) { $allex = @($ext) }
  $cr = [Microsoft.Win32.Registry]::CurrentUser
  try {
    $k = $cr.CreateSubKey('Software\Classes\Applications\' + $appKey)
    $k.SetValue('', $appName, 'String')
    $k.SetValue('FriendlyAppName', $appName, 'String')
    $k.Close()
  } catch { }
  try {
    $k = $cr.CreateSubKey('Software\Classes\Applications\' + $appKey + '\DefaultIcon')
    $k.SetValue('', ('"' + $exe + '",0'), 'String')
    $k.Close()
  } catch { }
  try {
    $k = $cr.CreateSubKey('Software\Classes\Applications\' + $appKey + '\shell\open\command')
    $k.SetValue('', $appCmd, 'String')
    $k.Close()
  } catch { }
  try {
    $k = $cr.CreateSubKey('Software\Classes\Applications\' + $appKey + '\SupportedTypes')
    foreach ($e2 in $allex) { $k.SetValue($e2, '', 'String') }
    $k.Close()
  } catch { }
  try {
    $k = $cr.CreateSubKey('Software\qqqide\Capabilities')
    $k.SetValue('ApplicationName', $appName, 'String')
    $k.SetValue('ApplicationDescription', $appDesc, 'String')
    $k.Close()
  } catch { }
  try {
    $k = $cr.CreateSubKey('Software\qqqide\Capabilities\FileAssociations')
    foreach ($e2 in $allex) { $k.SetValue($e2, $progId, 'String') }
    $k.Close()
  } catch { }
  try {
    $k = $cr.CreateSubKey('Software\RegisteredApplications')
    $k.SetValue($appName, 'Software\qqqide\Capabilities', 'String')
    $k.Close()
  } catch { }
  try {
    $lk = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('Software\RegisteredApplications')
    $lk.SetValue($appName, 'Software\qqqide\Capabilities', 'String')
    $lk.Close()
  } catch { }
  foreach ($e2 in $allex) {
    try {
      $k = $cr.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $e2 + '\OpenWithList')
      $names = $k.GetValueNames()
      $mru = ''
      $exists = $false
      $used = @{}
      foreach ($n in $names) {
        if ($n -eq 'MRUList') { $mru = [string]$k.GetValue('MRUList', ''); continue }
        $used[$n] = $true
        $v = [string]$k.GetValue($n, '')
        if ($v -ieq $appKey) { $exists = $true }
      }
      if (-not $exists) {
        $letter = ''
        foreach ($c in [char[]]'abcdefghijklmnopqrstuvwxyz') { if (-not $used.ContainsKey([string]$c)) { $letter = [string]$c; break } }
        if ($letter -ne '') {
          $k.SetValue($letter, $appKey, 'String')
          $k.SetValue('MRUList', ($letter + $mru), 'String')
        }
      }
      $k.Close()
    } catch { }
  }
  [QS]::NotifyAssocChanged()
  OutKV 'APPS' '1'
  if ($mode -eq 'picker') {
    # Sample goes to the DESKTOP (findable by the user): once the OS protects the extension a real
    # user double-click is the only reliable way to raise the picker; the auto-launch below is a
    # best-effort bonus (invisible on protected 25H2 builds, harmless everywhere else).
    $sampleDir = ''
    try { $sampleDir = [Environment]::GetFolderPath('Desktop') } catch { }
    if (-not $sampleDir -or -not (Test-Path $sampleDir)) { $sampleDir = $env:TEMP }
    $sample = Join-Path $sampleDir ('qqqide-setup' + $ext)
    $crlf2 = [string][char]13 + [string][char]10
    $content = "console.log('qqqide node is ready.');" + $crlf2
    if ($ext -eq '.py') { $content = "print('qqqide python is ready.')" + $crlf2 }
    try { [System.IO.File]::WriteAllText($sample, $content); OutKV 'SAMPLE' (B64 $sample) } catch { OutKV 'SAMPLE' '' }
    $launch = 'none'
    try {
      $ow = Join-Path $env:SystemRoot 'System32\OpenWith.exe'
      if (Test-Path $ow) {
        Start-Process -FilePath $ow -ArgumentList ('"' + $sample + '"') | Out-Null
        $launch = 'openwith'
      } else {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\rundll32.exe') -ArgumentList @('shell32.dll,OpenAs_RunDLL', ('"' + $sample + '"')) | Out-Null
        $launch = 'rundll32'
      }
    } catch { }
    OutKV 'LAUNCH' $launch
    OutKV 'EXE' (B64 $exe)
  } else {
    $dirs2 = @()
    try { $d2 = [Environment]::GetFolderPath('Desktop'); if ($d2) { $dirs2 += $d2 } } catch { }
    if ($env:TEMP) { $dirs2 += $env:TEMP }
    foreach ($d3 in $dirs2) {
      foreach ($e3 in ($allex + @($ext))) {
        try {
          $s2 = Join-Path $d3 ('qqqide-setup' + $e3)
          if (Test-Path $s2) { Remove-Item $s2 -Force -ErrorAction SilentlyContinue }
        } catch { }
      }
    }
  }
  OutKV 'OK' '1'
  OutKV 'CODE' 'ok'
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
  # 1b) UserChoiceLatest (Win11 user-choice protection carrier - the entry the user picked by hand;
  #     best effort delete, never blocks)
  $fxPathR = 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext
  try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($fxPathR + '\UserChoiceLatest'); $clean = $clean + 'ucl;' } catch { }
  # 1c) Applications\<exe> app registration + RegisteredApplications/Capabilities + OpenWithList
  #     (the "xx (qd)" entries shown in the system picker)
  $appKeyR = ''
  if ($exe) { $appKeyR = [System.IO.Path]::GetFileName($exe) }
  $appNameR = $env:QQQIDE_SYSPY_APPNAME
  if (-not $appNameR) { $appNameR = 'Node (qd)' }
  if ($appKeyR -ne '') {
    $appCmdR = Read-Value ('Software\Classes\Applications\' + $appKeyR + '\shell\open\command') ''
    if (($exeLower -ne '') -and ($appCmdR -ne '') -and $appCmdR.ToLower().Contains($exeLower)) {
      try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\Classes\Applications\' + $appKeyR); $clean = $clean + 'apps;' } catch { }
    }
    foreach ($e3 in ($env:QQQIDE_SYSPY_ALLEXT -split ';')) {
      if (-not $e3) { continue }
      try {
        $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $e3 + '\OpenWithList', $true)
        if ($k) {
          $rmN = @()
          foreach ($n in $k.GetValueNames()) {
            if ($n -eq 'MRUList') { continue }
            if ([string]$k.GetValue($n, '') -ieq $appKeyR) { $rmN += $n }
          }
          foreach ($n in $rmN) { try { $k.DeleteValue($n, $false); $clean = $clean + 'owl;' } catch { } }
          if ($rmN.Count -gt 0) {
            $mruR = [string]$k.GetValue('MRUList', '')
            foreach ($n in $rmN) { $mruR = $mruR.Replace($n, '') }
            $k.SetValue('MRUList', $mruR, 'String')
          }
          $k.Close()
        }
      } catch { }
    }
  }
  $raVal = Read-Value 'Software\RegisteredApplications' $appNameR
  if ($raVal -ne '') {
    try { $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\RegisteredApplications', $true); if ($k) { $k.DeleteValue($appNameR, $false); $k.Close(); $clean = $clean + 'ra;' } } catch { }
  }
  try {
    $lkR = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('Software\RegisteredApplications', $true)
    if ($lkR) {
      if ($lkR.GetValue($appNameR) -ne $null) { $lkR.DeleteValue($appNameR, $false); $clean = $clean + 'ra-hk;' }
      $lkR.Close()
    }
  } catch { }
  try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('Software\qqqide\Capabilities'); $clean = $clean + 'cap;' } catch { }
  # 1d) guided-flow sample files (desktop + temp) - clean back to a blank slate
  $dirsR = @()
  try { $dR = [Environment]::GetFolderPath('Desktop'); if ($dR) { $dirsR += $dR } } catch { }
  if ($env:TEMP) { $dirsR += $env:TEMP }
  foreach ($dR2 in $dirsR) {
    foreach ($eR in ($env:QQQIDE_SYSPY_ALLEXT -split ';')) {
      if (-not $eR) { continue }
      try {
        $sR = Join-Path $dR2 ('qqqide-setup' + $eR)
        if (Test-Path $sR) { Remove-Item $sR -Force -ErrorAction SilentlyContinue; $clean = $clean + 'smp;' }
      } catch { }
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
