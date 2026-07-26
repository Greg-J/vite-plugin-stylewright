import type { Plugin, ViteDevServer } from 'vite';
import type { AddressInfo } from 'node:net';
import { createStylewrightMiddleware, createHtmlInjectMiddleware } from './server/middleware.js';
import { Broker } from './server/ai/broker.js';
import { createAiRoutes } from './server/ai/routes.js';
import { writeDevFile, newToken, type DevFileHandles } from './server/ai/devfile.js';
import { resolveSetupCommand } from './server/ai/setupCommand.js';

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

			let handle: ReturnType<typeof createAiRoutes> | undefined;
			let broker: Broker | undefined;
			let devFile: DevFileHandles | undefined;

			if (aiEnabled) {
				broker = new Broker({ root, setup: resolveSetupCommand(root) });
				const token = newToken();
				handle = createAiRoutes({ broker, root, token });

				// The lockfile can only be written once we know the port. Vite may
				// already be listening by the time this hook runs (restart), so cover
				// both paths and keep it idempotent.
				const publish = (): void => {
					if (devFile) return;
					const addr = server.httpServer?.address() as AddressInfo | string | null;
					if (!addr || typeof addr === 'string') return;
					const host = addr.address === '::' || addr.address === '0.0.0.0' ? '127.0.0.1' : addr.address;
					const bracket = host.includes(':') ? `[${host}]` : host;
					devFile = writeDevFile({
						version: 1,
						pid: process.pid,
						root,
						origin: `http://${bracket}:${addr.port}`,
						token,
						startedAt: Date.now()
					});
				};
				if (server.httpServer?.listening) publish();
				server.httpServer?.once('listening', publish);

				const teardown = (): void => {
					devFile?.cleanup();
					devFile = undefined;
					broker?.dispose();
				};
				server.httpServer?.once('close', teardown);
				// A hard exit (Ctrl-C) skips 'close', which would leave a stale lockfile
				// pointing at a dead port with a live token in it.
				process.once('exit', teardown);
				process.once('SIGINT', teardown);
				process.once('SIGTERM', teardown);
			}

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
