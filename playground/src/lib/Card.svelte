<script>
	let { title = 'Card' } = $props();
</script>

<div class="card">
	<h2 class="title">{title}</h2>
	<p class="body">Edit my padding, color, or radius — then watch this file change on disk.</p>
</div>

<style>
	.card {
		background: #eee;
		border: 1px solid #e3e3e3;
		border-radius: 12px;
		padding: 24px;
		box-shadow: 0 8px 24px -12px #8f2424;
	}
	.title {
		margin: 0 0 8px;
		color: #0c2a30;
		font-size: 20px;
	}
	.body {
		margin: 0;
		color: #5b6b73;
		line-height: 1.5;
	}
</style>
