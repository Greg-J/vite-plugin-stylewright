// How to invoke this package's CLI from a shell, for text an agent will follow.
// Node-only (used by the MCP server and the proxy, never the overlay).

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `npx vite-plugin-stylewright` when this code was installed as a package (npx
 * resolves it), otherwise `node <absolute path to dist/mcp.js>` — the form that
 * works from a checkout, where the short name would 404 on npm.
 */
export function cliCommand(moduleUrl: string): string {
	const bin = join(dirname(fileURLToPath(moduleUrl)), 'mcp.js');
	if (/[\\/]node_modules[\\/]/.test(bin)) return 'npx vite-plugin-stylewright';
	return /\s/.test(bin) ? `node "${bin}"` : `node ${bin}`;
}
