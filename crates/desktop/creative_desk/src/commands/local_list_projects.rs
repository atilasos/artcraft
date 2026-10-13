use tauri::State;
use crate::app_state::AppState;
use crate::project_store::ProjectListing;

#[tauri::command]
pub fn local_list_projects(state: State<'_, AppState>) -> Result<ProjectListing, String> {
  state.store.list_projects().map_err(|error| error.to_string())
}
