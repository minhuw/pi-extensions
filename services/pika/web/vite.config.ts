/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
	base: "./",
	plugins: [react(), tailwindcss()],
	server: {
		// Herder worktrees live under `.git/`, which Vite's default deny list blocks for test modules.
		// Tests also read the logo's source of truth, `../resource/pika-icon.svg`.
		...(mode === "test" ? { fs: { deny: [".env", ".env.*", "*.{crt,pem}"], allow: [".", "../resource"] } } : {}),
		proxy: {
			"/api": "http://127.0.0.1:7171",
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		chunkSizeWarningLimit: 700,
	},
	test: {
		environment: "jsdom",
		setupFiles: ["tests/setup.ts"],
		include: ["tests/**/*.test.{ts,tsx}"],
		css: false,
	},
}));
