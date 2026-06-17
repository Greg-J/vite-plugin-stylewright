import { describe, it, expect } from 'vitest';
import { applyEdit, readRules, readStyle, applyStyleBlock } from '../src/server/patch.js';
import { findStyleBlock } from '../src/server/locate.js';

const SAMPLE = `<script>
  let count = 0;
</script>

<button class="btn" on:click={() => count++}>{count}</button>

<style>
  .btn {
    color: #333;
    padding: 8px 14px;
    border-radius: 4px;
  }
  .btn:hover {
    color: #000;
  }
</style>
`;

describe('findStyleBlock', () => {
	it('locates the inner CSS by exact offset', () => {
		const block = findStyleBlock(SAMPLE);
		expect(block).not.toBeNull();
		expect(SAMPLE.slice(block!.start, block!.end)).toBe(block!.css);
		expect(block!.css).toContain('.btn');
	});

	it('returns null when there is no <style>', () => {
		expect(findStyleBlock('<p>hi</p>')).toBeNull();
	});

	it('survives attributes on the style tag', () => {
		const src = '<style lang="postcss">\n.a { color: red; }\n</style>';
		const block = findStyleBlock(src);
		expect(block!.css.trim()).toBe('.a { color: red; }');
	});
});

describe('readRules', () => {
	it('lists source selectors + declarations', () => {
		const { hasStyle, rules } = readRules(SAMPLE);
		expect(hasStyle).toBe(true);
		const btn = rules.find((r) => r.selector === '.btn');
		expect(btn).toBeDefined();
		expect(btn!.decls).toContainEqual({ prop: 'color', value: '#333' });
		expect(btn!.decls).toContainEqual({ prop: 'padding', value: '8px 14px' });
	});
});

describe('applyEdit', () => {
	it('updates an existing declaration, touching only the <style>', () => {
		const res = applyEdit(SAMPLE, { file: 'X.svelte', selector: '.btn', prop: 'color', value: '#ff3e00' });
		expect(res.matched).toBe(true);
		expect(res.changed).toBe(true);
		expect(res.code).toContain('color: #ff3e00;');
		// surrounding markup + script left intact
		expect(res.code).toContain('let count = 0;');
		expect(res.code).toContain('<button class="btn"');
		// sibling declarations preserved
		expect(res.code).toContain('padding: 8px 14px;');
		// the :hover rule's color is untouched (first match wins on .btn)
		expect(res.code).toContain('color: #000;');
	});

	it('appends a declaration when the property is absent', () => {
		const res = applyEdit(SAMPLE, { file: 'X.svelte', selector: '.btn', prop: 'background', value: 'gold' });
		expect(res.changed).toBe(true);
		expect(res.code).toContain('background: gold');
	});

	it('reports matched:false for an unknown selector and changes nothing', () => {
		const res = applyEdit(SAMPLE, { file: 'X.svelte', selector: '.nope', prop: 'color', value: 'red' });
		expect(res.matched).toBe(false);
		expect(res.changed).toBe(false);
		expect(res.code).toBe(SAMPLE);
	});

	it('is a no-op when the value is unchanged', () => {
		const res = applyEdit(SAMPLE, { file: 'X.svelte', selector: '.btn', prop: 'color', value: '#333' });
		expect(res.changed).toBe(false);
		expect(res.matched).toBe(true);
	});

	it('handles a component with no <style>', () => {
		const res = applyEdit('<p>hi</p>', { file: 'X.svelte', selector: '.btn', prop: 'color', value: 'red' });
		expect(res.changed).toBe(false);
		expect(res.matched).toBe(false);
	});
});

describe('readStyle', () => {
	it('returns the raw inner CSS of the <style>', () => {
		const { hasStyle, css } = readStyle(SAMPLE);
		expect(hasStyle).toBe(true);
		expect(css).toBe(findStyleBlock(SAMPLE)!.css);
		expect(css).toContain('.btn {');
	});

	it('hasStyle:false when there is no <style>', () => {
		expect(readStyle('<p>x</p>').hasStyle).toBe(false);
	});
});

describe('applyStyleBlock', () => {
	it('replaces the whole <style> body, leaving markup + script intact', () => {
		const res = applyStyleBlock(SAMPLE, '\n  .btn { color: rebeccapurple; }\n');
		expect(res.changed).toBe(true);
		expect(res.code).toContain('color: rebeccapurple;');
		expect(res.code).toContain('let count = 0;');
		expect(res.code).toContain('<button class="btn"');
		// the whole block was replaced, so the old declarations are gone
		expect(res.code).not.toContain('padding: 8px 14px;');
	});

	it('is a no-op when the css is identical', () => {
		const same = findStyleBlock(SAMPLE)!.css;
		expect(applyStyleBlock(SAMPLE, same).changed).toBe(false);
	});

	it('no <style> -> no change', () => {
		expect(applyStyleBlock('<p>x</p>', '.a { color: red; }').changed).toBe(false);
	});
});
