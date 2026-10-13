use tauri::State;
use crate::app_state::AppState;
use crate::project_store::Project;

#[tauri::command]
pub fn local_save_project(state: State<'_, AppState>, project: Project) -> Result<Project, String> {
  state.store.save_project(project).map_err(|error| error.to_string())
}
