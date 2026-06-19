// @vitest-environment happy-dom
//
// The pure element→file resolution and DOM-tree model that the HTML panel is
// built on. happy-dom gives us a real document to walk; __svelte_meta is the
// dev-only marker Svelte stamps on elements, which we set by hand here.

import { describe, it, expect, afterEach } from 'vitest';
import { buildDomTree, describe as describeEl, pathPrefixes, resolveFile, tagLabel } from '../src/client/inspect.js';

type Meta = { __svelte_meta?: { loc?: { file?: string } } };
const stamp = (el: Element, file: string) => { (el as unknown as Meta).__svelte_meta = { loc: { file } }; };

afterEach(() => { document.body.innerHTML = ''; });

describe('buildDomTree', () => {
	it('nests element children and skips non-visual tags + the host', () => {
		document.body.innerHTML = '<div class="card"><span>hi</span><script></script></div>';
		const host = document.createElement('div');
		document.body.appendChild(host);
		const { roots, byEl } = buildDomTree(document.body, host);
		expect(roots).toHaveLength(1);
		const bodyNode = roots[0];
		expect(bodyNode.tag).toBe('body');
		// body's children: the card and the host element — host is skipped
		expect(bodyNode.children.map((c) => c.tag)).toEqual(['div']);
		const card = bodyNode.children[0];
		expect(card.classes).toEqual(['card']);
		// span kept, <script> skipped
		expect(card.children.map((c) => c.tag)).toEqual(['span']);
		expect(byEl.get(document.querySelector('.card')!)).toBe(card);
	});

	it('assigns stable child-index paths even when earlier siblings are skipped', () => {
		document.body.innerHTML = '<style></style><div id="a"></div><div id="b"></div>';
		const { byEl } = buildDomTree(document.body, null);
		// <style> is child 0 (skipped), #a is child 1, #b is child 2
		expect(byEl.get(document.getElementById('a')!)!.path).toBe('r/1');
		expect(byEl.get(document.getElementById('b')!)!.path).toBe('r/2');
	});

	it('flags component boundaries via __svelte_meta and inherits otherwise', () => {
		document.body.innerHTML = '<div id="a"><div id="b"><span id="c"></span></div></div>';
		const a = document.getElementById('a')!, b = document.getElementById('b')!, c = document.getElementById('c')!;
		stamp(a, 'src/A.svelte');
		stamp(b, 'src/widgets/B.svelte');
		const { byEl } = buildDomTree(document.body, null);
		expect(byEl.get(a)!.ownsFile).toBe(true);
		expect(byEl.get(a)!.fileLabel).toBe('src/A.svelte');
		expect(byEl.get(b)!.ownsFile).toBe(true);
		expect(byEl.get(b)!.fileLabel).toBe('widgets/B.svelte');
		// c has no own metadata → inherits B's file, not a boundary
		expect(byEl.get(c)!.ownsFile).toBe(false);
		expect(byEl.get(c)!.file).toBe('src/widgets/B.svelte');
	});
});

describe('pathPrefixes', () => {
	it('returns every inclusive prefix of a node path', () => {
		expect([...pathPrefixes('r/0/3')]).toEqual(['r', 'r/0', 'r/0/3']);
		expect([...pathPrefixes('r')]).toEqual(['r']);
	});
});

describe('describe / resolveFile', () => {
	it('fills fileLabel + a representative selector from svelte meta', () => {
		document.body.innerHTML = '<button class="btn primary">x</button>';
		const btn = document.querySelector('button')!;
		stamp(btn, 'src/lib/Button.svelte');
		expect(resolveFile(btn)).toBe('src/lib/Button.svelte');
		const m = describeEl(btn);
		expect(m.fileLabel).toBe('lib/Button.svelte');
		expect(m.selectorLabel).toBe('.btn');
		expect(m.tag).toBe('<button class="btn primary">');
	});

	it('resolves a file from an ancestor when the element itself has none', () => {
		document.body.innerHTML = '<div id="wrap"><span id="leaf"></span></div>';
		const wrap = document.getElementById('wrap')!;
		stamp(wrap, 'src/Wrap.svelte');
		expect(resolveFile(document.getElementById('leaf')!)).toBe('src/Wrap.svelte');
		expect(tagLabel(wrap)).toBe('<div>'); // tagLabel surfaces class, not id
	});
});
