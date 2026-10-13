import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import {
  parseProject,
  record,
  string,
  uuid,
  type Project,
} from "./projectDocuments";

const LOCAL_COMMANDS = new Set([
  "local_workspace_info",
  "local_list_projects",
  "local_save_project",
  "local_load_project",
  "local_import_asset",
  "local_list_assets",
  "local_read_asset",
  "codex_status",
  "codex_models",
  "codex_send",
]);
const MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "model/gltf-binary",
]);

export type Asset = {
  id: string;
  name: string;
  mimeType: string;
  path: string;
};
export type CodexModel = {
  id: string;
  displayName: string;
  isDefault: boolean;
  efforts: string[];
};
export type TestTransport = {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  fileSrc?(path: string): string;
};
declare global {
  interface Window {
    __CREATIVE_DESK_TEST_IPC__?: TestTransport;
    __CREATIVE_DESK_EDITOR__?: {
      canvasState(): unknown;
      addRectangle(): void;
      sceneState(): unknown;
      sceneJson(): unknown;
      addCube(): Promise<void>;
    };
  }
}

export function testTransport(): TestTransport | undefined {
  return import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("creativeDeskTest") ===
      "1" &&
    !("__TAURI_INTERNALS__" in window)
    ? window.__CREATIVE_DESK_TEST_IPC__
    : undefined;
}
async function command(
  name: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  if (!LOCAL_COMMANDS.has(name)) throw new Error("Ação externa não permitida.");
  const injected = testTransport();
  return injected ? injected.invoke(name, args) : invoke<unknown>(name, args);
}
export function parseAsset(value: unknown): Asset {
  const asset = record(value),
    path = string(asset.path),
    mimeType = string(asset.mimeType);
  if (
    !path.startsWith("/") ||
    path.split("/").includes("..") ||
    !MIME_TYPES.has(mimeType)
  )
    throw new Error("Recurso local inválido.");
  return { id: uuid(asset.id), name: string(asset.name), path, mimeType };
}
function assets(value: unknown): Asset[] {
  if (!Array.isArray(value)) throw new Error("Lista de recursos inválida.");
  return value.map(parseAsset);
}
export function assetUrl(asset: Asset): string {
  const injected = testTransport();
  return injected?.fileSrc
    ? injected.fileSrc(asset.path)
    : convertFileSrc(asset.path);
}
export async function workspaceInfo() {
  const result = record(await command("local_workspace_info"));
  if (result.applicationId !== "local.creative.desk")
    throw new Error("Aplicação local incompatível.");
  return {
    rootPath: string(result.rootPath),
    applicationId: result.applicationId,
  };
}
export async function listProjects() {
  const result = record(await command("local_list_projects"));
  if (!Array.isArray(result.projects) || !Array.isArray(result.warnings))
    throw new Error("Lista de projetos inválida.");
  const warnings = result.warnings.map(string),
    projects: Project[] = [];
  for (const value of result.projects) {
    try {
      projects.push(parseProject(value));
    } catch (error) {
      warnings.push(errorText(error));
    }
  }
  return { projects, warnings };
}
export async function saveProject(project: Project): Promise<Project> {
  return parseProject(
    await command("local_save_project", { project: parseProject(project) }),
  );
}
export async function loadProject(id: string): Promise<Project> {
  return parseProject(await command("local_load_project", { id: uuid(id) }));
}
export async function listAssets(): Promise<Asset[]> {
  return assets(await command("local_list_assets"));
}
export async function readAsset(id: string) {
  const result = record(await command("local_read_asset", { id: uuid(id) })),
    asset = parseAsset(result.asset),
    dataUrl = string(result.dataUrl);
  if (asset.id !== id || !dataUrl.startsWith(`data:${asset.mimeType};base64,`))
    throw new Error("Conteúdo do recurso inválido.");
  return { asset, dataUrl };
}
export async function codexStatus() {
  const status = record(await command("codex_status"));
  if (typeof status.connected !== "boolean")
    throw new Error("Estado Codex inválido.");
  return {
    connected: status.connected,
    authMode: string(status.authMode),
    message: string(status.message),
  };
}
export async function codexModels(): Promise<CodexModel[]> {
  const value = await command("codex_models");
  if (!Array.isArray(value)) throw new Error("Catálogo Codex inválido.");
  return value.map((value) => {
    const model = record(value);
    if (typeof model.isDefault !== "boolean" || !Array.isArray(model.efforts))
      throw new Error("Modelo Codex inválido.");
    return {
      id: string(model.id),
      displayName: string(model.displayName),
      isDefault: model.isDefault,
      efforts: model.efforts.map(string),
    };
  });
}
export async function codexSend(args: {
  projectId: string;
  prompt: string;
  kind: "assistant" | "image";
  assetIds: string[];
  maybeModel: string;
}) {
  uuid(args.projectId);
  args.assetIds.forEach(uuid);
  const result = record(await command("codex_send", args));
  return {
    message: string(result.message),
    threadId: string(result.threadId),
    assets: assets(result.assets),
  };
}
export function fileMime(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const byExtension: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    glb: "model/gltf-binary",
  };
  const mime = extension ? byExtension[extension] : undefined;
  if (!mime || !MIME_TYPES.has(mime))
    throw new Error(
      "Formato não suportado. Importe PNG, JPEG, WebP, GIF, MP3, WAV, OGG, M4A, MP4, WebM, MOV ou GLB.",
    );
  return mime;
}
export async function importAsset(file: File): Promise<Asset> {
  const mimeType = fileMime(file);
  if (file.size > 100 * 1024 * 1024)
    throw new Error("O ficheiro excede 100 MB.");
  if (mimeType === "model/gltf-binary") validateGlb(await file.arrayBuffer());
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Não foi possível ler o ficheiro."));
    reader.onerror = () =>
      reject(new Error("Não foi possível ler o ficheiro."));
    reader.readAsDataURL(file);
  });
  return parseAsset(
    await command("local_import_asset", {
      name: file.name,
      mimeType,
      bytesBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    }),
  );
}
export function validateGlb(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 20) throw new Error("GLB inválido.");
  const view = new DataView(buffer);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== buffer.byteLength ||
    view.getUint32(16, true) !== 0x4e4f534a
  )
    throw new Error("GLB inválido.");
  const length = view.getUint32(12, true);
  if (length > buffer.byteLength - 20) throw new Error("GLB inválido.");
  const gltf = record(
    JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length))),
  );
  for (const key of ["buffers", "images"]) {
    if (gltf[key] === undefined) continue;
    if (!Array.isArray(gltf[key])) throw new Error("GLB inválido.");
    for (const value of gltf[key]) {
      const uri = record(value).uri;
      if (uri !== undefined && !/^data:[^,]+;base64,/.test(string(uri)))
        throw new Error(
          "O GLB deve incorporar todas as imagens e buffers. Recursos externos não são suportados.",
        );
    }
  }
}
export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Não foi possível concluir a operação.";
}
export function newId(): string {
  // randomUUID is absent on some Tauri custom-protocol WebKit contexts.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function engineAssetToken(id: string): string {
  return `m_${uuid(id)}`;
}
export function localAssetId(token: string): string {
  return uuid(token.startsWith("m_") ? token.slice(2) : token);
}
