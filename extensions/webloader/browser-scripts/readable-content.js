() => {
	const whitespacePattern = /[ \t]+/g;
	const newlinePattern = /\n{3,}/g;
	const contentLimit = 32000;
	const normalize = (text) =>
		(text || "")
			.split("\u00a0")
			.join(" ")
			.replace(whitespacePattern, " ")
			.replace(newlinePattern, "\n\n")
			.trim();
	const clip = (text, limit) =>
		text.length > limit ? `${text.slice(0, limit).trimEnd()}...` : text;
	const cleanPieces = (pieces) =>
		pieces
			.map((piece) => normalize(piece))
			.filter(Boolean)
			.filter((piece, idx, arr) => idx === 0 || arr[idx - 1] !== piece);
	const linesFromText = (text) => cleanPieces((text || "").split(/\n+/g));
	const boilerplatePatterns = [
		/^home$/i,
		/^products$/i,
		/^overview$/i,
		/^get started$/i,
		/^install$/i,
		/^quickstart$/i,
		/^changelog$/i,
		/^philosophy$/i,
		/^core components$/i,
		/^agents$/i,
		/^models$/i,
		/^messages$/i,
		/^tools$/i,
		/^streaming$/i,
		/^structured output$/i,
		/^middleware$/i,
		/^frontend$/i,
		/^advanced usage$/i,
		/^guardrails$/i,
		/^runtime$/i,
		/^context engineering$/i,
		/^model context protocol/i,
		/^human-in-the-loop$/i,
		/^retrieval$/i,
		/^long-term memory$/i,
		/^agent development$/i,
		/^on this page$/i,
		/^stay organized with collections$/i,
		/^save and categorize content based on your preferences\.?$/i,
		/^documentation$/i,
	];
	const uiGarbagePatterns = [
		/^skip to (main )?content$/i,
		/^navigation menu$/i,
		/^provide feedback$/i,
		/^saved searches$/i,
		/^use saved searches to filter your results more quickly$/i,
		/^you must be signed in/i,
		/^(sign in|sign up|log in|login|log out)$/i,
		/^(light|dark)$/i,
		/^(download|full width|share|save|subscribe)$/i,
		/^(view all|show less|show more|collapse|expand)$/i,
		/^(sections|services|website|company|site theme)$/i,
		/^(about|contact us|terms of use|privacy policy|faq|advertise)$/i,
		/^if playback doesn't begin shortly/i,
		/^you're signed out/i,
		/^watch full video$/i,
		/^up next$/i,
		/^back$/i,
		/^an error occurred while retrieving sharing information/i,
	];
	const isBoilerplate = (piece) =>
		boilerplatePatterns.some((pattern) => pattern.test(piece));
	const isUiGarbage = (piece) =>
		uiGarbagePatterns.some((pattern) => pattern.test(piece));
	const isCodeLike = (piece) => {
		if (!piece) {
			return false;
		}
		if (
			piece.includes("import ") ||
			piece.includes("const ") ||
			piece.includes("function ") ||
			piece.includes("class ")
		) {
			return true;
		}
		const codeMarkers = ["{", "}", "=>", "::", "npm install", "pip install"];
		const markerHits = codeMarkers.filter((marker) =>
			piece.includes(marker),
		).length;
		return markerHits >= 2;
	};
	const filterObviousGarbage = (pieces) =>
		cleanPieces(pieces).filter((piece) => {
			if (!piece) {
				return false;
			}
			if (isUiGarbage(piece)) {
				return false;
			}
			if (piece.length <= 2 && !/\d/.test(piece) && !isCodeLike(piece)) {
				return false;
			}
			return true;
		});
	const trimLeadingGarbage = (pieces) => {
		const trimmed = [...pieces];
		while (trimmed.length > 1) {
			const candidate = trimmed[0];
			if (isBoilerplate(candidate)) {
				trimmed.shift();
				continue;
			}
			if (
				candidate.length < 40 &&
				!/[.!?]/.test(candidate) &&
				!isCodeLike(candidate)
			) {
				trimmed.shift();
				continue;
			}
			break;
		}
		return trimmed;
	};
	const trimTrailingGarbage = (pieces) => {
		const trimmed = [...pieces];
		while (trimmed.length > 1) {
			const candidate = trimmed[trimmed.length - 1];
			if (isUiGarbage(candidate) || isBoilerplate(candidate)) {
				trimmed.pop();
				continue;
			}
			if (
				candidate.length < 30 &&
				!/[.!?]/.test(candidate) &&
				!isCodeLike(candidate)
			) {
				trimmed.pop();
				continue;
			}
			break;
		}
		return trimmed;
	};
	const makeTitleSummary = () => {
		const headingText = normalize(
			document.querySelector("main h1, article h1, h1")?.textContent || "",
		);
		if (headingText) {
			return headingText;
		}
		const pageTitle = normalize(document.title || "");
		return pageTitle.replace(/\s+[|·-]\s+[^|·-]+$/g, "").trim();
	};
	const readMetaDescription = () =>
		normalize(
			document
				.querySelector(
					"meta[name='description'], meta[property='og:description']",
				)
				?.getAttribute("content") || "",
		);
	const pickLongest = (selectors) => {
		let best = null;
		let bestLength = 0;
		for (const selector of selectors) {
			for (const candidate of document.querySelectorAll(selector)) {
				const length = normalize(
					candidate.innerText || candidate.textContent || "",
				).length;
				if (length > bestLength) {
					best = candidate;
					bestLength = length;
				}
			}
		}
		return best;
	};
	const pickSummary = (paragraphs, pieces, fallbackContent) =>
		paragraphs.find(
			(piece) =>
				piece.length >= 80 &&
				piece.length <= 320 &&
				!isCodeLike(piece) &&
				!isBoilerplate(piece),
		) ||
		paragraphs.find(
			(piece) =>
				piece.length >= 40 && !isCodeLike(piece) && !isBoilerplate(piece),
		) ||
		pieces.find(
			(piece) =>
				piece.length >= 80 &&
				piece.length <= 320 &&
				!isCodeLike(piece) &&
				!isBoilerplate(piece),
		) ||
		pieces.find(
			(piece) =>
				piece.length >= 40 && !isCodeLike(piece) && !isBoilerplate(piece),
		) ||
		pieces.find((piece) => piece.length >= 80) ||
		pieces[0] ||
		fallbackContent.split("\n\n")[0] ||
		"";
	const extractFrom = (rootNode, selectors) => {
		if (!rootNode) {
			return { pieces: [], paragraphs: [], content: "" };
		}
		const clone = rootNode.cloneNode(true);
		for (const selector of selectors) {
			for (const node of clone.querySelectorAll(selector)) {
				node.remove();
			}
		}
		let pieces = [];
		let paragraphs = [];
		const nodes = clone.querySelectorAll(
			"h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,td,th,dd,dt",
		);
		for (const node of nodes) {
			const text = normalize(node.innerText || node.textContent || "");
			if (!text) {
				continue;
			}
			pieces.push(text);
			const tagName = node.tagName.toLowerCase();
			if (
				tagName === "p" ||
				tagName === "li" ||
				tagName === "blockquote" ||
				tagName === "figcaption" ||
				tagName === "dd" ||
				tagName === "dt" ||
				tagName === "td"
			) {
				paragraphs.push(text);
			}
		}
		pieces = trimTrailingGarbage(
			trimLeadingGarbage(filterObviousGarbage(pieces)),
		);
		paragraphs = trimTrailingGarbage(
			trimLeadingGarbage(filterObviousGarbage(paragraphs)),
		);
		let content = pieces.join("\n\n");
		if (content.length < 300) {
			content = normalize(clone.innerText || clone.textContent || "");
		}
		return { pieces, paragraphs, content };
	};

	const blockSelectors = [
		"main article",
		"article",
		".markdown-body",
		"[itemprop='text']",
		"[data-testid='code-view-lines']",
		"table.js-file-line-container",
		".js-file-line-container",
		".highlight",
		"pre",
		"[role='main']",
		"main",
		".main-content",
		".documentation",
		".docs-content",
		".docMainContainer",
		".theme-doc-markdown",
		".markdown",
		".md-content",
		".prose",
		".article-content",
		".article-body",
		".entry-content",
		".post-content",
		".post-body",
		".content",
		".story-body",
		".devsite-article",
		".devsite-content",
		".devsite-article-body",
		".documentation-content",
	];
	const broadNoiseSelectors = [
		"script",
		"style",
		"noscript",
		"template",
		"svg",
		"canvas",
		"video",
		"audio",
		"iframe",
		"img",
		"picture",
		"source",
		"form",
		"button",
		"input",
		"select",
		"textarea",
		"nav",
		"header",
		"footer",
		"aside",
		"dialog",
		"[aria-hidden='true']",
		"[hidden]",
		".nav",
		".navbar",
		".sidebar",
		".footer",
		".header",
		".menu",
		".share",
		".social",
		".cookie",
		".consent",
		".advertisement",
		".ads",
		".breadcrumb",
		".related",
		".recommend",
	];
	const focusedNoiseSelectors = [
		...broadNoiseSelectors,
		"[class*='sidebar']",
		"[class*='toc']",
		"[class*='table-of-contents']",
		"[class*='navigation']",
		"[id*='sidebar']",
		"[id*='toc']",
		"[data-testid*='sidebar']",
		"[data-testid*='toc']",
		".devsite-page-nav",
		".devsite-book-nav",
		".devsite-sidebar",
		".table-of-contents",
		".toc",
		".contents",
	];
	const rawBody = normalize(
		document.body?.innerText || document.documentElement?.innerText || "",
	);
	const focusedRoot =
		pickLongest(blockSelectors) ||
		document.querySelector("main") ||
		document.body ||
		document.documentElement;
	const broadRoot =
		document.querySelector("main") ||
		focusedRoot ||
		document.body ||
		document.documentElement;
	const focused = extractFrom(focusedRoot, focusedNoiseSelectors);
	const broad = extractFrom(broadRoot, broadNoiseSelectors);
	let pieces = focused.pieces;
	let paragraphs = focused.paragraphs;
	let content = focused.content;
	const focusedTooThin =
		content.length < 1200 ||
		(rawBody.length > 4000 && content.length < rawBody.length * 0.18);
	if (
		focusedTooThin &&
		broad.content.length > Math.max(content.length * 1.35, 1200)
	) {
		pieces = broad.pieces;
		paragraphs = broad.paragraphs;
		content = broad.content;
	}
	if (content.length < 500) {
		pieces = trimTrailingGarbage(
			trimLeadingGarbage(filterObviousGarbage(linesFromText(rawBody))),
		);
		content = pieces.join("\n\n");
		paragraphs = pieces.filter(
			(piece) =>
				piece.length >= 40 &&
				!isCodeLike(piece) &&
				!isBoilerplate(piece) &&
				!isUiGarbage(piece),
		);
	}
	if (content.length >= 500) {
		const filteredPieces = trimTrailingGarbage(
			trimLeadingGarbage(filterObviousGarbage(linesFromText(content))),
		);
		const filteredContent = filteredPieces.join("\n\n");
		if (filteredContent.length >= Math.min(400, content.length * 0.45)) {
			content = filteredContent;
			pieces = filteredPieces;
			paragraphs = pieces.filter(
				(piece) =>
					piece.length >= 40 &&
					!isCodeLike(piece) &&
					!isBoilerplate(piece) &&
					!isUiGarbage(piece),
			);
		}
	}

	const titleSummary = makeTitleSummary();
	const metaDescription = readMetaDescription();
	let summarySource =
		(!isCodeLike(metaDescription) && !isBoilerplate(metaDescription)
			? metaDescription
			: "") ||
		(!isCodeLike(titleSummary) && !isBoilerplate(titleSummary)
			? titleSummary
			: "") ||
		pickSummary(paragraphs, pieces, content);
	if (
		isCodeLike(summarySource) ||
		summarySource.includes("Stay organized with collections") ||
		summarySource.includes(
			"Save and categorize content based on your preferences",
		)
	) {
		summarySource = titleSummary || summarySource;
	}

	return {
		summary: clip(summarySource, 280),
		content: clip(content, contentLimit),
	};
};
