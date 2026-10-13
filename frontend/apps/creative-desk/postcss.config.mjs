import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { createRequire } from "node:module";

// Reuse the existing editor palette with absolute globs for native and dev builds.
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const upstream = await jiti.import("../artcraft/tailwind.config.ts", {
  default: true,
});
export default {
  plugins: [
    tailwindcss({
      ...upstream,
      content: [
        path.join(root, "app/src/**/*.{ts,tsx}"),
        path.join(root, "../../libs/components/**/*.{ts,tsx}"),
      ],
    }),
    autoprefixer(),
  ],
};
