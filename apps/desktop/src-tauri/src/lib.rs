//! Native capabilities only. Course production and learning stay in TypeScript.
use rand::RngCore;
use tauri::{Manager, menu::{Menu, MenuItem}, tray::TrayIconBuilder};
use tauri_plugin_dialog::DialogExt;
use std::{collections::HashMap, path::{PathBuf, Component}, sync::Mutex};

#[derive(Default)]
struct SelectedDirectories(Mutex<HashMap<String, PathBuf>>);

#[tauri::command]
async fn select_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(folder) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
        let path = folder.into_path().map_err(|_| "directory unavailable")?
            .canonicalize().map_err(|_| "directory unavailable")?;
        let mut random = [0u8; 16]; rand::rngs::OsRng.fill_bytes(&mut random);
        let handle: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        app.state::<SelectedDirectories>().0.lock().map_err(|_| "directory unavailable")?.insert(handle.clone(), path);
        Ok(Some(handle))
    }).await.map_err(|_| "directory unavailable".to_string())?
}

#[tauri::command]
fn read_selected_file(handle: String, name: String, directories: tauri::State<SelectedDirectories>) -> Result<Vec<u8>, String> {
    let relative = PathBuf::from(&name);
    if name.is_empty() || name.contains('\\') || relative.components().any(|part| match part {
        Component::Normal(value) => value.to_string_lossy().starts_with('.'), _ => true,
    }) { return Err("file path denied".into()) }
    let root = directories.0.lock().map_err(|_| "directory unavailable")?
        .get(&handle).cloned().ok_or("directory unavailable")?;
    let path = root.join(relative).canonicalize().map_err(|_| "file unavailable")?;
    if !path.starts_with(&root) { return Err("file path denied".into()) }
    let metadata = path.metadata().map_err(|_| "file unavailable")?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 { return Err("file unavailable or too large".into()) }
    std::fs::read(path).map_err(|_| "file unavailable".into())
}

#[tauri::command]
fn vault_password() -> Result<String, String> {
    let entry = keyring::Entry::new("com.linjiang12.course-reader", "stronghold-password")
        .map_err(|_| "credential store unavailable".to_string())?;
    match entry.get_password() {
        Ok(password) => Ok(password),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            let password: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            entry.set_password(&password).map_err(|_| "credential store write failed".to_string())?;
            Ok(password)
        }
        Err(_) => Err("credential store locked or unavailable".to_string()),
    }
}

#[tauri::command]
fn updates_enabled() -> bool { cfg!(feature = "updater") }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SelectedDirectories::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![vault_password, updates_enabled, select_directory, read_selected_file])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let data = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data)?;
            app.handle().plugin(tauri_plugin_stronghold::Builder::with_argon2(&data.join("salt.txt")).build())?;
            #[cfg(feature = "updater")]
            {
                let endpoint = env!("READER_UPDATE_URL").parse()?;
                let updater = tauri_plugin_updater::Builder::new()
                    .pubkey(env!("READER_UPDATER_PUBLIC_KEY"))
                    .endpoints(vec![endpoint])?.build();
                app.handle().plugin(updater)?;
            }
            let show = MenuItem::with_id(app, "show", "打开阅读器", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new().menu(&menu).on_menu_event(|app, event| {
                match event.id.as_ref() {
                    "show" => if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show(); let _ = window.set_focus();
                    },
                    "quit" => app.exit(0),
                    _ => (),
                }
            });
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用失败");
}
