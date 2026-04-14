mod julia;

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri::menu::MenuBuilder;

// ===========================================================================
// Types
// ===========================================================================

/// Startup progress event payload, sent to the frontend loading screen.
#[derive(Clone, Serialize)]
struct StartupProgress {
    stage: String,
    message: String,
    done: bool,
}

/// A single line of Julia backend output, streamed to the loading screen.
#[derive(Clone, Serialize)]
struct BackendLogLine {
    stream: String,  // "stdout" or "stderr"
    text: String,
}

/// State holding the Julia backend process and its port.
struct BackendState {
    process: Mutex<Option<Child>>,
    port: u16,
}

impl Drop for BackendState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut child) = guard.take() {
                log::info!("Shutting down Julia backend...");
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Channel for the user's Julia runtime choice during startup.
struct JuliaChoiceChannel {
    tx: Mutex<Option<std::sync::mpsc::Sender<String>>>,
}

/// Channel for the frontend to signal it has registered all event listeners.
struct FrontendReadyChannel {
    tx: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

/// Shared data directory path, accessible from menu event handlers.
struct DataDirState {
    path: PathBuf,
}

// ===========================================================================
// IPC commands
// ===========================================================================

/// IPC command: returns the port the Julia backend is listening on.
#[tauri::command]
fn get_backend_port(state: tauri::State<BackendState>) -> u16 {
    state.port
}

/// IPC command: returns the data directory path (schedules, results, etc.).
#[tauri::command]
fn get_data_dir(state: tauri::State<DataDirState>) -> String {
    state.path.to_string_lossy().into_owned()
}

/// IPC command: the user chose which Julia runtime to use.
/// Called from the loading screen when the user clicks a choice button.
/// `choice` is one of: "system", "dedicated".
#[tauri::command]
fn resolve_julia_choice(choice: String, state: tauri::State<JuliaChoiceChannel>) {
    log::info!("User chose Julia runtime: {}", choice);
    if let Ok(guard) = state.tx.lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(choice);
        }
    }
}

/// IPC command: frontend has registered all event listeners.
/// Must be called before the setup thread proceeds.
#[tauri::command]
fn frontend_ready(state: tauri::State<FrontendReadyChannel>) {
    log::info!("Frontend reports ready");
    if let Ok(mut guard) = state.tx.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
}

// ===========================================================================
// Progress helpers
// ===========================================================================

/// Emit a startup progress event to the frontend.
fn emit_progress(handle: &tauri::AppHandle, stage: &str, message: &str, done: bool) {
    log::info!("[startup] {}: {}", stage, message);
    let _ = handle.emit("startup-progress", StartupProgress {
        stage: stage.to_string(),
        message: message.to_string(),
        done,
    });
}

/// Emit a startup error event and log it.
fn emit_error(handle: &tauri::AppHandle, message: &str) {
    log::error!("[startup] {}", message);
    let _ = handle.emit("startup-progress", StartupProgress {
        stage: "error".to_string(),
        message: message.to_string(),
        done: false,
    });
}

// ===========================================================================
// Data directory
// ===========================================================================

/// Resolve the data directory for user storage (schedules, results, exports).
/// In dev mode: `backend/data/` (runtime data only).
/// In production: platform-specific app data directory.
fn resolve_data_dir(app: &tauri::App) -> PathBuf {
    if cfg!(debug_assertions) {
        let dev_dir = find_server_dir(None).join("data");
        log::info!("Dev mode -- using data at {}", dev_dir.display());
        return dev_dir;
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .expect("cannot resolve app data directory");
    std::fs::create_dir_all(&data_dir).expect("cannot create app data directory");
    log::info!("Production mode -- using data at {}", data_dir.display());
    data_dir
}

/// Resolve the examples directory for curated schedules.
/// In dev mode: `backend/examples/` (committed, in-tree).
/// In production: seeded into `<data_dir>/schedules/examples/`.
fn resolve_examples_dir(data_dir: &Path) -> PathBuf {
    if cfg!(debug_assertions) {
        let dev_dir = find_server_dir(None).join("examples");
        log::info!("Dev mode -- examples at {}", dev_dir.display());
        return dev_dir;
    }

    let examples_dir = data_dir.join("schedules").join("examples");
    log::info!("Production mode -- examples at {}", examples_dir.display());
    examples_dir
}

// ===========================================================================
// Server directory
// ===========================================================================

/// Find the Julia server directory.
/// - Dev mode: `../backend/` relative to tauri-app (the backend folder).
/// - Production: `<resource_dir>/server/` (bundled by Tauri).
fn find_server_dir(app: Option<&tauri::AppHandle>) -> PathBuf {
    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("backend"));

        if let Some(path) = dev_path {
            if path.join("run.jl").exists() {
                log::info!("Using dev server directory: {}", path.display());
                return path;
            }
        }
    }

    // Production: bundled resources
    if let Some(handle) = app {
        let resource_dir = handle
            .path()
            .resource_dir()
            .expect("cannot resolve resource directory");
        let server_dir = resource_dir.join("server");
        if server_dir.join("run.jl").exists() {
            log::info!("Using bundled server directory: {}", server_dir.display());
            return server_dir;
        }
        log::warn!("Bundled server dir missing run.jl: {}", server_dir.display());
    }

    log::warn!("Could not locate server directory, using current dir");
    std::env::current_dir().expect("cannot determine current directory")
}

// ===========================================================================
// Example schedules seeding
// ===========================================================================

/// On first launch, copy bundled example schedules into the data directory
/// so the user has something to explore straight away.
fn seed_example_schedules(data_dir: &Path, app_handle: &tauri::AppHandle) {
    let examples_dir = data_dir.join("schedules").join("examples");

    // Skip if examples already exist (not a first launch)
    if examples_dir.is_dir() {
        let has_files = std::fs::read_dir(&examples_dir)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        if has_files {
            log::debug!("Example schedules already present, skipping seed");
            return;
        }
    }

    // In dev mode the examples are already in the storage dir
    if cfg!(debug_assertions) {
        log::debug!("Dev mode -- example schedules already in place");
        return;
    }

    // Production: copy from the bundled resources
    let bundled_examples = find_server_dir(Some(app_handle)).join("examples");

    if !bundled_examples.is_dir() {
        log::warn!(
            "Bundled example schedules not found at {}",
            bundled_examples.display()
        );
        return;
    }

    std::fs::create_dir_all(&examples_dir).expect("cannot create examples dir");

    let entries = std::fs::read_dir(&bundled_examples)
        .expect("cannot read bundled examples directory");

    let mut count = 0u32;
    for entry in entries.flatten() {
        let src = entry.path();
        if src.extension().and_then(|e| e.to_str()) == Some("json") {
            let dest = examples_dir.join(entry.file_name());
            if let Err(e) = std::fs::copy(&src, &dest) {
                log::warn!("Failed to copy example schedule {:?}: {}", src, e);
            } else {
                count += 1;
            }
        }
    }

    log::info!("Seeded {} example schedules into {}", count, examples_dir.display());
}

// ===========================================================================
// Julia runtime resolution (interactive)
// ===========================================================================

/// Resolve the Julia binary, interacting with the user if needed.
/// In dev mode this simply returns "julia" (system PATH).
/// In production:
///   - Detect system Julia: if compatible, prompt the user to choose.
///   - If outdated, prompt to either update or download a dedicated copy.
///   - If not found, auto-download a dedicated copy.
fn resolve_julia_binary(
    data_dir: &Path,
    handle: &tauri::AppHandle,
    choice_rx: &std::sync::mpsc::Receiver<String>,
) -> Result<PathBuf, String> {
    // Dev mode: always use system Julia, no depot isolation
    if cfg!(debug_assertions) {
        log::info!("Dev mode -- using system Julia");
        return Ok(PathBuf::from("julia"));
    }

    // Check if we already have a provisioned copy
    if julia::is_provisioned(data_dir) {
        let bin = julia::provisioned_binary(data_dir);
        log::info!("Julia already provisioned at {}", bin.display());
        emit_progress(handle, "julia", "Julia runtime found", false);
        return Ok(bin);
    }

    // Check for a previously saved choice (e.g. system Julia from last launch)
    if let Some(saved) = julia::load_validated_choice(data_dir) {
        log::info!("Using saved Julia choice: {}", saved.display());
        emit_progress(handle, "julia", "Julia runtime found", false);
        return Ok(saved);
    }

    // Probe for system Julia
    emit_progress(handle, "julia", "Detecting Julia installation...", false);
    let system = julia::detect_system_julia();
    let prompt = julia::build_prompt(&system);

    let download = |handle: &tauri::AppHandle, data_dir: &Path| -> Result<PathBuf, String> {
        julia::download_and_extract(data_dir, &|msg| {
            emit_progress(handle, "julia", msg, false);
        })?;
        Ok(julia::provisioned_binary(data_dir))
    };

    match prompt.situation.as_str() {
        "compatible" => {
            // System Julia is good -- ask the user
            log::info!("Compatible system Julia found, prompting user");
            let _ = handle.emit("julia-prompt", &prompt);

            // Block until the user picks
            let choice = choice_rx
                .recv()
                .map_err(|e| format!("Julia choice channel closed: {}", e))?;

            if choice == "system" {
                if let julia::SystemJulia::Found { path, .. } = &system {
                    emit_progress(handle, "julia", "Using system Julia", false);
                    return Ok(path.clone());
                }
            }

            // User chose "dedicated" -- download
            emit_progress(handle, "julia", "Downloading dedicated Julia...", false);
            download(handle, data_dir)
        }
        "outdated" => {
            // System Julia is too old -- inform user, download
            log::info!("Outdated system Julia found, prompting user");
            let _ = handle.emit("julia-prompt", &prompt);

            let choice = choice_rx
                .recv()
                .map_err(|e| format!("Julia choice channel closed: {}", e))?;

            // Only "dedicated" is valid for outdated
            if choice != "dedicated" {
                log::warn!("Unexpected choice for outdated Julia: {}", choice);
            }

            emit_progress(handle, "julia", "Downloading dedicated Julia...", false);
            download(handle, data_dir)
        }
        _ => {
            // No system Julia found -- prompt user before downloading
            log::info!("No Julia found, prompting user");
            let _ = handle.emit("julia-prompt", &prompt);

            let choice = choice_rx
                .recv()
                .map_err(|e| format!("Julia choice channel closed: {}", e))?;

            if choice == "dedicated" {
                emit_progress(
                    handle,
                    "julia",
                    "Downloading Julia...",
                    false,
                );
                download(handle, data_dir)
            } else if choice.starts_with("path:") {
                // User provided a custom path
                let custom_path = PathBuf::from(choice.trim_start_matches("path:"));
                match julia::try_julia_at(&custom_path) {
                    Some(julia::SystemJulia::Found { path, version }) => {
                        if version.is_compatible() {
                            emit_progress(handle, "julia", &format!("Using Julia {} at {}", version, path.display()), false);
                            Ok(path)
                        } else {
                            Err(format!(
                                "Julia {} at {} is too old (need {}.{}+)",
                                version, path.display(), julia::JULIA_MIN_MAJOR, julia::JULIA_MIN_MINOR
                            ))
                        }
                    }
                    _ => Err(format!("Could not run Julia at: {}", custom_path.display())),
                }
            } else {
                Err("No Julia installation resolved".to_string())
            }
        }
    }
}

// ===========================================================================
// Backend spawn
// ===========================================================================

/// Spawn the Julia backend on a given port with a data directory.
/// Sets `JULIA_DEPOT_PATH` for depot isolation and pipes stdout/stderr.
fn spawn_julia_backend(
    julia_bin: &Path,
    port: u16,
    data_dir: &Path,
    examples_dir: &Path,
    app_handle: &tauri::AppHandle,
) -> Result<Child, String> {
    let server_dir = find_server_dir(Some(app_handle));
    let run_script = server_dir.join("run.jl");
    let depot = julia::depot_path(data_dir);

    std::fs::create_dir_all(&depot)
        .map_err(|e| format!("Cannot create Julia depot directory: {}", e))?;

    log::info!(
        "Starting Julia backend: {} --project={} {} 127.0.0.1 {} --data-dir={} --examples-dir={} (depot={})",
        julia_bin.display(),
        server_dir.display(),
        run_script.display(),
        port,
        data_dir.display(),
        examples_dir.display(),
        depot.display()
    );

    let mut cmd = Command::new(julia_bin);
    cmd.arg(format!("--project={}", server_dir.display()))
        .arg(&run_script)
        .arg("127.0.0.1")
        .arg(port.to_string())
        .arg(format!("--data-dir={}", data_dir.display()))
        .arg(format!("--examples-dir={}", examples_dir.display()))
        .current_dir(&server_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Isolate depot in production mode
    if !cfg!(debug_assertions) {
        cmd.env("JULIA_DEPOT_PATH", &depot);
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to start Julia backend at {}: {}", julia_bin.display(), e))
}

/// Spawn reader threads that forward the child's stdout/stderr as
/// `backend-log` events to the loading screen.
fn stream_backend_output(child: &mut Child, handle: &tauri::AppHandle) {
    if let Some(stdout) = child.stdout.take() {
        let h = handle.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(text) = line {
                    log::debug!("[julia:stdout] {}", text);
                    let _ = h.emit("backend-log", BackendLogLine {
                        stream: "stdout".to_string(),
                        text,
                    });
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let h = handle.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(text) = line {
                    log::debug!("[julia:stderr] {}", text);
                    let _ = h.emit("backend-log", BackendLogLine {
                        stream: "stderr".to_string(),
                        text,
                    });
                }
            }
        });
    }
}

// ===========================================================================
// Backend health check
// ===========================================================================

/// Result of waiting for the backend.
enum BackendStatus {
    Ready,
    Timeout,
    ProcessExited(Option<i32>),
}

/// Poll the backend until it accepts HTTP connections, or time out.
/// Also watches the child process for early exit.
fn wait_for_backend(
    port: u16,
    timeout: Duration,
    process: &Mutex<Option<Child>>,
) -> BackendStatus {
    let start = std::time::Instant::now();
    let poll_interval = Duration::from_millis(500);
    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();

    log::info!("Waiting for Julia backend on port {}...", port);

    loop {
        // Check if the process has exited
        if let Ok(mut guard) = process.lock() {
            if let Some(ref mut child) = *guard {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        log::error!("Julia backend exited early with {}", status);
                        return BackendStatus::ProcessExited(status.code());
                    }
                    Err(e) => {
                        log::error!("Cannot check Julia process status: {}", e);
                        return BackendStatus::ProcessExited(None);
                    }
                    Ok(None) => {} // Still running
                }
            }
        }

        if start.elapsed() > timeout {
            log::warn!("Julia backend did not respond within {} s", timeout.as_secs());
            return BackendStatus::Timeout;
        }

        // Try a simple HTTP GET via raw TCP to check Oxygen is serving.
        if let Ok(mut stream) = std::net::TcpStream::connect_timeout(
            &addr,
            Duration::from_millis(500),
        ) {
            use std::io::{Read, Write};
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let request = format!(
                "GET /schedules HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                port
            );
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut response = String::new();
                let _ = stream.read_to_string(&mut response);
                if response.contains("200") {
                    log::info!("Julia backend is ready on port {}", port);
                    return BackendStatus::Ready;
                }
            }
        }

        std::thread::sleep(poll_interval);
    }
}

// ===========================================================================
// App entry point
// ===========================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port = portpicker::pick_unused_port().expect("no free port available");

    // Channel for the interactive Julia choice prompt
    let (choice_tx, choice_rx) = std::sync::mpsc::channel::<String>();
    // Channel for the frontend-ready handshake
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();

    tauri::Builder::default()
        .manage(BackendState {
            process: Mutex::new(None),
            port,
        })
        .manage(JuliaChoiceChannel {
            tx: Mutex::new(Some(choice_tx)),
        })
        .manage(FrontendReadyChannel {
            tx: Mutex::new(Some(ready_tx)),
        })
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            get_data_dir,
            resolve_julia_choice,
            frontend_ready,
        ])
        .setup(move |app| {
            // Logging plugin
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Dialog plugin (native save dialogs for export)
            app.handle().plugin(tauri_plugin_dialog::init())?;

            // Filesystem plugin (write exported files to disk)
            app.handle().plugin(tauri_plugin_fs::init())?;

            // Opener plugin (reveal folders in native file manager)
            app.handle().plugin(tauri_plugin_opener::init())?;

            // Start with an empty menu (frontend replaces it once loaded)
            let empty_menu = MenuBuilder::new(app.handle()).build()?;
            app.set_menu(empty_menu)?;

            let handle = app.handle().clone();
            let data_dir = resolve_data_dir(app);
            let examples_dir = resolve_examples_dir(&data_dir);

            // Store data_dir for IPC access
            app.manage(DataDirState { path: data_dir.clone() });

            // Move the setup logic to a thread so the IPC handler
            // can receive the Julia choice while we block on the channel.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                // Wait for the frontend to confirm it has registered all
                // event listeners so we don't lose fire-and-forget events.
                log::info!("Setup thread waiting for frontend_ready...");
                let _ = ready_rx.recv_timeout(Duration::from_secs(30));
                log::info!("Frontend is ready, proceeding with setup");

                // Resolve Julia binary (may prompt user interactively)
                emit_progress(&handle, "julia", "Checking Julia runtime...", false);
                let julia_bin = match resolve_julia_binary(&data_dir, &handle, &choice_rx) {
                    Ok(bin) => {
                        // Persist the choice for next launch
                        julia::save_choice(&data_dir, &bin);
                        bin
                    }
                    Err(e) => {
                        emit_error(&handle, &e);
                        return;
                    }
                };

                // Seed example schedules on first launch
                seed_example_schedules(&data_dir, &app_handle);

                // Spawn Julia backend
                emit_progress(&handle, "julia", "Starting Julia backend...", false);
                let mut child = match spawn_julia_backend(&julia_bin, port, &data_dir, &examples_dir, &app_handle) {
                    Ok(child) => child,
                    Err(e) => {
                        emit_error(&handle, &e);
                        return;
                    }
                };
                stream_backend_output(&mut child, &handle);

                let backend_state: tauri::State<BackendState> = app_handle.state();
                *backend_state.process.lock().unwrap() = Some(child);

                let depot_packages = julia::depot_path(&data_dir).join("packages");
                let first_run = !depot_packages.is_dir();
                emit_progress(
                    &handle,
                    "julia",
                    if first_run {
                        "Loading Julia packages (this may take a while on first run)..."
                    } else {
                        "Starting Julia backend..."
                    },
                    false,
                );

                match wait_for_backend(port, Duration::from_secs(600), &backend_state.process) {
                    BackendStatus::Ready => {
                        emit_progress(&handle, "ready", "Backend is ready", true);
                        let _ = handle.emit("backend-ready", port);
                    }
                    BackendStatus::Timeout => {
                        emit_error(
                            &handle,
                            "Julia is taking longer than expected. \
                             The window will open -- it may still be loading.",
                        );
                        let _ = handle.emit("backend-ready", port);
                    }
                    BackendStatus::ProcessExited(code) => {
                        let msg = match code {
                            Some(c) => format!("Julia backend crashed (exit code {})", c),
                            None => "Julia backend crashed".to_string(),
                        };
                        emit_error(&handle, &msg);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
