// lsp_daemon.rs — LSP TCP broker for multi-Shell sharing
//
// Spawns LSP servers and exposes them via TCP. One process per language
// shared by all IDE instances. Pure byte forwarding with Content-Length
// header framing — no JSON parsing, no protocol awareness.
//
// Architecture:
//   Shell TCP clients ══ TCP ══→ ghrun daemon ←──stdin/stdout──→ LSP server
//   (Content-Length frames)      (byte forwarding)                 (gopls/pyright/…)

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(windows)]
extern "system" {
    fn SetPriorityClass(handle: isize, priority: u32) -> i32;
}

#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;

use crate::ctx::Ctx;
use crate::manifest;

/// Well-known port mapping: component → TCP port.
/// Shell uses the same mapping to connect.
pub fn port_for(name: &str) -> u16 {
    match name {
        "lsp/gopls"         => 9801,
        "lsp/pyright"       => 9802,
        "lsp/clangd"        => 9803,
        "lsp/rust-analyzer" => 9804,
        _ => 0,
    }
}

/// Start all installed LSP servers with TCP listeners.
/// Blocks until process killed (Ctrl+C / SIGTERM).
pub fn run(ctx: &Ctx) -> Result<(), String> {
    let mut handles: Vec<LspHandle> = Vec::new();

    let all_components = manifest::all_components(Some(&ctx.qdir));
    for comp in &all_components {
        if !comp.name.starts_with("lsp/") {
            continue;
        }
        let port = port_for(&comp.name);
        if port == 0 {
            continue;
        }

        let (dir_name, bin_name) = match manifest::find_bin(&comp.name, Some(&ctx.qdir)) {
            Some(v) => v,
            None => {
                eprintln!("[lsp-daemon] skip {}: no manifest entry", comp.name);
                continue;
            }
        };
        let bin_path = ctx.component_dir(&dir_name).join(&bin_name);
        if !bin_path.exists() {
            eprintln!(
                "[lsp-daemon] skip {}: not installed at {}",
                comp.name,
                bin_path.display()
            );
            continue;
        }

        let args: Vec<&str> = match comp.name.as_str() {
            "lsp/pyright" => vec!["--stdio"],
            _ => vec![],
        };

        eprintln!(
            "[lsp-daemon] starting {} :{} ({})",
            comp.name,
            port,
            bin_path.display()
        );

        match launch_one(&bin_path, &args, port) {
            Ok(h) => handles.push(h),
            Err(e) => eprintln!("[lsp-daemon] {}: {}", comp.name, e),
        }
    }

    if handles.is_empty() {
        return Err("no LSP components installed. Run: ghrun ensure lsp/gopls lsp/pyright lsp/clangd lsp/rust-analyzer".into());
    }

    // Signal readiness to stdout (Shell reads this to confirm startup)
    let ready_ports: Vec<u16> = handles.iter().map(|h| h.port).collect();
    println!(
        "{}",
        serde_json::json!({
            "event": "lsp_daemon_ready",
            "ports": ready_ports,
        })
    );

    eprintln!(
        "[lsp-daemon] {} server(s) running, waiting for connections…",
        handles.len()
    );

    // Block forever — all work happens in background threads.
    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}

/// One launched LSP → TCP broker.
struct LspHandle {
    port: u16,
    _child: Arc<Mutex<Option<Child>>>,
}

/// Spawn LSP process + TCP listener + forwarding threads.
fn launch_one(
    bin_path: &std::path::Path,
    extra_args: &[&str],
    port: u16,
) -> Result<LspHandle, String> {
    let mut child = Command::new(bin_path)
        .args(extra_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("spawn {:?}: {}", bin_path, e))?;

    // Set below-normal priority so LSP never starves the IDE
    #[cfg(windows)]
    {
        unsafe {
            SetPriorityClass(child.as_raw_handle() as isize, BELOW_NORMAL_PRIORITY_CLASS);
        }
    }

    let child_stdin = child.stdin.take().unwrap();
    let child_stdout = child.stdout.take().unwrap();
    let child_holder = Arc::new(Mutex::new(Some(child)));

    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("bind :{}: {}", port, e))?;
    // Default blocking mode — accept() blocks until connection, zero-CPU polling

    // Shared mutable client pool
    let clients: Arc<Mutex<Vec<TcpStream>>> = Arc::new(Mutex::new(Vec::new()));

    // ── Thread A: LSP stdout → broadcast to all TCP clients ──
    let clients_a = clients.clone();
    let child_a = child_holder.clone();
    thread::spawn(move || {
        pump_stdout_to_clients(BufReader::new(child_stdout), clients_a, child_a, port);
    });

    // ── Thread B: accept TCP connections + spawn per-client readers ──
    let clients_b = clients.clone();
    let stdin_arc = Arc::new(Mutex::new(child_stdin));
    let child_b = child_holder.clone();
    thread::spawn(move || {
        accept_loop(listener, clients_b, stdin_arc, child_b, port);
    });

    Ok(LspHandle {
        port,
        _child: child_holder,
    })
}

// ---------------------------------------------------------------------------
// Thread A: LSP stdout → all TCP clients
// ---------------------------------------------------------------------------

fn pump_stdout_to_clients(
    mut reader: BufReader<impl Read + Send + 'static>,
    clients: Arc<Mutex<Vec<TcpStream>>>,
    _child: Arc<Mutex<Option<Child>>>,
    port: u16,
) {
    loop {
        let frame = match read_lsp_frame(&mut reader) {
            Some(f) => f,
            None => {
                eprintln!("[lsp-daemon :{}] LSP stdout closed", port);
                return;
            }
        };

        // Broadcast to all connected clients — remove dead ones
        let mut dead: Vec<usize> = Vec::new();
        {
            let mut guard = clients.lock().unwrap();
            for (i, client) in guard.iter_mut().enumerate() {
                if client.write_all(&frame).is_err() {
                    dead.push(i);
                }
            }
            for i in dead.into_iter().rev() {
                guard.remove(i);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Thread B: accept TCP clients → spawn per-client forwarders
// ---------------------------------------------------------------------------

fn accept_loop(
    listener: TcpListener,
    clients: Arc<Mutex<Vec<TcpStream>>>,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    _child: Arc<Mutex<Option<Child>>>,
    port: u16,
) {
    // Blocking accept — zero CPU, zero latency (no polling)
    loop {
        match listener.accept() {
            Ok((stream, addr)) => {
                eprintln!("[lsp-daemon :{}] client connected from {}", port, addr);
                {
                    let mut guard = clients.lock().unwrap();
                    guard.push(stream.try_clone().unwrap());
                }
                // Per-client: read TCP → write LSP stdin
                let s = stdin.clone();
                thread::spawn(move || {
                    pump_client_to_stdin(BufReader::new(stream), s, port);
                });
            }
            Err(e) => {
                eprintln!("[lsp-daemon :{}] accept error: {}", port, e);
                thread::sleep(Duration::from_secs(1));
            }
        }
    }
}

/// Read Content-Length framed messages from one TCP client → LSP stdin.
fn pump_client_to_stdin(
    mut reader: BufReader<TcpStream>,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    port: u16,
) {
    loop {
        let frame = match read_lsp_frame(&mut reader) {
            Some(f) => f,
            None => {
                eprintln!("[lsp-daemon :{}] client disconnected", port);
                return;
            }
        };
        let mut guard = stdin.lock().unwrap();
        if guard.write_all(&frame).is_err() {
            eprintln!("[lsp-daemon :{}] write to LSP stdin failed", port);
            return;
        }
        let _ = guard.flush();
    }
}

// ---------------------------------------------------------------------------
// Content-Length header aware frame reader
// ---------------------------------------------------------------------------

/// Read one complete LSP frame (Content-Length header + body) from a BufRead.
/// Returns None on EOF or fatal error.
fn read_lsp_frame<R: BufRead>(reader: &mut R) -> Option<Vec<u8>> {
    // 1. Read headers until \r\n\r\n
    let mut header_bytes = Vec::new();
    loop {
        let mut line = Vec::new();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => return None, // EOF
            Ok(_) => {
                let is_blank = line == b"\r\n" || line == b"\n";
                header_bytes.extend_from_slice(&line);
                if is_blank {
                    break;
                }
            }
            Err(_) => return None,
        }
    }

    // 2. Parse Content-Length
    let header_str = String::from_utf8_lossy(&header_bytes);
    let content_length = header_str
        .lines()
        .find(|l| l.to_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse::<usize>().ok())?;

    // Reject oversized frames (prevents OOM from corrupted/malicious headers)
    if content_length > 50 * 1024 * 1024 {
        return None;
    }

    // 3. Read body
    let mut body = vec![0u8; content_length];
    if reader.read_exact(&mut body).is_err() {
        return None;
    }

    // 4. Return complete frame (header + body)
    header_bytes.extend_from_slice(&body);
    Some(header_bytes)
}
