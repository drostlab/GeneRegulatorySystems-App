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
/// Minimum Julia version the server supports.
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
    /// Whether this version meets the minimum requirement.
    pub fn is_compatible(&self) -> bool {
        (self.major, self.minor) >= (JULIA_MIN_MAJOR, JULIA_MIN_MINOR)
    }
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
fn known_julia_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(home) = dirs_home() {
        // juliaup (all platforms)
        paths.push(home.join(".juliaup").join("bin").join("julia"));
        // Homebrew (macOS)
        paths.push(PathBuf::from("/opt/homebrew/bin/julia"));
        paths.push(PathBuf::from("/usr/local/bin/julia"));
        // Linux common
        paths.push(PathBuf::from("/usr/bin/julia"));
        // macOS .app bundle
        for entry in std::fs::read_dir("/Applications").into_iter().flatten() {
            if let Ok(e) = entry {
                let name = e.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("Julia-") && name.ends_with(".app") {
                    paths.push(
                        e.path()
                            .join("Contents")
                            .join("Resources")
                            .join("julia")
                            .join("bin")
                            .join("julia"),
                    );
                }
            }
        }
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

/// Parse "julia version X.Y.Z" into a JuliaVersion.
fn parse_julia_version(s: &str) -> Option<JuliaVersion> {
    // Handle both "julia version 1.11.3" and "1.11.3"
    let version_part = s.split_whitespace().last()?;
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
#[derive(Debug, Clone, serde::Serialize)]
pub struct JuliaPrompt {
    /// "compatible", "outdated", or "not_found"
    pub situation: String,
    /// Human-readable system version (empty if not found).
    pub system_version: String,
    /// Required minimum version string.
    pub min_version: String,
    /// The version that would be downloaded.
    pub download_version: String,
}

/// Build the prompt payload based on system detection.
pub fn build_prompt(system: &SystemJulia) -> JuliaPrompt {
    let min_version = format!("{}.{}", JULIA_MIN_MAJOR, JULIA_MIN_MINOR);
    let download_version = JULIA_VERSION.to_string();

    match system {
        SystemJulia::Found { version, .. } => {
            if version.is_compatible() {
                JuliaPrompt {
                    situation: "compatible".to_string(),
                    system_version: version.raw.clone(),
                    min_version,
                    download_version,
                }
            } else {
                JuliaPrompt {
                    situation: "outdated".to_string(),
                    system_version: version.raw.clone(),
                    min_version,
                    download_version,
                }
            }
        }
        SystemJulia::NotFound => JuliaPrompt {
            situation: "not_found".to_string(),
            system_version: String::new(),
            min_version,
            download_version,
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
pub fn save_choice(data_dir: &Path, julia_path: &Path) {
    let file = choice_file(data_dir);
    if let Err(e) = std::fs::write(&file, julia_path.to_string_lossy().as_bytes()) {
        log::warn!("Could not persist Julia choice to {}: {}", file.display(), e);
    } else {
        log::info!("Persisted Julia choice: {}", julia_path.display());
    }
}

/// Load and validate a previously saved Julia choice.
/// Returns the path only if the file exists, the binary still runs, and
/// its version is still compatible. Deletes the file if validation fails.
pub fn load_validated_choice(data_dir: &Path) -> Option<PathBuf> {
    let file = choice_file(data_dir);
    let contents = std::fs::read_to_string(&file).ok()?;
    let saved_path = PathBuf::from(contents.trim());

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

    if platform.ext == "tar.gz" {
        extract_tar_gz(&archive_path, &julia_dir)?;
    } else {
        extract_zip(&archive_path, &julia_dir)?;
    }

    let _ = std::fs::remove_file(&archive_path);

    let bin = julia_binary(data_dir);
    if !bin.is_file() {
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

/// Extract a .tar.gz archive using the flate2 + tar crates.
fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("Cannot open archive: {}", e))?;
    let decompressor = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decompressor);
    archive
        .unpack(dest)
        .map_err(|e| format!("Extraction failed: {}", e))?;
    Ok(())
}

/// Extract a .zip archive using the zip crate (Windows).
fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path)
        .map_err(|e| format!("Cannot open archive: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid zip archive: {}", e))?;
    archive
        .extract(dest)
        .map_err(|e| format!("Zip extraction failed: {}", e))?;
    Ok(())
}
