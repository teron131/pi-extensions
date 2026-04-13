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
	const uniquePieces = (pieces) => {
		const seen = new Set();
		return cleanPieces(pieces).filter((piece) => {
			if (seen.has(piece)) {
				return false;
			}
			seen.add(piece);
			return true;
		});
	};
	const linesFromText = (text) => cleanPieces((text || "").split(/\n+/g));
	const findText = (selectors) => {
		for (const selector of selectors) {
			const node = document.querySelector(selector);
			const text = normalize(node?.textContent || node?.innerText || "");
			if (text) {
				return text;
			}
		}
		return "";
	};
	const readMeta = (selectors) => {
		for (const selector of selectors) {
			const value = normalize(
				document.querySelector(selector)?.getAttribute("content") || "",
			);
			if (value) {
				return value;
			}
		}
		return "";
	};
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

	if (location.hostname === "github.com") {
		const pathParts = location.pathname.split("/").filter(Boolean);
		const repoSection = pathParts[2] || "";
		const isRepoRoot =
			pathParts.length >= 2 &&
			!repoSection &&
			!location.pathname.includes("/blob/") &&
			!location.pathname.includes("/tree/");
		if (isRepoRoot) {
			const title = normalize(document.title || "");
			const description =
				findText([
					'[data-testid="repository-description"]',
					'[itemprop="about"]',
				]) ||
				readMeta([
					'meta[name="description"]',
					'meta[property="og:description"]',
				]);
			const readme = normalize(
				document.querySelector(
					'article.markdown-body, .markdown-body, [itemprop="text"]',
				)?.innerText || "",
			);
			const stars = normalize(
				document.querySelector(
					'#repo-stars-counter-star, a[href$="/stargazers"] strong, a[href$="/stargazers"]',
				)?.textContent || "",
			);
			const forks = normalize(
				document.querySelector(
					'#repo-network-counter, a[href$="/forks"] strong, a[href$="/forks"]',
				)?.textContent || "",
			);
			const content = clip(
				cleanPieces([
					description,
					stars ? `Stars: ${stars}` : "",
					forks ? `Forks: ${forks}` : "",
					readme,
				]).join("\n\n"),
				contentLimit,
			);
			return {
				summary: clip(description || title, 280),
				content,
			};
		}
	}

	if (
		location.hostname === "www.youtube.com" &&
		location.pathname === "/watch"
	) {
		const title =
			normalize(
				document.querySelector("ytd-watch-metadata h1, h1")?.textContent || "",
			) || normalize(document.title || "");
		const playerDetails =
			typeof ytInitialPlayerResponse !== "undefined"
				? ytInitialPlayerResponse?.videoDetails || null
				: null;
		const rawDescription = normalize(
			playerDetails?.shortDescription ||
				document.querySelector("#description-inline-expander")?.textContent ||
				document
					.querySelector('meta[name="description"]')
					?.getAttribute("content") ||
				"",
		);
		const richTitle = normalize(playerDetails?.title || title);
		const description = normalize(
			rawDescription
				.split(
					/How this was made|Chapters|Transcript|Explore the podcast|Show less/i,
				)[0]
				.replace(/\.\.\.more$/i, "")
				.replace(/\s*Show less$/i, ""),
		);
		const channel =
			normalize(playerDetails?.author || "") ||
			normalize(
				document.querySelector("ytd-channel-name a, ytd-channel-name")
					?.textContent || "",
			);
		const stats =
			cleanPieces([
				playerDetails?.viewCount ? `Views: ${playerDetails.viewCount}` : "",
				playerDetails?.lengthSeconds
					? `Duration: ${playerDetails.lengthSeconds} seconds`
					: "",
				readMeta(['meta[itemprop="datePublished"]'])
					? `Published: ${readMeta(['meta[itemprop="datePublished"]'])}`
					: "",
			]).join("\n") ||
			findText(["#info-text", "ytd-watch-info-text", "#owner-sub-count"]);
		const descriptionParts = rawDescription.split(/Timestamps:/i);
		const chapterText = descriptionParts[1] || "";
		const chapters = uniquePieces(
			linesFromText(chapterText).filter((line) =>
				/^\d{1,2}:\d{2}\s+/.test(line),
			),
		).slice(0, 20);
		const transcriptHint = normalize(
			[...document.querySelectorAll("*")]
				.map((node) => normalize(node.textContent || ""))
				.find(
					(text) => text.includes("Show transcript") && text.length < 120,
				) || "",
		);
		const pieces = cleanPieces([
			richTitle,
			channel,
			stats,
			description,
			chapters.length ? `Chapters:\n${chapters.join("\n")}` : "",
			transcriptHint ? "Transcript available in the page UI." : "",
		]);
		const content = clip(pieces.join("\n\n"), contentLimit);
		return {
			summary: clip(description || richTitle, 280),
			content,
		};
	}

	if (
		location.hostname === "artificialanalysis.ai" &&
		location.pathname === "/models"
	) {
		const mainText = normalize(
			document.querySelector("main")?.innerText ||
				document.body?.innerText ||
				"",
		);
		const lines = linesFromText(mainText);
		const title =
			lines.find((line) => line.includes("Comparison of Models")) ||
			normalize(document.title || "");
		const summary =
			lines.find((line) =>
				line.includes("Comparison and analysis of AI models"),
			) ||
			readMeta([
				'meta[name="description"]',
				'meta[property="og:description"]',
			]) ||
			title;
		const sectionTitles = [
			"Intelligence",
			"Output Speed (tokens/s)",
			"Latency (seconds)",
			"Price ($ per M tokens)",
			"Context Window",
		];
		const sectionPieces = [];
		for (const sectionTitle of sectionTitles) {
			const idx = lines.indexOf(sectionTitle);
			if (idx === -1) {
				continue;
			}
			const blurb = lines
				.slice(idx + 1, idx + 5)
				.find((line) => line.length > 30 && !sectionTitles.includes(line));
			if (blurb) {
				sectionPieces.push(`${sectionTitle}: ${blurb}`);
			}
		}
		const methodology = lines.find((line) =>
			line.startsWith("Models are compared across multiple dimensions"),
		);
		const content = clip(
			cleanPieces([title, summary, ...sectionPieces, methodology]).join("\n\n"),
			contentLimit,
		);
		return {
			summary: clip(summary, 280),
			content,
		};
	}

	if (
		location.hostname === "stockanalysis.com" &&
		location.pathname.includes("/markets/heatmap")
	) {
		const mainText = normalize(
			document.querySelector("main")?.innerText ||
				document.body?.innerText ||
				"",
		);
		const lines = linesFromText(mainText);
		const startIdx = Math.max(
			0,
			lines.findIndex((line) => /S&P 500 .*Performance|Heatmap/i.test(line)),
		);
		const endIdx = lines.findIndex((line) =>
			/^(SECTIONS|SERVICES|WEBSITE|COMPANY|MARKET NEWSLETTER|SITE THEME)$/i.test(
				line,
			),
		);
		const coreLines =
			endIdx > startIdx ? lines.slice(startIdx, endIdx) : lines.slice(startIdx);
		const title =
			coreLines.find((line) => /S&P 500 .*Performance|Heatmap/i.test(line)) ||
			normalize(document.title || "");
		const description =
			coreLines.find((line) =>
				/stock performance by sector and industry|heatmap showing/i.test(line),
			) ||
			readMeta([
				'meta[name="description"]',
				'meta[property="og:description"]',
			]) ||
			title;
		const sectorLines = uniquePieces(
			coreLines.filter(
				(line) =>
					/^[A-Z][A-Za-z& /-]{3,40}$/.test(line) &&
					!/^(Download|Full Width|Light|Dark|Log In|Sign Up|Home|Tools|Collapse)$/i.test(
						line,
					) &&
					!/(Performance|Heatmap|Holdings Treemap)$/i.test(line),
			),
		).slice(0, 24);
		const holdings = uniquePieces(
			coreLines.filter((line) => /^[A-Z.]{1,6}[+-]?\d/.test(line)),
		).slice(0, 30);
		const content = clip(
			cleanPieces([
				title,
				description,
				sectorLines.length
					? `Sectors and industries:\n${sectorLines.join(", ")}`
					: "",
				holdings.length
					? `Representative holdings:\n${holdings.join(", ")}`
					: "",
			]).join("\n\n"),
			contentLimit,
		);
		return {
			summary: clip(description, 280),
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
