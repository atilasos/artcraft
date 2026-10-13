use tauri::State;
use crate::app_state::AppState;
use crate::project_store::Asset;

#[tauri::command]
pub fn local_import_asset(
  state: State<'_, AppState>,
  name: String,
  mime_type: String,
  bytes_base64: String,
) -> Result<Asset, String> {
  state.store.import_asset(&name, &mime_type, &bytes_base64).map_err(|error| error.to_string())
}
