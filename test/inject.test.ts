import { describe, it, expect, vi } from 'vitest';
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
