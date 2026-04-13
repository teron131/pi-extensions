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
	const isBoilerplate = (piece) =>
		boilerplatePatterns.some((pattern) => pattern.test(piece));
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
		pieces = trimLeadingGarbage(cleanPieces(pieces));
		paragraphs = trimLeadingGarbage(cleanPieces(paragraphs));
		let content = pieces.join("\n\n");
		if (content.length < 300) {
			content = normalize(clone.innerText || clone.textContent || "");
		}
		return { pieces, paragraphs, content };
	};

	if (
		location.hostname === "github.com" &&
		location.pathname.includes("/blob/")
	) {
		const title = normalize(document.title || "");
		const codeNode =
			document.querySelector('[data-testid="code-view-lines"]') ||
			document.querySelector('[data-testid="read-only-cursor-text-area"]') ||
			document.querySelector(".react-code-text") ||
			document.querySelector("table.js-file-line-container") ||
			document.querySelector(".js-file-line-container") ||
			document.querySelector(".highlight");
		const codeText = normalize(codeNode?.textContent || "");
		const content = clip(
			codeText || normalize(document.body?.innerText || ""),
			contentLimit,
		);
		return {
			summary: clip(title, 280),
			content,
		};
	}

	if (
		location.hostname === "www.youtube.com" &&
		location.pathname === "/watch"
	) {
		const title =
			normalize(document.querySelector("h1")?.textContent || "") ||
			normalize(document.title || "");
		const description = normalize(
			document.querySelector("#description-inline-expander")?.textContent ||
				document
					.querySelector('meta[name="description"]')
					?.getAttribute("content") ||
				"",
		);
		const channel = normalize(
			document.querySelector("ytd-channel-name")?.textContent || "",
		);
		const pieces = cleanPieces([title, channel, description]);
		const content = clip(pieces.join("\n\n"), contentLimit);
		return {
			summary: clip(description || title, 280),
			content,
		};
	}

	const blockSelectors = [
		"main article",
		"article",
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
		content = rawBody;
		pieces = cleanPieces(content.split("\n\n"));
		paragraphs = pieces.filter(
			(piece) =>
				piece.length >= 40 && !isCodeLike(piece) && !isBoilerplate(piece),
		);
	}

	const titleSummary = makeTitleSummary();
	const metaDescription = normalize(
		document
			.querySelector(
				"meta[name='description'], meta[property='og:description']",
			)
			?.getAttribute("content") || "",
	);
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
