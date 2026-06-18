<script>
	let { label = 'Button' } = $props();
</script>

<button class="btn">{label}</button>

<style>
	.btn {
		background: #ff3e00;
		color: #ffffff;
		border: 0;
		padding: 10px 18px;
		border-radius: 6px;
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
	}

	.btn:hover {
		background: #e63600;
	}
</style>
