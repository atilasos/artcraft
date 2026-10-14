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
} finally {
  await browser.close();
}
if (failures.length) throw new Error(failures.join("\n"));
console.log(
  "PASS: 4 actual App native-sorted save/navigation regressions, no page errors or remote requests",
);

async function check(label, exercise) {
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
      writes: [],
      pending: [],
      deferSaves: false,
      releaseNext: () => state.pending.shift()?.(),
    };
    window.__CREATIVE_DESK_SAVE_TEST__ = state;
    window.__CREATIVE_DESK_TEST_IPC__ = {
      invoke: async (command, args = {}) => {
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
            return [];
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
            if (state.writes.length > 4)
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
    failures.push(label + ": " + String(error));
    console.error("FAIL: " + label + ": " + String(error));
  } finally {
    await page.close();
  }
}
async function click(page, id) {
  await page.getByTestId(id).evaluate((element) => element.click());
}
async function projectId(page) {
  return page.getByTestId("workspace").getAttribute("data-project-id");
}
async function writeCount(page) {
  return page.evaluate(() => window.__CREATIVE_DESK_SAVE_TEST__.writes.length);
}
