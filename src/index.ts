import type { Plugin } from 'vite';
import { createStylewrightMiddleware } from './server/middleware.js';

export interface StylewrightOptions {
	/**
	 * Master switch. Stylewright is dev-only regardless (it never attaches to a
	 * production build), but you can force it off here. Default: true.
	 */
	enabled?: boolean;
}

/**
 * vite-plugin-stylewright — edit a Svelte component's CSS live in the browser and
 * save it straight back into that component's `.svelte` `<style>` block.
 *
 * Dev-only: it mounts a small middleware on the Vite dev server and injects a
 * browser overlay. It contributes nothing to the production bundle.
 */
export default function stylewright(options: StylewrightOptions = {}): Plugin {
	const enabled = options.enabled ?? true;
	let root = process.cwd();

	return {
		name: 'vite-plugin-stylewright',
		apply: 'serve', // dev server only
		configResolved(config) {
			root = config.root;
		},
		configureServer(server) {
			if (!enabled) return;
			server.middlewares.use(createStylewrightMiddleware(root));
		},
		transformIndexHtml() {
			if (!enabled) return;
			return [
				{
					tag: 'script',
					attrs: { src: '/__stylewright/client.js', defer: true },
					injectTo: 'body'
				}
			];
		}
	};
}
