use anyhow::{ensure, Context, Result};
use creative_desk::codex_bridge::{CodexBridge, RequestKind};
use creative_desk::project_store::{Project, ProjectKind, ProjectStore};
use serde_json::json;
use std::io::{self, Write};
use std::path::PathBuf;

fn main() {
  if let Err(error) = entry() {
    let _ = writeln!(io::stderr(), "Creative Desk: {error:#}");
    std::process::exit(1);
  }
}

fn entry() -> Result<()> {
  let args: Vec<String> = std::env::args().skip(1).collect();
  if args.first().map(String::as_str) == Some("--smoke-test") {
    let root = PathBuf::from(args.get(1).context("--smoke-test requires a temporary root")?);
    return smoke(
      root,
      args.iter().any(|arg| arg == "--codex-smoke"),
      args.iter().any(|arg| arg == "--codex-image-smoke"),
      args
        .iter()
        .position(|arg| arg == "--codex-model")
        .map(|index| {
          args.get(index + 1).map(String::as_str).context("--codex-model requires a model ID")
        })
        .transpose()?,
    );
  }
  #[cfg(feature = "desktop")]
  return creative_desk::run();
  #[cfg(not(feature = "desktop"))]
  anyhow::bail!("This build supports --smoke-test only; enable the desktop feature for the app")
}

fn smoke(
  root: PathBuf,
  codex_smoke: bool,
  image_smoke: bool,
  maybe_model: Option<&str>,
) -> Result<()> {
  let store = ProjectStore::new(root.clone())?;
  let project =
    store.save_project(Project::new("Smoke", ProjectKind::Canvas, json!({"layers":[{"x":17}]})))?;
  let loaded = ProjectStore::new(root)?.load_project(&project.id)?;
  ensure!(loaded.document["layers"][0]["x"] == 17, "Storage roundtrip failed");
  let mut result = json!({"storage":"passed", "projectId":project.id});
  if codex_smoke || image_smoke {
    let reply = CodexBridge::default().send(
      &store,
      &project.id,
      if image_smoke {
        "A small simple blue square on a white background."
      } else {
        "Reply with exactly: Creative Desk ready."
      },
      if image_smoke { RequestKind::Image } else { RequestKind::Assistant },
      &[],
      maybe_model,
    )?;
    result["codex"] = serde_json::to_value(reply)?;
  }
  serde_json::to_writer(io::stdout(), &result)?;
  io::stdout().write_all(b"\n")?;
  Ok(())
}
