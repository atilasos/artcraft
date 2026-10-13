use tauri::State;
use crate::app_state::AppState;
use crate::codex_bridge::CodexStatus;

#[tauri::command]
pub async fn codex_status(state: State<'_, AppState>) -> Result<CodexStatus, String> {
  let codex = state.codex.clone();
  tauri::async_runtime::spawn_blocking(move || codex.status())
    .await
    .map_err(|error| error.to_string())
}
