import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	memoryDirFor,
	parseIndex,
	upsertIndexLine,
	parseMemory,
	serializeMemory,
	listMemories,
	readMemory,
	writeMemory,
	buildMemoryPrompt,
	memorySummary,
} from "../extensions/claude-memory/memory-core.ts";

function tmpdir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-memory-"));
}

test("memoryDirFor maps a cwd to Claude's project memory directory", () => {
	const dir = memoryDirFor("/Users/nicolas");
	assert.equal(dir, path.join(os.homedir(), ".claude/projects/-Users-nicolas/memory"));
});

test("memoryDirFor replaces dots as well as slashes", () => {
	// Claude Code slugifies /Users/dev/Source/my-app.git to
	// -Users-dev-Source-my-app-git
	const dir = memoryDirFor("/Users/dev/Source/my-app.git");
	assert.ok(dir.endsWith("/-Users-dev-Source-my-app-git/memory"));
});

test("memoryDirFor ignores a trailing slash", () => {
	assert.equal(memoryDirFor("/Users/nicolas/"), memoryDirFor("/Users/nicolas"));
});

test("parseIndex reads Claude's MEMORY.md pointer lines", () => {
	const md = [
		"- [No Claude PR signature](no-claude-pr-signature.md) — don't add Claude attribution",
		"- [Deploy runbook](deploy-runbook.md) — staging first, always",
	].join("\n");

	assert.deepEqual(parseIndex(md), [
		{
			title: "No Claude PR signature",
			file: "no-claude-pr-signature.md",
			hook: "don't add Claude attribution",
		},
		{ title: "Deploy runbook", file: "deploy-runbook.md", hook: "staging first, always" },
	]);
});

test("parseIndex tolerates blank lines and a missing hook", () => {
	const md = "\n- [Solo](solo.md)\n\n";
	assert.deepEqual(parseIndex(md), [{ title: "Solo", file: "solo.md", hook: "" }]);
});

test("upsertIndexLine appends a new entry", () => {
	const md = "- [A](a.md) — first\n";
	const out = upsertIndexLine(md, { title: "B", file: "b.md", hook: "second" });
	assert.equal(out, "- [A](a.md) — first\n- [B](b.md) — second\n");
});

test("upsertIndexLine replaces an existing entry by file, preserving order", () => {
	const md = "- [A](a.md) — first\n- [B](b.md) — second\n";
	const out = upsertIndexLine(md, { title: "A renamed", file: "a.md", hook: "updated" });
	assert.equal(out, "- [A renamed](a.md) — updated\n- [B](b.md) — second\n");
});

test("serializeMemory writes the frontmatter shape Claude Code expects", () => {
	const text = serializeMemory({
		name: "deploy-runbook",
		description: "How staging deploys work",
		type: "project",
		body: "Deploy to staging first.",
	});

	assert.match(text, /^---\n/);
	assert.match(text, /\nname: deploy-runbook\n/);
	assert.match(text, /\ndescription: How staging deploys work\n/);
	assert.match(text, /\n {2}type: project\n/);
	assert.ok(text.trimEnd().endsWith("Deploy to staging first."));
});

test("parseMemory round-trips serializeMemory", () => {
	const text = serializeMemory({
		name: "x",
		description: "d",
		type: "feedback",
		body: "body line",
	});
	const parsed = parseMemory(text);

	assert.equal(parsed.name, "x");
	assert.equal(parsed.description, "d");
	assert.equal(parsed.type, "feedback");
	assert.equal(parsed.body, "body line");
});

test("parseMemory keeps multi-line bodies intact", () => {
	const parsed = parseMemory("---\nname: n\ndescription: d\n---\n\nline one\n\nline two\n");
	assert.equal(parsed.body, "line one\n\nline two");
});

test("parseMemory on a file with no frontmatter yields an empty description", () => {
	const parsed = parseMemory("just a body");
	assert.equal(parsed.description, "");
	assert.equal(parsed.body, "just a body");
});

test("listMemories returns an empty list when the directory does not exist", () => {
	assert.deepEqual(listMemories(path.join(tmpdir(), "nope")), []);
});

test("listMemories excludes MEMORY.md itself", () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [A](a.md) — x\n");
	fs.writeFileSync(path.join(dir, "a.md"), serializeMemory({ name: "a", description: "d" }));

	assert.deepEqual(
		listMemories(dir).map((m) => m.name),
		["a"],
	);
});

test("writeMemory creates the file and registers it in the index", () => {
	const dir = tmpdir();
	writeMemory(dir, {
		name: "deploy-runbook",
		description: "How staging deploys work",
		type: "project",
		body: "Staging first.",
		title: "Deploy runbook",
		hook: "staging first, always",
	});

	const file = path.join(dir, "deploy-runbook.md");
	assert.ok(fs.existsSync(file));
	assert.equal(readMemory(dir, "deploy-runbook")?.body, "Staging first.");

	const index = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
	assert.equal(index, "- [Deploy runbook](deploy-runbook.md) — staging first, always\n");
});

test("writeMemory creates the memory directory when absent", () => {
	const dir = path.join(tmpdir(), "deep", "memory");
	writeMemory(dir, { name: "a", description: "d", body: "b" });
	assert.ok(fs.existsSync(path.join(dir, "a.md")));
});

test("writeMemory updates in place without duplicating the index line", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "first", body: "one", title: "A" });
	writeMemory(dir, { name: "a", description: "second", body: "two", title: "A" });

	const index = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
	assert.equal(index.match(/\(a\.md\)/g)?.length, 1);
	assert.equal(readMemory(dir, "a")?.description, "second");
	assert.equal(readMemory(dir, "a")?.body, "two");
});

test("writeMemory defaults the index title to the memory name", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "no-title-given", description: "d", body: "b" });
	const index = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
	assert.match(index, /- \[no-title-given\]\(no-title-given\.md\)/);
});

test("writeMemory rejects a name that escapes the memory directory", () => {
	const dir = tmpdir();
	assert.throws(() => writeMemory(dir, { name: "../escape", description: "d", body: "b" }), /name/i);
	assert.throws(() => writeMemory(dir, { name: "a/b", description: "d", body: "b" }), /name/i);
});

test("readMemory returns null for an unknown memory", () => {
	assert.equal(readMemory(tmpdir(), "missing"), null);
});

test("buildMemoryPrompt returns null when there are no memories", () => {
	assert.equal(buildMemoryPrompt(path.join(tmpdir(), "nope")), null);
});

test("buildMemoryPrompt includes the index and names the read tool", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "da", body: "ba", title: "A", hook: "ha" });

	const prompt = buildMemoryPrompt(dir);
	assert.ok(prompt);
	assert.match(prompt, /- \[A\]\(a\.md\) — ha/);
	assert.match(prompt, /memory_read/);
	assert.match(prompt, /memory_write/);
});

test("buildMemoryPrompt falls back to memory files when the index is missing", () => {
	const dir = tmpdir();
	fs.writeFileSync(
		path.join(dir, "orphan.md"),
		serializeMemory({ name: "orphan", description: "no index line exists" }),
	);

	const prompt = buildMemoryPrompt(dir);
	assert.ok(prompt);
	assert.match(prompt, /orphan/);
	assert.match(prompt, /no index line exists/);
});

test("writeMemory reports created=true with no previous for a new memory", () => {
	const dir = tmpdir();
	const out = writeMemory(dir, { name: "a", description: "d", body: "first" });
	assert.equal(out.created, true);
	assert.equal(out.previous, null);
	assert.equal(out.memory.body, "first");
});

test("writeMemory reports created=false with the previous body on update", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "d", body: "first" });
	const out = writeMemory(dir, { name: "a", description: "d", body: "second" });
	assert.equal(out.created, false);
	assert.equal(out.previous?.body, "first");
	assert.equal(out.memory.body, "second");
});

test("memorySummary distinguishes save vs update", () => {
	assert.equal(memorySummary("deploy-runbook", true), 'Saved memory "deploy-runbook".');
	assert.equal(memorySummary("deploy-runbook", false), 'Updated memory "deploy-runbook".');
});

test("writeMemory output is readable by parseIndex and listMemories together", () => {
	const dir = tmpdir();
	writeMemory(dir, { name: "a", description: "da", body: "ba", title: "A", hook: "ha" });
	writeMemory(dir, { name: "b", description: "db", body: "bb", title: "B", hook: "hb" });

	const index = parseIndex(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8"));
	assert.deepEqual(
		index.map((e) => e.file),
		["a.md", "b.md"],
	);
	assert.deepEqual(
		listMemories(dir).map((m) => m.description),
		["da", "db"],
	);
});
