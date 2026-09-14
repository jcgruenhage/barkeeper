import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Force a single copy of the WASM-backed automerge modules. A duplicate is a
// separate module instance, which breaks wasm-bindgen instanceof checks.
// Adapted from the keyhive todo demo (inkandswitch/keyhive-todo-app-demo).
const automergeEntryDir = dirname(fileURLToPath(import.meta.resolve("@automerge/automerge")));
const subductionEsmDir = dirname(fileURLToPath(import.meta.resolve("@automerge/automerge-subduction")));
const repoEntryDir = dirname(fileURLToPath(import.meta.resolve("@automerge/automerge-repo")));

export default defineConfig({
  base: "./",
  build: {
    target: "esnext",
    sourcemap: true,
  },
  resolve: {
    alias: [
      { find: /^@automerge\/automerge\/slim$/, replacement: resolve(automergeEntryDir, "slim.js") },
      { find: /^@automerge\/automerge$/, replacement: resolve(automergeEntryDir, "fullfat_bundler.js") },
      // web.js initializes the web-target bindings itself. bundler.js would
      // create a second class table over the same wasm instance.
      { find: /^@automerge\/automerge-subduction\/slim$/, replacement: resolve(subductionEsmDir, "slim.js") },
      { find: /^@automerge\/automerge-subduction$/, replacement: resolve(subductionEsmDir, "web.js") },
      { find: /^@automerge\/automerge-repo\/slim$/, replacement: resolve(repoEntryDir, "slim.js") },
      { find: /^@automerge\/automerge-repo$/, replacement: resolve(repoEntryDir, "fullfat.js") },
      // The Node websocket package is only reachable through a server adapter
      // re-export that never runs in the browser.
      { find: /^ws$/, replacement: fileURLToPath(new URL("./src/shims/ws.js", import.meta.url)) },
    ],
    dedupe: ["@keyhive/keyhive"],
  },
  optimizeDeps: {
    // Pre-bundling drops WASM ESM imports and ignores the aliases above.
    exclude: [
      "@automerge/automerge",
      "@automerge/automerge/slim",
      "@automerge/automerge-repo",
      "@automerge/automerge-repo/slim",
      "@automerge/automerge-repo-storage-indexeddb",
      "@automerge/automerge-repo-network-websocket",
      "@automerge/automerge-subduction",
      "@automerge/automerge-subduction/slim",
      "@automerge/automerge-repo-keyhive",
      "@keyhive/keyhive",
      "@keyhive/keyhive/slim",
    ],
    include: [
      "@automerge/automerge-repo > debug",
      "@automerge/automerge-repo > bs58check",
      "@automerge/automerge-repo > fast-sha256",
      "@automerge/automerge-repo > cbor-x",
      "@automerge/automerge-repo > eventemitter3",
      "@automerge/automerge-repo > uuid",
      "@automerge/automerge-repo > isomorphic-ws",
      "@automerge/automerge-repo > xstate",
    ],
  },
  plugins: [wasm()],
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
});
