use tauri::State;
use crate::app_state::AppState;
use crate::project_store::WorkspaceInfo;

#[tauri::command]
pub fn local_workspace_info(state: State<'_, AppState>) -> Result<WorkspaceInfo, String> {
  Ok(state.store.workspace_info())
}
