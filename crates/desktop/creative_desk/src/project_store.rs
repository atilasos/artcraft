use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

const MAX_ASSET_BYTES: usize = 256 * 1024 * 1024;
pub const APPLICATION_ID: &str = "local.creative.desk";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
  pub schema_version: u32,
  pub id: String,
  pub name: String,
  pub kind: ProjectKind,
  pub document: Value,
  pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
  Canvas,
  Scene,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
  pub id: String,
  pub name: String,
  pub mime_type: String,
  pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
  pub root_path: String,
  pub application_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetData {
  pub asset: Asset,
  pub data_url: String,
}

#[derive(Serialize)]
pub struct ProjectListing {
  pub projects: Vec<Project>,
  pub warnings: Vec<String>,
}

pub struct ProjectStore {
  root: PathBuf,
}

impl Project {
  pub fn new(name: &str, kind: ProjectKind, document: Value) -> Self {
    Self {
      schema_version: 1,
      id: Uuid::new_v4().to_string(),
      name: name.into(),
      kind,
      document,
      updated_at: Utc::now().to_rfc3339(),
    }
  }
}

impl ProjectStore {
  pub fn new(root: PathBuf) -> Result<Self> {
    ensure!(root.is_absolute(), "Workspace root must be absolute");
    if let Ok(metadata) = fs::symlink_metadata(&root) {
      ensure!(!metadata.file_type().is_symlink(), "Workspace root cannot be a symlink");
    }
    fs::create_dir_all(&root)?;
    let store = Self { root: root.canonicalize()? };
    for name in ["projects", "assets"] {
      fs::create_dir_all(store.safe_path(Path::new(name))?)?;
    }
    Ok(store)
  }

  pub fn workspace_info(&self) -> WorkspaceInfo {
    WorkspaceInfo {
      root_path: self.root.to_string_lossy().into(),
      application_id: APPLICATION_ID.into(),
    }
  }

  pub fn save_project(&self, mut project: Project) -> Result<Project> {
    validate_project(&project)?;
    let directory = self.safe_path(&Path::new("projects").join(&project.id))?;
    fs::create_dir_all(&directory)?;
    project.updated_at = Utc::now().to_rfc3339();
    self.write_json(&directory.join("project.json"), &project)?;
    Ok(project)
  }

  pub fn load_project(&self, id: &str) -> Result<Project> {
    validate_id(id)?;
    let path = self.safe_path(&Path::new("projects").join(id).join("project.json"))?;
    let project: Project = serde_json::from_slice(&fs::read(path).context("Cannot read project")?)?;
    validate_project(&project)?;
    ensure!(project.id == id, "Project ID does not match its directory");
    Ok(project)
  }

  pub fn list_projects(&self) -> Result<ProjectListing> {
    let mut projects = Vec::new();
    let mut warnings = Vec::new();
    for entry in fs::read_dir(self.safe_path(Path::new("projects"))?)? {
      let entry = entry?;
      let id = entry.file_name().to_string_lossy().into_owned();
      match self.load_project(&id) {
        Ok(project) => projects.push(project),
        Err(_) => warnings.push(if validate_id(&id).is_ok() {
          format!("Cannot load project {id}; its files were preserved")
        } else {
          "Ignored an invalid project directory; its files were preserved".into()
        }),
      }
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(ProjectListing { projects, warnings })
  }

  pub fn project_codex_dir(&self, id: &str) -> Result<PathBuf> {
    self.load_project(id)?;
    let path = self.safe_path(&Path::new("projects").join(id).join("codex"))?;
    fs::create_dir_all(&path)?;
    Ok(path)
  }

  pub fn import_asset(&self, name: &str, mime_type: &str, bytes_base64: &str) -> Result<Asset> {
    ensure!(bytes_base64.len() <= MAX_ASSET_BYTES * 4 / 3 + 4, "Asset is too large");
    let bytes = STANDARD.decode(bytes_base64).context("Invalid asset base64")?;
    self.import_bytes(name, mime_type, &bytes)
  }

  pub fn import_bytes(&self, name: &str, mime_type: &str, bytes: &[u8]) -> Result<Asset> {
    ensure!(!name.trim().is_empty(), "Asset name is required");
    ensure!(!bytes.is_empty() && bytes.len() <= MAX_ASSET_BYTES, "Asset is empty or too large");
    let extension = asset_extension(mime_type)?;
    let id = Uuid::new_v4().to_string();
    let directory = self.safe_path(&Path::new("assets").join(&id))?;
    fs::create_dir(&directory)?;
    let path = directory.join(format!("data.{extension}"));
    let asset = Asset {
      id,
      name: name.into(),
      mime_type: mime_type.into(),
      path: path.to_string_lossy().into(),
    };
    self.write_bytes(&path, bytes)?;
    self.write_json(&directory.join("asset.json"), &asset)?;
    Ok(asset)
  }

  pub fn load_asset(&self, id: &str) -> Result<Asset> {
    validate_id(id)?;
    let directory = self.safe_path(&Path::new("assets").join(id))?;
    let metadata = self.safe_path(&Path::new("assets").join(id).join("asset.json"))?;
    let asset: Asset = serde_json::from_slice(&fs::read(metadata)?)?;
    ensure!(asset.id == id && !asset.name.trim().is_empty(), "Invalid asset metadata");
    let expected = directory.join(format!("data.{}", asset_extension(&asset.mime_type)?));
    ensure!(Path::new(&asset.path) == expected, "Asset path does not match owned storage");
    self.safe_path(expected.strip_prefix(&self.root)?)?;
    ensure!(expected.is_file(), "Asset data is missing");
    Ok(asset)
  }

  pub fn list_assets(&self) -> Result<Vec<Asset>> {
    let mut assets = Vec::new();
    for entry in fs::read_dir(self.safe_path(Path::new("assets"))?)? {
      let id = entry?.file_name().to_string_lossy().into_owned();
      match self.load_asset(&id) {
        Ok(asset) => assets.push(asset),
        Err(_) => log::warn!("Cannot load a local asset directory; other assets remain available"),
      }
    }
    assets.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(assets)
  }

  pub fn read_asset(&self, id: &str) -> Result<AssetData> {
    let asset = self.load_asset(id)?;
    let bytes = fs::read(&asset.path)?;
    ensure!(bytes.len() <= MAX_ASSET_BYTES, "Asset is too large");
    let data_url = format!("data:{};base64,{}", asset.mime_type, STANDARD.encode(bytes));
    Ok(AssetData { asset, data_url })
  }

  fn safe_path(&self, relative: &Path) -> Result<PathBuf> {
    let mut path = self.root.clone();
    for component in relative.components() {
      let Component::Normal(name) = component else {
        bail!("Unsafe workspace path");
      };
      path.push(name);
      match fs::symlink_metadata(&path) {
        Ok(metadata) => ensure!(
          !metadata.file_type().is_symlink(),
          "Symlinks are not allowed in workspace storage"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
      }
    }
    Ok(path)
  }

  fn write_json(&self, path: &Path, value: &impl Serialize) -> Result<()> {
    self.write_bytes(path, &serde_json::to_vec_pretty(value)?)
  }

  fn write_bytes(&self, path: &Path, bytes: &[u8]) -> Result<()> {
    self.safe_path(path.strip_prefix(&self.root)?)?;
    let parent = path.parent().context("Missing parent directory")?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
      let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
      file.write_all(bytes)?;
      file.sync_all()?;
      fs::rename(&temporary, path)?;
      Ok(())
    })();
    if result.is_err() {
      let _ = fs::remove_file(temporary);
    }
    result
  }
}

fn validate_project(project: &Project) -> Result<()> {
  ensure!(project.schema_version == 1, "Unsupported project schema");
  validate_id(&project.id)?;
  ensure!(!project.name.trim().is_empty(), "Project name is required");
  chrono::DateTime::parse_from_rfc3339(&project.updated_at).context("Invalid project timestamp")?;
  Ok(())
}

fn validate_id(id: &str) -> Result<()> {
  let uuid = Uuid::parse_str(id).context("Invalid local ID")?;
  ensure!(uuid.to_string() == id, "Local IDs must be canonical UUIDs");
  Ok(())
}

fn asset_extension(mime_type: &str) -> Result<&'static str> {
  Ok(match mime_type {
    "image/png" => "png",
    "image/jpeg" => "jpg",
    "image/webp" => "webp",
    "image/gif" => "gif",
    "video/mp4" => "mp4",
    "video/webm" => "webm",
    "video/quicktime" => "mov",
    "audio/mpeg" => "mp3",
    "audio/wav" | "audio/x-wav" => "wav",
    "audio/ogg" => "ogg",
    "audio/mp4" => "m4a",
    "model/gltf-binary" => "glb",
    "application/octet-stream" => "bin",
    _ => bail!("Unsupported asset MIME type"),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn canvas_and_scene_survive_reopening() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    for kind in [ProjectKind::Canvas, ProjectKind::Scene] {
      let saved = store.save_project(Project::new(
        "Estudo",
        kind.clone(),
        serde_json::json!({"layers":[{"x":17}], "camera":{"z":42}}),
      ))?;
      let loaded = ProjectStore::new(root.path().into())?.load_project(&saved.id)?;
      assert_eq!(loaded.document["layers"][0]["x"], 17);
      assert_eq!(loaded.document["camera"]["z"], 42);
      assert_eq!(loaded.kind, kind);
    }
    assert!(store.load_project("../../outside").is_err());
    Ok(())
  }
  #[test]
  fn rejects_unsupported_schema_without_overwriting() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let saved = store.save_project(Project::new(
      "Valid",
      ProjectKind::Canvas,
      serde_json::json!({"x":17}),
    ))?;
    let mut invalid = saved.clone();
    invalid.schema_version = 2;
    assert!(store.save_project(invalid).is_err());
    assert_eq!(store.load_project(&saved.id)?.document["x"], 17);
    Ok(())
  }
  #[test]
  fn assets_survive_reopening_and_reject_bad_input() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let asset =
      store.import_asset("../../photo.png", "image/png", &STANDARD.encode(b"image fixture"))?;
    assert!(Path::new(&asset.path).starts_with(root.path().canonicalize()?));
    assert_eq!(fs::read(&asset.path)?, b"image fixture");
    let reopened = ProjectStore::new(root.path().into())?;
    assert_eq!(
      reopened.read_asset(&asset.id)?.data_url,
      format!("data:image/png;base64,{}", STANDARD.encode(b"image fixture"))
    );
    assert!(store.import_asset("bad", "image/png", "!!!").is_err());
    assert!(store.import_asset("", "image/png", "eA==").is_err());
    assert!(store.import_asset("bad", "text/html", "eA==").is_err());
    assert!(store.load_asset("../../outside").is_err());
    Ok(())
  }

  #[test]
  fn corrupt_project_does_not_hide_or_replace_valid_work() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let good =
      store.save_project(Project::new("Good", ProjectKind::Canvas, serde_json::json!({"x":17})))?;
    let bad = store.save_project(Project::new("Bad", ProjectKind::Scene, serde_json::json!({})))?;
    let path = root.path().join("projects").join(bad.id).join("project.json");
    fs::write(&path, b"broken json")?;
    let listing = store.list_projects()?;
    assert_eq!(listing.projects.len(), 1);
    assert_eq!(listing.projects[0].id, good.id);
    assert_eq!(listing.warnings.len(), 1);
    assert_eq!(fs::read(path)?, b"broken json");
    let mut blank = good;
    blank.name = " ".into();
    assert!(store.save_project(blank).is_err());
    Ok(())
  }

  #[cfg(unix)]
  #[test]
  fn rejects_symlinked_storage_and_forged_asset_paths() -> Result<()> {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir()?;
    let outside = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let project = Project::new("Unsafe", ProjectKind::Canvas, serde_json::json!({}));
    symlink(outside.path(), root.path().join("projects").join(&project.id))?;
    assert!(store.save_project(project).is_err());
    assert_eq!(fs::read_dir(outside.path())?.count(), 0);
    let asset = store.import_bytes("Asset", "image/png", b"fixture")?;
    let metadata = Path::new(&asset.path).parent().unwrap().join("asset.json");
    let mut forged = asset.clone();
    forged.path = outside.path().join("secret").to_string_lossy().into();
    fs::write(&metadata, serde_json::to_vec(&forged)?)?;
    assert!(store.read_asset(&asset.id).is_err());
    fs::write(&metadata, serde_json::to_vec(&asset)?)?;
    fs::remove_file(&asset.path)?;
    symlink(outside.path().join("secret"), &asset.path)?;
    assert!(store.read_asset(&asset.id).is_err());
    Ok(())
  }
}
