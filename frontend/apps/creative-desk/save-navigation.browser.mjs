import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const URL = "http://127.0.0.1:1421/?creativeDeskTest=1";
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: [
    "--enable-webgl",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const failures = [];
let checks = 0;
const engineModule =
  "/@fs" +
  new globalThis.URL(
    "../../libs/components/pagescene/src/lib/contexts/EngineContext/EngineContext.tsx",
    import.meta.url,
  ).pathname;

try {
  for (const [label, title] of [
    ["leading whitespace", " Estudo"],
    ["trailing whitespace", "Estudo "],
  ]) {
    await check(label, async (page) => {
      const id = await projectId(page);
      await page.getByTestId("project-name").fill(title);
      await click(page, "save-project");
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="save-state"]')?.textContent ===
          "Guardado neste Mac",
        undefined,
        { timeout: 8000 },
      );
      assert.equal(
        await page.getByTestId("project-name").inputValue(),
        "Estudo",
      );
      const saved = await page.evaluate(
        (id) => window.__CREATIVE_DESK_SAVE_TEST__.projects.get(id),
        id,
      );
      assert.equal(saved.name, "Estudo");
      assert.equal(await writeCount(page), 1);
      await click(page, "new-canvas");
      await page.waitForFunction(
        (id) =>
          document
            .querySelector('[data-testid="workspace"]')
            ?.getAttribute("data-project-id") !== id,
        id,
      );
      assert.equal(
        await writeCount(page),
        2,
        "navigation must complete with one ordinary save, without retries",
      );
    });
  }
  await check("rename during pending save and navigation", async (page) => {
    const id = await projectId(page);
    await page.evaluate(() => {
      window.__CREATIVE_DESK_SAVE_TEST__.deferSaves = true;
    });
    await page.getByTestId("project-name").fill(" Primeiro ");
    await click(page, "save-project");
    await page.waitForFunction(
      () => window.__CREATIVE_DESK_SAVE_TEST__.writes.length === 1,
    );
    await page.getByTestId("project-name").fill(" Segundo ");
    await click(page, "new-canvas");
    assert.equal(
      await projectId(page),
      id,
      "navigation must wait for the pending save",
    );
    await page.evaluate(() => window.__CREATIVE_DESK_SAVE_TEST__.releaseNext());
    await page.waitForFunction(
      () => window.__CREATIVE_DESK_SAVE_TEST__.writes.length === 2,
    );
    assert.equal(
      await projectId(page),
      id,
      "navigation must wait for the latest rename to persist",
    );
    const first = await page.evaluate(
      (id) => window.__CREATIVE_DESK_SAVE_TEST__.projects.get(id),
      id,
    );
    assert.equal(first.name, "Primeiro");
    await page.evaluate(() => window.__CREATIVE_DESK_SAVE_TEST__.releaseNext());
    await page.waitForFunction(
      (id) =>
        document
          .querySelector('[data-testid="workspace"]')
          ?.getAttribute("data-project-id") !== id,
      id,
    );
    const saved = await page.evaluate(
      (id) => window.__CREATIVE_DESK_SAVE_TEST__.projects.get(id),
      id,
    );
    assert.equal(saved.name, "Segundo");
    assert.equal(await writeCount(page), 2);
    const names = await page.evaluate(() =>
      window.__CREATIVE_DESK_SAVE_TEST__.writes.map((project) => project.name),
    );
    assert.deepEqual(names, ["Primeiro", "Segundo"]);
  });
  await check(
    "document edit and array reorder during native-sorted save",
    async (page) => {
      const id = await projectId(page);
      const ids = await page.evaluate(() => {
        window.__CREATIVE_DESK_EDITOR__.addRectangle();
        return window.__CREATIVE_DESK_EDITOR__
          .canvasState()
          .drawNodes.map((node) => node.id);
      });
      await page.evaluate(() => {
        window.__CREATIVE_DESK_SAVE_TEST__.deferSaves = true;
      });
      await click(page, "save-project");
      await page.waitForFunction(
        () => window.__CREATIVE_DESK_SAVE_TEST__.writes.length === 1,
      );
      await page.evaluate((ids) => {
        const state = window.__CREATIVE_DESK_EDITOR__.canvasState();
        state.updateNode(ids[0], { x: 83 }, true);
        state.bringToFront([ids[0]]);
      }, ids);
      await click(page, "new-canvas");
      await page.evaluate(() =>
        window.__CREATIVE_DESK_SAVE_TEST__.releaseNext(),
      );
      await page.waitForFunction(
        () => window.__CREATIVE_DESK_SAVE_TEST__.writes.length === 2,
      );
      assert.equal(
        await projectId(page),
        id,
        "navigation must await the changed document",
      );
      const first = await page.evaluate(
        (id) => window.__CREATIVE_DESK_SAVE_TEST__.projects.get(id),
        id,
      );
      assert.deepEqual(
        first.document.scene.drawNodes.map((node) => node.id),
        ids,
      );
      assert.equal(first.document.scene.drawNodes[0].x, 17);
      await page.evaluate(() =>
        window.__CREATIVE_DESK_SAVE_TEST__.releaseNext(),
      );
      await page.waitForFunction(
        (id) =>
          document
            .querySelector('[data-testid="workspace"]')
            ?.getAttribute("data-project-id") !== id,
        id,
      );
      const saved = await page.evaluate(
        (id) => window.__CREATIVE_DESK_SAVE_TEST__.projects.get(id),
        id,
      );
      assert.deepEqual(
        saved.document.scene.drawNodes.map((node) => node.id),
        [ids[1], ids[0]],
      );
      assert.equal(saved.document.scene.drawNodes[1].x, 83);
      assert.equal(await writeCount(page), 2);
    },
  );
  await check(
    "camera keyframes survive save/reopen and legacy scenes",
    async (page) => {
      await click(page, "new-scene");
      await sceneReady(page);
      const id = await projectId(page);
      const cameraUuid = await page.evaluate(async (url) => {
        const editor = (await import(url)).getActiveEditor();
        const camera = editor.cameraController.cam_obj;
        camera.position.x = 0;
        editor.timelineController.addKeyframe(camera.uuid, 0);
        camera.position.x = 4;
        editor.timelineController.addKeyframe(camera.uuid, 2);
        return camera.uuid;
      }, engineModule);
      await click(page, "save-project");
      await saved(page);
      await click(page, "new-scene");
      await sceneReady(page);
      await click(page, "project-" + id);
      await sceneReady(page);
      const reopened = await page.evaluate(async (url) => {
        const editor = (await import(url)).getActiveEditor();
        const camera = editor.cameraController.cam_obj;
        editor.timelineController.seekTo(0);
        const start = camera.position.x;
        editor.timelineController.seekTo(2);
        return { uuid: camera.uuid, start, end: camera.position.x };
      }, engineModule);
      assert.equal(reopened.uuid, cameraUuid);
      assert.equal(reopened.start, 0);
      assert.equal(reopened.end, 4);
      await click(page, "save-project");
      await saved(page);
      const persisted = await page.evaluate(
        (id) =>
          window.__CREATIVE_DESK_SAVE_TEST__.projects.get(id).document.scene,
        id,
      );
      assert.equal(persisted.renderCameraUuid, cameraUuid);
      assert.equal(persisted.timeline.tracks[0].objectUuid, cameraUuid);
      assert.equal(persisted.timeline.tracks[0].keyframes.length, 2);

      // Existing documents predate renderCameraUuid. They must still load and
      // gain a stable camera identity on their next ordinary save.
      await click(page, "new-scene");
      await sceneReady(page);
      await page.evaluate((id) => {
        const scene =
          window.__CREATIVE_DESK_SAVE_TEST__.projects.get(id).document.scene;
        delete scene.renderCameraUuid;
        scene.timeline.tracks = [];
      }, id);
      await click(page, "project-" + id);
      await sceneReady(page);
      await click(page, "save-project");
      await saved(page);
      assert.match(
        await page.evaluate(
          (id) =>
            window.__CREATIVE_DESK_SAVE_TEST__.projects.get(id).document.scene
              .renderCameraUuid,
          id,
        ),
        /^[0-9a-f-]{36}$/,
      );
    },
  );
  await check(
    "scene capture appears in local resources without remount",
    async (page) => {
      await click(page, "new-scene");
      await sceneReady(page);
      await page.evaluate(() => window.__CREATIVE_DESK_EDITOR__.addCube());
      await page.evaluate(async (url) => {
        const editor = (await import(url)).getActiveEditor();
        window.__captureEditor = editor;
        const { captureStill } = await import(
          url.replace(
            "contexts/EngineContext/EngineContext.tsx",
            "actions/recordOutput.ts",
          )
        );
        captureStill(editor);
      }, engineModule);
      await page.waitForFunction(
        () =>
          window.__CREATIVE_DESK_SAVE_TEST__.assets.size === 1 &&
          window.__CREATIVE_DESK_EDITOR__.sceneState().producedArtifact ===
            null,
      );
      const asset = await page.evaluate(
        () => [...window.__CREATIVE_DESK_SAVE_TEST__.assets.values()][0],
      );
      await page.getByTestId("asset-" + asset.id).waitFor({ timeout: 8000 });
      await page.getByTestId("asset-preview").waitFor({ timeout: 8000 });
      await page.waitForFunction(() => {
        const image = document.querySelector(
          '[data-testid="asset-preview"] img',
        );
        return image?.complete && image.naturalWidth > 0;
      });
      assert.equal(
        await page.evaluate(
          async (url) =>
            (await import(url)).getActiveEditor() === window.__captureEditor,
          engineModule,
        ),
        true,
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.__CREATIVE_DESK_EDITOR__
              .sceneJson()
              .scene.scene.filter((o) => o.object_name === "Cubo").length,
        ),
        1,
      );
    },
  );
  await check(
    "reselecting the active scene preserves its live editor",
    async (page) => {
      await click(page, "new-scene");
      await sceneReady(page);
      const id = await projectId(page);
      await page.evaluate(() => window.__CREATIVE_DESK_EDITOR__.addCube());
      await click(page, "save-project");
      await saved(page);
      await page.evaluate(() => window.__CREATIVE_DESK_EDITOR__.addCube());
      await page.getByTestId("project-name").fill("Cena ativa em edição");
      const writesBefore = await writeCount(page);
      await page.evaluate(
        async ({ id, engineModule }) => {
          const { getActiveEditor } = await import(engineModule);
          window.__editorBeforeReselect = getActiveEditor();
          window.__canvasBeforeReselect =
            document.querySelector("#video-scene");
          // Native IPC resolves asynchronously; a frame can precede React's
          // queued commit and is not an unmount acknowledgement.
          window.__CREATIVE_DESK_SAVE_TEST__.transportDelay = 20;
          const realFrame = window.requestAnimationFrame;
          window.__fastNavigationFrame = 0;
          window.requestAnimationFrame = (callback) => {
            if (new Error().stack?.includes("/src/App.tsx")) {
              window.requestAnimationFrame = realFrame;
              window.__fastNavigationFrame++;
              queueMicrotask(() => callback(performance.now()));
              return 0;
            }
            return realFrame(callback);
          };
          document.querySelector(`[data-testid="project-${id}"]`).click();
        },
        { id, engineModule },
      );
      await page.waitForTimeout(250);
      const lifecycle = await page.evaluate(async (engineModule) => {
        const { getActiveEditor } = await import(engineModule);
        const editor = getActiveEditor();
        return {
          hasEditor: Boolean(editor),
          sameEditor: editor === window.__editorBeforeReselect,
          sameCanvas:
            document.querySelector("#video-scene") ===
            window.__canvasBeforeReselect,
          loaded: window.__CREATIVE_DESK_EDITOR__.sceneState().is3DSceneLoaded,
          refs: ["sceneContainerEl", "editorCanvasEl", "camViewCanvasEl"].map(
            (key) =>
              window.__CREATIVE_DESK_EDITOR__.sceneState()[key]?.isConnected ??
              null,
          ),
          outliner:
            window.__CREATIVE_DESK_EDITOR__.sceneState().outlinerItems.length,
          frames: window.__fastNavigationFrame,
        };
      }, engineModule);
      console.log("Reselect lifecycle: " + JSON.stringify(lifecycle));
      assert.equal(lifecycle.hasEditor, true);
      assert.equal(lifecycle.sameEditor, true);
      assert.equal(lifecycle.sameCanvas, true);
      assert.equal(lifecycle.loaded, true);
      assert.equal(lifecycle.outliner, 3);
      assert.equal(lifecycle.frames, 0);
      assert.deepEqual(lifecycle.refs, [true, true, true]);
      assert.equal(await writeCount(page), writesBefore);
      assert.equal(
        await page.getByTestId("project-name").inputValue(),
        "Cena ativa em edição",
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.__CREATIVE_DESK_EDITOR__
              .sceneJson()
              .scene.scene.filter((object) => object.object_name === "Cubo")
              .length,
        ),
        2,
      );
      await click(page, "save-project");
      await saved(page);
      const stored = await page.evaluate(
        (id) => window.__CREATIVE_DESK_SAVE_TEST__.projects.get(id),
        id,
      );
      assert.equal(stored.name, "Cena ativa em edição");
      assert.equal(
        stored.document.scene.scene.filter(
          (object) => object.object_name === "Cubo",
        ).length,
        2,
      );
    },
  );
} finally {
  await browser.close();
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(
  `PASS: ${checks} actual App native-sorted save/navigation/capture regressions, no page errors or remote requests`,
);

async function check(label, exercise) {
  if (
    process.env.CREATIVE_DESK_CASE &&
    !label.includes(process.env.CREATIVE_DESK_CASE)
  )
    return;
  checks++;
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = [],
    remote = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (
      url.startsWith("http://127.0.0.1:1421/") ||
      url.startsWith("data:") ||
      url.startsWith("blob:")
    )
      return route.continue();
    remote.push(url);
    return route.abort();
  });
  await page.addInitScript(() => {
    // Match serde_json's object maps, while retaining semantic array order.
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
    const state = {
      projects: new Map(),
      assets: new Map(),
      data: new Map(),
      writes: [],
      pending: [],
      deferSaves: false,
      transportDelay: 0,
      releaseNext: () => state.pending.shift()?.(),
    };
    window.__CREATIVE_DESK_SAVE_TEST__ = state;
    window.__CREATIVE_DESK_TEST_IPC__ = {
      fileSrc: (path) => state.data.get(path),
      invoke: async (command, args = {}) => {
        if (
          state.transportDelay &&
          ["local_load_project", "local_save_project"].includes(command)
        )
          await new Promise((resolve) =>
            setTimeout(resolve, state.transportDelay),
          );
        switch (command) {
          case "local_workspace_info":
            return {
              rootPath: "/Users/test/CreativeDesk",
              applicationId: "local.creative.desk",
            };
          case "local_list_projects":
            return {
              projects: clone([...state.projects.values()]),
              warnings: [],
            };
          case "local_list_assets":
            return clone([...state.assets.values()]);
          case "local_import_asset": {
            const id = crypto.randomUUID();
            const asset = {
              id,
              name: args.name,
              mimeType: args.mimeType,
              path: `/Users/test/CreativeDesk/assets/${id}/data.png`,
            };
            state.assets.set(id, asset);
            state.data.set(
              asset.path,
              `data:${asset.mimeType};base64,${args.bytesBase64}`,
            );
            return clone(asset);
          }
          case "local_read_asset": {
            const asset = state.assets.get(args.id);
            return { asset: clone(asset), dataUrl: state.data.get(asset.path) };
          }
          case "codex_status":
            return {
              connected: false,
              authMode: "none",
              message: "Storage regression test",
            };
          case "local_load_project":
            return clone(state.projects.get(args.id));
          case "local_save_project": {
            const project = {
              ...clone(args.project),
              updatedAt: new Date().toISOString().replace("Z", "+00:00"),
            };
            state.writes.push(project);
            // Bound the pre-fix loop so the failing regression cannot flood writes.
            if (state.writes.length > 12)
              throw new Error("Repeated identical storage writes");
            if (state.deferSaves)
              await new Promise((resolve) => state.pending.push(resolve));
            state.projects.set(project.id, project);
            return clone(project);
          }
          default:
            throw new Error("Unexpected test command: " + command);
        }
      },
    };
  });
  try {
    await page.goto(URL, { timeout: 120000 });
    await page.getByTestId("new-canvas").waitFor();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="new-canvas"]')?.disabled,
    );
    await click(page, "new-canvas");
    await page.waitForFunction(
      () =>
        window.__CREATIVE_DESK_EDITOR__?.canvasState().baseImageInfo
          ?.isBlankCanvas === true,
    );
    await page.evaluate(() => window.__CREATIVE_DESK_EDITOR__.addRectangle());
    await exercise(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(remote, []);
    console.log("PASS: " + label);
  } catch (error) {
    console.error(
      "Failure state: " +
        JSON.stringify(
          await page.evaluate(async (engineModule) => {
            const { getActiveEditor } = await import(engineModule);
            const state = window.__CREATIVE_DESK_EDITOR__?.sceneState();
            return {
              project: document
                .querySelector('[data-testid="workspace"]')
                ?.getAttribute("data-project-id"),
              status: document.querySelector('[data-testid="save-state"]')
                ?.textContent,
              hasEditor: Boolean(getActiveEditor()),
              loaded: state?.is3DSceneLoaded,
              refs: [
                state?.sceneContainerEl,
                state?.editorCanvasEl,
                state?.camViewCanvasEl,
              ].map((node) => node?.isConnected ?? null),
              outliner: state?.outlinerItems.length,
              text: document.body.innerText.slice(-1500),
            };
          }, engineModule),
        ),
    );
    failures.push(label + ": " + String(error));
    console.error("FAIL: " + label + ": " + (error.stack || String(error)));
  } finally {
    await page.close();
  }
}
async function click(page, id) {
  await page.waitForFunction((id) => {
    const button = document.querySelector(`[data-testid="${id}"]`);
    return button && !button.disabled;
  }, id);
  await page.getByTestId(id).evaluate((element) => element.click());
}
async function projectId(page) {
  return page.getByTestId("workspace").getAttribute("data-project-id");
}
async function writeCount(page) {
  return page.evaluate(() => window.__CREATIVE_DESK_SAVE_TEST__.writes.length);
}
async function sceneReady(page) {
  await page.waitForFunction(
    () =>
      window.__CREATIVE_DESK_EDITOR__?.sceneState().is3DSceneLoaded === true,
  );
}
async function saved(page) {
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="save-state"]')?.textContent ===
      "Guardado neste Mac",
  );
}
