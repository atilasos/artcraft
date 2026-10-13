use tauri::State;
use crate::app_state::AppState;
use crate::project_store::Project;

#[tauri::command]
pub fn local_load_project(state: State<'_, AppState>, id: String) -> Result<Project, String> {
  state.store.load_project(&id).map_err(|error| error.to_string())
}
