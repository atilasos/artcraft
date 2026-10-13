use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use crate::project_store::{Asset, ProjectStore};

const TURN_TIMEOUT: Duration = Duration::from_secs(240);
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PROTOCOL_LINE: u64 = 32 * 1024 * 1024;
const DISABLED_FEATURES: &[&str] = &[
  "apps", "plugins", "hooks", "multi_agent", "shell_tool", "unified_exec", "view_image",
  "browser_use", "browser_use_external", "computer_use", "in_app_browser",
];
const LOCAL_INSTRUCTIONS: &str = "You are the Creative Desk local creative assistant. Use only the user's prompt and files staged in the current workspace. Do not access ArtCraft services, unrelated apps, connectors, credentials, or files outside this workspace. Do not change account settings or login. For image requests use the native image generation tool once. Creative Desk imports its completed tool output from the runtime image cache automatically; do not copy it or regenerate just to move the file. Never claim a generated image exists without a successful imageGeneration tool result. Answer in the user's language.";

#[derive(Default)]
pub struct CodexBridge {
  execution: Mutex<()>,
  lifecycle: Arc<ChildLifecycle>,
}

#[derive(Default)]
struct ChildLifecycle {
  state: Mutex<ChildState>,
  finished: Condvar,
}

#[derive(Default)]
struct ChildState {
  closing: bool,
  maybe_pid: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
  pub connected: bool,
  pub auth_mode: String,
  pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
  pub id: String,
  pub display_name: String,
  pub is_default: bool,
  pub efforts: Vec<String>,
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
  activity: Arc<ChildLifecycle>,
  stop_deadline: mpsc::Sender<()>,
  maybe_watchdog: Option<JoinHandle<()>>,
}

impl CodexBridge {
  pub fn shutdown(&self) {
    let mut state = self.lifecycle.state.lock().unwrap_or_else(|poison| poison.into_inner());
    state.closing = true;
    if let Some(pid) = state.maybe_pid {
      kill_process_group(pid);
    }
    while state.maybe_pid.is_some() {
      state = self.lifecycle.finished.wait(state).unwrap_or_else(|poison| poison.into_inner());
    }
  }

  pub fn status(&self) -> CodexStatus {
    let result = (|| -> Result<String> {
      let _guard = self.execution.try_lock().map_err(|_| anyhow::anyhow!("Codex is busy"))?;
      self.ensure_open()?;
      let mut transport =
        Transport::spawn(codex_command()?, STATUS_TIMEOUT, Some(self.lifecycle.clone()))?;
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

  pub fn models(&self) -> Result<Vec<CodexModel>> {
    let _guard = self.execution.try_lock().map_err(|_| anyhow::anyhow!("Codex is busy"))?;
    self.ensure_open()?;
    let mut transport =
      Transport::spawn(codex_command()?, STATUS_TIMEOUT, Some(self.lifecycle.clone()))?;
    transport.initialize()?;
    ensure!(
      transport.account_mode()? == "chatgpt",
      "An existing managed ChatGPT login is required"
    );
    transport.models()
  }

  pub fn send(
    &self,
    store: &ProjectStore,
    project_id: &str,
    prompt: &str,
    kind: RequestKind,
    asset_ids: &[String],
    maybe_model: Option<&str>,
  ) -> Result<CodexReply> {
    let _guard = self
      .execution
      .try_lock()
      .map_err(|_| anyhow::anyhow!("Codex is already processing a request"))?;
    self.ensure_open()?;
    ensure!(!prompt.trim().is_empty() && prompt.len() <= 100_000, "Prompt is empty or too large");
    let cwd = store.project_codex_dir(project_id)?;
    let mut input = vec![
      json!({"type":"text", "text": if matches!(kind, RequestKind::Image) { format!("Generate one image with the native image generation tool. Creative Desk imports the completed tool output automatically. Request: {prompt}") } else { prompt.into() }}),
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
      Some(self.lifecycle.clone()),
      maybe_model,
    )
  }

  fn ensure_open(&self) -> Result<()> {
    ensure!(!self.lifecycle.state.lock().unwrap_or_else(|poison| poison.into_inner()).closing,
      "Codex bridge is closing");
    Ok(())
  }
}

impl Transport {
  fn spawn(
    command: Command,
    timeout: Duration,
    maybe_activity: Option<Arc<ChildLifecycle>>,
  ) -> Result<Self> {
    Self::spawn_with_registration_hook(command, timeout, maybe_activity, |_| {})
  }

  fn spawn_with_registration_hook(
    mut command: Command,
    timeout: Duration,
    maybe_activity: Option<Arc<ChildLifecycle>>,
    before_publish: impl FnOnce(u32),
  ) -> Result<Self> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    command.process_group(0);
    let activity = maybe_activity.unwrap_or_default();
    // Shutdown and process creation share this gate, including the unpublished OS-child interval.
    let mut state = activity.state.lock().unwrap_or_else(|poison| poison.into_inner());
    ensure!(!state.closing, "Codex bridge is closing");
    let mut child = command.spawn().context("Cannot start the installed Codex CLI")?;
    before_publish(child.id());
    state.maybe_pid = Some(child.id());
    drop(state);
    let deadline = Instant::now() + timeout;
    let (stop_deadline, stopped) = mpsc::channel();
    let watchdog_activity = activity.clone();
    let watchdog = thread::spawn(move || {
      if matches!(stopped.recv_timeout(timeout), Err(mpsc::RecvTimeoutError::Timeout)) {
        // The owner cannot reap while this lock is held, so the PID cannot be reused.
        let guard = watchdog_activity.state.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(pid) = guard.maybe_pid {
          kill_process_group(pid);
        }
      }
    });
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
      deadline,
      next_id: 0,
      pending: Vec::new(),
      activity,
      stop_deadline,
      maybe_watchdog: Some(watchdog),
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

  fn models(&mut self) -> Result<Vec<CodexModel>> {
    let mut models = Vec::new();
    let mut cursor = Value::Null;
    for _ in 0..20 {
      let response =
        self.request("model/list", json!({"cursor":cursor,"limit":100,"includeHidden":false}))?;
      for model in response["data"].as_array().context("Codex model catalog is invalid")? {
        models.push(parse_model(model)?);
      }
      cursor = next_cursor(&response)?;
      if cursor.is_null() {
        ensure!(!models.is_empty(), "Codex model catalog is empty");
        return Ok(models);
      }
    }
    bail!("Codex model catalog exceeds page limit")
  }

  fn isolated_config(&mut self, cwd: &Path) -> Result<Value> {
    let response = self.request("config/read", json!({"cwd":cwd,"includeLayers":false}))?;
    let config = response["config"].as_object().context("Codex effective config is invalid")?;
    ensure!(config.get("web_search") == Some(&json!("disabled")),
      "Codex web search isolation could not be established");
    let features = config.get("features").and_then(Value::as_object)
      .context("Codex feature isolation could not be established")?;
    for name in DISABLED_FEATURES {
      ensure!(features.get(*name) == Some(&json!(false)),
        "Codex feature isolation could not be established");
    }
    ensure!(features.get("image_generation") == Some(&json!(true)),
      "Codex native image generation is disabled");
    let mut overrides = json!({"web_search":"disabled","features.image_generation":true,
      "shell_environment_policy.inherit":"core"});
    for name in DISABLED_FEATURES {
      overrides[format!("features.{name}")] = json!(false);
    }
    if let Some(servers) = config.get("mcp_servers") {
      for name in servers.as_object().context("Codex MCP configuration is invalid")?.keys() {
        // Protocol dotted paths do not accept quoted segments. Refuse ambiguous names.
        ensure!(
          !name.is_empty()
            && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
          "Cannot safely isolate an inherited Codex MCP server name"
        );
        overrides[format!("mcp_servers.{name}.enabled")] = json!(false);
      }
    }
    Ok(overrides)
  }

  fn verify_isolation(&mut self, thread_id: &str) -> Result<()> {
    let mut cursor = Value::Null;
    let mut count = 0usize;
    for _ in 0..20 {
      let response = self.request(
        "mcpServerStatus/list",
        json!({"threadId":thread_id,
        "cursor":cursor,"limit":100,"detail":"full"}),
      )?;
      for server in response["data"].as_array().context("Codex MCP inventory is invalid")? {
        ensure!(
          server["runtimeStatus"] == "disabled"
            && server["tools"].as_object().is_some_and(|tools| tools.is_empty())
            && server["resources"].as_array().is_some_and(|resources| resources.is_empty())
            && server["resourceTemplates"].as_array().is_some_and(|resources| resources.is_empty()),
          "Codex tool isolation could not be established"
        );
        count += 1;
      }
      cursor = next_cursor(&response)?;
      if cursor.is_null() {
        log::info!("Creative Desk verified {count} disabled MCP servers and zero MCP tools");
        return Ok(());
      }
    }
    bail!("Codex MCP inventory exceeds page limit")
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
    let result = (|| -> Result<()> {
      serde_json::to_writer(&mut self.stdin, value)?;
      self.stdin.write_all(b"\n")?;
      self.stdin.flush()?;
      Ok(())
    })();
    ensure!(Instant::now() < self.deadline, "Codex request deadline exceeded");
    result
  }
}

impl Drop for Transport {
  fn drop(&mut self) {
    let _ = self.stop_deadline.send(());
    if let Some(watchdog) = self.maybe_watchdog.take() {
      let _ = watchdog.join();
    }
    // Keep the advertised PID locked through reaping so shutdown cannot target a reused PID.
    let mut activity = self.activity.state.lock().unwrap_or_else(|poison| poison.into_inner());
    // The child gets its own process group so tool subprocesses cannot outlive it.
    kill_process_group(self.child.id());
    let _ = self.child.kill();
    let _ = self.child.wait();
    if let Some(reader) = self.maybe_reader.take() {
      let _ = reader.join();
    }
    activity.maybe_pid = None;
    self.activity.finished.notify_all();
  }
}

fn run_request(
  mut command: Command,
  store: &ProjectStore,
  cwd: &Path,
  kind: RequestKind,
  input: Vec<Value>,
  timeout: Duration,
  maybe_activity: Option<Arc<ChildLifecycle>>,
  maybe_model: Option<&str>,
) -> Result<CodexReply> {
  command.current_dir(cwd);
  let mut transport = Transport::spawn(command, timeout, maybe_activity)?;
  transport.initialize()?;
  ensure!(transport.account_mode()? == "chatgpt", "An existing managed ChatGPT login is required");
  if let Some(model) = maybe_model {
    ensure!(
      transport.models()?.iter().any(|entry| entry.id == model),
      "Selected Codex model is unavailable"
    );
  }
  let config = transport.isolated_config(cwd)?;
  let thread = transport.request("thread/start", json!({"cwd":cwd,"approvalPolicy":"never","sandbox":"workspace-write","ephemeral":true,"modelProvider":"openai","model":maybe_model,"developerInstructions":LOCAL_INSTRUCTIONS,"config":config}))?;
  let thread_id =
    thread["thread"]["id"].as_str().context("Codex thread response has no ID")?.to_owned();
  transport.verify_isolation(&thread_id)?;
  let turn = transport.request("turn/start", json!({"threadId":thread_id,"model":maybe_model,"input":input,"cwd":cwd,"approvalPolicy":"never","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":false,"excludeTmpdirEnvVar":true,"excludeSlashTmp":true}}))?;
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
    assets.push(import_generated_image(store, &path, cwd, native_image_cache_dir(&thread_id).as_deref())?);
  }
  ensure!(
    !matches!(kind, RequestKind::Image) || !assets.is_empty(),
    "Codex completed without a generated image file"
  );
  ensure!(!messages.is_empty() || !assets.is_empty(), "Codex completed without a reply");
  Ok(CodexReply { message: messages.join("\n\n"), thread_id, assets })
}

fn parse_model(value: &Value) -> Result<CodexModel> {
  let id = protocol_string(&value["id"], "model ID")?;
  let display_name = protocol_string(&value["displayName"], "model display name")?;
  let is_default = value["isDefault"].as_bool().context("Codex model default flag is invalid")?;
  let efforts = value["supportedReasoningEfforts"]
    .as_array()
    .context("Codex model efforts are invalid")?
    .iter()
    .map(|effort| protocol_string(&effort["reasoningEffort"], "reasoning effort"))
    .collect::<Result<Vec<_>>>()?;
  Ok(CodexModel { id, display_name, is_default, efforts })
}

fn protocol_string(value: &Value, name: &str) -> Result<String> {
  let text = value.as_str().with_context(|| format!("Codex {name} is invalid"))?;
  ensure!(
    !text.trim().is_empty() && text.len() <= 256 && !text.chars().any(char::is_control),
    "Codex {name} is invalid"
  );
  Ok(text.into())
}

fn next_cursor(response: &Value) -> Result<Value> {
  let cursor = response.get("nextCursor").unwrap_or(&Value::Null);
  ensure!(
    cursor.is_null() || cursor.as_str().is_some_and(|text| !text.is_empty()),
    "Codex pagination cursor is invalid"
  );
  Ok(cursor.clone())
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

fn import_generated_image(
  store: &ProjectStore,
  path: &Path,
  cwd: &Path,
  maybe_cache_dir: Option<&Path>,
) -> Result<Asset> {
  ensure!(
    path.is_absolute() && !path.is_symlink(),
    "Generated image path must be an absolute regular file"
  );
  let canonical = path.canonicalize().context("Generated image file does not exist")?;
  if !canonical.starts_with(cwd.canonicalize()?) {
    let cache = maybe_cache_dir.context("Generated image must be saved in the project workspace")?;
    ensure!(!cache.is_symlink() && cache.parent().is_some_and(|parent| !parent.is_symlink()),
      "Generated image cache cannot be a symlink");
    ensure!(canonical.parent() == Some(cache.canonicalize()?.as_path()),
      "Generated image must be saved in the project workspace or current thread image cache");
    let stem = canonical.file_stem().and_then(|name| name.to_str())
      .and_then(|name| name.strip_prefix("exec-"))
      .context("Generated image cache filename is invalid")?;
    ensure!(uuid::Uuid::parse_str(stem).is_ok_and(|id| id.to_string() == stem),
      "Generated image cache filename is invalid");
  }
  ensure!(canonical.is_file(), "Generated image is not a file");
  ensure!(
    fs::metadata(&canonical)?.len() <= 256 * 1024 * 1024,
    "Generated image file is too large"
  );
  let bytes = fs::read(&canonical)?;
  // Check container completeness without claiming to decode pixels or verify compression/CRCs.
  let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    ensure!(bytes.len() >= 45 && &bytes[8..16] == b"\x00\x00\x00\x0dIHDR"
      && bytes.ends_with(b"\x00\x00\x00\x00IEND\xae\x42\x60\x82"),
      "Generated PNG file is truncated or invalid");
    "image/png"
  } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
    ensure!(bytes.len() >= 4 && bytes.ends_with(&[0xff, 0xd9]),
      "Generated JPEG file is truncated or invalid");
    "image/jpeg"
  } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    let declared_len = u32::from_le_bytes(bytes[4..8].try_into()?) as u64 + 8;
    ensure!(bytes.len() >= 20 && declared_len == bytes.len() as u64,
      "Generated WebP file is truncated or invalid");
    "image/webp"
  } else {
    bail!("Generated file is not a supported PNG, JPEG or WebP image");
  };
  store.import_bytes("Codex image", mime, &bytes)
}

fn native_image_cache_dir(thread_id: &str) -> Option<PathBuf> {
  let id = uuid::Uuid::parse_str(thread_id).ok()?;
  if id.to_string() != thread_id {
    return None;
  }
  let home = std::env::var_os("CODEX_HOME").map(PathBuf::from)
    .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))?;
  Some(home.join("generated_images").join(thread_id))
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
  command.args(["app-server", "--listen", "stdio://", "--enable", "image_generation",
    "-c", "web_search=\"disabled\"", "-c", "shell_environment_policy.inherit=\"core\""]);
  for name in DISABLED_FEATURES {
    command.args(["--disable", name]);
  }
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
    None,
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::project_store::{Project, ProjectKind};
  use std::fs;

  const VALID_PNG: &[u8] = include_bytes!("../icons/icon.png");

  #[test]
  fn external_protocol_completed_and_real_image() -> Result<()> {
    for kind in [RequestKind::Assistant, RequestKind::Image] {
      let root = tempfile::tempdir()?;
      let store = ProjectStore::new(root.path().into())?;
      let project =
        store.save_project(Project::new("Test", ProjectKind::Canvas, serde_json::json!({})))?;
      let cwd = store.project_codex_dir(&project.id)?;
      let image = cwd.join("result.png");
      fs::write(&image, VALID_PNG)?;
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
    fs::write(&path, VALID_PNG)?;
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
  fn rejects_obviously_truncated_generated_images() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let project = store.save_project(Project::new("Truncated", ProjectKind::Canvas, json!({})))?;
    let cwd = store.project_codex_dir(&project.id)?;
    for (index, bytes) in [b"\x89PNG\r\n\x1a\nfixture".as_slice(),
      &VALID_PNG[..VALID_PNG.len() - 5], b"\xff\xd8\xff", b"RIFF\x04\x00\x00\x00WEBP"].into_iter().enumerate() {
      let path = cwd.join(format!("truncated-{index}.png"));
      fs::write(&path, bytes)?;
      assert!(import_generated_image(&store, &path, &cwd, None).is_err(),
        "Truncated image {index} was imported");
    }
    assert!(store.list_assets()?.is_empty());
    Ok(())
  }

  #[test]
  fn native_cache_import_requires_current_thread_and_regular_image() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().join("store"))?;
    let project = store.save_project(Project::new("Cache", ProjectKind::Canvas, json!({})))?;
    let cwd = store.project_codex_dir(&project.id)?;
    let cache = root.path().join("generated_images").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&cache)?;
    let path = cache.join(format!("exec-{}.png", uuid::Uuid::new_v4()));
    fs::write(&path, VALID_PNG)?;
    assert_eq!(import_generated_image(&store, &path, &cwd, Some(&cache))?.mime_type, "image/png");
    let other_thread = cache.parent().unwrap().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&other_thread)?;
    let foreign = other_thread.join(path.file_name().unwrap());
    fs::copy(&path, &foreign)?;
    assert!(import_generated_image(&store, &foreign, &cwd, Some(&cache)).is_err());
    fs::write(cache.join("unrelated.png"), VALID_PNG)?;
    assert!(import_generated_image(&store, &cache.join("unrelated.png"), &cwd, Some(&cache)).is_err());
    fs::write(&path, b"not an image")?;
    assert!(import_generated_image(&store, &path, &cwd, Some(&cache)).is_err());
    #[cfg(unix)] {
      fs::remove_file(&path)?;
      std::os::unix::fs::symlink(&foreign, &path)?;
      assert!(import_generated_image(&store, &path, &cwd, Some(&cache)).is_err());
    }
    Ok(())
  }

  #[test]
  fn rejects_effective_config_that_keeps_hooks_enabled() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let project = store.save_project(Project::new("Hooks", ProjectKind::Canvas, json!({})))?;
    let error = send_with_command(fixture("hooks_enabled", &root.path().join("unused.png")),
      &store, &project.id, RequestKind::Assistant).err().context("Enabled hooks were accepted")?;
    assert!(error.to_string().contains("isolation"), "{error}");
    Ok(())
  }

  #[test]
  fn rejects_active_mcp_tools_before_inference() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let project = store.save_project(Project::new("Isolation", ProjectKind::Canvas, json!({})))?;
    let error = send_with_command(
      fixture("mcp_active", &root.path().join("unused.png")),
      &store,
      &project.id,
      RequestKind::Assistant,
    )
    .err()
    .context("Active MCP tools were accepted")?;
    assert!(error.to_string().contains("isolation"), "{error}");
    Ok(())
  }

  #[test]
  fn selected_model_is_validated_and_sent_only_to_the_request() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let project = store.save_project(Project::new("Model", ProjectKind::Canvas, json!({})))?;
    let cwd = store.project_codex_dir(&project.id)?;
    for model in ["gpt-fixture", "unknown-model"] {
      let result = run_request(
        fixture("selected_model", &cwd.join("unused.png")),
        &store,
        &cwd,
        RequestKind::Assistant,
        vec![json!({"type":"text","text":"test"})],
        Duration::from_secs(2),
        None,
        Some(model),
      );
      if model == "gpt-fixture" {
        assert_eq!(result?.message, "Fixture reply");
      } else {
        assert!(result
          .err()
          .context("Unknown model accepted")?
          .to_string()
          .contains("unavailable"));
      }
    }
    Ok(())
  }

  #[test]
  fn model_catalog_validates_and_projects_safe_fields() -> Result<()> {
    let model = json!({"id":"gpt-fixture","displayName":"Fixture","isDefault":true,
      "supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Low"}],
      "ignoredSensitiveField":"must not be returned"});
    let parsed = parse_model(&model)?;
    assert_eq!(
      serde_json::to_value(parsed)?,
      json!({"id":"gpt-fixture",
      "displayName":"Fixture","isDefault":true,"efforts":["low"]})
    );
    for bad in [
      json!({}),
      json!({"id":"","displayName":"Fixture","isDefault":true,
      "supportedReasoningEfforts":[]}),
      json!({"id":"gpt-fixture","displayName":"Fixture",
      "isDefault":"true","supportedReasoningEfforts":[]}),
    ] {
      assert!(parse_model(&bad).is_err());
    }
    Ok(())
  }

  #[test]
  fn deadline_bounds_stdin_backpressure_and_reaps_child() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = ProjectStore::new(root.path().into())?;
    let project = store.save_project(Project::new("Pressure", ProjectKind::Canvas, json!({})))?;
    let cwd = store.project_codex_dir(&project.id)?;
    let path = cwd.join("unused.png");
    let started = Instant::now();
    let result = run_request(
      fixture("backpressure", &path),
      &store,
      &cwd,
      RequestKind::Assistant,
      vec![json!({"type":"text","text":"a".repeat(100_000)})],
      Duration::from_secs(2),
      None,
      None,
    );
    let error = result.err().context("Backpressure unexpectedly succeeded")?;
    assert!(path.with_extension("png.isolated").is_file(), "Fixture did not reply to isolation RPC");
    assert!(started.elapsed() < Duration::from_secs(4), "Blocked write exceeded deadline: {error}");
    assert!(error.to_string().contains("deadline exceeded"), "{error}");
    let pid = fs::read_to_string(path.with_extension("png.pid"))?;
    assert!(!Command::new("/bin/kill")
      .args(["-0", pid.trim()])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status()?
      .success());
    Ok(())
  }

  #[test]
  fn shutdown_waits_for_child_registration_and_rejects_later_spawns() -> Result<()> {
    let root = tempfile::tempdir()?;
    let bridge = Arc::new(CodexBridge::default());
    let active = bridge.lifecycle.clone();
    let (created, pid_receiver) = mpsc::channel();
    let (resume, paused) = mpsc::channel();
    let path = root.path().join("paused.png");
    let command = fixture("timeout", &path);
    let worker = thread::spawn(move || {
      let transport = Transport::spawn_with_registration_hook(
        command, Duration::from_secs(10), Some(active), |pid| {
          created.send(pid).unwrap();
          paused.recv().unwrap();
        },
      )?;
      let mut transport = transport;
      transport.initialize()
    });
    let pid = pid_receiver.recv_timeout(Duration::from_secs(2))?;
    let closing = bridge.clone();
    let (begun, begun_receiver) = mpsc::channel();
    let (finished, finished_receiver) = mpsc::channel();
    let closer = thread::spawn(move || {
      begun.send(()).unwrap();
      closing.shutdown();
      finished.send(()).unwrap();
    });
    begun_receiver.recv_timeout(Duration::from_secs(2))?;
    let returned_before_registration = finished_receiver.recv_timeout(Duration::from_millis(150)).is_ok();
    resume.send(())?;
    let _ = worker.join().unwrap();
    closer.join().unwrap();
    assert!(!returned_before_registration, "Shutdown returned while an OS child was unpublished");
    assert!(!Command::new("/bin/kill").args(["-0", &pid.to_string()])
      .stdout(Stdio::null()).stderr(Stdio::null()).status()?.success());
    let later_path = root.path().join("later.png");
    let result = Transport::spawn(fixture("timeout", &later_path),
      Duration::from_millis(500), Some(bridge.lifecycle.clone()));
    assert!(result.err().context("Closed bridge spawned a later child")?.to_string().contains("closing"));
    assert!(!later_path.with_extension("png.pid").exists());
    assert!(bridge.models().err().context("Closed bridge accepted a queued model request")?
      .to_string().contains("closing"));
    Ok(())
  }

  #[test]
  fn shutdown_terminates_and_reaps_the_active_child() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = Arc::new(ProjectStore::new(root.path().into())?);
    let project = store.save_project(Project::new("Cancel", ProjectKind::Canvas, json!({})))?;
    let cwd = store.project_codex_dir(&project.id)?;
    let bridge = Arc::new(CodexBridge::default());
    let active = bridge.lifecycle.clone();
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
        None,
      )
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while bridge.lifecycle.state.lock().unwrap().maybe_pid.is_none() && Instant::now() < deadline {
      thread::sleep(Duration::from_millis(5));
    }
    let pid = bridge.lifecycle.state.lock().unwrap().maybe_pid.context("Fixture did not start")?;
    bridge.shutdown();
    assert!(worker.join().unwrap().is_err());
    assert!(bridge.lifecycle.state.lock().unwrap().maybe_pid.is_none());
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
 elif method=='model/list':
  send({'id':id,'result':{'data':[{'id':'gpt-fixture','displayName':'Fixture','isDefault':True,'supportedReasoningEfforts':[{'reasoningEffort':'low'}]}],'nextCursor':None}})
 elif method=='config/read':
  send({'id':id,'result':{'config':{'web_search':'disabled','features':{'apps':False,'plugins':False,'hooks':mode=='hooks_enabled','multi_agent':False,'image_generation':True,**{n:False for n in ['shell_tool','unified_exec','view_image','browser_use','browser_use_external','computer_use','in_app_browser']}},'mcp_servers':{'fixture_server':{'enabled':True}}}}})
 elif method=='mcpServerStatus/list':
  data=[] if mode!='mcp_active' else [{'runtimeStatus':'connected','tools':{'bad':{}},'resources':[],'resourceTemplates':[]}]
  send({'id':id,'result':{'data':data,'nextCursor':None}})
  if mode=='backpressure':
   with open(path+'.isolated','w') as f: f.write('isolation replied; next write is turn/start')
   time.sleep(5); sys.exit(0)
 elif method=='thread/start':
  if mode=='selected_model': assert r['params']['model']=='gpt-fixture'
  assert r['params']['config'].get('mcp_servers.fixture_server.enabled') is False
  assert all(r['params']['config'].get('features.'+n) is False for n in ['apps','plugins','hooks','multi_agent'])
  assert r['params']['approvalPolicy']=='never'
  assert r['params']['sandbox']=='workspace-write'
  send({'id':id,'result':{'thread':{'id':'thread-fixture'}}})
 elif method=='turn/start':
  if mode=='selected_model': assert r['params']['model']=='gpt-fixture'
  assert mode!='mcp_active'
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
