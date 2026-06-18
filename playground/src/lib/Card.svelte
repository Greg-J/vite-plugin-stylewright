<script>
	let { title = 'Card' } = $props();
</script>

<div class="card">
	<h2 class="title">{title}</h2>
	<p class="body">Edit my padding, color, or radius — then watch this file change on disk.</p>
</div>

<style>
	.card {
		background: #e3e3e3;
		border: 1px solid #e3e3e3;
		border-radius: 12px;
		padding: 24px;
		box-shadow: 0 8px 24px -12px #0c2a30;
	}

	.title {
		margin: 0 0 9px;
		color: #2392a894;
		font-size: 20px;
		font-family: "IBM Plex Mono", sans-serif;
	}

	.body {
		margin: 0;
		color: #5b6b73;
		line-height: 1.5;
	}
</style>
