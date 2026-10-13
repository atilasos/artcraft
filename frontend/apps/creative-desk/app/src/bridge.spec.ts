import { describe, expect, it } from "vitest";
import {
  engineAssetToken,
  localAssetId,
  fileMime,
  newId,
  parseAsset,
  validateGlb,
} from "./bridge";

const ID = "6a547ea4-8c2e-4ccd-91bd-86f62ca2e16f";
describe("local asset boundary", () => {
  it("accepts owned asset metadata and rejects remote/traversal paths", () => {
    const asset = {
      id: ID,
      name: "Imagem",
      mimeType: "image/png",
      path: `/Users/test/CreativeDesk/assets/${ID}/data.png`,
    };
    expect(parseAsset(asset)).toEqual(asset);
    expect(() =>
      parseAsset({ ...asset, path: "https://host/image.png" }),
    ).toThrow();
    expect(() =>
      parseAsset({ ...asset, path: "/Users/test/../outside" }),
    ).toThrow();
  });
  it("recognizes native import formats and gives a visible unsupported-format error", () => {
    expect(fileMime(new File([""], "model.glb"))).toBe("model/gltf-binary");
    expect(fileMime(new File([""], "sound.m4a"))).toBe("audio/mp4");
    expect(() => fileMime(new File([""], "model.fbx"))).toThrow(
      "Formato não suportado",
    );
  });
  it("creates UUIDs with the WebKit-compatible getRandomValues path", () =>
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ));
  it("rejects GLB references that would escape the local resource adapter", () => {
    expect(() =>
      validateGlb(
        glb({ asset: { version: "2.0" }, buffers: [{ byteLength: 0 }] }),
      ),
    ).not.toThrow();
    expect(() =>
      validateGlb(
        glb({
          asset: { version: "2.0" },
          images: [{ uri: "https://host/texture.png" }],
        }),
      ),
    ).toThrow("Recursos externos");
    expect(() =>
      validateGlb(
        glb({
          asset: { version: "2.0" },
          buffers: [{ uri: "../outside.bin" }],
        }),
      ),
    ).toThrow("Recursos externos");
  });
});
it("roundtrips owned UUIDs through the legacy editor media-token format", () => {
  expect(engineAssetToken(ID)).toBe(`m_${ID}`);
  expect(localAssetId(engineAssetToken(ID))).toBe(ID);
  expect(() => localAssetId("m_../../outside")).toThrow();
  expect(() => localAssetId("https://host/model.glb")).toThrow();
});

function glb(json: unknown): ArrayBuffer {
  const text = JSON.stringify(json),
    length = Math.ceil(text.length / 4) * 4;
  const buffer = new ArrayBuffer(20 + length),
    view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).set(
    new TextEncoder().encode(text.padEnd(length, " ")),
  );
  return buffer;
}
