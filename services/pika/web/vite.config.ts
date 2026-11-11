/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { docsContent } from "./docs/plugin";

export default defineConfig(({ mode }) => ({
	base: "./",
	plugins: [docsContent(), react(), tailwindcss()],
	server: {
		// Herder worktrees live under `.git/`, which Vite's default deny list blocks for test modules.
		// Tests also read the logo's source of truth, `../resource/pika-icon.svg`. Both modes serve the pika-node
		// contract (`../../pika-node/src`), which the Nodes page imports by relative path.
		fs:
			mode === "test"
				? { deny: [".env", ".env.*", "*.{crt,pem}"], allow: [".", "../resource", "../../pika-node/src"] }
				: { allow: [".", "../../pika-node/src"] },
		proxy: {
			// `ws` for the Nodes page's socket, `/api/v1/node/connect`.
			"/api": { target: "http://127.0.0.1:7171", ws: true },
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		chunkSizeWarningLimit: 700,
		// Minified builds drop license comments unless asked; keep them, such as the model marks' MIT notice.
		rolldownOptions: { output: { comments: { legal: true } } },
	},
	test: {
		environment: "jsdom",
		setupFiles: ["tests/setup.ts"],
		include: ["tests/**/*.test.{ts,tsx}"],
		css: false,
	},
}));
