# Creative Desk implementation plan

> **For agentic workers:** Use subagent-driven-development task by task, with independent review. Steps use checkbox syntax.

**Goal:** Deliver a runnable Mac Intel prototype of the current ArtCraft fork with local 2D/3D projects and the user's existing Codex login, with no ArtCraft account or services.

**Architecture:** Keep ArtCraft's existing editor libraries, replacing the hosted application's entry point and platform adapters with a small local Tauri host. The host owns project/asset persistence and a stdio child process for Codex app-server. Relevant NRS commits remove telemetry, unlicensed bundled resources and broad network/file permissions; preserve their authorship.

**Tech stack:** Existing Rust/Tauri 2, React/Vite, Zustand/Konva/Three.js dependencies. No additional third-party dependencies.

## Global constraints

- Do not add new third-party dependencies or change credentials, API keys, user permissions or existing user data.
- The application is Creative Desk, identifier `local.creative.desk`, default data root `~/CreativeDesk`.
- No ArtCraft login, hosted persistence, provider router, telemetry, catalog calls or remote fonts in the running prototype.
- Use the Codex app-server managed ChatGPT session through stdio. Do not read or copy `auth.json` or tokens.
- Preserve existing editor canvas lifecycle and the engine → event bus → store flow. Do not conditionally unmount 3D canvases for toolbar gating.
- Rust commands each have their own file. Two-space indentation. Optional Rust fields use `maybe_` and camelCase IPC serialization.
- New code validates external data at filesystem/IPC/protocol boundaries and reports real errors. No simulated provider success.
- A first prototype may limit generation to Codex and hide unsupported providers, but must actually save and reopen edited 2D and 3D projects.

## Task 1: Local Tauri host and Codex boundary

**Files:** Create `crates/desktop/creative_desk/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json,src/main.rs,src/lib.rs,src/project_store.rs,src/codex_bridge.rs,src/commands/*.rs}`. Modify root `Cargo.toml` to include this crate and make it the default desktop target. Tests in the new crate. Own only these files; frontend is a later task.

**Interfaces:** All IPC uses camelCase. `Project` has `schemaVersion:1`, `id:string` UUID, `name:string`, `kind:"canvas"|"scene"`, `document:unknown` JSON value, `updatedAt:string` UTC. `Asset` has `id:string` UUID, `name:string`, `mimeType:string`, `path:string` absolute local copy. Result errors are strings for the frontend to display. Required Tauri commands:

```ts
local_workspace_info(): Promise<{rootPath:string; applicationId:string}>;
local_list_projects(): Promise<{projects:Project[],warnings:string[]}>;
local_save_project({project:Project}): Promise<Project>;
local_load_project({id:string}): Promise<Project>;
local_import_asset({name:string,mimeType:string,bytesBase64:string}): Promise<Asset>;
local_list_assets(): Promise<Asset[]>;
local_read_asset({id:string}): Promise<{asset:Asset,dataUrl:string}>;
codex_status(): Promise<{connected:boolean,authMode:string,message:string}>;
codex_models(): Promise<{id:string,displayName:string,isDefault:boolean,efforts:string[]}[]>;
codex_send({projectId:string,prompt:string,kind:"assistant"|"image",assetIds:string[],maybeModel?:string|null}):
  Promise<{message:string,threadId:string,assets:Asset[]}>;
```

Store layout: `projects/<uuid>/project.json`, `projects/<uuid>/codex/` as agent working directory, `assets/<uuid>/...` plus metadata. UUIDs determine paths; user titles/filenames never determine directory traversal. Write project JSON atomically; reject unsupported schema, empty names, unsafe IDs, symlinks escaping the root and invalid asset base64. Preserve valid projects if a corrupt unrelated project is encountered, reporting the failure rather than silently replacing it. Asset import copies bytes into owned storage and reopening reads from there.

Codex protocol: resolve an installed CLI from PATH and known `/usr/local/bin/codex` / `/opt/homebrew/bin/codex`, spawn `app-server --listen stdio://`, initialize once, acknowledge initialized, then account/read with `refreshToken:false`. Return account mode only, no personal details. For a request, start a fresh project-scoped thread, approvalPolicy never, restricted workspace sandbox, and explicit instructions to answer or use image generation without ArtCraft services or unrelated apps. Use the installed version's schemas from `/tmp/artcraft-codex-schema.9BnWJV`. Read notifications until `turn/completed` and require status completed; accumulate agent messages and completed imageGeneration items. Copy real generated files from savedPath into local assets; do not treat model text saying it generated a file as proof. Image requests with no file must report failure. Handle JSON-RPC errors, quota failures, EOF, unsuccessful turn and deadline; kill/reap the child on every exit. Deny unsupported server-initiated approval requests. Do not log full protocol messages or credentials. Limit concurrent execution in the small prototype so there are no process/state races.

- [ ] Write and run failing storage tests before implementation. Examples after constructing the real `ProjectStore`:

```rust
let root = tempfile::tempdir()?;
let store = ProjectStore::new(root.path().to_path_buf())?;
let project = Project::new("Estudo", ProjectKind::Canvas, serde_json::json!({"layers":[{"x":17}]}));
let saved = store.save_project(project)?;
let reopened = ProjectStore::new(root.path().to_path_buf())?.load_project(&saved.id)?;
assert_eq!(reopened.document["layers"][0]["x"], 17);
assert!(store.load_project("../../outside").is_err());
```

- [ ] Implement the store, preserving the roundtrip above and adding real tests for scene data, assets and unsupported schemas. Reuse existing workspace versions `serde`, `serde_json`, `uuid`, `base64`, `chrono`, `tempfile`, `anyhow`, `log` and Tauri. Optional desktop features allow headless core tests; do not add libraries outside the existing graph.
- [ ] Write protocol tests for completed/error/EOF turns and saved image file import. A scripted external transport fixture is appropriate here because live inference is verified separately and must not run in unit tests. Confirm the tests fail before implementation.
- [ ] Implement Codex child lifecycle and command wrappers. Use a new Tauri configuration with no HTTP/upload/network plugins, CSP limited to self, IPC, asset, data/blob and the owned local asset scope. Configure frontendDist as `../../../frontend/apps/creative-desk/dist`, no upstream MainApp entry.
- [ ] Provide a headless smoke entry point on the built binary, `--smoke-test <temporary-root>`, exercising store roundtrip and optionally `--codex-smoke` to require a real minimal assistant reply. Write a JSON result to stdout via std::io, not println logging; failures exit nonzero.
- [ ] Run `cargo test -p creative_desk --no-default-features`, record RED/GREEN output, inspect diff and commit only this task's files. Report any unresolved build issue with the exact command and cause.

## Task 2: Local creative interface and existing editors

**Files:** Create `frontend/apps/creative-desk/{vite.config.ts,tsconfig.json,app/index.html,app/src/main.tsx,app/src/App.tsx,app/src/bridge.ts,app/src/projectDocuments.ts,app/src/localAdapters.tsx,app/src/styles.css,app/src/*.spec.ts}`. Small changes allowed in `frontend/libs/components/pagedraw/src/lib/PageDraw.tsx`, `frontend/libs/components/pagescene/src/lib/{Stage3D.tsx,Stage3DBody.tsx}` and existing serialization if a demonstrated roundtrip fails. Own frontend files only.

**Interfaces:** Consume Task 1's exact IPC contract above. Reuse Tauri `invoke` and `convertFileSrc` already in the dependency graph. New IPC/file parsers treat input as unknown and validate before exposing typed values. No new provider keys/accounts.

The interface is a restrained creative desk in Portuguese, with project navigation, explicit save state, image/video/audio/GLB imports and native media previews, the existing 2D canvas and 3D editor, and a Codex sidebar. A dark neutral work area and warm paper-like navigation are appropriate; use installed fonts without network loading. Show real loading/error/empty states. Avoid unsupported cloud/provider controls. The assistant and image generation are explicit user-triggered actions and return actual messages/local files.

2D documents include the existing `useSceneStore.exportSceneAsJson()` output AND baseImageInfo/background dimensions, because upstream serialization omits the base image. Base images and GLB references must refer to persistent owned local assets or embed data. Ensure export/import preserves imported images and 3D node parameters; fix only gaps exposed by roundtrip tests. Loading a document resets the old state before restoring so project A cannot leak into B. Restore an image base only after its asynchronous bitmap load settles, then restore draw nodes; otherwise the upstream base-image onload clears restored nodes. Expose restoreCanvasDocument as an async function and prevent stale asynchronous loads from overwriting a later project.

3D uses `Stage3D` with a local `PageSceneAdapter`: save/load scene JSON via the store; asset lookups only by owned asset IDs; fetchAsset rejects remote URLs; local asset and project listings replace cloud libraries. Existing token/owner hooks must express local ownership and never construct an ArtCraft session. Add an optional generation-controls prop to hide model/cost/login UI without changing default upstream hosts. Ensure 3D engine canvases always mount. Save button uses the live engine serialization and reopen restores camera/objects/timeline. New blank scenes must be editable with built-in primitives. Expose local GLB import if the existing adapter allows it; do not advertise unsupported formats.

- [ ] Write failing tests for project parsing and 2D document roundtrip. Example assertions:

```ts
expect(() => parseProject({...validProject, schemaVersion:2})).toThrow();
expect(() => parseProject({...validProject, id:"../../outside"})).toThrow();
const serialized = await serializeCanvasDocument();
await restoreCanvasDocument(serialized);
expect(useSceneStore.getState().baseImageInfo?.blankCanvasWidth).toBe(640);
expect(useSceneStore.getState().drawNodes[0].x).toBe(17);
```

- [ ] Implement the local bridge, document parsing/serialization and adapters. Existing dependency versions only. Remote generation/catalog APIs must not be called or initialized. Unknown Tauri commands from shared components must not cause boot failure or repeated background work; isolate or disable those hooks for this host rather than swallowing unrelated errors.
- [ ] Build the shell and mount existing editors with stable adapter identity and project-specific state. Warn before losing unsaved edits, or save before navigation and prevent navigation on failure. Save status must reflect the latest document, including edits during a save. Codex generated images become real local assets and can be used as canvas base images. Display quota/error outcomes without simulated success.
- [ ] Add a small test harness using an injectable IPC transport for headless UI tests; the shipped path must always use real Tauri IPC. It should let the parent run Playwright CRUD/editor tests and deny every non-local request. Avoid a fake user-visible generation fallback.
- [ ] Run targeted Vitest checks and `vite build --config apps/creative-desk/vite.config.ts` from frontend. Record RED/GREEN output, review and commit only this task's files.

## Task 3: macOS bundle, real verification and handoff

**Files:** Create `script/creative-desk/build-macos.sh`, `script/creative-desk/verify.mjs`, `_docs/creative-desk.md`, `_docs/creative-desk-validation.md`; modify only build integration needed for the above. Deliver `.app` under repo build output and install to `/Applications/Creative Desk.app` if writable, otherwise `~/Applications/Creative Desk.app`.

- [ ] Build the frontend and `cargo build -p creative_desk --release --features custom-protocol` so the frontend is embedded. A release build without this feature is preparation only and must not be packaged or launched. If the existing Tauri CLI is unavailable, create a normal macOS app bundle containing that compiled executable and Info.plist; do not introduce a new CLI dependency just for packaging. Ad-hoc sign the new bundle locally, without modifying existing credentials or trust settings.
- [ ] Run core unit tests, targeted frontend tests, a headless editor roundtrip test with all remote requests rejected, and the built binary's storage smoke test. Verify the installed app executable is x86_64 and actually launches on this Mac. Check zero ArtCraft network calls in the tested frontend paths and no hosted clients/plugins in the new host.
- [ ] Send one minimal real Codex assistant request through the built bridge and require completed status/message. Try one small image generation and verify the output file if supported; if account limits/provider capability blocks it, preserve the actual failure and report that limit instead of claiming success.
- [ ] Open the native app and inspect the rendered project list, 2D/3D editor and Codex state using available screenshot/UI tooling. Do not change macOS screenshot/accessibility permissions. If UI automation is unavailable, use the native WebView's own evaluation/diagnostic pathway and record exactly which parts were verified.
- [ ] Independent review of NRS changes and all new code must check authentication isolation, filesystem traversal/symlinks, child cleanup, save/reopen behavior, accidental cloud calls, bundle reproducibility and meaningful verification. Fix blocking findings and rerun affected checks.
- [ ] Commit the verified implementation and documentation, push the branch to the authorized fork, read back its SHA, and give the user the app path, fork link, concise capabilities and remaining limitations. Do not deploy/publish a release or create accounts.
