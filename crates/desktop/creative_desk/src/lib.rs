pub mod project_store;
pub mod codex_bridge;
#[cfg(feature = "desktop")]
mod app_state;
#[cfg(feature = "desktop")]
mod commands;

#[cfg(feature = "desktop")]
pub fn run() -> anyhow::Result<()> {
  use std::sync::Arc;
  use tauri::Manager;
  use app_state::AppState;
  use codex_bridge::CodexBridge;
  use project_store::ProjectStore;
  let root = std::path::PathBuf::from(
    std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME is unavailable"))?,
  )
  .join("CreativeDesk");
  let store = ProjectStore::new(root)?;
  tauri::Builder::default()
    .manage(AppState { store: Arc::new(store), codex: Arc::new(CodexBridge::default()) })
    .invoke_handler(tauri::generate_handler![
      commands::local_workspace_info::local_workspace_info,
      commands::local_list_projects::local_list_projects,
      commands::local_save_project::local_save_project,
      commands::local_load_project::local_load_project,
      commands::local_import_asset::local_import_asset,
      commands::local_list_assets::local_list_assets,
      commands::local_read_asset::local_read_asset,
      commands::codex_status::codex_status,
      commands::codex_models::codex_models,
      commands::codex_send::codex_send,
    ])
    .build(tauri::generate_context!())?
    .run(|app, event| {
      if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
        app.state::<AppState>().codex.cancel();
      }
    });
  Ok(())
}
