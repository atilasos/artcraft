use std::sync::Arc;
use crate::codex_bridge::CodexBridge;
use crate::project_store::ProjectStore;

pub struct AppState {
  pub store: Arc<ProjectStore>,
  pub codex: Arc<CodexBridge>,
}
