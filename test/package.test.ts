// Packaging guards: keep the npm metadata and the exports map publish-correct so a
// future edit can't silently drop them before release (PRAC-1, PRAC-2).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

describe('package.json — repo metadata (PRAC-1)', () => {
	it('exposes repository / bugs / homepage so npm can link the source', () => {
		expect(pkg.repository?.url).toContain('github.com/Greg-J/vite-plugin-stylewright');
		expect(pkg.bugs?.url).toMatch(/github\.com\/.+\/issues/);
		expect(typeof pkg.homepage).toBe('string');
	});
});

describe('package.json — exports types per condition (PRAC-2)', () => {
	it('splits types for import (ESM) and require (CJS) so node16/nodenext resolve right', () => {
		const dot = pkg.exports['.'];
		expect(dot.import.types).toBe('./dist/index.d.ts');
		expect(dot.import.default).toBe('./dist/index.js');
		expect(dot.require.types).toBe('./dist/index.d.cts'); // CJS-flavored types, not the ESM .d.ts
		expect(dot.require.default).toBe('./dist/index.cjs');
	});
});
