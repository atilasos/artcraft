import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// NB(bt): This configuration file can specify bundler rollup options, compiler plugins,
// import path resolution, dev server HTTP headers, CORS options, path rewriting, etc.
// Read the vite docs for more: https://vitejs.dev/config/

const SPARK_MODULE_SUBPATH = "/@sparkjsdev/spark/dist/spark.module.js";
const SPARK_WASM_PATTERN =
  /module_or_path = new URL\("(data:application\/wasm;base64,[^"]+)", import\.meta\.url\);/;

const sparkWasmDataUrlFix = (): Plugin => ({
  name: "spark-wasm-data-url-fix",
  enforce: "pre",
  apply: "serve",
  transform(code, id) {
    if (!id.includes(SPARK_MODULE_SUBPATH)) {
      return null;
    }

    const match = code.match(SPARK_WASM_PATTERN);
    if (!match) {
      return null;
    }

    const [, dataUrl] = match;
    const patched = code.replace(
      SPARK_WASM_PATTERN,
      `module_or_path = "${dataUrl}";`,
    );

    return {
      code: patched,
      map: null,
    };
  },
});

// The sparse prototype deliberately omits bitmap resources. This neutral,
// procedural transparency grid is owned by this host and needs no binary file.
const localTransparencyGrid = (): Plugin => ({
  name: "creative-desk-transparency-grid",
  resolveId(source, importer) {
    if (
      source === "./checkerboard.png" &&
      importer?.endsWith("/common/src/lib/assets/images/index.ts")
    )
      return "\0creative-desk-checkerboard";
    return null;
  },
  load(id) {
    if (id !== "\0creative-desk-checkerboard") return null;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#ddd" d="M0 0h16v16H0z"/><path fill="#aaa" d="M0 0h8v8H0zm8 8h8v8H8z"/></svg>';
    return `export default ${JSON.stringify("data:image/svg+xml," + encodeURIComponent(svg))}`;
  },
});

// These upstream engine URLs are required at construction time. Package the
// already installed Three.js resources, preserving their license notices.
const localEngineResources = (workspaceRoot: string): Plugin => {
  const dependencyRoot = path.join(
    workspaceRoot,
    "node_modules/three/examples",
  );
  const resources = [
    {
      url: "/jsm/libs/ammo.wasm.js",
      file: "jsm/libs/ammo.wasm.js",
      mime: "application/javascript",
    },
    {
      url: "/jsm/libs/ammo.wasm.wasm",
      file: "jsm/libs/ammo.wasm.wasm",
      mime: "application/wasm",
    },
    {
      url: "/resources/fonts/CarterOneRegular.json",
      file: "fonts/helvetiker_regular.typeface.json",
      mime: "application/json",
    },
    {
      url: "/resources/fonts/LICENSE-three-fonts.txt",
      file: "fonts/LICENSE",
      mime: "text/plain",
    },
  ];
  return {
    name: "creative-desk-engine-resources",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const resource = resources.find(
          (resource) => resource.url === request.url?.split("?")[0],
        );
        if (!resource) return next();
        response.setHeader("Content-Type", resource.mime);
        response.end(readFileSync(path.join(dependencyRoot, resource.file)));
      });
    },
    generateBundle() {
      for (const resource of resources) {
        this.emitFile({
          type: "asset",
          fileName: resource.url.slice(1),
          source: readFileSync(path.join(dependencyRoot, resource.file)),
        });
      }
    },
  };
};

const projectRoot = __dirname;
const appRoot = path.resolve(projectRoot, "app");
const workspaceRoot = path.resolve(projectRoot, "..", "..");

export default defineConfig({
  root: appRoot,
  css: { postcss: projectRoot },
  optimizeDeps: {
    exclude: ["@sparkjsdev/spark"],
  },
  build: {
    emptyOutDir: true,
    outDir: path.resolve(projectRoot, "dist"),
    rollupOptions: {
      input: {
        index: resolve(projectRoot, "app/index.html"),
      },
    },
  },
  plugins: [
    react(),
    localTransparencyGrid(),
    localEngineResources(workspaceRoot),
    sparkWasmDataUrlFix(),
    tsconfigPaths({
      // Resolve workspace packages to source for every importer, including shared
      // libraries. Fresh release checkouts have no prebuilt library dist files.
      projects: [path.resolve(workspaceRoot, "tsconfig.base.json")],
    }),
    wasm(),
    topLevelAwait(),
  ],
  test: { environment: "jsdom", include: ["src/**/*.spec.ts"], watch: false },
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
    fs: {
      allow: [workspaceRoot],
    },
  },
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@preact/signals-core",
      "@preact/signals-react",
    ],
  },
});
