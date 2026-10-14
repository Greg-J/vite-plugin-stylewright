// The plain-HTML proxy: Stylewright in front of an app that is not served by
// Vite. It forwards every request to the app's own dev server, adds the overlay
// to HTML pages on the way back, and answers /__stylewright/* itself.
//
// The host app changes in no way. In particular its Content-Security-Policy is
// left exactly as sent: the overlay goes in as an inline <script>, which a page
// that inlines its own scripts already allows. A page that forbids inline
// scripts gets a warning on stderr rather than a policy quietly rewritten.
//
// Dev-only by construction: this is a separate command that listens on
// 127.0.0.1, and nothing in it is part of any build.

import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Connect } from 'vite';
import { createStylewrightMiddleware, loadClient } from '../server/middleware.js';
import { PlainSources, type CssSource } from '../server/sources.js';
import { mountAi } from '../server/ai/mount.js';
import { isSafeHost } from '../server/guard.js';

export const PROXY_HOST = '127.0.0.1';

export interface ProxyOptions {
	/** The app's own dev server. http only — it is local. */
	target: URL;
	root: string;
	sources: CssSource[];
	port: number;
	ai: boolean;
	fonts: boolean;
	/** Diagnostics (stderr in the CLI). */
	warn?: (line: string) => void;
}

export interface RunningProxy {
	url: string;
	close(): Promise<void>;
}

/**
 * Make a bundle safe to place inside an inline <script>. The HTML tokenizer ends
 * the element at `</script`, and `<!--` followed by `<script` changes how it
 * scans; `\x3C` means `<` in every place these can occur in a bundle (strings,
 * template literals, regular expressions), so the code is unchanged.
 */
export function inlineScriptSafe(js: string): string {
	return js.replace(/<(\/?script|!--)/gi, '\\x3C$1');
}

/** The two inline scripts the proxy adds: the mode flags, then the overlay. */
export function overlayTags(bundle: string, opts: { ai: boolean; fonts: boolean }): string {
	const flags = ['window.__stylewright_plain__=true'];
	if (!opts.ai) flags.push('window.__stylewright_no_ai__=true');
	if (!opts.fonts) flags.push('window.__stylewright_no_fonts__=true');
	return `<script>${flags.join(';')}</script><script>${inlineScriptSafe(bundle)}</script>`;
}

/** Add the overlay before the last </body>, or at the end. Never twice. */
export function injectOverlay(html: string, tags: string): string {
	if (html.includes('window.__stylewright_plain__')) return html;
	const i = html.toLowerCase().lastIndexOf('</body>');
	return i >= 0 ? html.slice(0, i) + tags + html.slice(i) : html + tags;
}

/**
 * Would this Content-Security-Policy stop an inline script? True when the
 * governing directive lacks 'unsafe-inline', or pairs it with a nonce, a hash
 * or 'strict-dynamic' (any of which makes browsers ignore 'unsafe-inline').
 */
export function cspBlocksInline(header: string | string[] | undefined): boolean {
	if (!header) return false;
	const policies = (Array.isArray(header) ? header : [header]).flatMap((h) => h.split(','));
	return policies.some((policy) => {
		const dirs = new Map<string, string[]>();
		for (const d of policy.split(';')) {
			const [name, ...values] = d.trim().split(/\s+/);
			if (name && !dirs.has(name.toLowerCase())) dirs.set(name.toLowerCase(), values.map((v) => v.toLowerCase()));
		}
		const src = dirs.get('script-src-elem') ?? dirs.get('script-src') ?? dirs.get('default-src');
		if (!src) return false;
		if (!src.includes("'unsafe-inline'")) return true;
		return src.some((v) => v.startsWith("'nonce-") || /^'sha(256|384|512)-/.test(v) || v === "'strict-dynamic'");
	});
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade'];

/**
 * Request headers for the app. The app sees itself addressed directly: Host is
 * its own, and an Origin/Referer naming the proxy is rewritten to name the app,
 * so a same-origin check on its side passes exactly as it would without us.
 * Accept-Encoding is dropped so HTML comes back as text we can add to.
 */
function upstreamHeaders(h: http.IncomingHttpHeaders, self: string, target: URL, upgrade: boolean): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = { ...h };
	if (!upgrade) for (const k of HOP_BY_HOP) delete out[k];
	delete out['accept-encoding'];
	out.host = target.host;
	if (out.origin === self) out.origin = target.origin;
	const ref = out.referer;
	if (typeof ref === 'string' && (ref === self || ref.startsWith(self + '/'))) out.referer = target.origin + ref.slice(self.length);
	return out;
}

/** An absolute redirect to the app becomes one to the proxy, so the browser stays on us. */
function rewriteLocation(loc: string, target: URL, self: string): string {
	return loc === target.origin || loc.startsWith(target.origin + '/') ? self + loc.slice(target.origin.length) : loc;
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
	switch ((encoding || '').trim().toLowerCase()) {
		case '': case 'identity': return body;
		case 'gzip': case 'x-gzip': return zlib.gunzipSync(body);
		case 'deflate': return zlib.inflateSync(body);
		case 'br': return zlib.brotliDecompressSync(body);
		default: throw new Error(`unsupported content-encoding ${encoding}`);
	}
}

export async function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
	const { target, root } = opts;
	if (target.protocol !== 'http:') throw new Error(`--target must be an http:// URL (got ${target.href})`);
	const warn = opts.warn ?? (() => {});
	const warned = new Set<string>();
	const warnOnce = (key: string, line: string): void => { if (!warned.has(key)) { warned.add(key); warn(line); } };

	const plain = new PlainSources(root, opts.sources);
	const server = http.createServer();
	const ai = opts.ai ? mountAi({ root, httpServer: server, isSourceFile: plain.isSourceFile }) : undefined;
	const api = createStylewrightMiddleware(root, ai, plain);
	const targetPort = Number(target.port || 80);

	const forward = (req: http.IncomingMessage, res: http.ServerResponse): void => {
		const self = `http://${req.headers.host}`;
		const up = http.request({
			host: target.hostname, port: targetPort, method: req.method, path: req.url,
			headers: upstreamHeaders(req.headers, self, target, false)
		}, (upRes) => {
			const status = upRes.statusCode || 502;
			const out: http.OutgoingHttpHeaders = { ...upRes.headers };
			delete out.connection;
			delete out['keep-alive'];
			if (typeof out.location === 'string') out.location = rewriteLocation(out.location, target, self);

			const ct = String(out['content-type'] || '').toLowerCase();
			const isHtml = ct.includes('text/html') && req.method !== 'HEAD' && status !== 204 && status !== 304;
			const charset = /charset=([^;]+)/.exec(ct)?.[1]?.trim();
			if (!isHtml || (charset && charset !== 'utf-8' && charset !== 'utf8')) {
				res.writeHead(status, out);
				upRes.pipe(res);
				return;
			}
			const chunks: Buffer[] = [];
			upRes.on('data', (c: Buffer) => chunks.push(c));
			upRes.on('error', () => res.destroy());
			upRes.on('end', () => {
				let body: Buffer;
				try {
					body = decode(Buffer.concat(chunks), out['content-encoding'] as string | undefined);
				} catch (err) {
					warnOnce('encoding', `[stylewright] could not decode ${req.url} (${String(err)}); served it without the overlay`);
					res.writeHead(status, out);
					res.end(Buffer.concat(chunks));
					return;
				}
				if (cspBlocksInline(upRes.headers['content-security-policy'])) {
					warnOnce('csp', `[stylewright] ${req.url} sends a Content-Security-Policy that blocks inline scripts, so the overlay cannot run on it. ` +
						'Stylewright leaves the policy alone; allowing \'unsafe-inline\' for scripts in local dev is the fix on the app\'s side.');
				}
				const html = Buffer.from(injectOverlay(body.toString('utf8'), overlayTags(loadClient(), opts)), 'utf8');
				delete out['content-encoding'];
				delete out['transfer-encoding'];
				// We changed the body, so the app's validators no longer describe it.
				delete out.etag;
				delete out['last-modified'];
				out['content-length'] = String(html.length);
				out['cache-control'] = 'no-store';
				res.writeHead(status, out);
				res.end(html);
			});
		});
		up.on('error', (err) => {
			if (res.headersSent) { res.destroy(); return; }
			res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
			res.end(`Stylewright proxy: nothing answered at ${target.origin} (${err.message}).\nStart the app's dev server, then reload.\n`);
		});
		req.pipe(up);
	};

	server.on('request', (req, res) => {
		// The proxy speaks for the app, so it applies the API's DNS-rebinding rule to
		// everything: only an IP literal or *.localhost Host is served at all.
		if (!isSafeHost(req.headers.host)) {
			res.writeHead(403, { 'content-type': 'text/plain' });
			res.end('Forbidden host');
			return;
		}
		Promise.resolve(api(req as Connect.IncomingMessage, res, () => forward(req, res))).catch((err: unknown) => {
			if (!res.headersSent) { res.statusCode = 500; res.end(String(err)); } else res.destroy();
		});
	});

	// WebSockets (and any other upgrade) are tunnelled to the app untouched. An
	// upgraded socket leaves the HTTP server's bookkeeping, so track the pairs
	// here: close() has to end them, and one side closing must end the other.
	const tunnels = new Set<net.Socket>();
	server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
		if (!isSafeHost(req.headers.host) || (req.url || '').startsWith('/__stylewright')) { socket.destroy(); return; }
		const self = `http://${req.headers.host}`;
		const headers = upstreamHeaders(req.headers, self, target, true);
		const up = net.connect(targetPort, target.hostname, () => {
			let lines = `${req.method} ${req.url} HTTP/1.1\r\n`;
			for (const [k, v] of Object.entries(headers)) {
				for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined) lines += `${k}: ${x}\r\n`;
			}
			up.write(lines + '\r\n');
			if (head.length) up.write(head);
			socket.pipe(up);
			up.pipe(socket);
		});
		tunnels.add(socket);
		tunnels.add(up);
		const kill = (): void => { socket.destroy(); up.destroy(); tunnels.delete(socket); tunnels.delete(up); };
		for (const s of [socket, up]) { s.on('error', kill); s.on('close', kill); }
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(opts.port, PROXY_HOST, () => { server.off('error', reject); resolve(); });
	});
	const addr = server.address() as net.AddressInfo;
	return {
		url: `http://${PROXY_HOST}:${addr.port}/`,
		close: () => new Promise<void>((resolve) => {
			// Long-polls, the overlay's event stream and open tunnels would hold
			// close() open.
			for (const t of tunnels) t.destroy();
			server.closeAllConnections?.();
			server.close(() => resolve());
		})
	};
}
