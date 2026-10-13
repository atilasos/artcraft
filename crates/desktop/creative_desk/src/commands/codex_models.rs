use tauri::State;
use crate::app_state::AppState;
use crate::codex_bridge::CodexModel;

#[tauri::command]
pub async fn codex_models(state: State<'_, AppState>) -> Result<Vec<CodexModel>, String> {
  let codex = state.codex.clone();
  tauri::async_runtime::spawn_blocking(move || codex.models())
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}
