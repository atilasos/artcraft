use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use crate::project_store::{Asset, ProjectStore};

const TURN_TIMEOUT: Duration = Duration::from_secs(240);
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PROTOCOL_LINE: u64 = 32 * 1024 * 1024;
const LOCAL_INSTRUCTIONS: &str = "You are the Creative Desk local creative assistant. Use only the user's prompt and files staged in the current workspace. Do not access ArtCraft services, unrelated apps, connectors, credentials, or files outside this workspace. Do not change account settings or login. For image requests use the native image generation tool and save real generated files in the current workspace. Never claim a generated image exists without a successful imageGeneration tool result. Answer in the user's language.";

#[derive(Default)]
pub struct CodexBridge {
  execution: Mutex<()>,
  maybe_child_pid: Arc<Mutex<Option<u32>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
  pub connected: bool,
  pub auth_mode: String,
  pub message: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RequestKind {
  Assistant,
  Image,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexReply {
  pub message: String,
  pub thread_id: String,
  pub assets: Vec<Asset>,
}

struct Transport {
  child: Child,
  stdin: ChildStdin,
  receiver: mpsc::Receiver<Result<Value, String>>,
  maybe_reader: Option<JoinHandle<()>>,
  deadline: Instant,
  next_id: u64,
  pending: Vec<Value>,
  maybe_activity: Option<Arc<Mutex<Option<u32>>>>,
}

impl CodexBridge {
  pub fn cancel(&self) {
    let maybe_pid = {
      let guard = self.maybe_child_pid.lock().unwrap_or_else(|poison| poison.into_inner());
      if let Some(pid) = *guard {
        kill_process_group(pid);
      }
      *guard
    };
    if maybe_pid.is_some() {
      let deadline = Instant::now() + Duration::from_secs(2);
      while Instant::now() < deadline {
        if self.maybe_child_pid.lock().unwrap_or_else(|poison| poison.into_inner()).is_none() {
          break;
        }
        thread::sleep(Duration::from_millis(10));
      }
    }
  }

  pub fn status(&self) -> CodexStatus {
    let result = (|| -> Result<String> {
      let _guard = self.execution.try_lock().map_err(|_| anyhow::anyhow!("Codex is busy"))?;
      let mut transport =
        Transport::spawn(codex_command()?, STATUS_TIMEOUT, Some(self.maybe_child_pid.clone()))?;
      transport.initialize()?;
      transport.account_mode()
    })();
    match result {
      Ok(mode) => CodexStatus {
        connected: mode == "chatgpt",
        message: if mode == "chatgpt" {
          "Codex ChatGPT session is ready".into()
        } else {
          "An existing ChatGPT login is required".into()
        },
        auth_mode: mode,
      },
      Err(error) => CodexStatus {
        connected: false,
        auth_mode: "unavailable".into(),
        message: error.to_string(),
      },
    }
  }

  pub fn send(
    &self,
    store: &ProjectStore,
    project_id: &str,
    prompt: &str,
    kind: RequestKind,
    asset_ids: &[String],
  ) -> Result<CodexReply> {
    let _guard = self
      .execution
      .try_lock()
      .map_err(|_| anyhow::anyhow!("Codex is already processing a request"))?;
    ensure!(!prompt.trim().is_empty() && prompt.len() <= 100_000, "Prompt is empty or too large");
    let cwd = store.project_codex_dir(project_id)?;
    let mut input = vec![
      json!({"type":"text", "text": if matches!(kind, RequestKind::Image) { format!("Generate an image with the native image generation tool, then save it in the current workspace. Request: {prompt}") } else { prompt.into() }}),
    ];
    ensure!(asset_ids.len() <= 20, "Too many attached assets");
    for id in asset_ids {
      let asset = store.load_asset(id)?;
      let source = Path::new(&asset.path);
      let destination = cwd.join(format!(
        "input-{}.{}",
        asset.id,
        source.extension().context("Asset extension is missing")?.to_string_lossy()
      ));
      ensure!(!destination.is_symlink(), "Asset staging path cannot be a symlink");
      fs::copy(source, &destination)?;
      if asset.mime_type.starts_with("image/") {
        input.push(json!({"type":"localImage", "path":destination}));
      } else {
        input.push(
          json!({"type":"text", "text":format!("Attached local file: {}", destination.display())}),
        );
      }
    }
    run_request(
      codex_command()?,
      store,
      &cwd,
      kind,
      input,
      TURN_TIMEOUT,
      Some(self.maybe_child_pid.clone()),
    )
  }
}

impl Transport {
  fn spawn(
    mut command: Command,
    timeout: Duration,
    maybe_activity: Option<Arc<Mutex<Option<u32>>>>,
  ) -> Result<Self> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().context("Cannot start the installed Codex CLI")?;
    if let Some(activity) = &maybe_activity {
      *activity.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(child.id());
    }
    let stdin = child.stdin.take().context("Codex stdin unavailable")?;
    let stdout = child.stdout.take().context("Codex stdout unavailable")?;
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
      let mut reader = BufReader::new(stdout);
      let mut total = 0usize;
      loop {
        let mut bytes = Vec::new();
        let read = reader.by_ref().take(MAX_PROTOCOL_LINE + 1).read_until(b'\n', &mut bytes);
        let result = match read {
          Ok(0) => {
            let _ =
              sender.send(Err("Codex closed its output before completing the request".into()));
            break;
          },
          Ok(_) if bytes.len() as u64 > MAX_PROTOCOL_LINE => {
            Err("Codex protocol message exceeds size limit".into())
          },
          Ok(_) => {
            serde_json::from_slice(&bytes).map_err(|_| "Invalid JSON from Codex app-server".into())
          },
          Err(_) => Err("Cannot read Codex app-server output".into()),
        };
        total += bytes.len();
        if total > 128 * 1024 * 1024 {
          let _ = sender.send(Err("Codex protocol output exceeds size limit".into()));
          break;
        }
        let failed = result.is_err();
        if sender.send(result).is_err() || failed {
          break;
        }
      }
    });
    Ok(Self {
      child,
      stdin,
      receiver,
      maybe_reader: Some(reader),
      deadline: Instant::now() + timeout,
      next_id: 0,
      pending: Vec::new(),
      maybe_activity,
    })
  }

  fn initialize(&mut self) -> Result<()> {
    self.request("initialize", json!({"clientInfo":{"name":"creative_desk", "version":"0.1.0"},"capabilities":{"experimentalApi":true}}))?;
    self.write(&json!({"method":"initialized"}))
  }

  fn account_mode(&mut self) -> Result<String> {
    let account = self.request("account/read", json!({"refreshToken":false}))?;
    Ok(account["account"]["type"].as_str().unwrap_or("none").into())
  }

  fn request(&mut self, method: &str, params: Value) -> Result<Value> {
    self.next_id += 1;
    let id = self.next_id;
    self.write(&json!({"id":id, "method":method, "params":params}))?;
    loop {
      let message = self.receive()?;
      if message.get("id") == Some(&json!(id)) && message.get("method").is_none() {
        if let Some(error) = message.get("error") {
          bail!("Codex request failed: {}", error["message"].as_str().unwrap_or("JSON-RPC error"));
        }
        return message.get("result").cloned().context("Codex response has no result");
      }
      if self.handle_server_request(&message)? {
        continue;
      }
      self.pending.push(message);
      ensure!(self.pending.len() <= 10_000, "Too many pending Codex notifications");
    }
  }

  fn receive(&self) -> Result<Value> {
    let remaining = self
      .deadline
      .checked_duration_since(Instant::now())
      .context("Codex request deadline exceeded")?;
    match self.receiver.recv_timeout(remaining) {
      Ok(Ok(value)) => Ok(value),
      Ok(Err(error)) => bail!("{error}"),
      Err(mpsc::RecvTimeoutError::Timeout) => bail!("Codex request deadline exceeded"),
      Err(_) => bail!("Codex output reader stopped"),
    }
  }

  fn handle_server_request(&mut self, message: &Value) -> Result<bool> {
    if message.get("method").is_some() {
      if let Some(id) = message.get("id") {
        self.write(&json!({"id":id,"error":{"code":-32601,"message":"Creative Desk does not support approval or interactive server requests"}}))?;
        return Ok(true);
      }
    }
    Ok(false)
  }

  fn write(&mut self, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut self.stdin, value)?;
    self.stdin.write_all(b"\n")?;
    self.stdin.flush()?;
    Ok(())
  }
}

impl Drop for Transport {
  fn drop(&mut self) {
    // Keep the advertised PID locked through reaping so cancellation cannot target a reused PID.
    let mut maybe_guard = self
      .maybe_activity
      .as_ref()
      .map(|activity| activity.lock().unwrap_or_else(|poison| poison.into_inner()));
    // The child gets its own process group so tool subprocesses cannot outlive it.
    kill_process_group(self.child.id());
    let _ = self.child.kill();
    let _ = self.child.wait();
    if let Some(reader) = self.maybe_reader.take() {
      let _ = reader.join();
    }
    if let Some(activity) = maybe_guard.as_mut() {
      **activity = None;
    }
  }
}

fn run_request(
  mut command: Command,
  store: &ProjectStore,
  cwd: &Path,
  kind: RequestKind,
  input: Vec<Value>,
  timeout: Duration,
  maybe_activity: Option<Arc<Mutex<Option<u32>>>>,
) -> Result<CodexReply> {
  command.current_dir(cwd);
  let mut transport = Transport::spawn(command, timeout, maybe_activity)?;
  transport.initialize()?;
  ensure!(transport.account_mode()? == "chatgpt", "An existing managed ChatGPT login is required");
  let thread = transport.request("thread/start", json!({"cwd":cwd,"approvalPolicy":"never","sandbox":"workspace-write","ephemeral":true,"modelProvider":"openai","developerInstructions":LOCAL_INSTRUCTIONS,"config":{"web_search":"disabled","features.apps":false,"features.multi_agent":false}}))?;
  let thread_id =
    thread["thread"]["id"].as_str().context("Codex thread response has no ID")?.to_owned();
  let turn = transport.request("turn/start", json!({"threadId":thread_id,"input":input,"cwd":cwd,"approvalPolicy":"never","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":false,"excludeTmpdirEnvVar":true,"excludeSlashTmp":true}}))?;
  let turn_id = turn["turn"]["id"].as_str().context("Codex turn response has no ID")?.to_owned();
  let mut messages = Vec::new();
  let mut generated_paths = Vec::new();
  let mut seen = HashSet::new();
  loop {
    let message =
      if transport.pending.is_empty() { transport.receive()? } else { transport.pending.remove(0) };
    if transport.handle_server_request(&message)? {
      continue;
    }
    let params = &message["params"];
    match message["method"].as_str() {
      Some("error") if params["willRetry"] != true => bail!(
        "Codex turn failed: {}",
        params["error"]["message"].as_str().unwrap_or("Unknown error")
      ),
      Some("item/completed") if params["threadId"] == thread_id && params["turnId"] == turn_id => {
        collect_item(&params["item"], &mut seen, &mut messages, &mut generated_paths)?
      },
      Some("turn/completed")
        if params["threadId"] == thread_id && params["turn"]["id"] == turn_id =>
      {
        ensure!(
          params["turn"]["status"] == "completed",
          "Codex turn was unsuccessful: {}",
          params["turn"]["error"]["message"].as_str().unwrap_or("failed or interrupted")
        );
        if let Some(items) = params["turn"]["items"].as_array() {
          for item in items {
            collect_item(item, &mut seen, &mut messages, &mut generated_paths)?;
          }
        }
        break;
      },
      _ => (),
    }
  }
  let mut assets = Vec::new();
  for path in generated_paths {
    assets.push(import_generated_image(store, &path, cwd)?);
  }
  ensure!(
    !matches!(kind, RequestKind::Image) || !assets.is_empty(),
    "Codex completed without a generated image file"
  );
  ensure!(!messages.is_empty() || !assets.is_empty(), "Codex completed without a reply");
  Ok(CodexReply { message: messages.join("\n\n"), thread_id, assets })
}

fn collect_item(
  item: &Value,
  seen: &mut HashSet<String>,
  messages: &mut Vec<String>,
  paths: &mut Vec<PathBuf>,
) -> Result<()> {
  let id = item["id"].as_str().context("Completed Codex item has no ID")?;
  if !seen.insert(id.into()) {
    return Ok(());
  }
  match item["type"].as_str() {
    Some("agentMessage") => {
      let text = item["text"].as_str().context("Codex agent message has no text")?;
      if !text.trim().is_empty() {
        messages.push(text.into());
      }
    },
    Some("imageGeneration") => {
      ensure!(
        item["failure"].is_null(),
        "Codex image generation failed: {}",
        item["failure"]["type"].as_str().unwrap_or("unknown image error")
      );
      ensure!(item["status"] == "completed", "Codex image generation did not complete");
      paths.push(PathBuf::from(
        item["savedPath"].as_str().context("Generated image has no saved file")?,
      ));
    },
    _ => (),
  }
  Ok(())
}

fn import_generated_image(store: &ProjectStore, path: &Path, cwd: &Path) -> Result<Asset> {
  ensure!(
    path.is_absolute() && !path.is_symlink(),
    "Generated image path must be an absolute regular file"
  );
  let canonical = path.canonicalize().context("Generated image file does not exist")?;
  ensure!(
    canonical.starts_with(cwd.canonicalize()?),
    "Generated image must be saved in the project workspace"
  );
  ensure!(canonical.is_file(), "Generated image is not a file");
  ensure!(
    fs::metadata(&canonical)?.len() <= 256 * 1024 * 1024,
    "Generated image file is too large"
  );
  let bytes = fs::read(&canonical)?;
  let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    "image/png"
  } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
    "image/jpeg"
  } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    "image/webp"
  } else {
    bail!("Generated file is not a supported PNG, JPEG or WebP image");
  };
  store.import_bytes("Codex image", mime, &bytes)
}

fn kill_process_group(pid: u32) {
  #[cfg(unix)]
  let _ = Command::new("/bin/kill")
    .args(["-KILL", "--", &format!("-{pid}")])
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status();
  #[cfg(not(unix))]
  let _ = Command::new("taskkill")
    .args(["/PID", &pid.to_string(), "/T", "/F"])
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status();
}

fn codex_command() -> Result<Command> {
  let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
    .map(|path| std::env::split_paths(&path).map(|dir| dir.join("codex")).collect())
    .unwrap_or_default();
  candidates
    .extend([PathBuf::from("/usr/local/bin/codex"), PathBuf::from("/opt/homebrew/bin/codex")]);
  let executable = candidates
    .into_iter()
    .find(|path| path.is_file())
    .context("Codex CLI is not installed or is not on PATH")?;
  let mut command = Command::new(executable);
  command.args(["app-server", "--listen", "stdio://"]);
  Ok(command)
}

#[cfg(test)]
fn send_with_command(
  command: Command,
  store: &ProjectStore,
  id: &str,
  kind: RequestKind,
) -> Result<CodexReply> {
  run_request(
    command,
    store,
    &store.project_codex_dir(id)?,
    kind,
    vec![json!({"type":"text","text":"fixture"})],
    Duration::from_millis(750),
    None,
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::project_store::{Project, ProjectKind};
  use std::fs;

  #[test]
  fn external_protocol_completed_and_real_image() -> Result<()> {
    for kind in [RequestKind::Assistant, RequestKind::Image] {
      let root = tempfile::tempdir()?;
      let store = ProjectStore::new(root.path().into())?;
      let project =
        store.save_project(Project::new("Test", ProjectKind::Canvas, serde_json::json!({})))?;
      let cwd = store.project_codex_dir(&project.id)?;
      let image = cwd.join("result.png");
      fs::write(&image, b"\x89PNG\r\n\x1a\nfixture")?;
      let reply = send_with_command(fixture("completed", &image), &store, &project.id, kind)?;
      assert_eq!(reply.message, "Fixture reply");
      assert_eq!(reply.thread_id, "thread-fixture");
      assert_eq!(reply.assets.len(), 1);
      fs::remove_file(image)?;
      assert!(store
        .read_asset(&reply.assets[0].id)?
        .data_url
        .starts_with("data:image/png;base64,"));
    }
    Ok(())
  }

  #[test]
  fn external_protocol_errors_eof_and_missing_image() -> Result<()> {
    for (mode, expected) in [
      ("rpc_error", "Fixture RPC error"),
      ("eof", "closed its output"),
      ("failed", "Fixture failed"),
      ("no_image", "without a generated image"),
      ("quota", "Usage limit exceeded"),
      ("timeout", "deadline exceeded"),
    ] {
      let root = tempfile::tempdir()?;
      let store = ProjectStore::new(root.path().into())?;
      let project =
        store.save_project(Project::new("Test", ProjectKind::Canvas, serde_json::json!({})))?;
      let error = match send_with_command(
        fixture(mode, &root.path().join("unused.png")),
        &store,
        &project.id,
        RequestKind::Image,
      ) {
        Ok(_) => panic!("{mode} unexpectedly succeeded"),
        Err(error) => error,
      };
      assert!(error.to_string().contains(expected), "{mode}: {error}");
      let pid = fs::read_to_string(root.path().join("unused.png.pid"))?;
      assert!(
        !Command::new("/bin/kill")
          .args(["-0", pid.trim()])
          .stdout(Stdio::null())
          .stderr(Stdio::null())
          .status()?
          .success(),
        "Codex child was not reaped after {mode}"
      );
    }
    Ok(())
  }

  #[test]
  fn rejects_server_approvals_and_outside_generated_files() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let project =
      store.save_project(Project::new("Test", ProjectKind::Canvas, serde_json::json!({})))?;
    let path = root.path().join("outside.png");
    let reply =
      send_with_command(fixture("approval", &path), &store, &project.id, RequestKind::Assistant)?;
    assert_eq!(reply.message, "Fixture reply");
    fs::write(&path, b"\x89PNG\r\n\x1a\nfixture")?;
    let error =
      match send_with_command(fixture("completed", &path), &store, &project.id, RequestKind::Image)
      {
        Ok(_) => panic!("An outside file was imported"),
        Err(error) => error,
      };
    assert!(error.to_string().contains("project workspace"));
    assert!(store.list_assets()?.is_empty());
    Ok(())
  }

  #[test]
  fn cancellation_terminates_and_reaps_the_active_child() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = Arc::new(ProjectStore::new(root.path().into())?);
    let project = store.save_project(Project::new("Cancel", ProjectKind::Canvas, json!({})))?;
    let cwd = store.project_codex_dir(&project.id)?;
    let bridge = Arc::new(CodexBridge::default());
    let active = bridge.maybe_child_pid.clone();
    let command = fixture("timeout", &cwd.join("unused.png"));
    let worker = thread::spawn(move || {
      run_request(
        command,
        &store,
        &cwd,
        RequestKind::Assistant,
        vec![json!({"type":"text","text":"test"})],
        Duration::from_secs(20),
        Some(active),
      )
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while bridge.maybe_child_pid.lock().unwrap().is_none() && Instant::now() < deadline {
      thread::sleep(Duration::from_millis(5));
    }
    let pid = bridge.maybe_child_pid.lock().unwrap().context("Fixture did not start")?;
    bridge.cancel();
    assert!(worker.join().unwrap().is_err());
    assert!(bridge.maybe_child_pid.lock().unwrap().is_none());
    assert!(!Command::new("/bin/kill")
      .args(["-0", &pid.to_string()])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status()?
      .success());
    Ok(())
  }

  fn fixture(mode: &str, image: &std::path::Path) -> Command {
    let mut command = Command::new("python3");
    command.args([
      "-u",
      "-c",
      r#"
import json,sys,time
mode,path=sys.argv[1:]
import os
with open(path+".pid","w") as f: f.write(str(os.getpid()))
def send(v): print(json.dumps(v),flush=True)
for line in sys.stdin:
 r=json.loads(line); method=r.get('method'); id=r.get('id')
 if id is None: continue
 if method=='initialize': send({'id':id,'result':{}})
 elif method=='account/read':
  assert r['params']=={'refreshToken':False}
  send({'id':id,'result':{'account':{'type':'chatgpt'}}})
 elif method=='thread/start':
  assert r['params']['approvalPolicy']=='never'
  assert r['params']['sandbox']=='workspace-write'
  send({'id':id,'result':{'thread':{'id':'thread-fixture'}}})
 elif method=='turn/start':
  assert r['params']['sandboxPolicy']['networkAccess']==False
  if mode=='rpc_error': send({'id':id,'error':{'code':-1,'message':'Fixture RPC error'}}); continue
  if mode=='eof': sys.exit(0)
  if mode=='timeout': time.sleep(20); continue
  send({'id':id,'result':{'turn':{'id':'turn-fixture'}}})
  if mode=='approval':
   send({'id':900,'method':'item/commandExecution/requestApproval','params':{}})
   denied=json.loads(sys.stdin.readline())
   assert denied['id']==900 and denied['error']['code']==-32601
  send({'method':'item/completed','params':{'threadId':'other-thread','turnId':'other-turn','item':{'id':'foreign','type':'agentMessage','text':'Must be ignored'}}})
  send({'method':'item/completed','params':{'threadId':'thread-fixture','turnId':'turn-fixture','item':{'id':'msg','type':'agentMessage','text':'Fixture reply'}}})
  if mode=='completed': send({'method':'item/completed','params':{'threadId':'thread-fixture','turnId':'turn-fixture','item':{'id':'img','type':'imageGeneration','status':'completed','savedPath':path}}})
  if mode=='quota': send({'method':'error','params':{'willRetry':False,'error':{'message':'Usage limit exceeded'}}}); continue
  send({'method':'turn/completed','params':{'threadId':'thread-fixture','turn':{'id':'turn-fixture','status':'failed' if mode=='failed' else 'completed','items':[],'error':{'message':'Fixture failed'} if mode=='failed' else None}}})
"#,
      mode,
      &image.to_string_lossy(),
    ]);
    command
  }
}
