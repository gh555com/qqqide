// spawn.rs — ghrun spawn subcommand (one-shot process execution)
//
// Protocol (matches qz-spawn.ts ghrunTier):
//   stdin : {"cmd":"...","args":[...],"cwd":"...","env":{...},"timeout":30000,"stallMs":0,"captureOutput":true}
//   stdout: last line = {"exitCode":0,"stdout":"...","stderr":"...","killReason":""}
//
// Anti-hang (surpasses runner.py):
//   - deadline watchdog: absolute timeout → tree kill
//   - stall watchdog: no-output detection → tree kill (100ms granularity, vs runner.py 50ms)
//   - Windows: CREATE_NEW_PROCESS_GROUP + CREATE_NO_WINDOW + taskkill /F /T
//   - POSIX:   process_group(0) → killpg via kill -9 -<pid> (+ fallback kill -9)
//   - stdin=DEVNULL, stdout/stderr captured in threads with incremental I/O
//   - Output safety-net cap (64KB) — prevents unbounded memory; AI-facing limit is in tools.js
//   - Spawn error differentiation: not-found / permission-denied / spawn-error
//   - Atomic I/O timestamps (no GC pause risk)

use serde::Deserialize;
use serde_json;
use std::io::{Read, BufRead};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
#[cfg(windows)]
use std::os::windows::{process::CommandExt as _, io::AsRawHandle};
#[cfg(windows)]
struct JobHandle(isize);
#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { CloseHandle(self.0); }
        }
    }
}

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Safety-net output cap: prevents unbounded memory consumption.
/// This is NOT the AI-facing limit — that lives in tools.js (OUTPUT_DEFAULT / OUTPUT_MAX).
/// Set generously so it never interferes with the AI-facing cap.
const MAX_OUTPUT: usize = 65536;

// ── Windows Job Object FFI (B2: per-process memory limit) ──
#[cfg(windows)]
extern "system" {
    fn CreateJobObjectW(
        lpJobAttributes: *mut std::ffi::c_void,
        lpName: *const u16,
    ) -> isize;
    fn SetInformationJobObject(
        hJob: isize,
        JobObjectInfoClass: i32,
        lpJobObjectInfo: *const std::ffi::c_void,
        cbJobObjectInfoLength: u32,
    ) -> i32;
    fn AssignProcessToJobObject(hJob: isize, hProcess: isize) -> i32;
    fn CloseHandle(hObject: isize) -> i32;
}

#[cfg(windows)]
#[repr(C)]
struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    PerProcessUserTimeLimit: i64,
    PerJobUserTimeLimit: i64,
    LimitFlags: u32,
    MinimumWorkingSetSize: usize,
    MaximumWorkingSetSize: usize,
    ActiveProcessLimit: u32,
    Affinity: usize,
    PriorityClass: u32,
    SchedulingClass: u32,
}

#[cfg(windows)]
#[repr(C)]
struct IO_COUNTERS {
    ReadOperationCount: u64,
    WriteOperationCount: u64,
    OtherOperationCount: u64,
    ReadTransferCount: u64,
    WriteTransferCount: u64,
    OtherTransferCount: u64,
}

#[cfg(windows)]
#[repr(C)]
struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    basic_limit_information: JOBOBJECT_BASIC_LIMIT_INFORMATION,
    io_info: IO_COUNTERS,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[derive(Deserialize)]
struct SpawnBrief {
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    timeout: u64, // ms; 0 = no deadline
    #[serde(default = "default_true", rename = "captureOutput")]
    capture_output: bool,
    #[serde(default, rename = "stallMs")]
    stall_ms: u64,
    #[serde(default, rename = "memLimitMb")]
    mem_limit_mb: u64, // 0 = no limit; >0 = assign child to a Windows Job Object with this RSS cap
    #[serde(default)]
    shell: bool, // true = cmd is a full OS command line (Windows: cmd.exe /d /s /c; POSIX: /bin/sh -c)
}

fn default_true() -> bool {
    true
}

/// Kill a process tree.
/// Windows: taskkill /F /T /PID  — kills entire job tree (child has own process group).
/// POSIX:   SIGTERM → 2s grace → SIGKILL killpg — gives processes a chance to flush.
fn tree_kill(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    #[cfg(not(windows))]
    {
        // SIGTERM first → gives child a chance to flush buffers / clean up
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", pid)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        thread::sleep(Duration::from_millis(2000));
        // kill -9 -<pid> → SIGKILL to entire process group (negative PID = PGID)
        let _ = Command::new("kill")
            .args(["-9", &format!("-{}", pid)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        // Defense-in-depth: also try direct kill in case process_group(0) failed
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

/// Emit a valid JSON brief to stdout and exit cleanly.
/// Output is capped at MAX_OUTPUT — runner.py never had this protection.
fn emit(exit_code: i32, mut stdout: String, mut stderr: String, kill_reason: &str) {
    if stdout.len() > MAX_OUTPUT {
        stdout = format!("{}...(truncated)", &stdout[..MAX_OUTPUT]);
    }
    if stderr.len() > MAX_OUTPUT {
        stderr.truncate(MAX_OUTPUT);
        stderr.push_str("...(truncated)");
    }
    let brief = serde_json::json!({
        "exitCode": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "killReason": kill_reason,
    });
    println!("{}", brief);
}

pub fn run() -> Result<(), String> {
    // ── 1. read one line of JSON from stdin ──
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| format!("stdin read: {}", e))?;
    let brief: SpawnBrief = serde_json::from_str(line.trim())
        .map_err(|e| format!("bad spawn brief JSON: {}", e))?;

      // ── 2. build command ──
    // ★ shell channel (v0.2.0): brief.shell=true → cmd 是整串 OS 命令行，走系统 shell。
    //   Windows: cmd.exe /d /s /c "<整串>" — raw_arg 原样拼接（禁 MSVCRT 引号转义，
    //   否则内部引号被转成 \" 后 cmd 当字面字符处理，命令崩坏）。
    //   外层强制包引号: /s 标志剥最外层一对引号，内部引号原样保留 →
    //   与 Node shell:true 行为一致（cd /d 生效 / 含空格路径安全 / 嵌套引号安全）。
    //   POSIX:   /bin/sh -c "<整串>"（argv 直传，无引号剥离问题）。
    //   Job Object / setrlimit 照常生效 → 整串命令同样享受内核级内存保护。
    let mut cmd;
    #[cfg(windows)]
    {
        if brief.shell {
            let wrapped = format!("\"{}\"", brief.cmd);
            cmd = Command::new("cmd.exe");
            cmd.raw_arg("/d").raw_arg("/s").raw_arg("/c").raw_arg(&wrapped);
        } else {
            cmd = Command::new(&brief.cmd);
            cmd.args(&brief.args);
        }
    }
    #[cfg(not(windows))]
    {
        if brief.shell {
            cmd = Command::new("/bin/sh");
            cmd.arg("-c").arg(&brief.cmd);
        } else {
            cmd = Command::new(&brief.cmd);
            cmd.args(&brief.args);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(ref cwd) = brief.cwd {
        if !std::path::Path::new(cwd).is_dir() {
            emit(-1, String::new(), format!("cwd-not-dir: {}", cwd), "spawn-error");
            return Ok(());
        }
        cmd.current_dir(cwd);
    }
    if let Some(ref env) = brief.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    // Platform-specific process isolation (full parity with runner.py):
    //   Windows: CREATE_NEW_PROCESS_GROUP → child owns its process group
    //            CREATE_NO_WINDOW          → no console flash
    //   POSIX:   process_group(0)         → child is session leader
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    #[cfg(unix)]
    cmd.process_group(0);

    // ── Linux/macOS memory limit via setrlimit(RLIMIT_AS) in pre_exec ──
    // Equivalent to Windows Job Object's process_memory_limit.
    // RLIMIT_AS limits virtual address space (≈ RSS + swap). Inherited by fork().
    // Unlike Job Objects which track tree total, setrlimit caps each process individually.
    // The JS-layer memory guard provides tree-level monitoring as a fallback.
    #[cfg(unix)]
    let mem_limit_bytes = (brief.mem_limit_mb as usize) * 1024 * 1024;
    #[cfg(unix)]
    if mem_limit_bytes > 0 {
        unsafe {
            cmd.pre_exec(move || {
                let rlim = libc::rlimit {
                    rlim_cur: mem_limit_bytes as u64,
                    rlim_max: mem_limit_bytes as u64,
                };
                if libc::setrlimit(libc::RLIMIT_AS, &rlim) != 0 {
                    // Non-fatal: process can still run, just without memory cap
                    eprintln!("ghrun: setrlimit(RLIMIT_AS) failed — running without memory limit");
                }
                Ok(())
            });
        }
    }

    // ── 3. spawn ──
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            // Differentiate spawn errors (runner.py only caught FileNotFound generically)
            let reason = match e.kind() {
                std::io::ErrorKind::NotFound => "not-found",
                std::io::ErrorKind::PermissionDenied => "permission-denied",
                _ => "spawn-error",
            };
            emit(-1, String::new(), format!("{}({}): {}", reason, brief.cmd, e), reason);
            return Ok(());
        }
    };
    let pid = child.id();

    // ── 3.5 Windows Job Object — enforce per-process memory limit (B2) ──
    #[cfg(windows)]
    let _job_handle: Option<JobHandle> = if brief.mem_limit_mb > 0 {
        unsafe {
            let job_name: Vec<u16> = format!("ghrun_job_{}", pid)
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let job = CreateJobObjectW(std::ptr::null_mut(), job_name.as_ptr());
            if job != 0 {
                let mem_bytes = (brief.mem_limit_mb as usize) * 1024 * 1024;
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.basic_limit_information.LimitFlags = 0x0000_0100; // JOB_OBJECT_LIMIT_PROCESS_MEMORY
                info.process_memory_limit = mem_bytes;
                let ret = SetInformationJobObject(
                    job,
                    9, // JobObjectExtendedLimitInformation
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ret != 0 {
                    let child_handle = child.as_raw_handle() as isize;
                    AssignProcessToJobObject(job, child_handle);
                    Some(JobHandle(job))
                } else {
                    CloseHandle(job);
                    None
                }
            } else {
                None
            }
        }
    } else {
        None
    };
    #[cfg(not(windows))]
    let _job_handle: Option<()> = None;

    // ── 4. deadline watchdog ──
    let killed = Arc::new(AtomicBool::new(false));
    let stall_killed = Arc::new(AtomicBool::new(false));
    let deadline_ms = if brief.timeout > 0 {
        brief.timeout
    } else {
        0
    };
    if deadline_ms > 0 {
        let killed2 = Arc::clone(&killed);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(deadline_ms));
            killed2.store(true, Ordering::SeqCst);
            tree_kill(pid);
        });
    }

    // ── 5. stall watchdog (100ms granularity: finer than runner.py's 50ms where it matters) ──
    let last_io = Arc::new(AtomicU64::new(
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
    ));
    let stall = brief.stall_ms;

    if stall > 0 {
        let killed3 = Arc::clone(&killed);
        let stall_killed2 = Arc::clone(&stall_killed);
        let last_io2 = Arc::clone(&last_io);
        thread::spawn(move || {
            // stall/10 → at most 10% overshoot (matched to runner.py 50ms granularity)
            let check = std::cmp::max(50, stall / 10);
            loop {
                thread::sleep(Duration::from_millis(check));
                if killed3.load(Ordering::SeqCst) {
                    return;
                }
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                if now.saturating_sub(last_io2.load(Ordering::SeqCst)) > stall {
                    stall_killed2.store(true, Ordering::SeqCst);
                    killed3.store(true, Ordering::SeqCst);
                    tree_kill(pid);
                    return;
                }
            }
        });
    }

    // ── 6. read stdout/stderr in background threads (incremental I/O, 4KB chunks) ──
    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();

    if brief.capture_output {
        let mut child_out = child.stdout.take().unwrap();
        let mut child_err = child.stderr.take().unwrap();

        let last_io_out = Arc::clone(&last_io);
        let out_thread = thread::spawn(move || {
            let mut s = String::new();
            let mut buf = [0u8; 4096];
            loop {
                match child_out.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        s.push_str(&String::from_utf8_lossy(&buf[..n]));
                        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        last_io_out.store(ts, Ordering::SeqCst);
                    }
                    Err(_) => break,
                }
            }
            s
        });

        let last_io_err = Arc::clone(&last_io);
        let err_thread = thread::spawn(move || {
            let mut s = String::new();
            let mut buf = [0u8; 4096];
            loop {
                match child_err.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        s.push_str(&String::from_utf8_lossy(&buf[..n]));
                        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        last_io_err.store(ts, Ordering::SeqCst);
                    }
                    Err(_) => break,
                }
            }
            s
        });

        stdout_buf = out_thread.join().unwrap_or_default();
        stderr_buf = err_thread.join().unwrap_or_default();
    }

    // ── 7. wait for child ──
    let status = match child.wait() {
        Ok(s) => s,
        Err(e) => {
            emit(-1, stdout_buf, format!("wait: {}", e), "spawn-error");
            return Ok(());
        }
    };
    let exit_code = status.code().unwrap_or(-1);
    let kill_reason = if stall_killed.load(Ordering::SeqCst) {
        "stall"
    } else if killed.load(Ordering::SeqCst) {
        "deadline"
    } else {
        ""
    };

    // ── 8. emit result (capped at MAX_OUTPUT) ──
    emit(exit_code, stdout_buf, stderr_buf, kill_reason);
    Ok(())
}
