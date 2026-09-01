/**
 * Core logic for reading and writing Claude Code's auto-memory store.
 *
 * Claude Code keeps one memory per file under
 * `~/.claude/projects/<slugified-cwd>/memory/`, alongside a `MEMORY.md`
 * index that holds one pointer line per memory. Only the index is loaded
 * at session start; bodies are read on demand. This module reproduces
 * that layout exactly so pi and Claude Code share a single store.
 *
 * Pure functions plus thin fs wrappers — no pi imports, so it is testable
 * with plain `node --test`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface IndexEntry {
	title: string;
	file: string;
	hook: string;
}

export interface Memory {
	name: string;
	description: string;
	type: string;
	body: string;
}

export interface WriteMemoryInput {
	name: string;
	description: string;
	body: string;
	type?: string;
	title?: string;
	hook?: string;
}

const INDEX_FILE = "MEMORY.md";
const DEFAULT_TYPE = "project";

/**
 * Claude Code slugifies the working directory into a single filesystem-safe
 * segment by collapsing every path separator and the drive colon and dots to
 * `-`. `path.resolve` returns Windows paths with backslashes and a drive
 * colon (e.g. `G:\AI`), so all of `/ \ : .` must be replaced. Leaving a `
 * separator inside the slug (the old `/[/.]/` regex dropped the backslash
 * and colon) produces a projects segment that never matches the directory
 * Claude Code created, so the store looks empty.
 */
export function memoryDirFor(cwd: string): string {
	const absolute = path.resolve(cwd);
	const slug = absolute.replace(/[/\\.:]/g, "-");
	return path.join(os.homedir(), ".claude", "projects", slug, "memory");
}

/** Parse `- [Title](file.md) — hook` pointer lines, ignoring anything else. */
export function parseIndex(md: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	for (const line of md.split("\n")) {
		const match = /^\s*-\s*\[([^\]]*)\]\(([^)]+)\)\s*(?:—\s*(.*))?$/.exec(line);
		if (!match) continue;
		entries.push({
			title: match[1].trim(),
			file: match[2].trim(),
			hook: (match[3] ?? "").trim(),
		});
	}
	return entries;
}

function renderIndexLine(entry: IndexEntry): string {
	const hook = entry.hook.trim();
	return hook ? `- [${entry.title}](${entry.file}) — ${hook}` : `- [${entry.title}](${entry.file})`;
}

/** Remove the pointer line for `file` from the index, if present. */
export function pruneIndexLine(md: string, file: string): string {
	const out: string[] = [];
	for (const line of md.split("\n")) {
		const parsed = parseIndex(line)[0];
		if (parsed && parsed.file === file) continue;
		out.push(line);
	}
	// Drop trailing blank lines so a deletion does not leave a dangling newline.
	while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
	return out.length ? `${out.join("\n")}\n` : "";
}

/** Replace the pointer line for `entry.file` if present, otherwise append it. */
export function upsertIndexLine(md: string, entry: IndexEntry): string {
	const rendered = renderIndexLine(entry);
	const lines = md.split("\n");
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

	let replaced = false;
	const next = lines.map((line) => {
		const parsed = parseIndex(line)[0];
		if (parsed && parsed.file === entry.file) {
			replaced = true;
			return rendered;
		}
		return line;
	});

	if (!replaced) next.push(rendered);
	return `${next.join("\n")}\n`;
}

/** Split a memory file into its frontmatter fields and body. */
export function parseMemory(text: string): Memory {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) {
		return { name: "", description: "", type: "", body: text.trim() };
	}

	const [, frontmatter, rest] = match;
	const field = (key: string): string => {
		const found = new RegExp(`^\\s*${key}:\\s*(.*)$`, "m").exec(frontmatter);
		return found ? found[1].trim() : "";
	};

	return {
		name: field("name"),
		description: field("description"),
		type: field("type"),
		body: rest.replace(/^\s*\n/, "").trimEnd(),
	};
}

/** Render a memory in the frontmatter shape Claude Code writes and reads. */
export function serializeMemory(input: {
	name: string;
	description: string;
	type?: string;
	body?: string;
}): string {
	return [
		"---",
		`name: ${input.name}`,
		`description: ${input.description}`,
		"metadata:",
		"  node_type: memory",
		`  type: ${input.type || DEFAULT_TYPE}`,
		"---",
		"",
		`${(input.body ?? "").trim()}\n`,
	].join("\n");
}

export interface ReconcileResult {
	/** The reconciled index markdown — verified index lines plus any generated ones. */
	index: string;
	/** True when `index` differs from what is currently on disk. */
	changed: boolean;
	/** Files named by an index line but absent from disk (pruned on reconcile). */
	pruned: string[];
	/** Memory files present on disk with no index line (a line is appended). */
	added: string[];
}

/**
 * Make the index match the files on disk:
 *  - drop every pointer whose file is gone (heals dangling pointers),
 *  - append a generated line for every memory file that has no pointer.
 *
 * Verified index lines are kept verbatim, so human-written titles and hooks
 * survive — only missing-or-orphaned entries change. Returns the reconciled
 * markdown and what changed so the caller can persist it in place. This is what
 * keeps the index and the directory from drifting apart after an out-of-band
 * deletion (e.g. a manual `rm`).
 */
export function reconcileIndex(dir: string): ReconcileResult {
	const current = readIndex(dir);
	if (!fs.existsSync(dir)) {
		return { index: "", changed: false, pruned: [], added: [] };
	}

	const indexed = parseIndex(current);
	const diskFiles = new Set(listMemories(dir).map((m) => `${m.name}.md`));

	const kept = indexed.filter((e) => diskFiles.has(e.file));
	const pruned = indexed.filter((e) => !diskFiles.has(e.file)).map((e) => e.file);

	const indexedFiles = new Set(kept.map((e) => e.file));
	const added = listMemories(dir)
		.filter((m) => !indexedFiles.has(`${m.name}.md`) && m.description.trim().length > 0)
		.map((m) => ({ title: m.name, file: `${m.name}.md`, hook: m.description } as IndexEntry));

	const next = [...kept, ...added].map((e) => renderIndexLine(e)).join("\n");
	const result = next.length ? `${next}\n` : "";
	return { index: result, changed: result !== current, pruned, added: added.map((e) => e.file) }
}

/**
 * Build the block injected into pi's system prompt: the index only, never the
 * bodies. This mirrors how Claude Code loads memory — a table of contents up
 * front, full text pulled on demand — so a large store stays cheap.
 *
 * The index is reconciled with the files on disk before it is injected (see
 * reconcileIndex): a pointer whose file is gone is dropped and a memory file
 * with no pointer is indexed. The healed index is written back only when it
 * actually changed, so a consistent store costs no extra writes. This is what
 * guarantees a deleted memory can never resurface as a broken pointer in a later
 * session.
 *
 * Returns null when the directory holds no memories, so the caller can leave
 * the prompt untouched.
 */
export function buildMemoryPrompt(dir: string): string | null {
	const { index, changed } = reconcileIndex(dir);
	if (changed) fs.writeFileSync(path.join(dir, INDEX_FILE), index);

	const lines = index
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	if (lines.length === 0) return null;

	return [
		"## Memory",
		"",
		"You share a persistent memory store with Claude Code for this project.",
		"Below is the index — one line per memory, bodies not included.",
		"",
		...lines,
		"",
		"Call `memory_read` with a name (the filename without `.md`) when an entry",
		"looks relevant to the task at hand. Call `memory_write` to record a durable",
		"fact — a preference, a project constraint, or guidance you were given.",
		"Do not record what the repo or git history already says.",
	].join("\n");
}

function assertSafeName(name: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
		throw new Error(
			`Invalid memory name "${name}": use a kebab-case slug with no path separators.`,
		);
	}
}

/** Every memory in the directory, sorted by name. Missing directory yields []. */
export function listMemories(dir: string): Memory[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((file) => file.endsWith(".md") && file !== INDEX_FILE)
		.sort()
		.map((file) => {
			const parsed = parseMemory(fs.readFileSync(path.join(dir, file), "utf8"));
			return { ...parsed, name: parsed.name || path.basename(file, ".md") };
		});
}

/** Read the index file verbatim, or "" when it does not exist yet. */
export function readIndex(dir: string): string {
	const file = path.join(dir, INDEX_FILE);
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

export function readMemory(dir: string, name: string): Memory | null {
	assertSafeName(name);
	const file = path.join(dir, `${name}.md`);
	if (!fs.existsSync(file)) return null;
	const parsed = parseMemory(fs.readFileSync(file, "utf8"));
	return { ...parsed, name: parsed.name || name };
}

export interface WriteMemoryResult {
	memory: Memory;
	previous: Memory | null;
	created: boolean;
}

/** One-line summary shown for a memory_write tool result. */
export function memorySummary(name: string, created: boolean): string {
	return created ? `Saved memory "${name}".` : `Updated memory "${name}".`;
}

/** Write (or overwrite) a memory and register it in the index. */
export function writeMemory(dir: string, input: WriteMemoryInput): WriteMemoryResult {
	assertSafeName(input.name);
	fs.mkdirSync(dir, { recursive: true });

	const previous = readMemory(dir, input.name);

	const memory: Memory = {
		name: input.name,
		description: input.description,
		type: input.type || DEFAULT_TYPE,
		body: input.body.trim(),
	};

	fs.writeFileSync(path.join(dir, `${input.name}.md`), serializeMemory(memory));

	const index = upsertIndexLine(readIndex(dir), {
		title: input.title?.trim() || input.name,
		file: `${input.name}.md`,
		hook: input.hook?.trim() || input.description,
	});
	fs.writeFileSync(path.join(dir, INDEX_FILE), index);

	return { memory, previous, created: previous === null };
}

export interface DeleteMemoryResult {
	/** True when the memory file existed and was removed. */
	deleted: boolean;
	/** True when a matching index pointer line was pruned as a result. */
	pruned: boolean;
	/** The memory name, echoed back for the tool result. */
	name: string;
}

/** One-line summary shown for a delete tool result. */
export function deleteSummary(name: string, deleted: boolean): string {
	return deleted ? `Deleted memory "${name}".` : `No memory named "${name}".`;
}

/**
 * Delete a memory and remove its pointer line from the index in one step. The
 * file is removed first, then its index line is pruned; the pruned index is
 * written only when the line was actually present. If an out-of-band deletion
 * already removed the file, the file is a no-op but the stale index line is
 * still pruned here, so delete remains the canonical way to keep the two in
 * sync — and reconcileIndex is the backstop if either write is missed.
 */
export function deleteMemory(dir: string, name: string): DeleteMemoryResult {
	assertSafeName(name);
	const file = path.join(dir, `${name}.md`);
	if (!fs.existsSync(file)) {
		// The file is already gone, but a dangling index pointer may remain —
		// prune it so this call still heals the index.
		const before = readIndex(dir);
		const after = pruneIndexLine(before, `${name}.md`);
		if (after !== before) fs.writeFileSync(path.join(dir, INDEX_FILE), after);
		return { deleted: false, pruned: after !== before, name };
	}

	fs.unlinkSync(file);

	const before = readIndex(dir);
	const after = pruneIndexLine(before, `${name}.md`);
	if (after !== before) fs.writeFileSync(path.join(dir, INDEX_FILE), after);

	return { deleted: true, pruned: after !== before, name };
}
