(el) => {
	const whitespacePattern = /[ \t]+/g;
	const newlinePattern = /\n{3,}/g;
	const content = (el.innerText || el.textContent || "")
		.split("\u00a0")
		.join(" ")
		.replace(whitespacePattern, " ")
		.replace(newlinePattern, "\n\n")
		.trim();
	return { summary: "", content };
};
