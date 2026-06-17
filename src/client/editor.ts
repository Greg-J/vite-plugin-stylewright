// Baseline editor — a plain <textarea> bound to the component's <style>, with a
// debounced save. CodeMirror has been stripped out; this is the bare foundation
// we'll grow our own editor on (syntax highlighting, inline widgets, scrub, color
// picker — all custom from here).

export interface EditorHandle {
	getValue(): string;
	destroy(): void;
}

/**
 * Mount the editor into `parent`, seeded with `doc`. `onChange` fires debounced
 * with the full text.
 */
export function createEditor(
	parent: HTMLElement,
	doc: string,
	onChange: (value: string) => void
): EditorHandle {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const ta = document.createElement('textarea');
	ta.className = 'sw-textarea';
	ta.value = doc;
	ta.spellcheck = false;
	ta.setAttribute('autocomplete', 'off');
	ta.setAttribute('autocapitalize', 'off');
	ta.setAttribute('wrap', 'off');
	ta.addEventListener('input', () => {
		clearTimeout(timer);
		timer = setTimeout(() => onChange(ta.value), 300);
	});

	parent.appendChild(ta);

	return {
		getValue: () => ta.value,
		destroy: () => {
			clearTimeout(timer);
			ta.remove();
		}
	};
}
