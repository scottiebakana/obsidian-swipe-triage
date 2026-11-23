import assert from "node:assert/strict";
import test from "node:test";
import {
	generateAiPrompt,
	generateDeckFileMarkdown,
	generateSampleFiles,
	parseDeckConfigFromFrontmatter,
} from "../src/deckConfig.ts";
import {
	appendSinkEntry,
	formatSinkEntry,
	matchesDeckFileFilters,
	parseDigestFile,
	parseNoteCard,
	removeSinkEntry,
	sortCards,
	updateCardVerdictInContent,
} from "../src/parser.ts";
import { createDeckFromPreset } from "../src/presets.ts";

test("parseDeckConfigFromFrontmatter parses _deck.md overrides and relative paths", () => {
	const deck = parseDeckConfigFromFrontmatter(
		{
			"swipe-triage": true,
			name: "Research inbox",
			preset: "inbox",
			mode: "notes",
			verdict_field: "triage",
			pending_value: "new",
			directions: {
				right: {
					label: "Promote",
					verdict: "promoted",
					color: "purple",
					action: "append-note",
					target_note: "./shortlist.md",
					target_heading: "## Shortlist",
				},
				down: {
					label: "Park",
					verdict: "parked",
					color: "orange",
					action: "move",
					target_folder: "./Parked",
				},
			},
		},
		"Projects/Research",
		"Projects/Research/_deck.md"
	);

	assert.ok(deck);
	assert.equal(deck.name, "Research inbox");
	assert.equal(deck.mode, "notes");
	assert.equal(deck.verdictField, "triage");
	assert.equal(deck.pendingValue, "new");
	assert.equal(deck.directions.right.label, "Promote");
	assert.equal(deck.directions.right.color, "purple");
	assert.equal(deck.directions.right.targetNote, "Projects/Research/shortlist.md");
	assert.equal(deck.directions.down.targetFolder, "Projects/Research/Parked");

	// Non-opt-in notes return null
	assert.equal(
		parseDeckConfigFromFrontmatter(
			{ title: "Regular note" },
			"Notes",
			"Notes/_deck.md"
		),
		null
	);
});

test("parseDigestFile handles structured cards, nested-bracket links, free-form cards, and CRLF lossless round-trips", () => {
	const deck = createDeckFromPreset("ai-digest", "AI-Digest");
	const sampleCrlf = [
		"---",
		'title: "Digest — 2026-11-08"',
		"status: new",
		"---",
		"",
		"# Digest — 2026-11-08",
		"",
		"## 1. Local semantic vault search",
		"",
		"_score 9.5 · seen in multiple sources_",
		"",
		"**What it is:** A self-hosted semantic index for Markdown vaults.",
		"",
		"**Why it matters for you:** Runs fully offline with local embeddings.",
		"",
		"> Queries private notes without uploading a single byte.",
		"",
		"**How to try it:**",
		"",
		"1. Pull the repo",
		"2. Point it at a test folder",
		"",
		"**Effort:** an evening",
		"",
		"**Verdict:** pending",
		"",
		"**Source:** [[AINews] Local Search (v2.0)](https://example.com/local-search) _(via news-feed)_",
		"",
		"## 2. Minimal free-form card",
		"",
		"Plain Markdown bullets work without strict boilerplate:",
		"",
		"- Bullet A",
		"- Bullet B",
		"",
		"_(source quote could not be verified — treat with caution)_",
		"",
		"**Verdict:** pending",
		"",
		"## Not a card section",
		"",
		"No verdict line here so it should be ignored.",
	].join("\r\n");

	const parsed = parseDigestFile(
		sampleCrlf,
		"AI-Digest/digest-2026-11-08.md",
		"digest-2026-11-08.md",
		deck
	);

	assert.equal(parsed.totalCount, 2);
	assert.equal(parsed.pendingCount, 2);
	assert.equal(parsed.isZeroCard, false);

	const c1 = parsed.cards[0];
	assert.equal(c1.title, "Local semantic vault search");
	assert.equal(c1.score, 9.5);
	assert.equal(c1.seenInMultipleSources, true);
	assert.equal(c1.howToTrySteps.length, 2);
	assert.equal(c1.sourceLabel, "[AINews] Local Search (v2.0)");
	assert.equal(c1.sourceUrl, "https://example.com/local-search");
	assert.equal(c1.sourceVia, "news-feed");
	assert.equal(c1.sourceQuote, "Queries private notes without uploading a single byte.");
	assert.equal(c1.unverifiedQuote, false);

	const c2 = parsed.cards[1];
	assert.equal(c2.title, "Minimal free-form card");
	assert.equal(c2.unverifiedQuote, true);
	assert.ok(c2.extraMarkdown.includes("- Bullet A"));
	assert.ok(!c2.extraMarkdown.includes("**Verdict:**"));

	// Byte-for-byte lossless update and undo preserving CRLF
	const updated = updateCardVerdictInContent(
		sampleCrlf,
		c1,
		"more-like-this",
		deck
	);
	assert.equal(updated.changed, true);
	assert.equal(updated.remainingPendingCount, 1);
	assert.ok(updated.updatedContent.includes("**Verdict:** more-like-this\r\n"));

	const updatedAll = updateCardVerdictInContent(
		updated.updatedContent,
		c2,
		"no",
		deck
	);
	assert.equal(updatedAll.remainingPendingCount, 0);

	const undo2 = updateCardVerdictInContent(
		updatedAll.updatedContent,
		c2,
		"pending",
		deck
	);
	const undo1 = updateCardVerdictInContent(
		undo2.updatedContent,
		c1,
		"pending",
		deck
	);
	assert.equal(undo1.updatedContent, sampleCrlf);
});

test("parseNoteCard parses standalone notes, respects pending filter, and skips already-triaged notes", () => {
	const deck = createDeckFromPreset("inbox", "Triage-Inbox");

	const pendingContent = [
		"---",
		'title: "Great article on local models"',
		"created: 2026-11-20",
		"score: 8.5",
		"effort: 10 minutes",
		"tags: [ai, reading]",
		'summary: "Benchmark comparing quantized models on 16GB GPUs."',
		"source: https://example.com/benchmarks",
		"---",
		"",
		"# Great article on local models",
		"",
		"Key takeaway: Q4 quantization keeps 98% accuracy.",
	].join("\n");

	const card = parseNoteCard(
		pendingContent,
		{
			title: "Great article on local models",
			created: "2026-11-20",
			score: 8.5,
			effort: "10 minutes",
			tags: ["ai", "reading"],
			summary: "Benchmark comparing quantized models on 16GB GPUs.",
			source: "https://example.com/benchmarks",
		},
		"Triage-Inbox/great-article.md",
		"great-article.md",
		"great-article",
		Date.now(),
		deck
	);

	assert.ok(card);
	assert.equal(card.mode, "notes");
	assert.equal(card.title, "Great article on local models");
	assert.equal(card.score, 8.5);
	assert.deepEqual(card.tags, ["ai", "reading"]);
	assert.equal(card.sourceUrl, "https://example.com/benchmarks");
	assert.equal(
		card.extraMarkdown,
		"Key takeaway: Q4 quantization keeps 98% accuracy."
	);

	// Already triaged note returns null
	const done = parseNoteCard(
		pendingContent,
		{ verdict: "keep" },
		"Triage-Inbox/done.md",
		"done.md",
		"done",
		Date.now(),
		deck
	);
	assert.equal(done, null);
});

test("sink note append, deduplication, and undo removal round-trip cleanly", () => {
	const base = "# Saved\n\nIntro paragraph.\n";
	const heading = "## Saved items";

	const noteLine = formatSinkEntry({
		mode: "notes",
		fileBasename: "local-models",
		title: "Local Models Guide",
		whatItIs: "Summary of GPU sizing.",
		sourceUrl: "https://example.com/gpu",
		date: "2026-11-22",
	});
	assert.equal(
		noteLine,
		"- [ ] [[local-models|Local Models Guide]] — Summary of GPU sizing. ([Source](https://example.com/gpu)) _(2026-11-22)_"
	);

	const step1 = appendSinkEntry(base, heading, noteLine);
	assert.equal(step1.createdSection, true);
	assert.equal(step1.alreadyPresent, false);

	const dup = appendSinkEntry(step1.updatedContent, heading, noteLine);
	assert.equal(dup.alreadyPresent, true);
	assert.equal(dup.updatedContent, step1.updatedContent);

	const undone = removeSinkEntry(step1.updatedContent, heading, noteLine, true);
	assert.equal(undone.trimEnd(), base.trimEnd());
	assert.ok(!undone.includes(heading));
});

test("deck scaffolding, filters, sorting, and AI prompt generation work across all presets", () => {
	const digestDeck = createDeckFromPreset("ai-digest", "AI-Digest");
	assert.equal(matchesDeckFileFilters("digest-2026-11-08.md", digestDeck), true);
	assert.equal(matchesDeckFileFilters("digest-week-2026-11-08.md", digestDeck), false);
	assert.equal(matchesDeckFileFilters("_index.md", digestDeck), false);

	const deckMd = generateDeckFileMarkdown(digestDeck);
	assert.ok(deckMd.includes("swipe-triage: true"));
	assert.ok(deckMd.includes("mode: cards"));

	const samples = generateSampleFiles(digestDeck, "2026-11-22");
	assert.equal(samples.length, 1);
	const parsedSamples = parseDigestFile(
		samples[0].content,
		`AI-Digest/${samples[0].relativeName}`,
		samples[0].relativeName,
		digestDeck
	);
	assert.equal(parsedSamples.pendingCount, 3);

	const byScore = sortCards(parsedSamples.pendingCards, "score");
	assert.equal(byScore[0].score, 9.5);
	assert.equal(byScore[2].score, null);

	const prompt = generateAiPrompt(digestDeck);
	assert.ok(prompt.includes("AI-Digest/"));
	assert.ok(prompt.includes("**Verdict:** pending"));
	assert.ok(prompt.includes("more-like-this"));
});
