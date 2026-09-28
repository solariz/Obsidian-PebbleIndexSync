import type { App } from "obsidian";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_DAILY_NOTE_HEADING,
	DEFAULT_SETTINGS,
	buildEndpoint,
	captureDateFromFilename,
	classifyMarkAsReadResponse,
	classifyResponse,
	dailyConfigFromApp,
	dailyNotePath,
	folderError,
	formatCaptureDateTime,
	formatDailyStamp,
	folderNoteMetasFromChildren,
	importedPathsFromFiles,
	importedPathsFromFolderChildren,
	insertDailyEmbed,
	isIndexedNotePath,
	isNoteFilename,
	noteFilePath,
	noteStorageFolder,
	noteIsRecent,
	parseListDate,
	prepareImportedContent,
	resolvedCaptureDate,
	resolveListedNote,
	sanitizeNoteTitle,
	titledNotePath,
	tokenHeader,
	withNsyncId,
} from "./main";

const NOTE = "202609100226.pftTsMaG.md";
const OLDER = "202608211341.aB3dEf9h.md";

describe("endpoint", () => {
	it("ships no default endpoint and the expected toggles", () => {
		expect(DEFAULT_SETTINGS.apiUrl).toBe("");
		expect(DEFAULT_SETTINGS.syncOnStartup).toBe(false);
		expect(DEFAULT_SETTINGS.syncIntervalMinutes).toBe(0);
		expect(DEFAULT_SETTINGS.newerThanDays).toBe(0);
		expect(DEFAULT_SETTINGS.importedFiles).toEqual({});
		expect(DEFAULT_SETTINGS.useDatedSubfolders).toBe(true);
	});

	it("refuses an empty endpoint", () => {
		expect(() => buildEndpoint("", "list")).toThrow("Configure a valid API URL before syncing");
	});

	it("builds an https list url", () => {
		const url = new URL(buildEndpoint("https://nsync.example.com/index.php", "list"));
		expect(url.protocol).toBe("https:");
		expect(url.searchParams.get("action")).toBe("list");
		expect(url.searchParams.get("filename")).toBeNull();
	});

	it("builds a read url with the filename", () => {
		const url = new URL(buildEndpoint("https://nsync.example.com/index.php", "read", NOTE));
		expect(url.searchParams.get("action")).toBe("read");
		expect(url.searchParams.get("filename")).toBe(NOTE);
	});

	it("builds a mark-as-read url with the filename", () => {
		const url = new URL(buildEndpoint("https://nsync.example.com/index.php", "markasread", NOTE));
		expect(url.searchParams.get("action")).toBe("markasread");
		expect(url.searchParams.get("filename")).toBe(NOTE);
	});

	it("keeps the token out of the url", () => {
		const token = "super-secret-token";
		const url = buildEndpoint("https://nsync.example.com/index.php", "list");
		expect(url.includes(token)).toBe(false);
		expect(tokenHeader(token)).toEqual({ Token: token });
	});

	it("rejects http and credentials", () => {
		expect(() => buildEndpoint("http://nsync.example.com/index.php", "list")).toThrow("API URL must use HTTPS");
		expect(() => buildEndpoint("https://user:secret@nsync.example.com/index.php", "list")).toThrow("API URL must not contain credentials");
	});

	it("rejects a read without a server filename", () => {
		expect(() => buildEndpoint("https://nsync.example.com/index.php", "read", "note.md")).toThrow("Invalid filename");
	});
});

describe("filenames and folders", () => {
	it("accepts only server filenames", () => {
		expect(isNoteFilename(NOTE)).toBe(true);
		expect(isNoteFilename("note.md")).toBe(false);
		expect(isNoteFilename(`../${NOTE}`)).toBe(false);
	});

	it("rejects absolute folders and parent segments", () => {
		expect(folderError("Pebble")).toBeNull();
		expect(folderError("Pebble/Ideas")).toBeNull();
		expect(folderError("")).toBe("Set a folder for notes");
		expect(folderError("../Pebble")).toBe("Note folder cannot contain ..");
		expect(folderError("Pebble/../Secret")).toBe("Note folder cannot contain ..");
		expect(folderError("/etc")).toBe("Note folder must be inside the vault");
		expect(folderError("C:/notes")).toBe("Note folder must be inside the vault");
	});

	it("joins the note folder and the server filename", () => {
		expect(noteFilePath("Pebble/", NOTE)).toBe(`Pebble/${NOTE}`);
	});

	it("builds flat and monthly storage folders from the capture date", () => {
		expect(noteStorageFolder("Pebble", "2026-08-22T13:07:00", false)).toBe("Pebble");
		expect(noteStorageFolder("Pebble/", "2026-08-22T13:07:00", true)).toBe("Pebble/2026/08");
	});
});

describe("mark as read", () => {
	it("accepts a successful acknowledgement", () => {
		expect(classifyMarkAsReadResponse(200, JSON.stringify({ ok: true }))).toEqual({ kind: "ok" });
	});

	it("surfaces token, client, and server errors", () => {
		expect(classifyMarkAsReadResponse(403, "")).toEqual({ kind: "error", message: "Token rejected" });
		expect(classifyMarkAsReadResponse(400, JSON.stringify({ error: "bad request" }))).toEqual({
			kind: "error",
			message: "API returned bad request",
		});
		expect(classifyMarkAsReadResponse(404, JSON.stringify({ error: "not found" }))).toEqual({
			kind: "error",
			message: "API returned not found",
		});
	});
});

describe("responses", () => {
	it("reads a list and drops invalid filenames", () => {
		const body = JSON.stringify([
			{ filename: "nope.md", date: "2026-09-10T02:26:40" },
			{ filename: NOTE, date: "2026-09-10T02:26:40", title: "Hello" },
			{ filename: OLDER, date: "2026-08-21T13:41:01" },
			{ filename: NOTE.replace(".md", ""), date: "2026-09-10T02:26:40" },
		]);
		expect(classifyResponse(200, body, "list")).toEqual({
			kind: "list",
			notes: [
				{ filename: NOTE, date: "2026-09-10T02:26:40", lastModified: "2026-09-10T02:26:40", title: "Hello" },
				{ filename: OLDER, date: "2026-08-21T13:41:01", lastModified: "2026-08-21T13:41:01", title: "" },
			],
		});
	});

	it("reads note content", () => {
		const content = "---\ntitle: \"Hello\"\n---\nBody\n";
		expect(classifyResponse(200, JSON.stringify({ content }), "read")).toEqual({
			kind: "read",
			content,
		});
	});

	it("treats an empty 403 as a rejected token and does not require json", () => {
		expect(classifyResponse(403, "", "list")).toEqual({ kind: "error", message: "Token rejected" });
		expect(classifyResponse(403, "not-json", "read")).toEqual({ kind: "error", message: "Token rejected" });
	});

	it("surfaces an error field", () => {
		expect(classifyResponse(400, JSON.stringify({ error: "bad request" }), "list")).toEqual({
			kind: "error",
			message: "API returned bad request",
		});
	});

	it("skips a missing note on read and reports it for list", () => {
		const body = JSON.stringify({ error: "not found" });
		expect(classifyResponse(404, body, "read")).toEqual({ kind: "not-found" });
		expect(classifyResponse(404, body, "list")).toEqual({
			kind: "error",
			message: "API returned not found",
		});
	});

	it("rejects a success body that is not the expected json", () => {
		expect(classifyResponse(200, "{", "list")).toEqual({
			kind: "error",
			message: "API returned an invalid JSON payload",
		});
		expect(classifyResponse(200, JSON.stringify({ filename: NOTE }), "read")).toEqual({
			kind: "error",
			message: "API returned an invalid JSON payload",
		});
	});
});

describe("daily note embed", () => {
	it("appends the heading and embed when the heading is missing", () => {
		expect(insertDailyEmbed("Hello", "![[Pebble/new]]", DEFAULT_DAILY_NOTE_HEADING)).toBe(
			`Hello\n\n${DEFAULT_DAILY_NOTE_HEADING}\n![[Pebble/new]]\n`,
		);
	});

	it("inserts before the next heading and ignores hash count", () => {
		const content = "# Today\n\n# Pebble Index\n\n![[old]]\n\n## Tasks\n\n- one\n";
		const next = insertDailyEmbed(content, "![[Pebble/new]]", DEFAULT_DAILY_NOTE_HEADING);
		expect(next).not.toBeNull();
		const text = next ?? "";
		expect(text.indexOf("![[Pebble/new]]")).toBeGreaterThan(text.indexOf("![[old]]"));
		expect(text.indexOf("![[Pebble/new]]")).toBeLessThan(text.indexOf("## Tasks"));
	});

	it("adds hash marks when the heading has none", () => {
		expect(insertDailyEmbed("Hello", "![[Pebble/new]]", "Pebble Index")).toBe(
			"Hello\n\n## Pebble Index\n![[Pebble/new]]\n",
		);
	});

	it("skips an embed that is already present", () => {
		expect(insertDailyEmbed("![[Pebble/new]]", "![[Pebble/new]]", DEFAULT_DAILY_NOTE_HEADING)).toBeNull();
	});

	it("builds the daily path and formats the stamp with the core format", () => {
		expect(dailyNotePath("Daily Notes", "2026-09-10")).toBe("Daily Notes/2026-09-10.md");
		expect(dailyNotePath("", "2026-09-10.md")).toBe("2026-09-10.md");
		expect(formatDailyStamp("2026-09-10T02:26:40", "YYYY-MM-DD")).toBe("2026-09-10");
		expect(formatDailyStamp("2026-09-22T10:01:56", "YYYY-MM-DD")).toBe("2026-09-22");
		expect(formatDailyStamp("bad", "")).toBe("");
		expect(formatDailyStamp("", "YYYY-MM-DD")).toBe("");
	});

	it("reads folder, format, and template from the core plugin", () => {
		const enabled = {
			internalPlugins: {
				plugins: { "daily-notes": { enabled: true } },
				getPluginById: () => ({
					instance: { options: { folder: " Daily ", format: "", template: " Templates/Day " } },
				}),
			},
		} as unknown as App;
		expect(dailyConfigFromApp(enabled)).toEqual({
			folder: "Daily",
			format: "YYYY-MM-DD",
			template: "Templates/Day",
		});
		const disabled = {
			internalPlugins: {
				plugins: { "daily-notes": { enabled: false } },
				getPluginById: () => ({ instance: { options: { folder: "Daily" } } }),
			},
		} as unknown as App;
		expect(dailyConfigFromApp(disabled)).toBeNull();
	});
});

describe("capture date", () => {
	it("reads the capture time from a server filename", () => {
		expect(captureDateFromFilename("202608221307.Gvhan3i0.md")).toBe("2026-08-22T13:07:00");
		expect(formatDailyStamp("2026-08-22T13:07:00", "YYYY-MM-DD")).toBe("2026-08-22");
	});

	it("prefers the filename when the list date is wrong", () => {
		const note = {
			filename: "202608221307.Gvhan3i0.md",
			date: "2026-09-23T19:29:00",
			lastModified: "2026-09-23T19:29:00",
			title: "Note Ring Sat 22 Aug 13:07",
		};
		expect(resolvedCaptureDate(note)).toBe("2026-08-22T13:07:00");
	});
});

describe("note age", () => {
	const now = new Date(2026, 8, 23, 12, 0, 0);

	it("keeps a note on the cutoff and drops an older one", () => {
		expect(noteIsRecent("2026-09-16T12:00:00", 7, now)).toBe(true);
		expect(noteIsRecent("2026-09-16T11:59:59", 7, now)).toBe(false);
		expect(noteIsRecent("2026-09-23T12:00:00", 7, now)).toBe(true);
	});

	it("skips a missing or unparseable date only while the window is on", () => {
		expect(noteIsRecent("", 7, now)).toBe(false);
		expect(noteIsRecent("bad", 7, now)).toBe(false);
		expect(noteIsRecent("2026-09-10", 7, now)).toBe(false);
		expect(noteIsRecent("", 0, now)).toBe(false);
		expect(noteIsRecent("bad", 0, now)).toBe(false);
	});
});

describe("note titles", () => {
	it("sanitizes a title into a single path segment", () => {
		expect(sanitizeNoteTitle("  Hello   World  ")).toBe("Hello World");
		expect(sanitizeNoteTitle('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
		expect(sanitizeNoteTitle("Idea #1 [draft]^")).toBe("Idea -1 -draft--");
		expect(sanitizeNoteTitle("  ...  ")).toBe("Note");
		expect(sanitizeNoteTitle("CON")).toBe("Note");
		expect(sanitizeNoteTitle("   ")).toBe("Note");
	});

	it("uses the next free title when the path is taken", () => {
		const taken = new Set(["Pebble/Hello.md", "Pebble/Hello 2.md"]);
		expect(titledNotePath("Pebble", "Hello", (path) => taken.has(path))).toBe("Pebble/Hello 3.md");
		expect(titledNotePath("Pebble", "   ", (path) => path === "Pebble/Note.md")).toBe("Pebble/Note 2.md");
	});
});

describe("imported content", () => {
	const apiBody =
		'---\ntitle: "Patchdosen CAD 7"\ndate: 2026-09-22T10:01:56\nmodified: 2026-09-22T10:01:56\nstored-at: 1790064294\nhash: abc123\n---\nJeder Raum hat drei Patchdosen.\n';

	it("drops hash, adds nsync-id, and shows the recorded date above the body", () => {
		const when = parseListDate("2026-09-22T10:01:56");
		expect(when).not.toBeNull();
		const recorded = `**Recorded:** ${formatCaptureDateTime(when as Date)}`;
		expect(prepareImportedContent(apiBody, NOTE, "2026-09-22T10:01:56", "2026-09-22T10:01:56")).toBe(
			`---\nnsync-id: ${NOTE}\ntitle: "Patchdosen CAD 7"\nstored-at: 1790064294\ndate: 2026-09-22T10:01\nmodified: 2026-09-22T10:01\n---\n${recorded}\n\nJeder Raum hat drei Patchdosen.\n`,
		);
	});

	it("leaves content unchanged when the capture date is missing", () => {
		const emptyDates = '---\ntitle: "Hello"\ndate: \nmodified: \n---\nBody\n';
		expect(prepareImportedContent(emptyDates, "nope.md", "", "")).toBe(emptyDates);
	});
});

describe("nsync id", () => {
	const body = '---\ntitle: "Hello"\n---\nBody\n---\nmore\n';

	it("injects the server filename into frontmatter and leaves the body", () => {
		expect(withNsyncId(body, NOTE)).toBe(`---\nnsync-id: ${NOTE}\ntitle: "Hello"\n---\nBody\n---\nmore\n`);
	});

	it("does not add a second id line", () => {
		const once = withNsyncId(body, NOTE);
		expect(withNsyncId(once, NOTE)).toBe(once);
	});

	it("adds a frontmatter block when the note has none", () => {
		expect(withNsyncId("Body\n", NOTE)).toBe(`---\nnsync-id: ${NOTE}\n---\nBody\n`);
	});

	it("fills an empty frontmatter block", () => {
		expect(withNsyncId("---\n---\nBody\n", NOTE)).toBe(`---\nnsync-id: ${NOTE}\n---\nBody\n`);
	});
});

describe("import index", () => {
	it("indexes only direct markdown children of the notes folder", () => {
		const children = [
			{ path: "Pebble/Hello.md", extension: "md", frontmatter: { "nsync-id": NOTE } },
			{ path: "Pebble/Nested/Other.md", extension: "md", frontmatter: { "nsync-id": OLDER } },
			{ path: "Pebble/readme.txt", extension: "txt", frontmatter: { "nsync-id": NOTE } },
			{ path: "Other/Hello.md", extension: "md", frontmatter: { "nsync-id": OLDER } },
		];
		expect(folderNoteMetasFromChildren(children, "Pebble", false)).toEqual([
			{ path: "Pebble/Hello.md", frontmatter: { "nsync-id": NOTE } },
		]);
		expect(importedPathsFromFolderChildren(children, "Pebble", false)).toEqual({ [NOTE]: "Pebble/Hello.md" });
	});

	it("indexes monthly subfolders when dated subfolders are enabled", () => {
		const children = [
			{ path: "Pebble/2026/08/August.md", extension: "md", frontmatter: { "nsync-id": NOTE } },
			{ path: "Pebble/2026/08/Nested/Other.md", extension: "md", frontmatter: { "nsync-id": OLDER } },
			{ path: "Pebble/Hello.md", extension: "md", frontmatter: { "nsync-id": OLDER } },
		];
		expect(isIndexedNotePath("Pebble/2026/08/August.md", "Pebble", true)).toBe(true);
		expect(isIndexedNotePath("Pebble/Hello.md", "Pebble", true)).toBe(true);
		expect(importedPathsFromFolderChildren(children, "Pebble", true)).toEqual({
			[NOTE]: "Pebble/2026/08/August.md",
			[OLDER]: "Pebble/Hello.md",
		});
	});

	it("skips a note whose indexed path still exists", () => {
		const looked: string[] = [];
		const exists = (path: string): boolean => {
			looked.push(path);
			return path === "Pebble/Hello.md";
		};
		const found = importedPathsFromFiles(
			[
				{ path: "Pebble/Nested/Hidden.md", frontmatter: { "nsync-id": NOTE } },
				{ path: "Pebble/Hello.md", frontmatter: { "nsync-id": NOTE } },
				{ path: "Other/Hello.md", frontmatter: { "nsync-id": OLDER } },
				{ path: "Pebble/Plain.md", frontmatter: { title: "Plain" } },
			],
			"Pebble",
			false,
		);
		expect(found).toEqual({ [NOTE]: "Pebble/Hello.md" });
		expect(resolveListedNote(NOTE, "Pebble", found, exists, false)).toBe("skip");
		expect(looked).toEqual(["Pebble/Hello.md"]);
	});

	it("renames a file that still uses the server filename", () => {
		const legacy = `Pebble/${NOTE}`;
		expect(resolveListedNote(NOTE, "Pebble", {}, (path) => path === legacy, false)).toBe("rename-legacy");
	});

	it("scans once when the index and the old filename are both missing", () => {
		expect(resolveListedNote(NOTE, "Pebble", {}, () => false, false)).toBe("needs-scan");
		expect(resolveListedNote(NOTE, "Pebble", {}, () => false, true)).toBe("create");
	});
});
