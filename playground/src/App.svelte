<script>
	import Button from './lib/Button.svelte';
	import Card from './lib/Card.svelte';
</script>

<main>
	<h1>Stylewright playground</h1>
	<p class="lead">
		Click the <strong>✎</strong> button (bottom-right), then click any element below to edit its
		component's CSS. Saves land in <code>src/lib/*.svelte</code>.
	</p>

	<Card title="A card component" />

	<div class="row">
		<Button label="Primary" />
		<Button label="Edit me" />
	</div>
</main>

<style>
	main {
		max-width: 640px;
		margin: 48px auto;
		padding: 0 20px;
		font-family: system-ui, sans-serif;
		color: #15202b;
	}
	h1 {
		color: #0c2a30;
		font-size: 30px;
		margin: 0 0 8px;
	}
	.lead {
		color: #5b6b73;
		line-height: 1.5;
		margin: 0 0 28px;
	}
	code {
		font-family: ui-monospace, monospace;
		font-size: 13px;
		background: #f2f2f2;
		padding: 1px 5px;
		border-radius: 4px;
	}
	.row {
		display: flex;
		gap: 12px;
		margin-top: 24px;
	}
</style>
