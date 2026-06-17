import { defineConfig } from 'tsup';

export default defineConfig([
	// The Vite plugin — runs in Node (the dev server).
	{
		entry: { index: 'src/index.ts' },
		format: ['esm', 'cjs'],
		dts: true,
		clean: true,
		target: 'node18',
		platform: 'node',
		// Polyfill import.meta.url in the CJS output (used to locate the client
		// bundle) and __dirname in ESM. Without this, CJS consumers get an empty URL.
		shims: true,
		// Host-provided / heavy deps stay external; bundle nothing the host already has.
		external: ['vite', 'svelte', 'svelte/compiler', 'postcss', 'magic-string']
	},
	// The browser overlay — a single self-contained IIFE the plugin injects into the
	// page in dev. Bundles everything so the host page needs no module resolution.
	{
		entry: { client: 'src/client/index.ts' },
		format: ['iife'],
		platform: 'browser',
		target: 'es2020',
		clean: false,
		dts: false,
		minify: false
	}
]);
