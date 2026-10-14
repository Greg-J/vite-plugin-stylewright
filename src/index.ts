import type { Plugin, ViteDevServer } from 'vite';
import { createStylewrightMiddleware, createHtmlInjectMiddleware } from './server/middleware.js';
import { mountAi } from './server/ai/mount.js';

export interface StylewrightOptions {
	/**
	 * Master switch. Stylewright is dev-only regardless (it never attaches to a
	 * production build), but you can force it off here. Default: true.
	 */
	enabled?: boolean;
	/**
	 * The "Ask AI" path: hand a selected element plus an instruction to a linked
	 * Claude Code / Cline session over MCP. Default: true. Turning it off removes
	 * the tab, the routes, and the dev-server lockfile — the CSS editor is
	 * unaffected either way.
	 */
	ai?: boolean;
	/**
	 * Load IBM Plex from Google Fonts for the overlay chrome. Default: true.
	 * This is the only request Stylewright makes to anything but your own dev
	 * server; set it to false and the overlay uses the system sans/mono stacks.
	 */
	fonts?: boolean;
}

/**
 * vite-plugin-stylewright — edit a Svelte component's CSS live in the browser and
 * save it straight back into that component's `.svelte` `<style>` block, or hand
 * the element to your own coding-agent session and let it make the change.
 *
 * Dev-only: it mounts a small middleware on the Vite dev server and injects a
 * browser overlay. It contributes nothing to the production bundle.
 */
export default function stylewright(options: StylewrightOptions = {}): Plugin {
	const enabled = options.enabled ?? true;
	const aiEnabled = options.ai ?? true;
	let root = process.cwd();

	return {
		name: 'vite-plugin-stylewright',
		apply: 'serve', // dev server only
		configResolved(config) {
			root = config.root;
		},
		config() {
			if (!enabled) return;
			// Defence in depth. Nothing is written under the root any more — the
			// bearer token lives only in the user-level registry — but a lockfile
			// left behind by an older version would still be inside the tree Vite
			// serves, and it would be handed to any unauthenticated GET.
			return { server: { fs: { deny: ['**/.stylewright/**'] } } };
		},
		configureServer(server: ViteDevServer) {
			if (!enabled) return;

			// Broker, token, routes and the registry entry the MCP server finds us by.
			const handle = aiEnabled ? mountAi({ root, httpServer: server.httpServer }) : undefined;

			// Inject the client by rewriting HTML responses (works under SvelteKit too,
			// where transformIndexHtml is bypassed), then serve the API + bundle.
			server.middlewares.use(createHtmlInjectMiddleware());
			server.middlewares.use(createStylewrightMiddleware(root, handle));
		},
		// Plain Vite path — clean inject via the index.html transform. The middleware
		// above is idempotent, so this never results in a double injection.
		transformIndexHtml() {
			if (!enabled) return;
			const tags = [];
			const flags: string[] = [];
			if (options.fonts === false) flags.push('window.__stylewright_no_fonts__=true');
			// Tell the overlay the AI routes aren't mounted, so it hides the tab
			// instead of rendering one whose every call 404s.
			if (!aiEnabled) flags.push('window.__stylewright_no_ai__=true');
			if (flags.length) {
				tags.push({ tag: 'script', children: flags.join(';'), injectTo: 'head' as const });
			}
			tags.push({ tag: 'script', attrs: { src: '/__stylewright/client.js', defer: true }, injectTo: 'body' as const });
			return tags;
		}
	};
}
