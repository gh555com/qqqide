// main.rs — ghrun: qqq IDE component manager & gaea goods installer
//
// Protocol: all output is JSON lines to stdout.
//   {"event":"start","component":"ffmpeg","version":"7.1"}
//   {"event":"progress","downloaded":1048576,"total":52428800,"percent":2}
//   {"event":"done","component":"ffmpeg","path":"/path/to/ffmpeg.exe"}
//   {"event":"error","msg":"..."}
//
// The Node.js extension spawns ghrun and parses stdout line-by-line.
// stderr is for human-readable debug info only.

use clap::{Parser, Subcommand};

mod ctx;
mod ensure;
mod install;
mod lsp_daemon;
mod manifest;
mod spawn;

use ctx::Ctx;

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(name = "ghrun", version, about = "qqq IDE component manager")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Initialize QDIR directory structure
    Init,

    /// Ensure a component is installed (idempotent)
    /// Examples: ghrun ensure ffmpeg | ghrun ensure python yt-dlp
    Ensure {
        /// Component name(s): ffmpeg, python, yt-dlp, git
        #[arg(required = true)]
        components: Vec<String>,
    },

    /// Install a gaea good from its gaea.json URL
    Install {
        /// URL to gaea.json manifest
        url: String,
    },

    /// Upgrade all installed components to latest versions
    Upgrade,

    /// Upgrade shell-out/ from remote (download + verify + atomic swap + restart Electron)
    UpgradeShell {
        /// URL to shell-out.tar.xz
        url: String,
        /// Expected SHA-256 hex
        #[arg(long)]
        sha256: Option<String>,
        /// Path to the shell-out directory to replace
        #[arg(long)]
        target: String,
        /// Path to electron.exe to restart
        #[arg(long)]
        electron: String,
    },

    /// List installed components and goods
    List,

    /// Print QDIR path info (useful for debugging)
    Info,

    /// Start the LSP TCP daemon (byte-forwarding broker for multi-Shell sharing)
    LspDaemon,

    /// Resolve a component's binary path (used by qz-spawn / LSP bridge)
    /// Also includes "port" when the component is an LSP server
    Which {
        /// Component name: ffmpeg, python, lsp/gopls, lsp/clangd, etc.
        name: String,
    },

    /// Spawn a one-shot subprocess with deadline watchdog (stdin JSON RPC)
    /// Protocol matches qz-spawn.ts ghrunTier + engines/runner.py
    Spawn {
        /// Always pass this flag (reserved, protocol compat)
        #[arg(long)]
        json: bool,
    },

    /// Print QDIR root path (for debugging / env detection)
    Root,

    /// Health check — verify ghrun is functional (for CI / startup probe)
    Doctor,
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let cli = Cli::parse();
    let ctx = Ctx::detect();

    let result = match cli.cmd {
        Cmd::Init => cmd_init(&ctx),
        Cmd::Ensure { components } => cmd_ensure(&ctx, &components),
        Cmd::Install { url } => cmd_install(&ctx, &url),
        Cmd::Upgrade => cmd_upgrade(&ctx),
        Cmd::UpgradeShell { url, sha256, target, electron } => cmd_upgrade_shell(&ctx, &url, &sha256, &target, &electron),
        Cmd::List => { install::list_goods(&ctx); Ok(()) },
        Cmd::Info => cmd_info(&ctx),
        Cmd::LspDaemon => lsp_daemon::run(&ctx),
        Cmd::Which { name } => cmd_which(&ctx, &name),
        Cmd::Spawn { .. } => spawn::run(),
        Cmd::Root => cmd_root(&ctx),
        Cmd::Doctor => cmd_doctor(&ctx),
    };

    if let Err(e) = result {
        let msg = serde_json::json!({"event":"error","msg": e});
        eprintln!("{}", msg);
        println!("{}", msg);
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

fn cmd_init(ctx: &Ctx) -> Result<(), String> {
    ctx.init_dirs().map_err(|e| e.to_string())?;
    let marker = ctx.f.join(".qqq-portable");
    if !marker.exists() {
        std::fs::write(&marker, format!("ghrun init {}", chrono_now()))
            .map_err(|e| e.to_string())?;
    }
    println!("{}", serde_json::json!({"event":"init_done","qdir": ctx.qdir.to_string_lossy().to_string()}));
    Ok(())
}

fn cmd_ensure(ctx: &Ctx, names: &[String]) -> Result<(), String> {
    ctx.init_dirs().map_err(|e| e.to_string())?;
    let refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
    ensure::ensure_all(ctx, &refs)
}

fn cmd_install(ctx: &Ctx, url: &str) -> Result<(), String> {
    ctx.init_dirs().map_err(|e| e.to_string())?;
    install::install_good_from_url(ctx, url)
}

fn cmd_upgrade(ctx: &Ctx) -> Result<(), String> {
    let components = ["ffmpeg", "python", "yt-dlp", "git"];
    for name in &components {
        let ver_file = ctx.component_dir(name).join(".version");
        if ver_file.exists() {
            if let Err(e) = ensure::ensure_component(ctx, name) {
                eprintln!("upgrade {}: {}", name, e);
            }
        }
    }
    println!("{}", serde_json::json!({"event":"upgrade_done"}));
    Ok(())
}

fn cmd_upgrade_shell(ctx: &Ctx, url: &str, sha256: &Option<String>, target: &str, electron: &str) -> Result<(), String> {
    use std::process::Command;

    let target_dir = PathBuf::from(target);
    if !target_dir.exists() {
        return Err(format!("target directory not found: {}", target));
    }

    let staging = ctx.tmp.join("shell-upgrade");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let archive_path = staging.join("shell-out.tar.xz");

    // 1) Download
    println!("{}", ev!("event" => "download_start", "url" => url));
    let resp = reqwest::blocking::get(url)
        .map_err(|e| format!("download failed: {}", e))?;
    let total = resp.content_length();
    let bytes = resp.bytes().map_err(|e| format!("download read failed: {}", e))?;
    let downloaded = bytes.len() as u64;
    fs::write(&archive_path, &bytes).map_err(|e| e.to_string())?;
    println!("{}", ev!("event" => "download_done", "size" => downloaded));

    // 2) Verify SHA-256
    if let Some(expected) = sha256 {
        if !expected.is_empty() {
            let actual = sha256_file(&archive_path)?;
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(format!("SHA-256 mismatch: expected {}, got {}", expected, actual));
            }
            println!("{}", ev!("event" => "verify_ok", "sha256" => actual));
        }
    }

    // 3) Extract to staging/extracted
    let extract_dir = staging.join("extracted");
    fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;
    extract_tar_xz(&archive_path, &extract_dir)?;
    println!("{}", ev!("event" => "extract_done"));

    // 4) Signal ready — parent (Electron main process) should now quit
    println!("{}", ev!("event" => "ready_to_swap", "staging" => extract_dir.to_string_lossy().to_string()));

    // 5) Wait for parent process (Electron) to exit
    // On Windows, we watch the electron.exe process
    let electron_path = PathBuf::from(electron);
    if electron_path.exists() {
        let electron_name = electron_path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "electron.exe".to_string());
        println!("{}", ev!("event" => "waiting_for_exit", "process" => electron_name));
        // Poll until electron.exe is gone (max 30s)
        for _ in 0..60 {
            let running = is_process_running(&electron_name);
            if !running { break; }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    } else {
        // Fallback: wait 2s for parent to die
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    // 6) Atomic swap
    let backup = target_dir.with_extension("old");
    let _ = fs::remove_dir_all(&backup);
    fs::rename(&target_dir, &backup).map_err(|e| format!("backup failed: {}", e))?;
    // Copy extracted contents into target
    copy_dir_recursive(&extract_dir, &target_dir)?;
    let _ = fs::remove_dir_all(&backup);
    let _ = fs::remove_dir_all(&staging);
    println!("{}", ev!("event" => "swap_done"));

    // 7) Restart Electron
    if electron_path.exists() {
        println!("{}", ev!("event" => "restarting"));
        Command::new(&electron_path)
            .arg(".")
            .spawn()
            .map_err(|e| format!("restart failed: {}", e))?;
    }

    println!("{}", ev!("event" => "upgrade_shell_done"));
    Ok(())
}

fn sha256_file(path: &PathBuf) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn extract_tar_xz(archive: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let xz = xz2::read::XzDecoder::new(file);
    let mut archive = tar::Archive::new(xz);
    archive.unpack(dest).map_err(|e| format!("extract failed: {}", e))?;
    Ok(())
}

fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let dst_path = dst.join(&name);
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else {
            fs::copy(entry.path(), &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_process_running(name: &str) -> bool {
    use std::process::Command;
    let output = Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {}", name)])
        .output();
    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.contains(name)
        }
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn is_process_running(name: &str) -> bool {
    use std::process::Command;
    let output = Command::new("pgrep")
        .arg(name)
        .output();
    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

fn cmd_info(ctx: &Ctx) -> Result<(), String> {
    println!("{}", serde_json::json!({
        "event":      "info",
        "qdir":       ctx.qdir.to_string_lossy().to_string(),
        "f":          ctx.f.to_string_lossy().to_string(),
        "components": ctx.components.to_string_lossy().to_string(),
        "goods":      ctx.goods.to_string_lossy().to_string(),
        "builtin":    ctx.extensions.to_string_lossy().to_string(),
        "platform":   manifest::current_platform(),
    }));
    Ok(())
}

fn cmd_which(ctx: &Ctx, name: &str) -> Result<(), String> {
    let (dir_name, bin_name) = manifest::find_bin(name, Some(&ctx.qdir))
        .ok_or_else(|| format!("component '{}' not found in manifest", name))?;
    let dir = ctx.component_dir(&dir_name);
    let full_path = dir.join(&bin_name);
    let path_str = full_path.to_string_lossy().to_string();

    let port = lsp_daemon::port_for(name);

    println!("{}", serde_json::json!({
        "event": "which",
        "name":  name,
        "path":  path_str,
        "dir":   dir.to_string_lossy().to_string(),
        "bin":   bin_name,
        "port":  if port > 0 { serde_json::json!(port) } else { serde_json::Value::Null },
    }));
    Ok(())
}

fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    format!("unix={}", secs)
}

fn cmd_root(ctx: &Ctx) -> Result<(), String> {
    let exe = std::env::current_exe().unwrap_or_default();
    println!("{}", serde_json::json!({
        "event": "root",
        "qdir": ctx.qdir.to_string_lossy(),
        "ghrun": exe.to_string_lossy(),
    }));
    Ok(())
}

fn cmd_doctor(ctx: &Ctx) -> Result<(), String> {
    let exe = std::env::current_exe().unwrap_or_default();
    println!("{}", serde_json::json!({
        "event": "doctor",
        "status": "ok",
        "qdir": ctx.qdir.to_string_lossy(),
        "ghrun": exe.to_string_lossy(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
    }));
    Ok(())
}
