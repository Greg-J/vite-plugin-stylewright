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
      <Button label="Edit me" secondary />
	</div>
</main>

<style>
	main {
		max-width: 600px;
		margin: 48px auto;
		/* extra bottom room so content never sits inside the torn edge */
		padding: 28px 24px 44px 64px;
		font-family: system-ui, sans-serif;
		color: #15202b;
		background-color: #fff9c4;
		background-image:
			repeating-linear-gradient(
				to bottom,
				transparent,
				transparent 31px,
				#90caf9 31px,
				#90caf9 32px
			),
			/* one margin rule, not a repeat */
			linear-gradient(
				to right,
				transparent 43px,
				#ef9a9a 43px,
				#ef9a9a 45px,
				transparent 45px
			);
		border: 1px solid #e0d4a0;
		border-radius: 2px 2px 0 0;
		box-shadow: inset 0 0 20px rgba(0,0,0,0.02);
		/* drop-shadow follows the clip silhouette; box-shadow would be clipped flat */
		filter: drop-shadow(0 2px 3px rgba(0,0,0,0.22));
		position: relative;
		/* fixed-px depths so the tear doesn't scale with content height */
		clip-path: polygon(
			0 0,
			100% 0,
			100% calc(100% - 7px),
			98% calc(100% - 10px),
			95% calc(100% - 5px),
			92% calc(100% - 14px),
			89% calc(100% - 9px),
			86% calc(100% - 4px),
			83% calc(100% - 13px),
			80% calc(100% - 7px),
			77% calc(100% - 11px),
			74% calc(100% - 2px),
			71% calc(100% - 6px),
			68% calc(100% - 15px),
			65% calc(100% - 10px),
			62% calc(100% - 5px),
			59% calc(100% - 12px),
			56% calc(100% - 3px),
			53% calc(100% - 7px),
			50% calc(100% - 16px),
			47% calc(100% - 9px),
			44% calc(100% - 4px),
			41% calc(100% - 14px),
			38% calc(100% - 6px),
			35% calc(100% - 11px),
			32% calc(100% - 2px),
			29% calc(100% - 8px),
			26% calc(100% - 13px),
			23% calc(100% - 5px),
			20% calc(100% - 10px),
			17% calc(100% - 3px),
			14% calc(100% - 7px),
			11% calc(100% - 15px),
			8% calc(100% - 6px),
			5% calc(100% - 12px),
			2% calc(100% - 4px),
			0 calc(100% - 9px)
		);
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
