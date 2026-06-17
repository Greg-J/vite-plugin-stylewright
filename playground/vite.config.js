import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import stylewright from 'vite-plugin-stylewright';

export default defineConfig({
	plugins: [svelte(), stylewright()],
	// Fixed port so the demo is predictable.
	server: { port: 5191, strictPort: true }
});
