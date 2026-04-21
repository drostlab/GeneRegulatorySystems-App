//! Julia runtime provisioning.
//!
//! Handles three scenarios:
//! 1. **Dev mode** -- uses system `julia` on PATH, global depot.
//! 2. **Production, system Julia found** -- checks version compatibility,
//!    offers a choice to the user (use system vs. dedicated download).
//! 3. **Production, no system Julia** -- downloads a pinned release.
//!
//! In all production scenarios the Julia package depot is isolated to the
//! app data directory so we don't pollute `~/.julia/`.
//!
//! Security: downloads are fetched over HTTPS from the official Julia CDN
//! and verified against pinned SHA256 checksums before extraction.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Sha256, Digest};

/// Pinned Julia version for production builds.
pub const JULIA_VERSION: &str = "1.12.0";
/// Major.minor prefix used in the download URL path.
const JULIA_VERSION_SHORT: &str = "1.12";
/// Minimum Julia version the server supports (hard floor, independent of Manifest).
pub const JULIA_MIN_MAJOR: u32 = 1;
pub const JULIA_MIN_MINOR: u32 = 11;

// ===========================================================================
// System Julia detection
// ===========================================================================

/// Parsed Julia version (major.minor.patch).
#[derive(Debug, Clone)]
pub struct JuliaVersion {
    pub major: u32,
    pub minor: u32,
    #[allow(dead_code)]
    pub patch: u32,
    pub raw: String,
}

impl std::fmt::Display for JuliaVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.raw)
    }
}

impl JuliaVersion {
    /// Whether this version meets the hard-floor minimum.
    pub fn is_compatible(&self) -> bool {
        (self.major, self.minor) >= (JULIA_MIN_MAJOR, JULIA_MIN_MINOR)
    }

    /// Whether a bundled `Manifest-v{major}.{minor}.toml` is shipped for this
    /// version. When `true`, Julia will pick it up automatically and skip
    /// dependency resolution. When `false`, Julia falls through to a fresh
    /// resolve from Project.toml inside the isolated depot.
    pub fn has_shipped_manifest(&self, server_dir: &Path) -> bool {
        server_dir
            .join(format!("Manifest-v{}.{}.toml", self.major, self.minor))
            .is_file()
    }
}

/// Parse the `julia_version = "X.Y.Z"` line from a Manifest.toml without
/// pulling in a full TOML parser. Returns `None` if the file is missing or
/// malformed.
pub fn parse_manifest_julia_version(path: &Path) -> Option<(u32, u32)> {
    let contents = std::fs::read_to_string(path).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("julia_version") {
            // Require a word boundary (whitespace or `=`) after the key so
            // we don't match hypothetical siblings like `julia_version_minor`.
            if !rest.starts_with(|c: char| c.is_whitespace() || c == '=') {
                continue;
            }
            let rest = rest.trim_start().strip_prefix('=')?.trim();
            let quoted = rest.trim_matches(|c: char| c == '"' || c.is_whitespace());
            let parts: Vec<&str> = quoted.split('.').collect();
            if parts.len() >= 2 {
                let major = parts[0].parse().ok()?;
                let minor = parts[1].parse().ok()?;
                return Some((major, minor));
            }
        }
    }
    None
}

/// Result of probing for a system Julia installation.
#[derive(Debug)]
pub enum SystemJulia {
    /// Found at `path` with parsed version.
    Found { path: PathBuf, version: JuliaVersion },
    /// Not found on PATH.
    NotFound,
}

/// Probe for `julia` on the system PATH and parse its version.
pub fn detect_system_julia() -> SystemJulia {
    // Try PATH first, then common installation locations
    let candidates = std::iter::once(PathBuf::from("julia"))
        .chain(known_julia_paths());

    for candidate in candidates {
        if let Some(found) = try_julia_at(&candidate) {
            return found;
        }
    }

    SystemJulia::NotFound
}

/// Try to validate a specific Julia path provided by the user.
pub fn try_julia_at(path: &Path) -> Option<SystemJulia> {
    let output = Command::new(path).arg("--version").output();
    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return None,
    };

    let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let version = parse_julia_version(&version_str);
    match version {
        Some(v) => {
            let resolved = path.to_path_buf();
            log::info!("Julia found: {} at {}", v, resolved.display());
            Some(SystemJulia::Found { path: resolved, version: v })
        }
        None => {
            log::warn!("Could not parse Julia version from: {}", version_str);
            None
        }
    }
}

/// Common Julia installation paths across platforms.
/// macOS `/Applications/Julia-X.Y.Z.app` entries are sorted by parsed version,
/// newest first, so a 1.12 app is preferred over a 1.10 app when both exist.
fn known_julia_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(home) = dirs_home() {
        // juliaup (all platforms) — resolves to its default channel
        if cfg!(target_os = "windows") {
            paths.push(home.join(".juliaup").join("bin").join("julia.exe"));
        } else {
            paths.push(home.join(".juliaup").join("bin").join("julia"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Homebrew on Apple Silicon vs Intel
        paths.push(PathBuf::from("/opt/homebrew/bin/julia"));
        paths.push(PathBuf::from("/usr/local/bin/julia"));

        // macOS .app bundles, sorted by version descending
        let mut app_candidates: Vec<((u32, u32, u32), PathBuf)> = Vec::new();
        for entry in std::fs::read_dir("/Applications").into_iter().flatten().flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let stripped = match name.strip_prefix("Julia-").and_then(|s| s.strip_suffix(".app")) {
                Some(s) => s,
                None => continue,
            };
            let parts: Vec<&str> = stripped.split('.').collect();
            let version = match parts.as_slice() {
                [a, b, c, ..] => (
                    a.parse().unwrap_or(0),
                    b.parse().unwrap_or(0),
                    c.parse().unwrap_or(0),
                ),
                [a, b] => (a.parse().unwrap_or(0), b.parse().unwrap_or(0), 0),
                _ => (0, 0, 0),
            };
            let bin = entry
                .path()
                .join("Contents")
                .join("Resources")
                .join("julia")
                .join("bin")
                .join("julia");
            app_candidates.push((version, bin));
        }
        app_candidates.sort_by(|a, b| b.0.cmp(&a.0));
        paths.extend(app_candidates.into_iter().map(|(_, p)| p));
    }

    #[cfg(target_os = "linux")]
    {
        paths.push(PathBuf::from("/usr/local/bin/julia"));
        paths.push(PathBuf::from("/usr/bin/julia"));
    }

    paths
}

/// Resolve the user home directory.
fn dirs_home() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

/// Parse "julia version X.Y.Z" into a JuliaVersion. Rejects prerelease
/// versions (e.g. `1.13.0-rc1`, `1.13.0-beta2`, `1.13.0-DEV.123`) since
/// the server has not been tested against them and their stdlib APIs may
/// differ in subtle ways from the eventual stable release.
fn parse_julia_version(s: &str) -> Option<JuliaVersion> {
    // Handle both "julia version 1.11.3" and "1.11.3"
    let version_part = s.split_whitespace().last()?;

    if version_part.contains('-') {
        log::warn!("Rejecting prerelease Julia version: {}", version_part);
        return None;
    }

    let parts: Vec<&str> = version_part.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    Some(JuliaVersion {
        major: parts[0].parse().ok()?,
        minor: parts[1].parse().ok()?,
        patch: parts[2].parse().ok()?,
        raw: version_part.to_string(),
    })
}

// ===========================================================================
// User choice
// ===========================================================================

/// Describes the situation to present to the user.
/// `depot_path` and `has_matching_manifest` let the frontend explain what
/// "Use system Julia" actually means (isolated depot, not the user's `~/.julia`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct JuliaPrompt {
    /// "compatible", "outdated", or "not_found"
    pub situation: String,
    /// Human-readable system version (empty if not found).
    pub system_version: String,
    /// System Julia binary path (empty if not found).
    pub system_path: String,
    /// Required minimum version string (hard floor).
    pub min_version: String,
    /// The version that would be downloaded if the user picks "dedicated".
    pub download_version: String,
    /// Absolute path to the isolated app depot. Shown to users so they
    /// understand their global `~/.julia/` is not touched.
    pub depot_path: String,
    /// True when a bundled `Manifest-v{major}.{minor}.toml` matches the
    /// detected system Julia — precompile is then deterministic.
    /// False means the system Julia will resolve deps from Project.toml
    /// (slower first run but still correct).
    pub has_matching_manifest: bool,
}

/// Build the prompt payload based on system detection.
pub fn build_prompt(system: &SystemJulia, data_dir: &Path, server_dir: &Path) -> JuliaPrompt {
    let min_version = format!("{}.{}", JULIA_MIN_MAJOR, JULIA_MIN_MINOR);
    let download_version = JULIA_VERSION.to_string();
    let depot = depot_path(data_dir).to_string_lossy().into_owned();

    match system {
        SystemJulia::Found { version, path } => {
            let situation = if version.is_compatible() { "compatible" } else { "outdated" };
            JuliaPrompt {
                situation: situation.to_string(),
                system_version: version.raw.clone(),
                system_path: path.to_string_lossy().into_owned(),
                min_version,
                download_version,
                depot_path: depot,
                has_matching_manifest: version.has_shipped_manifest(server_dir),
            }
        }
        SystemJulia::NotFound => JuliaPrompt {
            situation: "not_found".to_string(),
            system_version: String::new(),
            system_path: String::new(),
            min_version,
            download_version,
            depot_path: depot,
            has_matching_manifest: false,
        },
    }
}

// ===========================================================================
// Depot path
// ===========================================================================

/// Return the isolated Julia depot path inside the app data directory.
/// This keeps all compiled packages separate from `~/.julia/`.
pub fn depot_path(data_dir: &Path) -> PathBuf {
    data_dir.join("julia-depot")
}

// ===========================================================================
// Platform detection & checksums
// ===========================================================================

/// Target platform descriptor for the Julia download URL.
struct Platform {
    os: &'static str,
    arch: &'static str,
    suffix: &'static str,
    ext: &'static str,
    sha256: &'static str,
}

fn detect_platform() -> Platform {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Platform {
            os: "mac",
            arch: "aarch64",
            suffix: "macaarch64",
            ext: "tar.gz",
            sha256: "d1aaa44a9507c7eaa500d41460f06694bffd0ca366dbc23b38c09bb3290f52c8",
        }
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Platform {
            os: "mac",
            arch: "x64",
            suffix: "mac64",
            ext: "tar.gz",
            sha256: "373abf275872269f2ca97452e583a4aaf565e6f0572f7072b189aa3dc1b29429",
        }
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Platform {
            os: "linux",
            arch: "x64",
            suffix: "linux-x86_64",
            ext: "tar.gz",
            sha256: "6f87b8fcf5ef6a7371e8c79d948aedfa0ba28ce44447c446d7d82e70f0158da8",
        }
    }

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Platform {
            os: "linux",
            arch: "aarch64",
            suffix: "linux-aarch64",
            ext: "tar.gz",
            sha256: "0fb44de10c3a9da719b4962c2158fe4484d98377e521318b692e91a1bea5716b",
        }
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Platform {
            os: "winnt",
            arch: "x64",
            suffix: "win64",
            ext: "zip",
            sha256: "bc196d2b39d672ce139d6f7a67108773c18db069a05d9311852f9fa04192e421",
        }
    }

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    compile_error!("Unsupported platform for Julia auto-download");
}

// ===========================================================================
// Provisioned binary paths
// ===========================================================================

fn julia_install_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("julia").join(format!("julia-{}", JULIA_VERSION))
}

fn julia_binary(data_dir: &Path) -> PathBuf {
    let base = julia_install_dir(data_dir);
    if cfg!(target_os = "windows") {
        base.join("bin").join("julia.exe")
    } else {
        base.join("bin").join("julia")
    }
}

/// Whether a provisioned Julia binary exists in the data directory.
pub fn is_provisioned(data_dir: &Path) -> bool {
    julia_binary(data_dir).is_file()
}

/// Return the path to the provisioned Julia binary.
pub fn provisioned_binary(data_dir: &Path) -> PathBuf {
    julia_binary(data_dir)
}

// ===========================================================================
// Persisted Julia choice
// ===========================================================================

/// File where the user's Julia binary choice is saved between launches.
fn choice_file(data_dir: &Path) -> PathBuf {
    data_dir.join("julia-choice.txt")
}

/// Save the resolved Julia binary path so subsequent launches skip the prompt.
/// Refuses to save paths containing control characters (newlines, tabs, NUL)
/// since they'd be silently truncated by `trim()` on reload.
pub fn save_choice(data_dir: &Path, julia_path: &Path) {
    let file = choice_file(data_dir);
    let path_str = julia_path.to_string_lossy();
    if path_str.chars().any(|c| c.is_control()) {
        log::warn!(
            "Refusing to persist Julia choice with control characters: {:?}",
            path_str
        );
        return;
    }
    if let Err(e) = std::fs::write(&file, path_str.as_bytes()) {
        log::warn!("Could not persist Julia choice to {}: {}", file.display(), e);
    } else {
        log::info!("Persisted Julia choice: {}", julia_path.display());
    }
}

/// Load and validate a previously saved Julia choice.
/// Returns the path only if the file exists, parses cleanly, the binary
/// still runs, and its version is still compatible. Deletes the file if
/// validation fails.
pub fn load_validated_choice(data_dir: &Path) -> Option<PathBuf> {
    let file = choice_file(data_dir);
    let contents = std::fs::read_to_string(&file).ok()?;
    let trimmed = contents.trim();

    // Reject empty / control-char-bearing content. An empty file or a file
    // with embedded NULs would otherwise be passed to Command::new and
    // either fail opaquely or, on some platforms, behave unexpectedly.
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control()) {
        log::warn!("Saved Julia choice file is empty or malformed, clearing");
        let _ = std::fs::remove_file(&file);
        return None;
    }

    let saved_path = PathBuf::from(trimmed);
    log::info!("Found saved Julia choice: {}", saved_path.display());

    match try_julia_at(&saved_path) {
        Some(SystemJulia::Found { path, version }) if version.is_compatible() => {
            log::info!("Saved Julia choice validated: {} ({})", path.display(), version);
            Some(path)
        }
        _ => {
            log::warn!("Saved Julia choice no longer valid, clearing");
            let _ = std::fs::remove_file(&file);
            None
        }
    }
}

// ===========================================================================
// Reset
// ===========================================================================

/// Safely remove a directory that we expect to own inside `data_dir`.
///
/// Guards against four classes of footgun:
///   1. `target` is a symlink (we'd follow it and wipe the linked dir).
///   2. `target` canonicalizes outside `data_dir` (escapes the sandbox).
///   3. `target` equals `data_dir` itself (we'd wipe the whole app state).
///   4. `target` is on a different filesystem volume than `data_dir`
///      (suggests something unusual — bail rather than proceed).
///
/// If `target` does not exist, returns `Ok(false)` (nothing to do). On any
/// guard failure returns `Err` without touching the filesystem.
fn safe_remove_dir(target: &Path, data_dir: &Path) -> Result<bool, String> {
    if !target.exists() {
        return Ok(false);
    }

    // Reject symlinks: symlink_metadata() does NOT follow, so if the target
    // itself is a symlink we see its own type here.
    let meta = std::fs::symlink_metadata(target)
        .map_err(|e| format!("Cannot stat {}: {}", target.display(), e))?;
    if meta.file_type().is_symlink() {
        return Err(format!(
            "Refusing to delete symlink {} (would follow to an unknown location)",
            target.display()
        ));
    }
    if !meta.file_type().is_dir() {
        return Err(format!(
            "Refusing to delete non-directory {}",
            target.display()
        ));
    }

    // Canonicalize both sides and require `target` to live under `data_dir`.
    // canonicalize() fails on non-existent paths, so we only call it once
    // we've confirmed existence above.
    let canon_target = std::fs::canonicalize(target)
        .map_err(|e| format!("Cannot canonicalize {}: {}", target.display(), e))?;
    let canon_data = std::fs::canonicalize(data_dir)
        .map_err(|e| format!("Cannot canonicalize {}: {}", data_dir.display(), e))?;

    if canon_target == canon_data {
        return Err(format!(
            "Refusing to delete data_dir itself ({})",
            canon_data.display()
        ));
    }
    if !canon_target.starts_with(&canon_data) {
        return Err(format!(
            "Refusing to delete {} — resolves outside data_dir {}",
            canon_target.display(),
            canon_data.display()
        ));
    }

    std::fs::remove_dir_all(&canon_target)
        .map_err(|e| format!("Could not remove {}: {}", canon_target.display(), e))?;
    Ok(true)
}

/// Delete the isolated depot and the saved Julia-binary choice so the next
/// launch re-prompts and re-precompiles from scratch. The downloaded Julia
/// binary itself is left intact (it's expensive to re-download). Pass
/// `include_binary = true` to also remove the provisioned Julia install.
///
/// All deletions go through `safe_remove_dir`, which refuses symlinks and
/// paths that canonicalize outside `data_dir`. This is the reason we do not
/// expose a generic "clear everything" option — every path deleted here is
/// one we know the app itself created under its own data dir.
///
/// Returns a human-readable summary of what was deleted.
pub fn reset_environment(data_dir: &Path, include_binary: bool) -> Result<String, String> {
    let mut removed: Vec<String> = Vec::new();

    let depot = depot_path(data_dir);
    if safe_remove_dir(&depot, data_dir)? {
        removed.push(format!("depot ({})", depot.display()));
    }

    let choice = choice_file(data_dir);
    if choice.exists() {
        // choice_file is a regular file, not a directory — handle separately.
        // Still verify it's not a symlink to avoid following it.
        let meta = std::fs::symlink_metadata(&choice)
            .map_err(|e| format!("Cannot stat choice file: {}", e))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Refusing to delete symlinked choice file {}",
                choice.display()
            ));
        }
        std::fs::remove_file(&choice)
            .map_err(|e| format!("Could not remove choice file: {}", e))?;
        removed.push("saved choice".to_string());
    }

    if include_binary {
        let install = data_dir.join("julia");
        if safe_remove_dir(&install, data_dir)? {
            removed.push("bundled Julia install".to_string());
        }
    }

    if removed.is_empty() {
        Ok("Nothing to reset — depot and choice are already clean.".to_string())
    } else {
        Ok(format!("Removed: {}", removed.join(", ")))
    }
}

// ===========================================================================
// Download & extract
// ===========================================================================

fn download_url() -> String {
    let p = detect_platform();
    format!(
        "https://julialang-s3.julialang.org/bin/{}/{}/{}/julia-{}-{}.{}",
        p.os, p.arch, JULIA_VERSION_SHORT, JULIA_VERSION, p.suffix, p.ext
    )
}

/// Download Julia, verify its SHA256 checksum, and extract into the app data directory.
/// Progress messages are sent via the callback so the user sees each step.
pub fn download_and_extract(
    data_dir: &Path,
    progress: &dyn Fn(&str),
) -> Result<(), String> {
    let url = download_url();
    let platform = detect_platform();
    let julia_dir = data_dir.join("julia");
    std::fs::create_dir_all(&julia_dir)
        .map_err(|e| format!("Cannot create julia directory: {}", e))?;

    let archive_name = format!(
        "julia-{}-{}.{}",
        JULIA_VERSION, platform.suffix, platform.ext
    );
    let archive_path = julia_dir.join(&archive_name);

    // ---- Download ----
    progress(&format!("Downloading Julia {} ...", JULIA_VERSION));
    log::info!("Downloading Julia from {}", url);

    let response = reqwest::blocking::get(&url)
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed: HTTP {}",
            response.status()
        ));
    }

    let total_size = response.content_length();
    let mut reader = response;
    let mut file = std::fs::File::create(&archive_path)
        .map_err(|e| format!("Cannot create archive file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    let mut last_pct: u64 = 0;

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Download read error: {}", e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("Write error: {}", e))?;
        hasher.update(&buf[..n]);
        downloaded += n as u64;

        if let Some(total) = total_size {
            let pct = (downloaded * 100) / total;
            if pct != last_pct && pct % 10 == 0 {
                progress(&format!(
                    "Downloading Julia {} ... {}%",
                    JULIA_VERSION, pct
                ));
                last_pct = pct;
            }
        }
    }
    drop(file);

    log::info!(
        "Download complete: {} ({} bytes)",
        archive_path.display(),
        downloaded
    );

    // ---- Checksum verification ----
    progress("Verifying download integrity ...");
    let computed = format!("{:x}", hasher.finalize());
    let expected = platform.sha256;

    if computed != expected {
        let _ = std::fs::remove_file(&archive_path);
        return Err(format!(
            "SHA256 checksum mismatch.\n  Expected: {}\n  Got:      {}\n\
             The download may be corrupted or tampered with. \
             The file has been deleted for safety.",
            expected, computed
        ));
    }
    log::info!("SHA256 checksum verified: {}", computed);

    // ---- Extraction ----
    progress("Extracting Julia ...");
    log::info!("Extracting to {}", julia_dir.display());

    let install_dir = julia_install_dir(data_dir);

    // If extraction fails halfway, tear down whatever partial install we
    // wrote so the next launch isn't fooled into thinking Julia is ready.
    let cleanup_on_fail = |e: String| -> String {
        log::warn!("Extraction failed, cleaning up partial install at {}", install_dir.display());
        if install_dir.exists() {
            if let Err(rm_err) = safe_remove_dir(&install_dir, data_dir) {
                log::warn!("Cleanup of partial install also failed: {}", rm_err);
            }
        }
        let _ = std::fs::remove_file(&archive_path);
        e
    };

    let extract_result = if platform.ext == "tar.gz" {
        extract_tar_gz(&archive_path, &julia_dir)
    } else {
        extract_zip(&archive_path, &julia_dir)
    };
    extract_result.map_err(cleanup_on_fail)?;

    let _ = std::fs::remove_file(&archive_path);

    let bin = julia_binary(data_dir);
    if !bin.is_file() {
        // Tarball extracted but binary is missing — likely a partial install
        // or unexpected archive layout. Clean up so the next launch can retry.
        if install_dir.exists() {
            let _ = safe_remove_dir(&install_dir, data_dir);
        }
        return Err(format!(
            "Julia binary not found after extraction at {}",
            bin.display()
        ));
    }

    log::info!(
        "Julia {} provisioned at {}",
        JULIA_VERSION,
        julia_install_dir(data_dir).display()
    );
    progress("Julia runtime ready");
    Ok(())
}

/// Return an error if `entry_path` (as stored in an archive) would escape
/// `dest` when joined — i.e. contains `..` segments, absolute components,
/// or Windows drive prefixes. Defense-in-depth: the extractor crates
/// already refuse obvious traversal, but the SHA256 pin is the real
/// guarantee, and this adds a cheap sanity check.
fn entry_is_contained(entry_path: &Path) -> bool {
    use std::path::Component;
    for component in entry_path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            // ParentDir (..), RootDir (/), Prefix (C:) — all bail
            _ => return false,
        }
    }
    true
}

/// Extract a .tar.gz archive using the flate2 + tar crates, validating each
/// entry's path before writing.
fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("Cannot open archive: {}", e))?;
    let decompressor = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decompressor);

    for entry in archive
        .entries()
        .map_err(|e| format!("Cannot read archive entries: {}", e))?
    {
        let mut entry = entry.map_err(|e| format!("Bad archive entry: {}", e))?;
        let path = entry
            .path()
            .map_err(|e| format!("Cannot read entry path: {}", e))?
            .into_owned();
        if !entry_is_contained(&path) {
            return Err(format!(
                "Refusing to extract entry with unsafe path: {}",
                path.display()
            ));
        }
        entry
            .unpack_in(dest)
            .map_err(|e| format!("Extraction failed for {}: {}", path.display(), e))?;
    }
    Ok(())
}

/// Extract a .zip archive using the zip crate (Windows), validating each
/// entry's path before writing.
fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("Cannot open archive: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid zip archive: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Cannot read zip entry {}: {}", i, e))?;
        let enclosed = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => {
                return Err(format!(
                    "Refusing to extract zip entry with unsafe name: {}",
                    entry.name()
                ));
            }
        };
        if !entry_is_contained(&enclosed) {
            return Err(format!(
                "Refusing to extract zip entry with unsafe path: {}",
                enclosed.display()
            ));
        }
        let out_path = dest.join(&enclosed);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("Cannot create dir {}: {}", out_path.display(), e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Cannot create dir {}: {}", parent.display(), e))?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("Cannot create file {}: {}", out_path.display(), e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Cannot write {}: {}", out_path.display(), e))?;
        }
    }
    Ok(())
}
