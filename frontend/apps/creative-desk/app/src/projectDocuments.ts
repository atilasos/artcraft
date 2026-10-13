import {
  Node,
  type NodeProps,
} from "../../../../libs/components/pagedraw/src/lib/Node";
import {
  AspectRatioType,
  useSceneStore,
  type LineNode,
} from "../../../../libs/components/pagedraw/src/lib/stores/SceneState";
import type { BaseSelectorImage } from "../../../../libs/components/pagedraw/src/lib/types";
import type { Model3DParams } from "../../../../libs/components/pagedraw/src/lib/utilities/render3DModel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE_TYPES = ["rectangle", "circle", "triangle", "image"];
let restoreTicket = 0;

export type CanvasDocument = {
  version: 1;
  kind: "canvas";
  baseImageInfo: BaseSelectorImage | null;
  scene: Record<string, unknown>;
};
export type SceneDocument = {
  version: 1;
  kind: "scene";
  scene: Record<string, unknown> | null;
};
export type ProjectDocument = CanvasDocument | SceneDocument;
export type Project = {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: "canvas" | "scene";
  document: ProjectDocument;
  updatedAt: string;
};

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Dados inválidos.");
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Texto inválido.");
  return value;
}
export function uuid(value: unknown): string {
  const id = string(value);
  if (!UUID.test(id)) throw new Error("Identificador local inválido.");
  return id;
}
export function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Número inválido.");
  return value;
}
function localUrl(value: unknown): string {
  const url = string(value);
  if (
    !/^data:(image\/(png|jpeg|webp|gif)|model\/gltf-binary);base64,[a-zA-Z0-9+/=\s]+$/.test(
      url,
    )
  )
    throw new Error("O documento requer um recurso incorporado local.");
  return url;
}
function localJson(value: unknown, depth = 0): void {
  if (depth > 60) throw new Error("Documento demasiado complexo.");
  if (typeof value === "string" && /^(https?:|file:|blob:|\/\/)/i.test(value))
    throw new Error("Recursos externos não são suportados.");
  if (typeof value === "number") finite(value);
  if (Array.isArray(value))
    value.forEach((child) => localJson(child, depth + 1));
  else if (value && typeof value === "object")
    Object.values(record(value)).forEach((child) =>
      localJson(child, depth + 1),
    );
  else if (
    value !== null &&
    !["string", "number", "boolean"].includes(typeof value)
  )
    throw new Error("JSON inválido.");
}
function vector(value: unknown) {
  const v = record(value);
  return { x: finite(v.x), y: finite(v.y), z: finite(v.z) };
}
function modelParams(value: unknown): Model3DParams | undefined {
  if (value === undefined) return undefined;
  const p = record(value);
  return {
    cameraPosition: vector(p.cameraPosition),
    cameraTarget: vector(p.cameraTarget),
    fov: finite(p.fov),
    modelScale: finite(p.modelScale),
    nativeWidth: finite(p.nativeWidth),
    nativeHeight: finite(p.nativeHeight),
  };
}
function parseBase(value: unknown): BaseSelectorImage | null {
  if (value === null) return null;
  const base = record(value);
  if (base.isBlankCanvas === true) {
    const width = finite(base.blankCanvasWidth),
      height = finite(base.blankCanvasHeight);
    if (width < 1 || height < 1 || width > 8192 || height > 8192)
      throw new Error("Dimensões da tela inválidas.");
    return {
      url: "",
      mediaToken: string(base.mediaToken),
      isBlankCanvas: true,
      blankCanvasWidth: width,
      blankCanvasHeight: height,
    };
  }
  return { url: localUrl(base.url), mediaToken: uuid(base.mediaToken) };
}
function parseNode(value: unknown): NodeProps | LineNode {
  const n = record(value);
  const id = string(n.id),
    type = string(n.type);
  if (type === "line") {
    if (!Array.isArray(n.points) || n.points.length % 2)
      throw new Error("Traço inválido.");
    n.points.forEach(finite);
    string(n.stroke);
    finite(n.strokeWidth);
    if (typeof n.draggable !== "boolean") throw new Error("Traço inválido.");
    for (const key of [
      "x",
      "y",
      "rotation",
      "scaleX",
      "scaleY",
      "offsetX",
      "offsetY",
      "opacity",
    ])
      if (n[key] !== undefined) finite(n[key]);
    return n as LineNode;
  }
  if (!NODE_TYPES.includes(type)) throw new Error("Forma não suportada.");
  const props: NodeProps = {
    id,
    type: type as NodeProps["type"],
    x: finite(n.x),
    y: finite(n.y),
    width: finite(n.width),
    height: finite(n.height),
    fill: string(n.fill),
  };
  for (const key of [
    "rotation",
    "scaleX",
    "scaleY",
    "offsetX",
    "offsetY",
    "strokeWidth",
    "zIndex",
  ] as const)
    if (n[key] !== undefined) props[key] = finite(n[key]);
  for (const key of ["stroke", "backgroundColor"] as const)
    if (n[key] !== undefined) props[key] = string(n[key]);
  for (const key of ["locked", "draggable"] as const)
    if (n[key] !== undefined) {
      if (typeof n[key] !== "boolean") throw new Error("Forma inválida.");
      props[key] = n[key];
    }
  if (n.imageDataUrl !== undefined || n.imageUrl !== undefined)
    props.imageUrl = localUrl(n.imageDataUrl ?? n.imageUrl);
  if (n.modelUrl !== undefined) props.modelUrl = localUrl(n.modelUrl);
  props.model3dParams = modelParams(n.model3dParams);
  return props;
}
export function parseDocument(value: unknown): ProjectDocument {
  localJson(value);
  const doc = record(value);
  if (doc.version !== 1) throw new Error("Versão de documento não suportada.");
  if (doc.kind === "canvas") {
    const scene = record(doc.scene);
    if (
      scene.version !== "2.0" ||
      !Array.isArray(scene.drawNodes) ||
      !Array.isArray(scene.inpaintLineNodes)
    )
      throw new Error("Tela inválida.");
    scene.drawNodes.forEach(parseNode);
    scene.inpaintLineNodes.forEach((n) => {
      if (parseNode(n).type !== "line") throw new Error("Máscara inválida.");
    });
    string(scene.fillColor);
    for (const key of ["brushSize", "eraserSize"])
      if (scene[key] !== undefined) finite(scene[key]);
    if (scene.brushColor !== undefined) string(scene.brushColor);
    if (
      scene.aspectRatioType !== undefined &&
      !Object.values(AspectRatioType).includes(
        scene.aspectRatioType as AspectRatioType,
      )
    )
      throw new Error("Proporção inválida.");
    return {
      version: 1,
      kind: "canvas",
      baseImageInfo: parseBase(doc.baseImageInfo),
      scene,
    };
  }
  if (doc.kind === "scene") {
    if (doc.scene === null) return { version: 1, kind: "scene", scene: null };
    const scene = record(doc.scene);
    if (
      typeof scene.version !== "number" ||
      !Array.isArray(scene.scene) ||
      !Array.isArray(scene.cameras)
    )
      throw new Error("Cena inválida.");
    scene.cameras.forEach((item) => {
      const camera = record(item);
      string(camera.id);
      string(camera.label);
      finite(camera.focalLength);
      vector(camera.position);
      vector(camera.rotation);
      vector(camera.lookAt);
    });
    scene.scene.forEach((item) => {
      const object = record(item);
      const data = object.user_data ? record(object.user_data) : {};
      const token = string(object.media_file_token);
      if (token !== "Parim" && token !== "DirectionalLight")
        uuid(token.startsWith("m_") ? token.slice(2) : token);
      uuid(object.object_uuid);
      string(object.object_name);
      if (
        token === "Parim" &&
        !["Box", "Cone", "Cylinder", "Sphere", "Donut", "PointLight"].includes(
          string(data.shapeKey ?? object.object_name),
        )
      )
        throw new Error("Forma local não suportada.");
      vector(object.position);
      vector(object.rotation);
      vector(object.scale);
      if (object.object_name === "Water" || data.shapeKey === "Water")
        throw new Error("Água requer recursos externos e não está disponível.");
    });
    if (scene.timeline !== undefined && scene.timeline !== null) {
      const timeline = record(scene.timeline);
      finite(timeline.duration);
      finite(timeline.fps);
      if (!Array.isArray(timeline.tracks) || !Array.isArray(timeline.clipLanes))
        throw new Error("Animação inválida.");
      timeline.tracks.forEach((value) => {
        const track = record(value);
        uuid(track.objectUuid);
        if (!Array.isArray(track.keyframes))
          throw new Error("Animação inválida.");
        track.keyframes.forEach((value) => {
          const keyframe = record(value),
            transform = record(keyframe.transform),
            easing = record(keyframe.easing);
          string(keyframe.id);
          finite(keyframe.time);
          vector(transform.position);
          vector(transform.rotation);
          vector(transform.scale);
          for (const key of ["p1x", "p1y", "p2x", "p2y"]) finite(easing[key]);
        });
      });
      timeline.clipLanes.forEach((value) => {
        const lane = record(value),
          strip = record(lane.strip);
        string(lane.id);
        uuid(lane.objectUuid);
        string(strip.id);
        string(strip.name);
        const source = string(strip.sourceMediaId);
        if (source) uuid(source.startsWith("m_") ? source.slice(2) : source);
        finite(strip.startTime);
        finite(strip.duration);
      });
    }
    return { version: 1, kind: "scene", scene };
  }
  throw new Error("Tipo de documento não suportado.");
}
export function parseProject(value: unknown): Project {
  const p = record(value);
  if (p.schemaVersion !== 1 || (p.kind !== "canvas" && p.kind !== "scene"))
    throw new Error("Versão ou tipo de projeto não suportado.");
  const updatedAt = string(p.updatedAt);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/.test(
      updatedAt,
    ) ||
    Number.isNaN(Date.parse(updatedAt))
  )
    throw new Error("Data inválida.");
  const name = string(p.name).trim();
  if (!name || name.length > 200) throw new Error("Nome inválido.");
  const document = parseDocument(p.document);
  if (document.kind !== p.kind)
    throw new Error("Tipo de documento incompatível.");
  return {
    schemaVersion: 1,
    id: uuid(p.id),
    name,
    kind: p.kind,
    document,
    updatedAt,
  };
}
export function blankCanvasDocument(): CanvasDocument {
  return {
    version: 1,
    kind: "canvas",
    baseImageInfo: {
      url: "",
      mediaToken: "blank",
      isBlankCanvas: true,
      blankCanvasWidth: 1024,
      blankCanvasHeight: 768,
    },
    scene: {
      version: "2.0",
      drawNodes: [],
      inpaintLineNodes: [],
      fillColor: "#faf9f6",
    },
  };
}
export async function serializeCanvasDocument(): Promise<CanvasDocument> {
  const state = useSceneStore.getState();
  const baseImageInfo = state.baseImageInfo ? { ...state.baseImageInfo } : null;
  // The upstream export omits model editing parameters. Capture them alongside
  // the same synchronous state snapshot before its file encoding awaits.
  const modelData = state.drawNodes.map((node) =>
    node instanceof Node
      ? { modelUrl: node.modelUrl, model3dParams: node.model3dParams }
      : {},
  );
  const scene = record(JSON.parse(await state.exportSceneAsJson()));
  if (!Array.isArray(scene.drawNodes)) throw new Error("Tela inválida.");
  scene.drawNodes = scene.drawNodes.map((node, index) => ({
    ...record(node),
    ...modelData[index],
  }));
  const document = parseDocument(
    JSON.parse(
      JSON.stringify({ version: 1, kind: "canvas", baseImageInfo, scene }),
    ),
  );
  if (document.kind !== "canvas") throw new Error("Tela inválida.");
  return document;
}
export function cancelCanvasRestore(): void {
  restoreTicket++;
  useSceneStore.getState().setBaseImageInfo(null);
}
export async function restoreCanvasDocument(value: unknown): Promise<void> {
  const doc = parseDocument(value);
  if (doc.kind !== "canvas") throw new Error("Tela inválida.");
  const ticket = ++restoreTicket;
  useSceneStore.getState().setBaseImageInfo(null); // invalidates upstream image onload
  useSceneStore.getState().RESET();
  const base = doc.baseImageInfo;
  if (base && !base.isBlankCanvas) {
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = useSceneStore.subscribe((state) => {
        if (ticket !== restoreTicket) {
          unsubscribe();
          resolve();
        } else if (state.baseImageBitmap) {
          unsubscribe();
          resolve();
        } else if (!state.baseImageInfo) {
          unsubscribe();
          reject(new Error("Não foi possível abrir a imagem base."));
        }
      });
      useSceneStore.getState().setBaseImageInfo(base);
    });
  } else useSceneStore.getState().setBaseImageInfo(base);
  if (ticket !== restoreTicket) return;
  const rawNodes = doc.scene.drawNodes;
  if (!Array.isArray(rawNodes)) throw new Error("Tela inválida.");
  const nodes = await Promise.all(
    rawNodes.map(async (value) => {
      const props = parseNode(value);
      if (props.type === "line") return props;
      const node = new Node(props);
      if (node.imageUrl) await node.setImageFromUrl(node.imageUrl);
      return node;
    }),
  );
  if (ticket !== restoreTicket) return;
  // Hydrate all nodes together only after the base bitmap and node images.
  const masks = doc.scene.inpaintLineNodes;
  useSceneStore.setState({
    drawNodes: nodes,
    inpaintLineNodes: Array.isArray(masks)
      ? masks.map((n) => parseNode(n) as LineNode)
      : [],
    fillColor: string(doc.scene.fillColor),
    brushColor: doc.scene.brushColor ? string(doc.scene.brushColor) : "#000000",
    brushSize: doc.scene.brushSize ? finite(doc.scene.brushSize) : 5,
    eraserSize: doc.scene.eraserSize ? finite(doc.scene.eraserSize) : 16,
    aspectRatioType:
      (doc.scene.aspectRatioType as AspectRatioType | undefined) ??
      AspectRatioType.NONE,
  });
  useSceneStore.getState().saveState();
}
