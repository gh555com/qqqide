// manifest.rs — component and goods manifest definitions.
//
// Resolution order (first wins):
//   1. <QDIR>/userData/manifest.json   (user override, survives upgrades)
//   2. <QDIR>/engines/manifest.json     (shipped with ghrun, updated by CI)
//   3. Hardcoded builtin fallback       (compiled into binary, always available)
//
// To change download URLs, edit engines/manifest.json — no recompile needed.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformEntry {
    pub url:        String,
    /// hex SHA-256 of the downloaded archive
    pub sha256:     String,
    /// sub-directory name to extract into (inside components/<name>/ or goods/<id>/)
    pub extract_to: Option<String>,
    /// relative path to the main executable (used to set QDIR_<NAME> etc.)
    pub bin:        Option<String>,
    /// "zip" | "tar.gz" | "binary" (raw file, no archive)
    pub kind:       String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentManifest {
    pub name:        String,
    pub version:     String,
    pub platforms:   HashMap<String, PlatformEntry>,
}

// ---------------------------------------------------------------------------
// Hardcoded component registry (MVP)
// ---------------------------------------------------------------------------

/// Detect current platform key.
pub fn current_platform() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]   { "win32-x64"    }
    #[cfg(all(target_os = "linux",   target_arch = "x86_64"))]   { "linux-x64"    }
    #[cfg(all(target_os = "macos",   target_arch = "x86_64"))]   { "darwin-x64"   }
    #[cfg(all(target_os = "macos",   target_arch = "aarch64"))]  { "darwin-arm64" }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux",   target_arch = "x86_64"),
        all(target_os = "macos",   target_arch = "x86_64"),
        all(target_os = "macos",   target_arch = "aarch64"),
    )))] { "unknown" }
}

// ---------------------------------------------------------------------------
// External manifest loading (JSON files, no recompile needed)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestFile {
    #[serde(default)]
    _comment: String,
    #[serde(default)]
    _version: u32,
    components: Vec<ComponentManifest>,
}

/// Try to load manifest from a JSON file.
fn load_manifest_json(path: &std::path::Path) -> Option<Vec<ComponentManifest>> {
    let data = std::fs::read_to_string(path).ok()?;
    let mf: ManifestFile = serde_json::from_str(&data).ok()?;
    if mf.components.is_empty() {
        None
    } else {
        Some(mf.components)
    }
}

/// Try to load external manifest from known search paths.
fn load_external_manifest(qdir: Option<&PathBuf>) -> Option<Vec<ComponentManifest>> {
    // Path 1: user override — <QDIR>/userData/manifest.json
    if let Some(qd) = qdir {
        let user_manifest = qd.join("userData").join("manifest.json");
        if let Some(cmps) = load_manifest_json(&user_manifest) {
            eprintln!("[manifest] loaded user manifest: {}", user_manifest.display());
            return Some(cmps);
        }
    }

    // Path 2: shipped manifest — next to ghrun.exe (engines/ directory)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let shipped = exe_dir.join("manifest.json");
            if let Some(cmps) = load_manifest_json(&shipped) {
                eprintln!("[manifest] loaded shipped manifest: {}", shipped.display());
                return Some(cmps);
            }
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Unified component lookup — tries external JSON first, then hardcoded
// ---------------------------------------------------------------------------

/// Get all components, preferring external manifest over hardcoded.
pub fn all_components(qdir: Option<&PathBuf>) -> Vec<ComponentManifest> {
    if let Some(ext) = load_external_manifest(qdir) {
        return ext;
    }
    builtin_components()
}

/// Look up a component by name (with optional QDIR for external manifest).
pub fn find_component_in(all_components: &[ComponentManifest], name: &str) -> Option<ComponentManifest> {
    all_components.iter().find(|c| c.name == name).cloned()
}

// ---------------------------------------------------------------------------
// Hardcoded fallback (runs if no JSON manifest found)
// ---------------------------------------------------------------------------

pub fn builtin_components() -> Vec<ComponentManifest> {
    vec![
        // ------------------------------------------------------------------ ffmpeg
        ComponentManifest {
            name:    "ffmpeg".into(),
            version: "7.1".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/ffmpeg/7.1/win32-x64.zip".into(),
                    sha256:     "".into(),   // filled by deploy script
                    extract_to: Some("ffmpeg".into()),
                    bin:        Some("ffmpeg.exe".into()),
                    kind:       "zip".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/ffmpeg/7.1/linux-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("ffmpeg".into()),
                    bin:        Some("ffmpeg".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/ffmpeg/7.1/darwin-arm64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("ffmpeg".into()),
                    bin:        Some("ffmpeg".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/ffmpeg/7.1/darwin-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("ffmpeg".into()),
                    bin:        Some("ffmpeg".into()),
                    kind:       "tar.gz".into(),
                }),
            ].into(),
        },

        // ------------------------------------------------------------------ yt-dlp
        ComponentManifest {
            name:    "yt-dlp".into(),
            version: "2025.05.01".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/yt-dlp/2025.05.01/yt-dlp.exe".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("yt-dlp.exe".into()),
                    kind:       "binary".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/yt-dlp/2025.05.01/yt-dlp_linux".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("yt-dlp".into()),
                    kind:       "binary".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/yt-dlp/2025.05.01/yt-dlp_macos".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("yt-dlp".into()),
                    kind:       "binary".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/yt-dlp/2025.05.01/yt-dlp_macos".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("yt-dlp".into()),
                    kind:       "binary".into(),
                }),
            ].into(),
        },

        // ------------------------------------------------------------------ python
        ComponentManifest {
            name:    "python".into(),
            version: "3.12.3".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/python/3.12.3/win32-x64.zip".into(),
                    sha256:     "".into(),
                    extract_to: Some("python".into()),
                    bin:        Some("python.exe".into()),
                    kind:       "zip".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/python/3.12.3/linux-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("python".into()),
                    bin:        Some("bin/python3".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/python/3.12.3/darwin-arm64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("python".into()),
                    bin:        Some("bin/python3".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/python/3.12.3/darwin-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("python".into()),
                    bin:        Some("bin/python3".into()),
                    kind:       "tar.gz".into(),
                }),
            ].into(),
        },

        // ------------------------------------------------------------------ git (Windows only for now)
        ComponentManifest {
            name:    "git".into(),
            version: "2.46.0".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/git/2.46.0/win32-x64.zip".into(),
                    sha256:     "".into(),
                    extract_to: Some("git".into()),
                    bin:        Some("bin/git.exe".into()),
                    kind:       "zip".into(),
                }),
            ].into(),
        },

        // ──────────────────────────────────────────────────────────────────
        // LSP servers — language intelligence for Monaco editor
        //
        // Naming convention: "lsp/<name>" (e.g. "lsp/gopls").
        // On disk: f/components/lsp_gopls/  (slash → underscore)
        //
        // Communication: stdin/stdout JSON-RPC (LSP protocol).
        // ghrun only ensures installation; qz-spawn manages lifecycle;
        // shell/lsp-bridge.ts handles protocol bridging.
        // ──────────────────────────────────────────────────────────────────

        // ── clangd (C/C++/Objective-C) — from LLVM project
        ComponentManifest {
            name:    "lsp/clangd".into(),
            version: "19.1.0".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/clangd/19.1.0/win32-x64.zip".into(),
                    sha256:     "".into(),
                    extract_to: Some("clangd".into()),
                    bin:        Some("clangd.exe".into()),
                    kind:       "zip".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/clangd/19.1.0/linux-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("clangd".into()),
                    bin:        Some("bin/clangd".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/clangd/19.1.0/darwin-arm64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("clangd".into()),
                    bin:        Some("bin/clangd".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/clangd/19.1.0/darwin-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("clangd".into()),
                    bin:        Some("bin/clangd".into()),
                    kind:       "tar.gz".into(),
                }),
            ].into(),
        },

        // ── gopls (Go) — from Google
        ComponentManifest {
            name:    "lsp/gopls".into(),
            version: "0.17.0".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/gopls/0.17.0/win32-x64.zip".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("gopls.exe".into()),
                    kind:       "zip".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/gopls/0.17.0/linux-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("gopls".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/gopls/0.17.0/darwin-arm64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("gopls".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/gopls/0.17.0/darwin-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("gopls".into()),
                    kind:       "tar.gz".into(),
                }),
            ].into(),
        },

        // ── rust-analyzer (Rust)
        ComponentManifest {
            name:    "lsp/rust-analyzer".into(),
            version: "2025-05-01".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/rust-analyzer/2025-05-01/win32-x64.zip".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("rust-analyzer.exe".into()),
                    kind:       "zip".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/rust-analyzer/2025-05-01/linux-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("rust-analyzer".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/rust-analyzer/2025-05-01/darwin-arm64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("rust-analyzer".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/rust-analyzer/2025-05-01/darwin-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: None,
                    bin:        Some("rust-analyzer".into()),
                    kind:       "tar.gz".into(),
                }),
            ].into(),
        },

        // ── pyright (Python) — from Microsoft, needs Node.js
        ComponentManifest {
            name:    "lsp/pyright".into(),
            version: "1.1.390".into(),
            platforms: [
                ("win32-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/pyright/1.1.390/win32-x64.zip".into(),
                    sha256:     "".into(),
                    extract_to: Some("pyright".into()),
                    bin:        Some("index.js".into()),
                    kind:       "zip".into(),
                }),
                ("linux-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/pyright/1.1.390/linux-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("pyright".into()),
                    bin:        Some("index.js".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-arm64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/pyright/1.1.390/darwin-arm64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("pyright".into()),
                    bin:        Some("index.js".into()),
                    kind:       "tar.gz".into(),
                }),
                ("darwin-x64".into(), PlatformEntry {
                    url:        "https://cdn.gh555.com/components/lsp/pyright/1.1.390/darwin-x64.tar.gz".into(),
                    sha256:     "".into(),
                    extract_to: Some("pyright".into()),
                    bin:        Some("index.js".into()),
                    kind:       "tar.gz".into(),
                }),
            ].into(),
        },
    ]
}

/// Look up the binary path for a component.
/// Returns (directory_name, binary_name).
/// "lsp/gopls" → ("lsp_gopls", "gopls.exe")
/// "ffmpeg"    → ("ffmpeg",    "ffmpeg.exe")
pub fn find_bin(name: &str, qdir: Option<&PathBuf>) -> Option<(String, String)> {
    let dir_name = name.replace('/', "_");
    let manifest = find_component(name, qdir)?;
    let platform = current_platform();
    let entry = manifest.platforms.get(platform)?;
    let bin = entry.bin.as_ref()?;
    Some((dir_name, bin.clone()))
}

/// Look up a component manifest by name. Tries external JSON first.
pub fn find_component(name: &str, qdir: Option<&PathBuf>) -> Option<ComponentManifest> {
    let all = all_components(qdir);
    find_component_in(&all, name)
}
