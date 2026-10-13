use tauri::State;
use crate::app_state::AppState;
use crate::project_store::AssetData;

#[tauri::command]
pub fn local_read_asset(state: State<'_, AppState>, id: String) -> Result<AssetData, String> {
  state.store.read_asset(&id).map_err(|error| error.to_string())
}
