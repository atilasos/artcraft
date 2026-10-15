import { useContext } from "react";
import {
  EngineContext,
  addShape,
  setTransformMode,
  type PageSceneAdapter,
  type Editor,
  type MediaInfo,
  MediaFileType,
  MediaFileClass,
  AssetType,
  FilterEngineCategories,
  WeightCategory,
  WeightType,
  usePageSceneStore,
} from "@storyteller/ui-pagescene";
import type { PageDrawAdapter } from "@storyteller/ui-pagedraw";
import {
  assetUrl,
  importAsset,
  listAssets,
  listProjects,
  loadProject,
  readAsset,
  validateGlb,
  localAssetId,
  errorText,
  type Asset,
} from "./bridge";
import { parseDocument, type Project } from "./projectDocuments";

const unsupported = async (): Promise<never> => {
  throw new Error(
    "Esta ação não está disponível localmente. Use o painel Codex para conversar ou gerar imagens.",
  );
};

export const localDrawAdapter: PageDrawAdapter = {
  enqueueEditImage: unsupported,
  enqueueInpaint: unsupported,
  enqueueBgRemoval: unsupported,
  renderBaseImageSelector: () => (
    <p className="desk-empty">
      Escolha uma imagem local ou crie uma tela em branco.
    </p>
  ),
};
export function createSceneAdapter({
  project,
  save,
  onError,
  onAssetImported,
}: {
  project: Project;
  save(document: unknown): Promise<void>;
  onError(message: string): void;
  onAssetImported(asset: Asset): void;
}): PageSceneAdapter {
  const ownedUrls = new Map<string, string>();
  const mediaUrl = async (id: string) => {
    const localId = localAssetId(id);
    const asset = (await listAssets()).find((asset) => asset.id === localId);
    if (!asset || asset.mimeType !== "model/gltf-binary")
      throw new Error("O recurso GLB local não foi encontrado.");
    const url = assetUrl(asset);
    ownedUrls.set(url, asset.id);
    return url;
  };
  return {
    enqueueGeneration: unsupported,
    async saveScene({ saveJson }) {
      await save({ version: 1, kind: "scene", scene: JSON.parse(saveJson) });
      return project.id;
    },
    async loadScene(id) {
      const p = await loadProject(id);
      if (p.document.kind !== "scene") throw new Error("Cena inválida.");
      return p.document.scene;
    },
    async fetchAsset(url, init) {
      const id = ownedUrls.get(url);
      if (!id)
        throw new Error("Pedidos de recursos externos não são permitidos.");
      if (init?.signal?.aborted)
        throw new DOMException("Operação cancelada.", "AbortError");
      const { dataUrl } = await readAsset(id);
      const response = await fetch(dataUrl, { signal: init?.signal });
      const buffer = await response.arrayBuffer();
      validateGlb(buffer);
      return new Response(buffer, {
        headers: { "Content-Type": "model/gltf-binary" },
      });
    },
    getCdnOrigin: () => "",
    getApiSchemeAndHost: () => "",
    getCurrentUserToken: () => "creative-desk-local-owner",
    getCdnUrl: (path) => {
      if (!ownedUrls.has(path))
        throw new Error("Recurso externo não permitido.");
      return path;
    },
    async listUserMediaFiles() {
      return {
        success: true,
        data: (await listAssets())
          .filter((a) => a.mimeType === "model/gltf-binary")
          .map(mediaInfo),
      };
    },
    async listFeaturedMediaFiles() {
      return { success: true, data: [] };
    },
    async listUserSceneProjects() {
      return {
        success: true,
        data: (await listProjects()).projects
          .filter((p) => p.kind === "scene")
          .map((p) => ({
            token: p.id,
            maybe_title: p.name,
            updated_at: p.updatedAt,
          })),
      };
    },
    showToast: (_level, message) => onError(message),
    getMediaUrlByToken: mediaUrl,
    renderAssetBrowser: () => (
      <p>Os recursos locais estão na coluna esquerda.</p>
    ),
    renderSceneLoader: () => <p>Escolha um projeto na coluna esquerda.</p>,
    renderAssetUploader: (props) =>
      props.isOpen ? (
        <label>
          Importar GLB
          <input
            type="file"
            accept=".glb"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try {
                await importAsset(file);
                props.onSuccess(FilterEngineCategories.OBJECT);
                props.onClose();
              } catch (error) {
                onError(errorText(error));
              }
            }}
          />
        </label>
      ) : null,
    renderImageUploader: () => null,
    renderSplatUploader: () => null,
    uploadImage: unsupported,
    uploadPlaneFromMediaToken: unsupported,
    navigateToImageTo3D: () =>
      onError("A geração de modelos 3D não está disponível localmente."),
    async uploadMedia({ blob, fileName }) {
      const asset = await importAsset(
        new File([blob], fileName, { type: blob.type }),
      );
      return asset.id;
    },
    openMediaLightbox: async (id) =>
      onAssetImported((await readAsset(id)).asset),
    performLogout: () => onError("Esta aplicação usa apenas projetos locais."),
    onError: ({ message }) => onError(message),
  };
}
export function serializeSceneDocument(editor: Editor) {
  if (!editor.isEngineDataLoaded())
    throw new Error("A cena ainda está a abrir.");
  const metadata = {
    positivePrompt: editor.positive_prompt,
    cameraAspectRatio: usePageSceneStore.getState().cameraAspectRatio,
  };
  // Persist the live engine, including camera transforms and timeline controller.
  return parseDocument(
    JSON.parse(
      JSON.stringify({
        version: 1,
        kind: "scene",
        scene: editor.save_manager.getSceneJson({
          sceneGenerationMetadata: metadata,
        }),
      }),
    ),
  );
}
export function SceneLocalTools({
  onError,
}: {
  onError(message: string): void;
}) {
  const editor = useContext(EngineContext);
  const primitive = async (key: string, name: string) => {
    if (!editor) return;
    try {
      await addShape(editor, {
        version: 1,
        type: AssetType.SHAPE,
        media_id: key,
        name,
      });
    } catch (error) {
      onError(errorText(error));
    }
  };
  return (
    <div className="desk-scene-tools">
      <button
        onClick={() => {
          const state = usePageSceneStore.getState();
          state.setOutlinerShowing(!state.outlinerShowing);
        }}
      >
        Lista
      </button>
      <button
        data-testid="add-cube"
        disabled={!editor}
        onClick={() => primitive("Box", "Cubo")}
      >
        + Cubo
      </button>
      <button disabled={!editor} onClick={() => primitive("Sphere", "Esfera")}>
        + Esfera
      </button>
      <button
        disabled={!editor}
        onClick={() => primitive("Cylinder", "Cilindro")}
      >
        + Cilindro
      </button>
      {(["move", "rotate", "scale"] as const).map((mode, index) => (
        <button
          key={mode}
          disabled={!editor}
          onClick={() => editor && setTransformMode(editor, mode)}
        >
          {["Mover", "Rodar", "Escala"][index]}
        </button>
      ))}
    </div>
  );
}
function mediaInfo(asset: Asset): MediaInfo {
  return {
    token: asset.id,
    media_type: MediaFileType.GLB,
    media_class: MediaFileClass.Prop,
    maybe_animation_type: null,
    maybe_engine_extension: "glb",
    maybe_batch_token: "",
    maybe_original_filename: asset.name,
    maybe_creator_user: null,
    maybe_prompt_token: null,
    origin: {
      origin_category: "local",
      product_category: "local",
      maybe_model: null,
    },
    origin_category: "local",
    origin_product_category: "local",
    maybe_origin_model_type: null,
    maybe_origin_model_token: null,
    maybe_duration_millis: null,
    maybe_style_name: null,
    public_bucket_path: asset.path,
    cover_image: {
      maybe_cover_image_public_bucket_path: null,
      default_cover: { image_index: 0, color_index: 0 },
    },
    creator_set_visibility: "private",
    maybe_title: asset.name,
    maybe_text_transcript: null,
    stats: { positive_rating_count: 0, bookmark_count: 0 },
    maybe_model_weight_info: {
      title: "",
      weight_token: "",
      weight_category: WeightCategory.SD,
      weight_type: WeightType.NONE,
      maybe_weight_creator: {
        user_token: "creative-desk-local-owner",
        username: "local",
        display_name: "Local",
        gravatar_hash: "",
        default_avatar: { image_index: 0, color_index: 0 },
      },
      maybe_cover_image_public_bucket_path: "",
    },
    created_at: "",
    updated_at: "",
  };
}
