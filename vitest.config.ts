import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Vitest settings for the plugin's pure logic. */
export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL("./src/obsidian-stub.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
