() =>
	[...document.links].slice(0, __MAX_LINKS__).map((link) => ({
		text: (link.textContent || "").trim(),
		href: link.href,
	}));
