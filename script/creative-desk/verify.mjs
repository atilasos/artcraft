import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(root, "frontend/package.json"));
const { chromium } = require("@playwright/test");
const origin = process.env.CREATIVE_DESK_TEST_URL || "http://127.0.0.1:1421";
assert.equal(
  new URL(origin).hostname,
  "127.0.0.1",
  "Only the local dev server is allowed",
);
const fixtures = await fs.mkdtemp(
  path.join(os.tmpdir(), "creative-desk-verify-"),
);
const imagePath = process.env.CREATIVE_DESK_TEST_IMAGE;
const png = imagePath
  ? await fs.readFile(imagePath)
  : Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=",
      "base64",
    );
const glb = makeGlb();
execFileSync("/usr/local/bin/ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=1.5",
  path.join(fixtures, "tone.wav"),
]);
execFileSync("/usr/local/bin/ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=64x64:d=1.5",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  path.join(fixtures, "clip.mp4"),
]);
const state = {
  projects: new Map(),
  assets: new Map(),
  data: new Map(),
  writes: [],
  pending: [],
  defer: false,
};
// serde_json::Value uses sorted maps. Preserve this native IPC behavior so
// document equality checks cannot accidentally depend on JS insertion order.
const clone = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, current) =>
      current && typeof current === "object" && !Array.isArray(current)
        ? Object.fromEntries(
            Object.keys(current)
              .sort()
              .map((key) => [key, current[key]]),
          )
        : current,
    ),
  );
const browser = await chromium.launch({
  executablePath:
    process.env.CREATIVE_DESK_CHROME ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: [
    "--enable-webgl",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(60000);
const errors = [],
  remote = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error")
    errors.push("console.error: " + message.text());
});
await page.route("**/*", (route) => {
  const url = route.request().url();
  if (
    new URL(url).origin === new URL(origin).origin ||
    url.startsWith("data:") ||
    url.startsWith("blob:")
  )
    return route.continue();
  remote.push(url);
  return route.abort();
});
await page.exposeFunction("__fixtureInvoke", async (command, args = {}) => {
  switch (command) {
    case "local_workspace_info":
      return {
        rootPath: "/Users/test/CreativeDesk",
        applicationId: "local.creative.desk",
      };
    case "local_list_projects":
      return { projects: clone([...state.projects.values()]), warnings: [] };
    case "local_list_assets":
      return clone([...state.assets.values()]);
    case "codex_status":
      return {
        connected: false,
        authMode: "none",
        message: "Isolated storage verification",
      };
    case "local_load_project":
      assert(state.projects.has(args.id));
      return clone(state.projects.get(args.id));
    case "local_save_project": {
      const project = {
        ...clone(args.project),
        name: args.project.name.trim(),
        updatedAt: new Date().toISOString(),
      };
      state.writes.push(project);
      if (state.writes.length > 50)
        throw new Error("Repeated native-order storage writes");
      if (state.defer)
        await new Promise((resolve) => state.pending.push(resolve));
      state.projects.set(project.id, project);
      return clone(project);
    }
    case "local_import_asset": {
      const id = crypto.randomUUID();
      const asset = {
        id,
        name: args.name,
        mimeType: args.mimeType,
        path: `/Users/test/CreativeDesk/assets/${id}/data.bin`,
      };
      state.assets.set(id, asset);
      state.data.set(
        asset.path,
        `data:${args.mimeType};base64,${args.bytesBase64}`,
      );
      return clone(asset);
    }
    case "local_read_asset": {
      const asset = state.assets.get(args.id);
      assert(asset);
      return { asset: clone(asset), dataUrl: state.data.get(asset.path) };
    }
    default:
      throw new Error("Unexpected IPC: " + command);
  }
});
await page.addInitScript(() => {
  const urls = new Map();
  window.__CREATIVE_DESK_TEST_IPC__ = {
    fileSrc: (path) => {
      if (!urls.has(path)) throw new Error("Fixture path was not read");
      return urls.get(path);
    },
    invoke: async (command, args) => {
      const result = await window.__fixtureInvoke(command, args);
      if (command === "local_import_asset") {
        const read = await window.__fixtureInvoke("local_read_asset", {
          id: result.id,
        });
        urls.set(result.path, read.dataUrl);
      }
      if (command === "local_read_asset")
        urls.set(result.asset.path, result.dataUrl);
      if (command === "local_list_assets")
        for (const asset of result) {
          const read = await window.__fixtureInvoke("local_read_asset", {
            id: asset.id,
          });
          urls.set(asset.path, read.dataUrl);
        }
      return result;
    },
  };
});
try {
  await page.goto(origin + "/?creativeDeskTest=1", { timeout: 120000 });
  await click("new-canvas");
  await canvasReady();
  const canvasId = await id();
  await page.evaluate(() => window.__CREATIVE_DESK_EDITOR__.addRectangle());
  await importFile("blue.png", "image/png", png);
  await page
    .getByTestId("asset-preview")
    .getByRole("button", { name: "Adicionar à tela", exact: true })
    .evaluate((e) => e.click());
  await page.waitForFunction(
    () => window.__CREATIVE_DESK_EDITOR__.canvasState().drawNodes.length === 2,
  );
  await save();
  assert.equal(state.projects.get(canvasId).document.kind, "canvas");
  await click("new-canvas");
  await canvasReady();
  assert.equal(await nodeCount(), 0, "Canvas B must start empty");
  await click("project-" + canvasId);
  await canvasReady(false);
  assert.equal(
    await nodeCount(),
    2,
    "Canvas A reopens rectangle and imported image",
  );
  const nodes = await page.evaluate(() =>
    window.__CREATIVE_DESK_EDITOR__.canvasState().drawNodes.map((n) => ({
      type: n.type,
      x: n.x,
      y: n.y,
      image: !!n.imageElement?.complete && n.imageElement.naturalWidth > 0,
    })),
  );
  assert.equal(nodes[0].x, 17);
  assert.equal(nodes[0].y, 29);
  assert.equal(nodes[1].type, "image");
  assert.equal(nodes[1].image, true, "Reopened PNG must decode");
  await page.screenshot({ path: path.join(fixtures, "canvas.png") });
  console.log("PASS canvas image/rectangle save/reopen and A/B isolation");

  state.defer = true;
  const writeStart = state.writes.length;
  await click("save-project");
  await until(() => state.pending.length === 1);
  await page.evaluate(() => window.__CREATIVE_DESK_EDITOR__.addRectangle());
  state.pending.shift()();
  await until(
    () => state.writes.length === writeStart + 2 && state.pending.length === 1,
  );
  assert.equal(
    await page.getByTestId("save-state").textContent(),
    "A guardar…",
  );
  state.pending.shift()();
  state.defer = false;
  await saved();
  await click("new-canvas");
  await canvasReady();
  await click("project-" + canvasId);
  await canvasReady(false);
  assert.equal(
    await nodeCount(),
    3,
    "Edits arriving during save must survive reopen",
  );
  console.log("PASS edit during pending save persists in a subsequent write");

  await click("new-scene");
  await sceneReady();
  const sceneId = await id();
  await page.evaluate(
    async (engineUrl) => {
      await window.__CREATIVE_DESK_EDITOR__.addCube();
      const { getActiveEditor } = await import(engineUrl);
      const editor = getActiveEditor();
      const cube = window.__CREATIVE_DESK_EDITOR__
        .sceneJson()
        .scene.scene.find((o) => o.object_name === "Cubo");
      editor.timelineController.setDuration(7);
      editor.timelineController.addKeyframe(cube.object_uuid, 1);
      editor.cameraController.camera.position.set(2, 3, 8);
      editor.cameraController.camera.lookAt(0, 0.5, 0);
      window.__CREATIVE_DESK_EDITOR__.sceneState().updateCamera("main", {
        position: { x: 2, y: 3, z: 8 },
        focalLength: 24,
      });
    },
    "/@fs" +
      path.join(
        root,
        "frontend/libs/components/pagescene/src/lib/contexts/EngineContext/EngineContext.tsx",
      ),
  );
  await importFile("triangle.glb", "model/gltf-binary", glb);
  await click("asset-scene");
  await page.waitForFunction(() =>
    window.__CREATIVE_DESK_EDITOR__
      .sceneJson()
      ?.scene.scene.some((o) => o.object_name === "triangle.glb"),
  );
  await save();
  const sceneA = clone(state.projects.get(sceneId).document.scene);
  assert.equal(sceneA.timeline.duration, 7);
  assert(sceneA.timeline.tracks.length > 0);
  assert.equal(sceneA.camera_data.position.z, 8);
  assert(sceneA.scene.some((o) => o.media_file_token?.startsWith("m_")));
  await page.screenshot({ path: path.join(fixtures, "scene.png") });
  await click("new-scene");
  await sceneReady();
  const sceneB = await page.evaluate(
    () => window.__CREATIVE_DESK_EDITOR__.sceneJson().scene,
  );
  assert.equal(sceneB.timeline.duration, 10);
  assert.equal(sceneB.timeline.tracks.length, 0);
  assert.equal(
    sceneB.scene.filter(
      (o) => o.object_name === "Cubo" || o.object_name === "triangle.glb",
    ).length,
    0,
  );
  assert.notDeepEqual(sceneB.camera_data.position, sceneA.camera_data.position);
  await click("project-" + sceneId);
  await sceneReady();
  const reopened = await page.evaluate(
    () => window.__CREATIVE_DESK_EDITOR__.sceneJson().scene,
  );
  assert.equal(reopened.timeline.duration, 7);
  assert.equal(reopened.timeline.tracks.length, sceneA.timeline.tracks.length);
  assert.deepEqual(reopened.camera_data.position, sceneA.camera_data.position);
  assert(reopened.scene.some((o) => o.object_name === "triangle.glb"));
  assert(reopened.scene.some((o) => o.object_name === "Cubo"));
  console.log(
    "PASS GLB/cube/camera/keyframe save/reopen and scene A/B isolation",
  );

  for (const [name, mime, selector] of [
    ["tone.wav", "audio/wav", "audio"],
    ["clip.mp4", "video/mp4", "video"],
  ]) {
    await importFile(name, mime, await fs.readFile(path.join(fixtures, name)));
    await page.waitForFunction(
      (selector) =>
        document.querySelector('[data-testid="asset-preview"] ' + selector)
          ?.readyState >= 2,
      selector,
    );
    const media = await page
      .locator('[data-testid="asset-preview"] ' + selector)
      .evaluate(async (e) => {
        await e.play();
        const deadline = Date.now() + 8000;
        while (e.currentTime < 0.05 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 25));
        e.pause();
        return {
          duration: e.duration,
          time: e.currentTime,
          error: e.error?.message,
        };
      });
    assert(media.duration > 0);
    assert(media.time > 0, `${name} must advance during real playback`);
    assert.equal(media.error, undefined);
  }
  console.log("PASS audio/video local preview decode and playback");
  await importFile("unsupported.txt", "text/plain", Buffer.from("test"));
  assert.match(
    await page.getByTestId("error").textContent(),
    /suportado|suportada|Formato/i,
  );
  assert.deepEqual(errors, [], "All browser page errors must be reviewed");
  assert.deepEqual(remote, [], "No external browser requests allowed");
  console.log(
    "PASS unsupported import reports error; zero page/console errors or remote requests",
  );
  await fs.writeFile(
    path.join(fixtures, "results.json"),
    JSON.stringify({ canvas: nodes, scene: reopened, errors, remote }, null, 2),
  );
  console.log("Artifacts: " + fixtures);
} catch (error) {
  await page.screenshot({ path: path.join(fixtures, "failure.png") });
  console.error(
    JSON.stringify({
      error: String(error),
      errors,
      remote,
      artifacts: fixtures,
    }),
  );
  throw error;
} finally {
  await browser.close();
}

async function click(testId) {
  const previous = await id();
  await page.getByTestId(testId).evaluate((e) => e.click());
  if (testId.startsWith("new-"))
    await page.waitForFunction(
      (previous) =>
        document
          .querySelector('[data-testid="workspace"]')
          ?.getAttribute("data-project-id") !== previous,
      previous,
    );
  if (testId.startsWith("project-"))
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('[data-testid="workspace"]')
          ?.getAttribute("data-project-id") === expected,
      testId.slice(8),
    );
}
async function id() {
  return page.getByTestId("workspace").getAttribute("data-project-id");
}
async function canvasReady(blank = true) {
  await page.waitForFunction(
    (blank) =>
      !!window.__CREATIVE_DESK_EDITOR__?.canvasState().baseImageInfo &&
      (!blank ||
        window.__CREATIVE_DESK_EDITOR__.canvasState().baseImageInfo
          .isBlankCanvas),
    blank,
  );
  await page.locator('[data-testid="workspace"] canvas').first().waitFor();
}
async function sceneReady() {
  await page.waitForFunction(() => {
    try {
      return (
        window.__CREATIVE_DESK_EDITOR__?.sceneState().is3DSceneLoaded &&
        !!window.__CREATIVE_DESK_EDITOR__.sceneJson()
      );
    } catch {
      return false;
    }
  });
  await page.locator("canvas#video-scene").waitFor();
}
async function nodeCount() {
  return page.evaluate(
    () => window.__CREATIVE_DESK_EDITOR__.canvasState().drawNodes.length,
  );
}
async function saved() {
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="save-state"]')?.textContent ===
      "Guardado neste Mac",
  );
}
async function save() {
  await click("save-project");
  await saved();
}
async function importFile(name, mimeType, buffer) {
  await page
    .getByTestId("import-assets")
    .setInputFiles({ name, mimeType, buffer });
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="import-assets"]').disabled,
  );
}
async function until(predicate) {
  const deadline = Date.now() + 60000;
  while (!predicate()) {
    assert(Date.now() < deadline, "Timed out waiting for storage barrier");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function makeGlb() {
  const bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((n, i) => bin.writeFloatLE(n, i * 4));
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
      ],
    }),
  );
  const padding = Buffer.alloc((4 - (json.length % 4)) % 4, 32);
  const body = Buffer.concat([json, padding]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + body.length + bin.length, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const chunk = Buffer.alloc(8);
  chunk.writeUInt32LE(bin.length, 0);
  chunk.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, body, chunk, bin]);
}
