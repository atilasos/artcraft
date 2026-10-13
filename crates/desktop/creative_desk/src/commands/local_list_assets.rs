use tauri::State;
use crate::app_state::AppState;
use crate::project_store::Asset;

#[tauri::command]
pub fn local_list_assets(state: State<'_, AppState>) -> Result<Vec<Asset>, String> {
  state.store.list_assets().map_err(|error| error.to_string())
}
