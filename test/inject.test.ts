import { describe, it, expect, vi } from 'vitest';
import vm from 'node:vm';
import { createHtmlInjectMiddleware } from '../src/server/middleware.js';

/** A minimal stand-in for Node's ServerResponse that records the final body.
 *  The REAL writeHead/write set headersSent (flush), exactly like Node — so this
 *  catches the SvelteKit case where writeHead flushes before the body. */
function makeRes() {
	const headers: Record<string, string> = {};
	const res = {
		statusCode: 200,
		headersSent: false,
		finalBody: null as Buffer | null,
		setHeader(k: string, v: unknown) { if (res.headersSent) throw new Error('headers already sent'); headers[k.toLowerCase()] = String(v); },
		getHeader(k: string) { return headers[k.toLowerCase()]; },
		removeHeader(k: string) { delete headers[k.toLowerCase()]; },
		writeHead(status: number, hdrs?: Record<string, string>) { res.statusCode = status; if (hdrs) for (const k of Object.keys(hdrs)) headers[k.toLowerCase()] = hdrs[k]; res.headersSent = true; return res; },
		write(_chunk?: unknown) { res.headersSent = true; return true; },
		end(chunk?: unknown) { res.headersSent = true; if (chunk != null) res.finalBody = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); return res; }
	};
	return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (res: any, accept = 'text/html') => {
	const next = vi.fn();
	createHtmlInjectMiddleware()({ method: 'GET', url: '/', headers: { accept } } as never, res, next);
	return next;
};

describe('html inject middleware', () => {
	it('injects the client once for a SvelteKit-style writeHead + end', () => {
		const res = makeRes();
		run(res);
		// SvelteKit: writeHead() flushes headers, THEN writes the body
		res.writeHead(200, { 'content-type': 'text/html', 'content-length': '33' });
		res.end('<html><body>hello</body></html>');
		const body = res.finalBody!.toString('utf8');
		expect(body.match(/\/__stylewright\/client\.js/g)?.length).toBe(1);
		expect(body).toContain('client.js" defer></script></body>');
		expect(res.getHeader('content-length')).toBe(String(res.finalBody!.length)); // corrected
	});

	it('injects when the body is written then ended (chunked)', () => {
		const res = makeRes();
		run(res);
		res.setHeader('content-type', 'text/html');
		res.write('<html><body>');
		res.end('hi</body></html>');
		expect(res.finalBody!.toString('utf8')).toContain('/__stylewright/client.js');
	});

	it('never injects twice (idempotent)', () => {
		const res = makeRes();
		run(res);
		res.setHeader('content-type', 'text/html');
		res.end('<html><body><script src="/__stylewright/client.js" defer></script></body></html>');
		expect(res.finalBody!.toString('utf8').match(/\/__stylewright\/client\.js/g)?.length).toBe(1);
	});

	it('handles Uint8Array body chunks without corrupting them (SvelteKit streams)', () => {
		const res = makeRes();
		run(res);
		res.setHeader('content-type', 'text/html');
		const enc = new TextEncoder();
		res.write(enc.encode('<html><body>café '));
		res.end(enc.encode('done</body></html>'));
		const body = res.finalBody!.toString('utf8');
		expect(body).toContain('café done'); // real text, NOT "60,47,98,..."
		expect(body).not.toMatch(/\d{2,3},\d{2,3},\d{2,3}/); // no comma-joined byte garbage
		expect(body).toContain('/__stylewright/client.js" defer></script></body>'); // injected before </body>
	});

	it('handles CROSS-REALM Uint8Array chunks (the real SvelteKit SSR case)', () => {
		const res = makeRes();
		run(res);
		res.setHeader('content-type', 'text/html');
		// SvelteKit's SSR runs in a separate module realm (Vite uses a vm context), so
		// its streamed chunks are Uint8Arrays whose `instanceof Uint8Array` is FALSE in
		// this realm. Reproduce that exactly with vm.runInNewContext — a same-realm
		// `new TextEncoder().encode()` does NOT exercise this path.
		const mk = (s: string): Uint8Array => {
			const ctx: { codes: number[]; out?: Uint8Array } = { codes: [...Buffer.from(s, 'utf8')] };
			vm.runInNewContext('out = Uint8Array.from(codes)', ctx);
			return ctx.out as Uint8Array;
		};
		const a = mk('<html><body>café ');
		const b = mk('done</body></html>');
		expect(a instanceof Uint8Array).toBe(false); // proves the cross-realm condition holds
		res.write(a);
		res.end(b);
		const body = res.finalBody!.toString('utf8');
		expect(body).toContain('café done'); // real text, NOT "60,47,98,..."
		expect(body).not.toMatch(/\d{2,3},\d{2,3},\d{2,3}/); // no comma-joined byte garbage
		expect(body).toContain('/__stylewright/client.js" defer></script></body>'); // injected before </body>
	});

	it('leaves non-HTML responses untouched', () => {
		const res = makeRes();
		run(res);
		res.setHeader('content-type', 'application/json');
		res.end('{"ok":true}');
		expect(res.finalBody!.toString('utf8')).toBe('{"ok":true}');
	});

	it('skips requests that do not accept html (passes through)', () => {
		const res = makeRes();
		const next = run(res, '*/*');
		expect(next).toHaveBeenCalled();
		res.setHeader('content-type', 'text/html');
		res.end('<html><body>x</body></html>');
		expect(res.finalBody!.toString('utf8')).not.toContain('/__stylewright/client.js');
	});
});
