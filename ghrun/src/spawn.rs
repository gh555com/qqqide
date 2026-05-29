// spawn.rs — ghrun spawn subcommand (one-shot process execution)
//
// Protocol (matches qz-spawn.ts ghrunTier + runner.py):
//   stdin : {"cmd":"...","args":[...],"cwd":"...","env":{...},"timeout":30000,"stallMs":0,"captureOutput":true}
//   stdout: last line = {"exitCode":0,"stdout":"...","stderr":"...","killReason":""}
//
// Anti-hang:
//   - deadline watchdog: absolute timeout → tree kill
//   - Windows: taskkill /F /T /PID (entire tree, no orphan zombies)
//   - POSIX:   kill -9 <pid>
//   - stdin=DEVNULL (no accidental tty reads)
//   - stdout/stderr captured in threads, never block main

use serde::Deserialize;
use serde_json;
use std::io::{BufRead, Read};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

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
    #[serde(default = "default_true")]
    capture_output: bool,
    #[serde(default)]
    stall_ms: u64, // reserved, not yet implemented
}

fn default_true() -> bool {
    true
}

/// Kill a process tree.
/// Windows: taskkill /F /T /PID  — kills entire job tree, no orphans.
/// POSIX:   kill -9 <pid>         — kills direct child (children → init).
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
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

/// Emit a valid JSON brief to stdout and exit cleanly.
/// Even spawn failures produce valid JSON — caller never sees a parse error.
fn emit(exit_code: i32, stdout: String, stderr: String, kill_reason: &str) {
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
    let mut cmd = Command::new(&brief.cmd);
    cmd.args(&brief.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(ref cwd) = brief.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(ref env) = brief.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    // ── 3. spawn ──
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit(-1, String::new(), format!("spawn {}: {}", brief.cmd, e), "spawn-error");
            return Ok(());
        }
    };
    let pid = child.id();

    // ── 4. deadline watchdog ──
    let killed = Arc::new(AtomicBool::new(false));
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

    // ── 5. read stdout/stderr in background threads ──
    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();

    if brief.capture_output {
        let mut child_out = child.stdout.take().unwrap();
        let mut child_err = child.stderr.take().unwrap();

        let out_thread = thread::spawn(move || {
            let mut s = String::new();
            let _ = child_out.read_to_string(&mut s);
            s
        });
        let err_thread = thread::spawn(move || {
            let mut s = String::new();
            let _ = child_err.read_to_string(&mut s);
            s
        });

        stdout_buf = out_thread.join().unwrap_or_default();
        stderr_buf = err_thread.join().unwrap_or_default();
    }

    // ── 6. wait for child ──
    let status = match child.wait() {
        Ok(s) => s,
        Err(e) => {
            emit(-1, stdout_buf, format!("wait: {}", e), "spawn-error");
            return Ok(());
        }
    };
    let exit_code = status.code().unwrap_or(-1);
    let kill_reason = if killed.load(Ordering::SeqCst) {
        "deadline"
    } else {
        ""
    };

    // ── 7. emit result ──
    emit(exit_code, stdout_buf, stderr_buf, kill_reason);
    Ok(())
}
