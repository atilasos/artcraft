import { beforeEach, describe, expect, it, vi } from "vitest";
import { Node } from "../../../../libs/components/pagedraw/src/lib/Node";
import { useSceneStore } from "../../../../libs/components/pagedraw/src/lib/stores/SceneState";
import {
  cancelCanvasRestore,
  jsonValuesEqual,
  parseProject,
  restoreCanvasDocument,
  serializeCanvasDocument,
} from "./projectDocuments";

const project = {
  schemaVersion: 1,
  id: "6a547ea4-8c2e-4ccd-91bd-86f62ca2e16f",
  name: "Estudo",
  kind: "canvas",
  updatedAt: "2026-10-13T10:00:00Z",
  document: {
    version: 1,
    kind: "canvas",
    baseImageInfo: null,
    scene: {
      version: "2.0",
      drawNodes: [],
      inpaintLineNodes: [],
      fillColor: "#ffffff",
    },
  },
};
beforeEach(() => useSceneStore.getState().RESET());
describe("project boundary", () => {
  it("accepts a versioned local project", () =>
    expect(parseProject(project).name).toBe("Estudo"));
  it("accepts the UTC RFC3339 offset returned by native Rust persistence", () =>
    expect(
      parseProject({
        ...project,
        updatedAt: "2026-10-13T10:00:00.123456789+00:00",
      }).name,
    ).toBe("Estudo"));
  it.each([
    { schemaVersion: 2 },
    { id: "../../outside" },
    { updatedAt: "yesterday" },
    { document: {} },
    {
      document: {
        ...project.document,
        baseImageInfo: { url: "https://outside/image.png", mediaToken: "x" },
      },
    },
  ])("rejects unsafe or unsupported data %o", (override) =>
    expect(() => parseProject({ ...project, ...override })).toThrow(),
  );
});
describe("canvas roundtrip", () => {
  it("restores blank dimensions, background, node geometry and 3D editing parameters", async () => {
    const store = useSceneStore.getState();
    store.setBaseImageInfo({
      url: "",
      mediaToken: "blank",
      isBlankCanvas: true,
      blankCanvasWidth: 640,
      blankCanvasHeight: 480,
    });
    store.setFillColor("#e7d8b8");
    const params = {
      cameraPosition: { x: 1, y: 2, z: 3 },
      cameraTarget: { x: 0, y: 0, z: 0 },
      fov: 50,
      modelScale: 1,
      nativeWidth: 512,
      nativeHeight: 512,
    };
    store.addNode(
      new Node({
        id: "shape",
        x: 17,
        y: 29,
        width: 120,
        height: 90,
        fill: "#333333",
        type: "rectangle",
        modelUrl: "data:model/gltf-binary;base64,AA==",
        model3dParams: params,
      }),
    );
    const document = await serializeCanvasDocument();
    store.RESET();
    await restoreCanvasDocument(document);
    const restored = useSceneStore.getState();
    expect(restored.baseImageInfo?.blankCanvasWidth).toBe(640);
    expect(restored.fillColor).toBe("#e7d8b8");
    expect(restored.drawNodes[0]).toMatchObject({
      x: 17,
      y: 29,
      model3dParams: params,
    });
    expect(restored.drawNodes[0]).toBeInstanceOf(Node);
  });
});

describe("asynchronous canvas restore", () => {
  it("waits for base bitmap before restoring nodes and ignores a superseded load", async () => {
    const images: HTMLImageElement[] = [];
    vi.stubGlobal("Image", function () {
      const image = document.createElement("img");
      images.push(image);
      return image;
    });
    try {
      const a = {
        ...project.document,
        baseImageInfo: {
          url: "data:image/png;base64,AA==",
          mediaToken: project.id,
        },
        scene: {
          ...project.document.scene,
          drawNodes: [
            {
              id: "a",
              type: "rectangle",
              x: 17,
              y: 29,
              width: 90,
              height: 80,
              fill: "#fff",
            },
          ],
        },
      };
      const first = restoreCanvasDocument(a);
      expect(useSceneStore.getState().drawNodes).toHaveLength(0);
      images[0].onload?.call(images[0], new Event("load"));
      await first;
      expect(useSceneStore.getState().drawNodes[0].x).toBe(17);
      const late = restoreCanvasDocument(a);
      const b = {
        ...a,
        baseImageInfo: {
          url: "",
          mediaToken: "blank",
          isBlankCanvas: true,
          blankCanvasWidth: 320,
          blankCanvasHeight: 240,
        },
        scene: { ...a.scene, drawNodes: [] },
      };
      await restoreCanvasDocument(b);
      images[1].onload?.call(images[1], new Event("load"));
      await late;
      expect(useSceneStore.getState().baseImageInfo?.blankCanvasWidth).toBe(
        320,
      );
      expect(useSceneStore.getState().drawNodes).toHaveLength(0);
    } finally {
      cancelCanvasRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("scene document boundary", () => {
  const origin = { x: 0, y: 0, z: 0 };
  const sceneProject = {
    ...project,
    kind: "scene",
    document: {
      version: 1,
      kind: "scene",
      scene: {
        version: 2,
        scene: [
          {
            object_uuid: project.id,
            object_name: "Cubo",
            media_file_token: "Parim",
            position: origin,
            rotation: origin,
            scale: { x: 1, y: 1, z: 1 },
            user_data: { shapeKey: "Box" },
          },
        ],
        cameras: [
          {
            id: "main",
            label: "Principal",
            focalLength: 35,
            position: origin,
            rotation: origin,
            lookAt: origin,
          },
        ],
        timeline: { duration: 10, fps: 30, tracks: [], clipLanes: [] },
      },
    },
  };
  it("accepts actual engine primitives, cameras and an empty timeline", () =>
    expect(parseProject(sceneProject).kind).toBe("scene"));
  it("rejects a scene with malformed camera or timeline data before mounting the engine", () => {
    expect(() =>
      parseProject({
        ...sceneProject,
        document: {
          ...sceneProject.document,
          scene: { ...sceneProject.document.scene, cameras: [{}] },
        },
      }),
    ).toThrow();
    expect(() =>
      parseProject({
        ...sceneProject,
        document: {
          ...sceneProject.document,
          scene: {
            ...sceneProject.document.scene,
            timeline: { tracks: ["invalid"] },
          },
        },
      }),
    ).toThrow();
  });
});

describe("JSON document equality", () => {
  it("ignores nested object property ordering returned by native storage", () => {
    const live = {
      version: 1,
      scene: { drawNodes: [{ id: "a", x: 17, y: 29 }], fillColor: "#fff" },
    };
    const native = {
      scene: { fillColor: "#fff", drawNodes: [{ y: 29, x: 17, id: "a" }] },
      version: 1,
    };
    expect(jsonValuesEqual(live, native)).toBe(true);
  });
  it("keeps actual values, value types and missing properties significant", () => {
    expect(jsonValuesEqual({ x: 0.45000000000000007 }, { x: 0.45 })).toBe(
      false,
    );
    expect(jsonValuesEqual({ x: 17 }, { x: 83 })).toBe(false);
    expect(jsonValuesEqual({ x: 17 }, { x: "17" })).toBe(false);
    expect(jsonValuesEqual({ x: null }, {})).toBe(false);
  });
  it("preserves array order, length and array versus object distinctions", () => {
    expect(
      jsonValuesEqual([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "a" }]),
    ).toBe(false);
    expect(jsonValuesEqual([1], [1, 2])).toBe(false);
    expect(jsonValuesEqual([], {})).toBe(false);
  });
});
