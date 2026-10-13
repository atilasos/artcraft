use tauri::State;
use crate::app_state::AppState;
use crate::codex_bridge::{CodexReply, RequestKind};

#[tauri::command]
pub async fn codex_send(
  state: State<'_, AppState>,
  project_id: String,
  prompt: String,
  kind: RequestKind,
  asset_ids: Vec<String>,
  maybe_model: Option<String>,
) -> Result<CodexReply, String> {
  let codex = state.codex.clone();
  let store = state.store.clone();
  tauri::async_runtime::spawn_blocking(move || {
    codex.send(&store, &project_id, &prompt, kind, &asset_ids, maybe_model.as_deref())
  })
  .await
  .map_err(|error| error.to_string())?
  .map_err(|error| error.to_string())
}
