import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageDraw, Node, useSceneStore } from "@storyteller/ui-pagedraw";
import {
  Stage3D,
  getActiveEditor,
  usePageSceneStore,
  addObject,
  addShape,
  AssetType,
} from "@storyteller/ui-pagescene";
import * as bridge from "./bridge";
import {
  blankCanvasDocument,
  cancelCanvasRestore,
  jsonValuesEqual,
  parseDocument,
  restoreCanvasDocument,
  serializeCanvasDocument,
  type Project,
  type ProjectDocument,
} from "./projectDocuments";
import {
  createSceneAdapter,
  localDrawAdapter,
  SceneLocalTools,
  serializeSceneDocument,
} from "./localAdapters";

type SaveState = "saved" | "dirty" | "saving" | "error";
const SAVE_LABELS: Record<SaveState, string> = {
  saved: "Guardado neste Mac",
  dirty: "Alterações por guardar",
  saving: "A guardar…",
  error: "Falha ao guardar",
};
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [assets, setAssets] = useState<bridge.Asset[]>([]);
  const [active, setActive] = useState<Project | null>(null);
  const [rootPath, setRootPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<bridge.Asset | null>(null);
  const [codex, setCodex] = useState({
    connected: false,
    authMode: "",
    message: "A verificar a sessão Codex…",
  });
  const [models, setModels] = useState<bridge.CodexModel[]>([]);
  const [model, setModel] = useState("");
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexLoading, setCodexLoading] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const revision = useRef(0);
  const restoring = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const navigationLock = useRef(false);
  const importLock = useRef(false);
  const codexLock = useRef(false);

  const reportError = (message: string) => setError(message);
  const onAssetImported = useCallback((asset: bridge.Asset) => {
    setAssets((items) => [
      asset,
      ...items.filter((item) => item.id !== asset.id),
    ]);
    setPreview(asset);
  }, []);
  const markDirty = () => {
    if (!activeRef.current || restoring.current) return;
    revision.current++;
    setSaveState((state) => (state === "saving" ? state : "dirty"));
  };
  useEffect(() => {
    const offCanvas = useSceneStore.subscribe((state, previous) => {
      if (activeRef.current?.kind !== "canvas") return;
      if (
        state.drawNodes !== previous.drawNodes ||
        state.inpaintLineNodes !== previous.inpaintLineNodes ||
        state.fillColor !== previous.fillColor ||
        state.baseImageInfo !== previous.baseImageInfo ||
        state.brushColor !== previous.brushColor ||
        state.brushSize !== previous.brushSize ||
        state.eraserSize !== previous.eraserSize
      )
        markDirty();
    });
    const offScene = usePageSceneStore.subscribe((state, previous) => {
      if (
        activeRef.current?.kind !== "scene" ||
        !state.is3DSceneLoaded ||
        !previous.is3DSceneLoaded
      )
        return;
      if (
        state.objects !== previous.objects ||
        state.shapes !== previous.shapes ||
        state.characters !== previous.characters ||
        state.objectPanelCurrent !== previous.objectPanelCurrent ||
        state.outlinerItems !== previous.outlinerItems ||
        state.cameras !== previous.cameras ||
        state.cameraAspectRatio !== previous.cameraAspectRatio ||
        state.timelineTracks !== previous.timelineTracks ||
        state.timelineClipLanes !== previous.timelineClipLanes ||
        state.timelineDuration !== previous.timelineDuration ||
        state.selectedCameraId !== previous.selectedCameraId
      )
        markDirty();
    });
    return () => {
      offCanvas();
      offScene();
      cancelCanvasRestore();
    };
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (revision.current || saving.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    let alive = true;
    Promise.all([
      bridge.workspaceInfo(),
      bridge.listProjects(),
      bridge.listAssets(),
    ])
      .then(([info, result, assets]) => {
        if (!alive) return;
        setRootPath(info.rootPath);
        setProjects(result.projects);
        setWarnings(result.warnings);
        setAssets(assets);
      })
      .catch((error) => alive && setError(bridge.errorText(error)))
      .finally(() => alive && setLoading(false));
    refreshCodex();
    return () => {
      alive = false;
    };
  }, []);

  async function refreshCodex() {
    if (codexLock.current) return;
    codexLock.current = true;
    setCodexLoading(true);
    try {
      const status = await bridge.codexStatus();
      setCodex(status);
      // Native backend serializes these calls. Never start them in parallel.
      const catalog = status.connected ? await bridge.codexModels() : [];
      setModels(catalog);
      setModel((current) =>
        catalog.some((m) => m.id === current)
          ? current
          : ((
              catalog.find((m) => m.id === "gpt-6-luna") ??
              catalog.find((m) => m.isDefault) ??
              catalog[0]
            )?.id ?? ""),
      );
    } catch (error) {
      setCodex({
        connected: false,
        authMode: "",
        message: bridge.errorText(error),
      });
    } finally {
      codexLock.current = false;
      setCodexLoading(false);
    }
  }
  async function currentDocument(project: Project): Promise<ProjectDocument> {
    if (project.kind === "canvas") return serializeCanvasDocument();
    const editor = getActiveEditor();
    if (!editor) throw new Error("A cena ainda está a abrir.");
    return serializeSceneDocument(editor);
  }
  async function saveCurrent(): Promise<void> {
    if (saving.current) return saving.current;
    const project = activeRef.current;
    if (!project) return;
    if (project.kind === "scene") getActiveEditor()?.timelineController.pause();
    setSaveState("saving");
    setError("");
    const work = async () => {
      try {
        // Each write snapshots the live engine. If edits arrive while native
        // persistence awaits, repeat until disk and the latest state agree.
        while (activeRef.current?.id === project.id) {
          const before = activeRef.current;
          const document = await currentDocument(before);
          const saved = await bridge.saveProject({
            ...before,
            document,
            updatedAt: new Date().toISOString(),
          });
          setProjects((items) => [
            saved,
            ...items.filter((p) => p.id !== saved.id),
          ]);
          const latest = activeRef.current;
          if (!latest || latest.id !== project.id) return;
          const comparisonRevision = revision.current;
          const newest = await currentDocument(latest);
          if (
            revision.current !== comparisonRevision ||
            activeRef.current?.name !== latest.name
          )
            continue;
          if (
            latest.name.trim() === saved.name &&
            jsonValuesEqual(newest, saved.document)
          ) {
            // Commit native name normalization only after the latest-edit
            // barrier, so a rename made during the save cannot be overwritten.
            if (latest.name !== saved.name) {
              const normalized = { ...latest, name: saved.name };
              activeRef.current = normalized;
              setActive(normalized);
            }
            revision.current = 0;
            setSaveState("saved");
            return;
          }
        }
      } catch (error) {
        setSaveState("error");
        setError(bridge.errorText(error));
        throw error;
      }
    };
    saving.current = work();
    try {
      await saving.current;
    } finally {
      saving.current = null;
    }
  }
  async function navigate(project?: Project, kind?: Project["kind"]) {
    if (navigationLock.current || codexLock.current || importLock.current)
      return;
    navigationLock.current = true;
    setNavigationBusy(true);
    setError("");
    try {
      await saveCurrent();
      const next = project
        ? await bridge.loadProject(project.id)
        : ({
            schemaVersion: 1,
            id: bridge.newId(),
            name: kind === "scene" ? "Cena sem título" : "Tela sem título",
            kind: kind ?? "canvas",
            document:
              kind === "scene"
                ? { version: 1, kind: "scene", scene: null }
                : blankCanvasDocument(),
            updatedAt: new Date().toISOString(),
          } satisfies Project);
      restoring.current = true;
      cancelCanvasRestore();
      setActive(null);
      activeRef.current = null;
      await nextFrame(); // dispose the previous engine before resetting shared state
      usePageSceneStore.setState({
        ...usePageSceneStore.getInitialState(),
        currentUserToken: "creative-desk-local-owner",
        sceneMeta: {
          title: next.name,
          token: next.id,
          ownerToken: "creative-desk-local-owner",
          isModified: false,
          isInitializing: true,
        },
      });
      if (next.document.kind === "canvas")
        await restoreCanvasDocument(next.document);
      setReply("");
      setReferences([]);
      setPreview(null);
      revision.current = project ? 0 : 1;
      setSaveState(project ? "saved" : "dirty");
      activeRef.current = next;
      setActive(next);
      restoring.current = false;
      if (!project) setProjects((items) => [next, ...items]);
    } catch (error) {
      setError(bridge.errorText(error));
    } finally {
      restoring.current = false;
      navigationLock.current = false;
      setNavigationBusy(false);
    }
  }
  async function importFiles(files: FileList | null) {
    if (!files || importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const asset = await bridge.importAsset(file);
        onAssetImported(asset);
      }
    } catch (error) {
      setError(bridge.errorText(error));
    } finally {
      importLock.current = false;
      setImporting(false);
    }
  }
  async function useAsset(asset: bridge.Asset, asBase = false) {
    if (!activeRef.current || navigationLock.current || importLock.current)
      return;
    importLock.current = true;
    setImporting(true);
    setError("");
    try {
      if (
        asset.mimeType.startsWith("image/") &&
        activeRef.current.kind === "canvas"
      ) {
        const { dataUrl } = await bridge.readAsset(asset.id);
        if (asBase) {
          const document = await serializeCanvasDocument();
          restoring.current = true;
          await restoreCanvasDocument({
            ...document,
            baseImageInfo: { url: dataUrl, mediaToken: asset.id },
          });
          restoring.current = false;
          markDirty();
        } else {
          const image = new Node({
            id: bridge.newId(),
            type: "image",
            x: 30,
            y: 30,
            width: 300,
            height: 200,
            fill: "transparent",
            draggable: true,
          });
          await image.setImageFromUrl(dataUrl);
          useSceneStore.getState().addNode(image);
        }
      } else if (
        asset.mimeType === "model/gltf-binary" &&
        activeRef.current.kind === "scene"
      ) {
        const editor = getActiveEditor();
        if (!editor?.isEngineDataLoaded())
          throw new Error("A cena ainda está a abrir.");
        await addObject(editor, {
          version: 1,
          type: AssetType.OBJECT,
          media_id: bridge.engineAssetToken(asset.id),
          name: asset.name,
        });
      } else
        throw new Error(
          "Use imagens na tela 2D e ficheiros GLB na cena 3D. Áudio e vídeo têm pré-visualização local.",
        );
    } catch (error) {
      restoring.current = false;
      setError(bridge.errorText(error));
    } finally {
      importLock.current = false;
      setImporting(false);
    }
  }
  async function send(kind: "assistant" | "image") {
    const project = activeRef.current;
    if (
      !project ||
      !prompt.trim() ||
      codexLock.current ||
      importLock.current ||
      navigationLock.current ||
      !codex.connected ||
      !model
    )
      return;
    codexLock.current = true;
    setCodexBusy(true);
    setError("");
    try {
      await saveCurrent();
      const result = await bridge.codexSend({
        projectId: project.id,
        prompt: prompt.trim(),
        kind,
        assetIds: references,
        maybeModel: model,
      });
      setReply(result.message);
      setAssets((items) => [
        ...result.assets,
        ...items.filter(
          (asset) =>
            !result.assets.some((newAsset) => asset.id === newAsset.id),
        ),
      ]);
      if (result.assets[0]) setPreview(result.assets[0]);
    } catch (error) {
      setError(bridge.errorText(error));
    } finally {
      codexLock.current = false;
      setCodexBusy(false);
    }
  }
  const sceneAdapter = useMemo(
    () =>
      active?.kind === "scene"
        ? createSceneAdapter({
            project: active,
            save: async (value) => {
              const doc = parseDocument(value);
              if (doc.kind !== "scene") throw new Error("Cena inválida.");
              await saveCurrent();
            },
            onError: reportError,
            onAssetImported,
          })
        : null,
    [active?.id, onAssetImported],
  );

  useEffect(() => {
    if (!bridge.testTransport()) return;
    window.__CREATIVE_DESK_EDITOR__ = {
      canvasState: () => useSceneStore.getState(),
      addRectangle: () =>
        useSceneStore.getState().addNode(
          new Node({
            id: bridge.newId(),
            type: "rectangle",
            x: 17,
            y: 29,
            width: 120,
            height: 90,
            fill: "#dc704d",
            draggable: true,
          }),
        ),
      sceneState: () => usePageSceneStore.getState(),
      sceneJson: () => {
        const editor = getActiveEditor();
        return editor ? serializeSceneDocument(editor) : null;
      },
      addCube: async () => {
        const editor = getActiveEditor();
        if (!editor) throw new Error("Editor not ready");
        await addShape(editor, {
          version: 1,
          type: AssetType.SHAPE,
          media_id: "Box",
          name: "Cubo",
        });
      },
    };
    return () => {
      delete window.__CREATIVE_DESK_EDITOR__;
    };
  }, []);
  const blocked =
    loading || navigationBusy || importing || codexBusy || codexLoading;
  return (
    <div className="desk">
      <aside className="desk-nav">
        <div className="desk-brand">
          <span className="desk-monogram">cd</span>
          <div>
            Creative Desk<small>ESTÚDIO LOCAL</small>
          </div>
        </div>
        <section>
          <div className="desk-section-heading">
            PROJETOS <span>{projects.length.toString().padStart(2, "0")}</span>
          </div>
          <div className="desk-new">
            <button
              data-testid="new-canvas"
              disabled={blocked}
              onClick={() => navigate(undefined, "canvas")}
            >
              + Tela 2D
            </button>
            <button
              data-testid="new-scene"
              disabled={blocked}
              onClick={() => navigate(undefined, "scene")}
            >
              + Cena 3D
            </button>
          </div>
          {loading ? (
            <p className="desk-muted">A abrir o estúdio…</p>
          ) : projects.length === 0 ? (
            <p className="desk-muted">A primeira ideia começa numa tela.</p>
          ) : (
            <div className="desk-projects">
              {projects.map((project) => (
                <button
                  key={project.id}
                  data-testid={`project-${project.id}`}
                  className={active?.id === project.id ? "is-active" : ""}
                  disabled={blocked}
                  onClick={() => navigate(project)}
                >
                  <span className="desk-project-kind">
                    {project.kind === "canvas" ? "2D" : "3D"}
                  </span>
                  <span>
                    {project.name}
                    <small>
                      {new Date(project.updatedAt).toLocaleDateString("pt-PT")}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="desk-assets">
          <div className="desk-section-heading">
            RECURSOS <span>{assets.length.toString().padStart(2, "0")}</span>
          </div>
          <label className={`desk-import ${importing ? "is-disabled" : ""}`}>
            {importing ? "A importar…" : "↑ Importar ficheiros"}
            <input
              data-testid="import-assets"
              type="file"
              multiple
              disabled={blocked}
              onChange={(event) => {
                importFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          <p className="desk-hint">
            Imagem, áudio, vídeo e GLB. Cópias neste Mac.
          </p>
          <div className="desk-asset-list">
            {assets.map((asset) => (
              <button
                key={asset.id}
                data-testid={`asset-${asset.id}`}
                onClick={() => setPreview(asset)}
                className={preview?.id === asset.id ? "is-active" : ""}
              >
                <span>
                  {asset.mimeType.startsWith("image/")
                    ? "IMG"
                    : asset.mimeType.startsWith("audio/")
                      ? "SOM"
                      : asset.mimeType.startsWith("video/")
                        ? "VID"
                        : "GLB"}
                </span>
                {asset.name}
              </button>
            ))}
          </div>
        </section>
        <footer>
          <span className="desk-dot" /> NO SEU MAC
          <small title={rootPath}>{rootPath || "~/CreativeDesk"}</small>
        </footer>
      </aside>
      <main className="desk-main">
        <header className="desk-topbar">
          {active ? (
            <>
              <span className="desk-type">
                {active.kind === "canvas" ? "TELA / 2D" : "CENA / 3D"}
              </span>
              <input
                aria-label="Nome do projeto"
                data-testid="project-name"
                maxLength={200}
                value={active.name}
                disabled={navigationBusy}
                onChange={(event) => {
                  const current = activeRef.current;
                  if (!current) return;
                  const next = { ...current, name: event.target.value };
                  activeRef.current = next;
                  setActive(next);
                  markDirty();
                }}
              />
              <span
                data-testid="save-state"
                className={`desk-save-state ${saveState}`}
              >
                {SAVE_LABELS[saveState]}
              </span>
              <button
                data-testid="save-project"
                disabled={navigationBusy || saveState === "saving"}
                onClick={() => saveCurrent().catch(() => {})}
              >
                Guardar
              </button>
            </>
          ) : (
            <>
              <span className="desk-type">O SEU ESPAÇO CRIATIVO</span>
              <span className="desk-topbar-note">
                Projetos e recursos guardados localmente
              </span>
            </>
          )}
        </header>
        {error && (
          <div role="alert" className="desk-error" data-testid="error">
            <span>{error}</span>
            <button aria-label="Fechar erro" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {warnings.length > 0 && (
          <div className="desk-warning">
            Alguns projetos não puderam ser abertos. {warnings.join(" ")}
          </div>
        )}
        <div
          className="desk-workspace"
          data-testid="workspace"
          data-project-id={active?.id}
        >
          {active?.kind === "canvas" ? (
            <PageDraw
              key={active.id}
              adapter={localDrawAdapter}
              fillParentHeight
              showBottomRightControls={false}
              showGenerationControls={false}
            />
          ) : active?.kind === "scene" && sceneAdapter ? (
            <Stage3D
              key={active.id}
              adapter={sceneAdapter}
              cacheJsonString={
                active.document.kind === "scene" && active.document.scene
                  ? JSON.stringify(active.document.scene)
                  : undefined
              }
              showGenerationControls={false}
              showCostCalculator={false}
              showHelpMenu={false}
              showImageTo3DButton={false}
              topBarStartSlot={<SceneLocalTools onError={reportError} />}
            />
          ) : (
            <div className="desk-welcome">
              <div className="desk-welcome-mark">
                cd<span>○</span>
              </div>
              <span className="desk-eyebrow">UM LUGAR PARA EXPERIMENTAR</span>
              <h1>
                Dê espaço
                <br />à próxima ideia.
              </h1>
              <p>
                Desenhe numa tela. Componha uma cena.
                <br />
                Trabalhe com o Codex que já tem.
              </p>
              <div>
                <button
                  disabled={blocked}
                  onClick={() => navigate(undefined, "canvas")}
                >
                  Criar uma tela 2D
                </button>
                <button
                  disabled={blocked}
                  onClick={() => navigate(undefined, "scene")}
                >
                  Abrir uma cena 3D
                </button>
              </div>
            </div>
          )}
          {navigationBusy && (
            <div className="desk-loading" role="status">
              A guardar e abrir o projeto…
            </div>
          )}
        </div>
      </main>
      <aside className="desk-assistant">
        <header>
          <span className="desk-eyebrow">AO SEU LADO</span>
          <h2>Codex</h2>
          <p>
            {codexLoading
              ? "A verificar a sessão…"
              : codex.connected
                ? "Sessão ChatGPT ligada"
                : "Sessão indisponível"}
          </p>
        </header>
        <details className="desk-status">
          <summary>Estado da sessão</summary>
          <p>{codex.message}</p>
          <button disabled={codexBusy || codexLoading} onClick={refreshCodex}>
            Verificar novamente
          </button>
        </details>
        <label className="desk-model-label">
          Modelo
          <select
            data-testid="codex-model"
            value={model}
            disabled={codexBusy || codexLoading || !models.length}
            onChange={(event) => setModel(event.target.value)}
          >
            {models.length === 0 && (
              <option value="">Sem catálogo disponível</option>
            )}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="desk-conversation">
          {reply ? (
            <div className="desk-reply" data-testid="codex-reply">
              {reply}
            </div>
          ) : (
            <div className="desk-assistant-empty">
              <span>↗</span>
              <p>
                Uma segunda perspetiva
                <br />
                para a sua próxima ideia.
              </p>
              <small>
                Converse ou gere uma imagem. Os resultados aparecem nos recursos
                locais.
              </small>
            </div>
          )}
        </div>
        {references.length > 0 && (
          <div className="desk-references">
            {references.map((id) => (
              <button
                key={id}
                onClick={() =>
                  setReferences((ids) => ids.filter((value) => value !== id))
                }
              >
                {assets.find((a) => a.id === id)?.name ?? "Imagem"} ×
              </button>
            ))}
          </div>
        )}
        <textarea
          data-testid="codex-prompt"
          aria-label="Mensagem para Codex"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={
            active ? "Descreva a sua ideia…" : "Abra um projeto para começar…"
          }
          disabled={!active || codexBusy}
        />
        <div className="desk-send">
          <button
            data-testid="codex-send"
            disabled={
              !active ||
              !prompt.trim() ||
              !codex.connected ||
              !model ||
              codexBusy ||
              codexLoading ||
              navigationBusy ||
              importing
            }
            onClick={() => send("assistant")}
          >
            {codexBusy ? "A trabalhar…" : "Conversar"}
          </button>
          <button
            data-testid="codex-image"
            disabled={
              !active ||
              !prompt.trim() ||
              !codex.connected ||
              !model ||
              codexBusy ||
              codexLoading ||
              navigationBusy ||
              importing
            }
            onClick={() => send("image")}
          >
            Gerar imagem
          </button>
        </div>
        <p className="desk-hint">
          Imagens podem servir de referência. Áudio, vídeo e GLB ficam no
          estúdio local.
        </p>
      </aside>
      {preview && (
        <div className="desk-preview" data-testid="asset-preview">
          <div className="desk-preview-title">
            <span>{preview.name}</span>
            <button
              aria-label="Fechar pré-visualização"
              onClick={() => setPreview(null)}
            >
              ×
            </button>
          </div>
          {preview.mimeType.startsWith("image/") ? (
            <img src={bridge.assetUrl(preview)} alt={preview.name} />
          ) : preview.mimeType.startsWith("video/") ? (
            <video
              controls
              src={bridge.assetUrl(preview)}
              onError={() =>
                setError(
                  "Este formato de vídeo não pode ser reproduzido neste Mac.",
                )
              }
            />
          ) : preview.mimeType.startsWith("audio/") ? (
            <audio
              controls
              src={bridge.assetUrl(preview)}
              onError={() =>
                setError(
                  "Este formato de áudio não pode ser reproduzido neste Mac.",
                )
              }
            />
          ) : (
            <p>
              Modelo GLB local. Adicione-o a uma cena 3D para o visualizar e
              transformar.
            </p>
          )}
          <div className="desk-preview-actions">
            {preview.mimeType.startsWith("image/") && (
              <>
                <button
                  disabled={active?.kind !== "canvas" || navigationBusy}
                  onClick={() => useAsset(preview)}
                >
                  Adicionar à tela
                </button>
                <button
                  data-testid="asset-base"
                  disabled={active?.kind !== "canvas" || navigationBusy}
                  onClick={() => useAsset(preview, true)}
                >
                  Usar como base
                </button>
                <button
                  disabled={!active || codexBusy}
                  onClick={() =>
                    setReferences((ids) =>
                      ids.includes(preview.id) ? ids : [...ids, preview.id],
                    )
                  }
                >
                  Referência Codex
                </button>
              </>
            )}
            {preview.mimeType === "model/gltf-binary" && (
              <button
                data-testid="asset-scene"
                disabled={active?.kind !== "scene" || navigationBusy}
                onClick={() => useAsset(preview)}
              >
                Adicionar à cena
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
