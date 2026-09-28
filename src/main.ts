import {
	Notice,
	Plugin,
	PluginSettingTab,
	TFile,
	TFolder,
	moment as obsidianMoment,
	normalizePath,
	requestUrl,
	type App,
	type ButtonComponent,
	type Setting,
	type TextComponent,
} from "obsidian";

/**
 * Obsidian bundles moment at runtime, but its type comes from the moment package.
 * Only `format` is used here, and typing it locally keeps the value typed even
 * when lint runs can't resolve moment's types.
 */
type MomentLike = { format: (pattern: string) => string };
const moment = obsidianMoment as (input: Date) => MomentLike;

const FILENAME_PATTERN = /^[0-9]{12}\.[A-Za-z0-9]{8}\.md$/;
const LIST_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const LIST_DATE_MINUTE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const STARTUP_DELAY_MS = 10000;
/** Default markdown heading line for daily note embeds. */
export const DEFAULT_DAILY_NOTE_HEADING = "## Pebble Index";
const TITLE_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;
/** Windows device names that cannot be used as a file name. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

	/** Saved plugin configuration. */
	export interface PluginSettings {
	apiUrl: string;
	token: string;
	folder: string;
	useDatedSubfolders: boolean;
	linkDailyNote: boolean;
	dailyNoteHeading: string;
	syncOnStartup: boolean;
	syncIntervalMinutes: number;
	newerThanDays: number;
	importedFiles: Record<string, string>;
}

/** Folder, format, and template copied from the core Daily Notes plugin. */
export interface DailyConfig {
	folder: string;
	format: string;
	template: string;
}

/** One note row from the list endpoint. */
export interface ListedNote {
	filename: string;
	date: string;
	lastModified: string;
	title: string;
}

/** A markdown file in the notes folder, with whatever frontmatter the cache holds. */
export interface FolderNoteMeta {
	path: string;
	frontmatter?: unknown;
}

/** One child row when listing a vault folder. */
export interface FolderChildNote {
	path: string;
	extension: string;
	frontmatter?: unknown;
}

/** What to do with one listed note after the age check. */
export type ListedNoteStep = "skip" | "rename-legacy" | "needs-scan" | "create";

/** Result of reading an NSync HTTP response. */
export type ApiResult =
	| { kind: "list"; notes: ListedNote[] }
	| { kind: "read"; content: string }
	| { kind: "not-found" }
	| { kind: "error"; message: string };

export const DEFAULT_SETTINGS: PluginSettings = {
	apiUrl: "",
	token: "",
	folder: "Pebble",
	useDatedSubfolders: true,
	linkDailyNote: false,
	dailyNoteHeading: DEFAULT_DAILY_NOTE_HEADING,
	syncOnStartup: false,
	syncIntervalMinutes: 0,
	newerThanDays: 0,
	importedFiles: {},
};

interface DailyCorePlugin {
	enabled?: boolean;
	instance?: {
		options?: {
			folder?: string;
			format?: string;
			template?: string;
		};
	};
}

interface InternalPluginHost {
	plugins?: Record<string, DailyCorePlugin | undefined>;
	getPluginById?(id: string): DailyCorePlugin | undefined;
}

/** Error whose message is safe to show in a notice. */
export class ApiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApiError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(message: string): string {
	const trimmed = message.trim();
	return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorText(payload: unknown): string | null {
	if (!isRecord(payload) || typeof payload.error !== "string") {
		return null;
	}
	const message = payload.error.trim();
	return message === "" ? null : message;
}

export function isNoteFilename(filename: string): boolean {
	return FILENAME_PATTERN.test(filename);
}

/** Message for a folder that can't be used, or null when it's fine. */
export function folderError(folder: string): string | null {
	const trimmed = folder.trim();
	if (!trimmed || trimmed === ".") {
		return "Set a folder for notes";
	}
	if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
		return "Note folder must be inside the vault";
	}
	const parts = trimmed.split(/[\\/]+/);
	if (parts.includes("..")) {
		return "Note folder cannot contain ..";
	}
	return null;
}

/** Header for every NSync request. The token stays out of the URL. */
export function tokenHeader(token: string): { Token: string } {
	return { Token: token };
}

/** NSync `index.php` actions used by this plugin. */
export type NsyncAction = "list" | "read" | "markasread";

/** Builds an HTTPS API URL. The token is never placed in the URL. */
export function buildEndpoint(rawUrl: string, action: NsyncAction, filename?: string): string {
	const trimmed = rawUrl.trim();
	if (!trimmed) {
		throw new ApiError("Configure a valid API URL before syncing");
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new ApiError("Configure a valid API URL before syncing");
	}
	if (url.protocol !== "https:") {
		throw new ApiError("API URL must use HTTPS");
	}
	if (url.username !== "" || url.password !== "") {
		throw new ApiError("API URL must not contain credentials");
	}
	url.searchParams.set("action", action);
	if (action === "list") {
		url.searchParams.delete("filename");
	} else {
		if (!filename || !isNoteFilename(filename)) {
			throw new ApiError("Invalid filename");
		}
		url.searchParams.set("filename", filename);
	}
	return url.toString();
}

/** Notice text for an HTTP error. A 403 is handled before this runs. */
function httpErrorMessage(status: number, trimmed: string): string {
	if (trimmed !== "") {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			const message = errorText(parsed);
			if (message) {
				return `API returned ${clip(message)}`;
			}
		} catch {
			return `API returned ${status}`;
		}
	}
	return `API returned ${status}`;
}

/** Keeps list rows whose filename matches the server pattern. */
function listedNotes(items: unknown[]): ListedNote[] {
	const notes: ListedNote[] = [];
	for (const item of items) {
		if (!isRecord(item) || typeof item.filename !== "string" || !isNoteFilename(item.filename)) {
			continue;
		}
		const date = typeof item.date === "string" ? item.date : "";
		const lastModified = typeof item.lastmodified === "string" ? item.lastmodified : date;
		notes.push({
			filename: item.filename,
			date,
			lastModified,
			title: typeof item.title === "string" ? item.title : "",
		});
	}
	return notes;
}

function readContent(payload: unknown): string | null {
	if (!isRecord(payload) || typeof payload.content !== "string") {
		return null;
	}
	return payload.content;
}

/**
 * Turns an HTTP status and body into a list, a note, a missing note, or an error.
 * A 403 body is never parsed.
 */
export function classifyResponse(status: number, text: string, expected: "list" | "read"): ApiResult {
	if (status === 403) {
		return { kind: "error", message: "Token rejected" };
	}
	if (status === 404 && expected === "read") {
		return { kind: "not-found" };
	}
	const trimmed = text.trim();
	if (status >= 400) {
		return { kind: "error", message: httpErrorMessage(status, trimmed) };
	}
	if (status !== 200) {
		return { kind: "error", message: `API returned ${status}` };
	}
	if (trimmed === "") {
		return { kind: "error", message: "API returned an invalid JSON payload" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "error", message: "API returned an invalid JSON payload" };
	}
	if (expected === "list") {
		if (!Array.isArray(parsed)) {
			return { kind: "error", message: "API returned an invalid JSON payload" };
		}
		return { kind: "list", notes: listedNotes(parsed) };
	}
	const content = readContent(parsed);
	if (content === null) {
		return { kind: "error", message: "API returned an invalid JSON payload" };
	}
	return { kind: "read", content };
}

function markAsReadOk(payload: unknown): boolean {
	return isRecord(payload) && payload.ok === true;
}

/**
 * Turns an HTTP status and body into a mark-as-read result.
 * A 403 body is never parsed.
 */
export function classifyMarkAsReadResponse(status: number, text: string): { kind: "ok" } | { kind: "error"; message: string } {
	if (status === 403) {
		return { kind: "error", message: "Token rejected" };
	}
	const trimmed = text.trim();
	if (status >= 400) {
		return { kind: "error", message: httpErrorMessage(status, trimmed) };
	}
	if (status !== 200) {
		return { kind: "error", message: `API returned ${status}` };
	}
	if (trimmed === "") {
		return { kind: "error", message: "API returned an invalid JSON payload" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "error", message: "API returned an invalid JSON payload" };
	}
	if (!markAsReadOk(parsed)) {
		return { kind: "error", message: "API returned an invalid JSON payload" };
	}
	return { kind: "ok" };
}

function folderBase(folder: string): string {
	return normalizePath(folder.trim().replace(/[\\/]+$/g, ""));
}

/** Vault path of an imported note. The folder must already have passed `folderError`. */
export function noteFilePath(folder: string, filename: string): string {
	return normalizePath(`${folderBase(folder)}/${filename}`);
}

/**
 * Folder where a new note is written.
 * With dated subfolders enabled, notes go under `{folder}/YYYY/MM` from the capture time.
 */
export function noteStorageFolder(pebbleFolder: string, captureDate: string, useDatedSubfolders: boolean): string {
	const base = folderBase(pebbleFolder);
	if (!useDatedSubfolders) {
		return base;
	}
	const when = parseListDate(captureDate);
	if (!when) {
		return base;
	}
	const pad = (value: number): string => String(value).padStart(2, "0");
	return normalizePath(`${base}/${when.getFullYear()}/${pad(when.getMonth() + 1)}`);
}

/** Positive whole part of a setting, zero for anything else. */
export function nonNegativeWhole(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}
	return Math.floor(value);
}

/** Local date from the parts, or null when they don't describe a real timestamp. */
function dateFromParts(year: number, month: number, day: number, hour: number, minute: number, second: number): Date | null {
	const parsed = new Date(year, month - 1, day, hour, minute, second);
	if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
		return null;
	}
	if (parsed.getHours() !== hour || parsed.getMinutes() !== minute || parsed.getSeconds() !== second) {
		return null;
	}
	return parsed;
}

export function toListDateString(when: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
}

/**
 * Parses a list date as local time. Accepts `YYYY-MM-DDTHH:MM:SS` or `YYYY-MM-DDTHH:MM`.
 * The server sends these without a timezone, in Europe/Berlin, so a device in another zone shifts the day.
 */
export function parseListDate(date: string): Date | null {
	const trimmed = date.trim();
	let match = LIST_DATE_PATTERN.exec(trimmed);
	if (match) {
		return dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
	}
	match = LIST_DATE_MINUTE_PATTERN.exec(trimmed);
	if (match) {
		return dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), 0);
	}
	return null;
}

/**
 * Reads the capture time encoded in a server filename (`YYYYMMDDhhmm`).
 * Returns a canonical list date string, or null when the name does not match.
 */
export function captureDateFromFilename(filename: string): string | null {
	if (!isNoteFilename(filename)) {
		return null;
	}
	const stamp = filename.slice(0, 12);
	const when = dateFromParts(
		Number(stamp.slice(0, 4)),
		Number(stamp.slice(4, 6)),
		Number(stamp.slice(6, 8)),
		Number(stamp.slice(8, 10)),
		Number(stamp.slice(10, 12)),
		0,
	);
	return when === null ? null : toListDateString(when);
}

/**
 * Chooses the capture time for import and daily notes.
 * The server filename is preferred because it is fixed at capture time; list `date` is the fallback.
 */
export function resolvedCaptureDate(note: ListedNote): string | null {
	const fromFilename = captureDateFromFilename(note.filename);
	if (fromFilename) {
		return fromFilename;
	}
	const trimmed = note.date.trim();
	return parseListDate(trimmed) ? trimmed : null;
}

/** Modified time from the list row, or the capture time when the server didn't send one. */
export function resolvedModifiedDate(note: ListedNote): string {
	const capture = resolvedCaptureDate(note);
	if (!capture) {
		return "";
	}
	const trimmed = note.lastModified.trim();
	return parseListDate(trimmed) ? trimmed : capture;
}

export function hasValidCaptureDate(date: string): boolean {
	return parseListDate(date) !== null;
}

export function hasValidCaptureForNote(note: ListedNote): boolean {
	return resolvedCaptureDate(note) !== null;
}

/**
 * True when a listed note is inside the day window.
 * Zero days keeps every note with a valid capture date. A positive value keeps notes at or after now minus that many days.
 * A missing or unparseable date is always dropped.
 */
export function noteIsRecent(date: string, newerThanDays: number, now: Date): boolean {
	const parsed = parseListDate(date);
	if (!parsed) {
		return false;
	}
	const days = nonNegativeWhole(newerThanDays);
	if (days === 0) {
		return true;
	}
	return parsed.getTime() >= now.getTime() - days * 24 * 60 * 60 * 1000;
}

/** Capture time in the short form Obsidian writes into frontmatter. */
export function formatObsidianTimestamp(when: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/** Turns a note title into one path segment. Empty or reserved titles become `Note`. */
export function sanitizeNoteTitle(title: string): string {
	const cleaned = title
		.replace(TITLE_FILENAME_CHARS, "-")
		.replace(/\s+/g, " ")
		.replace(/^\.+/, "")
		.replace(/[.\s]+$/g, "")
		.trim();
	if (cleaned === "" || WINDOWS_RESERVED_NAME.test(cleaned)) {
		return "Note";
	}
	return cleaned;
}

/**
 * First free `{folder}/{title}.md` path.
 * When that path is taken, uses `Title 2`, then `Title 3`.
 * `exists` should report false for a file that is allowed to keep its current path.
 */
export function titledNotePath(folder: string, title: string, exists: (path: string) => boolean): string {
	const base = sanitizeNoteTitle(title);
	const first = noteFilePath(folder, `${base}.md`);
	if (!exists(first)) {
		return first;
	}
	let suffix = 2;
	let candidate = noteFilePath(folder, `${base} ${suffix}.md`);
	while (exists(candidate)) {
		suffix += 1;
		candidate = noteFilePath(folder, `${base} ${suffix}.md`);
	}
	return candidate;
}

const NOTE_FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(\r?\n|$)/;

/** Removes one frontmatter key and its value line. Notes without frontmatter stay as they are. */
export function withoutFrontmatterKey(content: string, key: string): string {
	const matched = NOTE_FRONTMATTER.exec(content);
	if (!matched) {
		return content;
	}
	const newline = content.startsWith("---\r\n") ? "\r\n" : "\n";
	const keyPattern = new RegExp("^" + escapeRegExp(key) + ":\\s*", "i");
	const inner = matched[1] ?? "";
	const kept = inner === "" ? [] : inner.split(/\r?\n/).filter((line) => !keyPattern.test(line));
	const closing = matched[2] ? matched[2] : newline;
	const body = content.slice(matched[0].length);
	return `---${newline}${kept.join(newline)}${newline}---${closing}${body}`;
}

export function formatCaptureDateTime(when: Date): string {
	const months = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${when.getDate()} ${months[when.getMonth()]} ${when.getFullYear()}, ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/** Line with the recording time, placed under the frontmatter. */
export function recordedBannerLine(captureDate: string): string | null {
	const when = parseListDate(captureDate);
	return when === null ? null : `**Recorded:** ${formatCaptureDateTime(when)}`;
}

/** Adds the recorded line under the frontmatter, unless it's already there. */
export function prependRecordedBanner(content: string, captureDate: string): string {
	const banner = recordedBannerLine(captureDate);
	if (!banner) {
		return content;
	}
	const matched = NOTE_FRONTMATTER.exec(content);
	if (!matched) {
		if (content.trimStart().startsWith(banner)) {
			return content;
		}
		return `${banner}\n\n${content}`;
	}
	const body = content.slice(matched[0].length).replace(/^(\r?\n)+/, "");
	if (body.startsWith(banner)) {
		return content;
	}
	return `${content.slice(0, matched[0].length)}${banner}\n\n${body}`;
}

/** Sets the Obsidian `date` and `modified` fields from the server times. */
export function withObsidianDates(content: string, captureDate: string, lastModified: string): string {
	const capture = parseListDate(captureDate);
	if (!capture) {
		return content;
	}
	const modified = parseListDate(lastModified) ?? capture;
	let next = withoutFrontmatterKey(content, "hash");
	next = withoutFrontmatterKey(next, "date");
	next = withoutFrontmatterKey(next, "modified");
	const matched = NOTE_FRONTMATTER.exec(next);
	const dateLine = `date: ${formatObsidianTimestamp(capture)}`;
	const modifiedLine = `modified: ${formatObsidianTimestamp(modified)}`;
	if (!matched) {
		const newline = "\n";
		return `---${newline}${dateLine}${newline}${modifiedLine}${newline}---${newline}${next}`;
	}
	const newline = next.startsWith("---\r\n") ? "\r\n" : "\n";
	const closing = matched[2] ? matched[2] : newline;
	const body = next.slice(matched[0].length);
	const frontmatter = matched[1] ?? "";
	const dated =
		frontmatter.trim() === ""
			? `${dateLine}${newline}${modifiedLine}`
			: `${frontmatter}${newline}${dateLine}${newline}${modifiedLine}`;
	return `---${newline}${dated}${newline}---${closing}${body}`;
}

/**
 * Content of an imported note: `nsync-id` added, Obsidian dates set, the `hash`
 * field dropped, and the recording time written above the body.
 */
export function prepareImportedContent(content: string, filename: string, captureDate: string, lastModified: string): string {
	if (!hasValidCaptureDate(captureDate)) {
		return content;
	}
	let next = withNsyncId(content, filename);
	next = withObsidianDates(next, captureDate, lastModified);
	next = prependRecordedBanner(next, captureDate);
	return next;
}

/** Adds `nsync-id` to the frontmatter. An id that's already there is left alone. */
export function withNsyncId(content: string, filename: string): string {
	const line = `nsync-id: ${filename}`;
	const matched = NOTE_FRONTMATTER.exec(content);
	if (!matched) {
		return `---\n${line}\n---\n${content}`;
	}
	if (/^nsync-id:/m.test(matched[1] ?? "")) {
		return content;
	}
	const newline = content.startsWith("---\r\n") ? "\r\n" : "\n";
	const opening = `---${newline}`.length;
	return `${content.slice(0, opening)}${line}${newline}${content.slice(opening)}`;
}

/** `nsync-id` from the frontmatter, or null when it's missing or malformed. */
export function nsyncIdFromFrontmatter(frontmatter: unknown): string | null {
	if (!isRecord(frontmatter)) {
		return null;
	}
	const id = frontmatter["nsync-id"];
	return typeof id === "string" && isNoteFilename(id) ? id : null;
}

/** True when a vault path matches the configured notes folder layout. */
export function isIndexedNotePath(filePath: string, folder: string, useDatedSubfolders: boolean): boolean {
	const base = folderBase(folder);
	if (!base) {
		return false;
	}
	const prefix = `${base}/`;
	if (!filePath.startsWith(prefix)) {
		return false;
	}
	const rest = filePath.slice(prefix.length);
	if (!rest.endsWith(".md") || rest.includes("//")) {
		return false;
	}
	if (!useDatedSubfolders) {
		return !rest.includes("/");
	}
	return !rest.includes("/") || /^(\d{4})\/(\d{2})\/[^/]+\.md$/.test(rest);
}

/** Keeps markdown files that belong to the configured notes folder layout. */
export function folderNoteMetasFromChildren(
	children: readonly FolderChildNote[],
	folder: string,
	useDatedSubfolders: boolean,
): FolderNoteMeta[] {
	const metas: FolderNoteMeta[] = [];
	for (const child of children) {
		if (child.extension !== "md" || !isIndexedNotePath(child.path, folder, useDatedSubfolders)) {
			continue;
		}
		metas.push({ path: child.path, frontmatter: child.frontmatter });
	}
	return metas;
}

/** Maps `nsync-id` values to vault paths for notes in the configured folder layout. */
export function importedPathsFromFiles(
	files: readonly FolderNoteMeta[],
	folder: string,
	useDatedSubfolders: boolean,
): Record<string, string> {
	const found: Record<string, string> = {};
	for (const file of files) {
		if (!isIndexedNotePath(file.path, folder, useDatedSubfolders)) {
			continue;
		}
		const id = nsyncIdFromFrontmatter(file.frontmatter);
		if (id) {
			found[id] = file.path;
		}
	}
	return found;
}

/** Builds the import index from a folder listing and cached frontmatter. */
export function importedPathsFromFolderChildren(
	children: readonly FolderChildNote[],
	folder: string,
	useDatedSubfolders: boolean,
): Record<string, string> {
	return importedPathsFromFiles(folderNoteMetasFromChildren(children, folder, useDatedSubfolders), folder, useDatedSubfolders);
}

/** Copies discovered paths into the saved map. */
function mergeImportedFiles(index: Record<string, string>, found: Readonly<Record<string, string>>): void {
	for (const [filename, path] of Object.entries(found)) {
		index[filename] = path;
	}
}

/**
 * Decides how to handle one listed note that already passed the age check.
 * An indexed path that still exists skips the note with no further lookup.
 */
export function resolveListedNote(
	filename: string,
	folder: string,
	importedFiles: Readonly<Record<string, string>>,
	exists: (path: string) => boolean,
	scanned: boolean,
): ListedNoteStep {
	const indexed = importedFiles[filename];
	if (typeof indexed === "string" && indexed !== "" && exists(indexed)) {
		return "skip";
	}
	if (exists(noteFilePath(folder, filename))) {
		return "rename-legacy";
	}
	if (!scanned) {
		return "needs-scan";
	}
	return "create";
}

/** True when both maps store the same server filename paths. */
function sameImportedFiles(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) {
		return false;
	}
	for (const key of leftKeys) {
		if (left[key] !== right[key]) {
			return false;
		}
	}
	return true;
}

/** Daily note path from the core folder and an already formatted file name. */
export function dailyNotePath(folder: string, formattedName: string): string {
	const fileName = formattedName.endsWith(".md") ? formattedName : `${formattedName}.md`;
	const trimmed = folder.trim();
	return normalizePath(trimmed ? `${trimmed}/${fileName}` : fileName);
}

/** Formats a capture timestamp with the core Daily Notes format. */
export function formatDailyStamp(date: string, format: string): string {
	const fmt = format.trim() || "YYYY-MM-DD";
	const capture = parseListDate(date);
	if (!capture) {
		return "";
	}
	return moment(capture).format(fmt);
}

/** Heading line from settings. A title without hash marks gets `## ` in front. */
export function normalizedDailyHeadingLine(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return DEFAULT_DAILY_NOTE_HEADING;
	}
	if (!trimmed.startsWith("#")) {
		return `## ${trimmed}`;
	}
	return trimmed;
}

/** Title text matched after a run of hash marks when locating an existing section. */
export function dailyHeadingMatchTitle(headingLine: string): string {
	const title = normalizedDailyHeadingLine(headingLine).replace(/^#+\s*/, "").trim();
	return title === "" ? DEFAULT_DAILY_NOTE_HEADING.replace(/^#+\s*/, "").trim() : title;
}

/**
 * Inserts an embed under the configured daily-note heading.
 * Returns null when that embed is already in the note.
 * Heading match ignores the number of hash marks on the matched title.
 */
export function insertDailyEmbed(currentContent: string, embedLink: string, headingLine: string): string | null {
	if (currentContent.includes(embedLink)) {
		return null;
	}
	const line = normalizedDailyHeadingLine(headingLine);
	const title = dailyHeadingMatchTitle(headingLine);
	const headingRegex = new RegExp("^#+\\s+" + escapeRegExp(title) + "\\s*$", "mi");
	if (!headingRegex.test(currentContent)) {
		return `${currentContent}\n\n${line}\n${embedLink}\n`;
	}
	const lines = currentContent.split("\n");
	function isDailyHeadingLine(line: string): boolean {
		return headingRegex.test(line);
	}
	const headingIndex = lines.findIndex(isDailyHeadingLine);
	if (headingIndex < 0) {
		return `${currentContent}\n\n${line}\n${embedLink}\n`;
	}
	let insertIndex = headingIndex + 1;
	while (insertIndex < lines.length && !/^#+\s/.test(lines[insertIndex])) {
		insertIndex++;
	}
	const insertion = [embedLink];
	if (lines[insertIndex - 1]?.trim() !== "") {
		insertion.unshift("");
	}
	lines.splice(insertIndex, 0, ...insertion, "");
	return lines.join("\n");
}

/** Reads folder, format, and template from the enabled core Daily Notes plugin. */
export function dailyConfigFromApp(app: App): DailyConfig | null {
	const host = (app as App & { internalPlugins?: InternalPluginHost }).internalPlugins;
	if (!host?.plugins?.["daily-notes"]?.enabled || typeof host.getPluginById !== "function") {
		return null;
	}
	try {
		const coreConfig = host.getPluginById("daily-notes")?.instance?.options;
		return {
			folder: coreConfig?.folder?.trim() || "",
			format: coreConfig?.format || "YYYY-MM-DD",
			template: coreConfig?.template?.trim() || "",
		};
	} catch (error) {
		console.error("PebbleIndexSync: Error reading Daily Notes core config", error);
		return null;
	}
}

/** Keeps saved server-filename paths and drops anything that is not a string path. */
function importedFilesFrom(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}
	const files: Record<string, string> = {};
	for (const [filename, path] of Object.entries(value)) {
		if (isNoteFilename(filename) && typeof path === "string" && path !== "") {
			files[filename] = path;
		}
	}
	return files;
}

function storedWhole(value: unknown): number {
	return typeof value === "number" ? nonNegativeWhole(value) : 0;
}

/** Copies stored JSON onto the defaults, ignoring values of the wrong type. */
function settingsFromData(stored: unknown): PluginSettings {
	const source = isRecord(stored) ? stored : {};
	const apiUrl = typeof source.apiUrl === "string" ? source.apiUrl : DEFAULT_SETTINGS.apiUrl;
	return {
		apiUrl,
		token: typeof source.token === "string" ? source.token : "",
		folder: typeof source.folder === "string" ? source.folder : DEFAULT_SETTINGS.folder,
		useDatedSubfolders:
			typeof source.useDatedSubfolders === "boolean" ? source.useDatedSubfolders : DEFAULT_SETTINGS.useDatedSubfolders,
		linkDailyNote: typeof source.linkDailyNote === "boolean" ? source.linkDailyNote : false,
		dailyNoteHeading:
			typeof source.dailyNoteHeading === "string" && source.dailyNoteHeading.trim() !== ""
				? source.dailyNoteHeading
				: DEFAULT_DAILY_NOTE_HEADING,
		syncOnStartup: typeof source.syncOnStartup === "boolean" ? source.syncOnStartup : false,
		syncIntervalMinutes: storedWhole(source.syncIntervalMinutes),
		newerThanDays: storedWhole(source.newerThanDays),
		importedFiles: importedFilesFrom(source.importedFiles),
	};
}

/** Settings message for a note folder, or undefined when the folder is allowed. */
function folderValidation(value: string): string | undefined {
	return folderError(value) ?? undefined;
}

/** Settings message for a daily-note heading, or undefined when it is allowed. */
function dailyHeadingValidation(value: string): string | undefined {
	return value.trim() === "" ? "Set a daily note heading" : undefined;
}

function apiUrlError(value: string): string | undefined {
	try {
		buildEndpoint(value, "list");
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : "Configure a valid API URL before syncing";
	}
}

/** Imports NSync notes into the vault. */
export default class PebbleIndexSyncPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private importing = false;
	private startupTimer: number | null = null;
	private intervalTimer: number | null = null;

	/** Loads settings and registers the tab, command, ribbon icon, and import schedule. */
	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new PebbleIndexSyncSettingTab(this.app, this));
		this.addCommand({
			id: "import-notes",
			name: "Import notes",
			callback: this.requestImport.bind(this),
		});
		this.addRibbonIcon("download", "Import notes", this.requestImport.bind(this));
		this.register(() => {
			this.clearSchedule();
		});
		this.setupInterval();
		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(this.scheduleStartupImport.bind(this));
		}
	}

	/** Runs one import shortly after the workspace is ready. */
	private scheduleStartupImport(): void {
		this.cancelStartupImport();
		this.startupTimer = window.setTimeout(() => {
			this.startupTimer = null;
			void this.importNotes(true);
		}, STARTUP_DELAY_MS);
	}

	/**
	 * Restarts the repeating import timer from settings.
	 * The first interval run waits the full period. A zero interval turns the timer off.
	 */
	setupInterval(): void {
		this.cancelInterval();
		const minutes = nonNegativeWhole(this.settings.syncIntervalMinutes);
		if (minutes > 0) {
			this.intervalTimer = this.registerInterval(
				window.setInterval(() => {
					void this.importNotes(true);
				}, minutes * 60 * 1000),
			);
		}
	}

	/** Clears a pending startup import without touching the interval timer. */
	cancelStartupImport(): void {
		if (this.startupTimer !== null) {
			window.clearTimeout(this.startupTimer);
			this.startupTimer = null;
		}
	}

	/** Clears the repeating import timer without touching the startup timer. */
	private cancelInterval(): void {
		if (this.intervalTimer !== null) {
			window.clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
	}

	private clearSchedule(): void {
		this.cancelStartupImport();
		this.cancelInterval();
	}

	async loadSettings(): Promise<void> {
		const stored: unknown = await this.loadData();
		this.settings = settingsFromData(stored);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private requestImport(): void {
		void this.importNotes();
	}

	/** Checks the endpoint with the list call and doesn't write notes. */
	async testConnection(): Promise<void> {
		const notice = new Notice("Testing API connection...", 0);
		/** Replaces the progress notice with a finished message. */
		const finish = (message: string): void => {
			notice.hide();
			new Notice(message);
		};
		try {
			const token = this.settings.token.trim();
			const tokenProblem = this.tokenProblem(token);
			if (tokenProblem) {
				finish(tokenProblem);
				return;
			}
			const response = await this.fetchApi(buildEndpoint(this.settings.apiUrl, "list"), token);
			const result = classifyResponse(response.status, response.text, "list");
			if (result.kind !== "list") {
				finish(result.kind === "error" ? result.message : "API returned an invalid JSON payload");
				return;
			}
			finish("API connection successful");
		} catch (error) {
			console.error("PebbleIndexSync API test error", error);
			finish(error instanceof Error ? error.message : "Connection test failed");
		}
	}

	/**
	 * Downloads notes that are not already in the vault and writes each one under its title.
	 * A quiet run, used by the startup and interval timers, stays silent when nothing changed.
	 */
	async importNotes(quiet = false): Promise<void> {
		if (this.importing) {
			if (!quiet) {
				new Notice("Import already running");
			}
			return;
		}
		this.importing = true;
		const progress = quiet ? null : new Notice("Importing notes...", 0);
		const index: Record<string, string> = { ...this.settings.importedFiles };
		const scan = { done: false };
		/** Hides the progress notice and shows a result. Quiet runs can skip a clean empty result. */
		const finish = (message: string, always: boolean): void => {
			progress?.hide();
			if (always || !quiet) {
				new Notice(message);
			}
		};
		try {
			const token = this.settings.token.trim();
			const tokenProblem = this.tokenProblem(token);
			if (tokenProblem) {
				finish(tokenProblem, true);
				return;
			}
			const folderProblem = folderError(this.settings.folder);
			if (folderProblem) {
				finish(folderProblem, true);
				return;
			}
			const listed = await this.fetchApi(buildEndpoint(this.settings.apiUrl, "list"), token);
			const listResult = classifyResponse(listed.status, listed.text, "list");
			if (listResult.kind === "error") {
				finish(listResult.message, true);
				return;
			}
			if (listResult.kind !== "list") {
				finish("API returned an invalid JSON payload", true);
				return;
			}
			let imported = 0;
			let failed = 0;
			let dailyDisabled = false;
			let dailyFailed = false;
			const now = new Date();
			for (const note of listResult.notes) {
				try {
					const captureDate = resolvedCaptureDate(note);
					if (!captureDate || !noteIsRecent(captureDate, this.settings.newerThanDays, now)) {
						continue;
					}
					const outcome = await this.takeListedNote(note, token, index, scan, captureDate);
					if (outcome.kind === "stop") {
						finish(outcome.message, true);
						return;
					}
					if (outcome.kind === "failed") {
						failed += 1;
						continue;
					}
					if (outcome.kind !== "created") {
						continue;
					}
					imported += 1;
					if (this.settings.linkDailyNote && !dailyDisabled) {
						try {
							const linked = await this.linkImportedNote(outcome.file, captureDate);
							if (linked === "disabled") {
								dailyDisabled = true;
							} else if (linked === "failed") {
								dailyFailed = true;
							}
						} catch (error) {
							console.error("PebbleIndexSync daily note error", error);
							dailyFailed = true;
						}
					}
				} catch (error) {
					console.error("PebbleIndexSync note error", error);
					failed += 1;
				}
			}
			const quietOk = quiet && imported === 0 && failed === 0 && !dailyDisabled && !dailyFailed;
			if (quietOk) {
				progress?.hide();
			} else {
				finish(this.importSummary(imported, failed), true);
			}
			if (dailyDisabled) {
				new Notice("Daily notes is disabled. Notes were imported without a daily link.");
			} else if (dailyFailed) {
				new Notice("Could not update the daily note.");
			}
		} catch (error) {
			console.error("PebbleIndexSync import error", error);
			finish(error instanceof Error ? error.message : "Import failed", true);
		} finally {
			await this.saveImportedFiles(index);
			this.importing = false;
		}
	}

	/** Saves the filename map when this import changed it. */
	private async saveImportedFiles(index: Record<string, string>): Promise<void> {
		this.pruneImportedFiles(index);
		if (sameImportedFiles(index, this.settings.importedFiles)) {
			return;
		}
		this.settings.importedFiles = index;
		try {
			await this.saveSettings();
		} catch (error) {
			console.error("PebbleIndexSync import error", error);
		}
	}

	/**
	 * Skips a note already on disk, renames an old server-filename file, or creates a titled note.
	 * The folder scan runs at most once per import, and only after the index and the old path both miss.
	 */
	private async takeListedNote(
		note: ListedNote,
		token: string,
		index: Record<string, string>,
		scan: { done: boolean },
		captureDate: string,
	): Promise<{ kind: "created"; file: TFile } | { kind: "skipped" } | { kind: "failed" } | { kind: "stop"; message: string }> {
		let step = resolveListedNote(note.filename, this.settings.folder, index, (path) => this.vaultHas(path), scan.done);
		if (step === "needs-scan") {
			mergeImportedFiles(index, this.readFolderIndex());
			scan.done = true;
			step = resolveListedNote(note.filename, this.settings.folder, index, (path) => this.vaultHas(path), true);
		}
		if (step === "skip") {
			await this.acknowledgeImported(note.filename, token);
			return { kind: "skipped" };
		}
		if (step === "rename-legacy") {
			const renamed = await this.renameLegacyNote(note, index, captureDate);
			if (renamed) {
				await this.acknowledgeImported(note.filename, token);
				return { kind: "skipped" };
			}
		}
		return await this.createListedNote(note, token, index, captureDate);
	}

	/** Drops index entries whose vault file no longer exists. */
	private pruneImportedFiles(index: Record<string, string>): void {
		for (const [filename, path] of Object.entries(index)) {
			if (!this.app.vault.getAbstractFileByPath(path)) {
				delete index[filename];
			}
		}
	}

	/** True when some other vault item already occupies the path, ignoring letter case. */
	private vaultHas(path: string, exceptPath?: string): boolean {
		if (exceptPath && path.toLowerCase() === exceptPath.toLowerCase()) {
			return false;
		}
		if (this.app.vault.getAbstractFileByPath(path) !== null) {
			return true;
		}
		const slash = path.lastIndexOf("/");
		const dir = slash === -1 ? "" : path.slice(0, slash);
		const name = path.slice(slash + 1).toLowerCase();
		const folder = dir === "" ? this.app.vault.getRoot() : this.app.vault.getFolderByPath(dir);
		if (!folder) {
			return false;
		}
		return folder.children.some((child) => child.name.toLowerCase() === name);
	}

	/** Reads `nsync-id` from markdown files directly in the notes folder. */
	private readFolderIndex(): Record<string, string> {
		return importedPathsFromFolderChildren(
			this.collectIndexedNotes(),
			this.settings.folder,
			this.settings.useDatedSubfolders,
		);
	}

	/** Lists markdown notes under the configured folder without scanning the whole vault. */
	private collectIndexedNotes(): FolderChildNote[] {
		const root = this.app.vault.getFolderByPath(folderBase(this.settings.folder));
		if (!root) {
			return [];
		}
		const notes: FolderChildNote[] = [];
		for (const child of root.children) {
			if (child instanceof TFile) {
				this.pushIndexedNote(child, notes);
				continue;
			}
			if (child instanceof TFolder && this.settings.useDatedSubfolders) {
				this.collectDatedSubfolderNotes(child, notes);
			}
		}
		return notes;
	}

	/** Walks `YYYY/MM` folders and collects markdown files. */
	private collectDatedSubfolderNotes(yearFolder: TFolder, notes: FolderChildNote[]): void {
		if (!/^\d{4}$/.test(yearFolder.name)) {
			return;
		}
		for (const monthChild of yearFolder.children) {
			if (!(monthChild instanceof TFolder) || !/^\d{2}$/.test(monthChild.name)) {
				continue;
			}
			for (const file of monthChild.children) {
				if (file instanceof TFile) {
					this.pushIndexedNote(file, notes);
				}
			}
		}
	}

	private pushIndexedNote(file: TFile, notes: FolderChildNote[]): void {
		if (file.extension !== "md") {
			return;
		}
		notes.push({
			path: file.path,
			extension: file.extension,
			frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter,
		});
	}

	/**
	 * Adds `nsync-id` to an old server-filename note and renames it to its title. Does not download it again.
	 * Returns false when the legacy path is not a file, so the caller can create the note instead.
	 */
	private async renameLegacyNote(note: ListedNote, index: Record<string, string>, captureDate: string): Promise<boolean> {
		const legacyPath = noteFilePath(this.settings.folder, note.filename);
		const existing = this.app.vault.getAbstractFileByPath(legacyPath);
		if (!(existing instanceof TFile)) {
			return false;
		}
		const content = await this.app.vault.read(existing);
		const next = prepareImportedContent(content, note.filename, captureDate, resolvedModifiedDate(note));
		if (next !== content) {
			await this.app.vault.modify(existing, next);
		}
		const storage = noteStorageFolder(this.settings.folder, captureDate, this.settings.useDatedSubfolders);
		await this.ensureFolder(storage);
		const target = titledNotePath(storage, note.title, (path) => this.vaultHas(path, existing.path));
		if (target.toLowerCase() !== existing.path.toLowerCase()) {
			await this.app.fileManager.renameFile(existing, target);
			index[note.filename] = target;
		} else {
			index[note.filename] = existing.path;
		}
		return true;
	}

	/** Reads one note and writes it under a free title path, with `nsync-id` in frontmatter. */
	private async createListedNote(
		note: ListedNote,
		token: string,
		index: Record<string, string>,
		captureDate: string,
	): Promise<{ kind: "created"; file: TFile } | { kind: "skipped" } | { kind: "failed" } | { kind: "stop"; message: string }> {
		const read = await this.fetchApi(buildEndpoint(this.settings.apiUrl, "read", note.filename), token);
		const readResult = classifyResponse(read.status, read.text, "read");
		if (readResult.kind === "not-found") {
			return { kind: "skipped" };
		}
		if (readResult.kind === "error") {
			if (readResult.message === "Token rejected") {
				return { kind: "stop", message: readResult.message };
			}
			console.error("PebbleIndexSync read error", readResult.message);
			return { kind: "failed" };
		}
		if (readResult.kind !== "read") {
			return { kind: "stop", message: "API returned an invalid JSON payload" };
		}
		const storage = noteStorageFolder(this.settings.folder, captureDate, this.settings.useDatedSubfolders);
		await this.ensureFolder(storage);
		const prepared = prepareImportedContent(readResult.content, note.filename, captureDate, resolvedModifiedDate(note));
		const file = await this.writeImportedNote(storage, note, prepared);
		index[note.filename] = file.path;
		await this.acknowledgeImported(note.filename, token);
		return { kind: "created", file };
	}

	/** Writes the note, and falls back to the server filename when the title path is rejected. */
	private async writeImportedNote(storage: string, note: ListedNote, prepared: string): Promise<TFile> {
		const path = titledNotePath(storage, note.title, (candidate) => this.vaultHas(candidate));
		try {
			return await this.app.vault.create(path, prepared);
		} catch (error) {
			const fallback = noteFilePath(storage, note.filename);
			if (fallback.toLowerCase() === path.toLowerCase() || this.vaultHas(fallback)) {
				throw error;
			}
			console.error("PebbleIndexSync title path failed, using server filename", error);
			return await this.app.vault.create(fallback, prepared);
		}
	}

	/** Tells the server this note is imported. A failure is logged and doesn't undo the local file. */
	private async acknowledgeImported(filename: string, token: string): Promise<void> {
		try {
			const marked = await this.markNoteAsRead(filename, token);
			if (marked.kind === "error") {
				console.error("PebbleIndexSync mark as read error", marked.message);
			}
		} catch (error) {
			console.error("PebbleIndexSync mark as read error", error);
		}
	}

	private async markNoteAsRead(filename: string, token: string): Promise<{ kind: "ok" } | { kind: "error"; message: string }> {
		const response = await this.fetchApi(buildEndpoint(this.settings.apiUrl, "markasread", filename), token);
		return classifyMarkAsReadResponse(response.status, response.text);
	}

	private importSummary(imported: number, failed: number): string {
		let written = "No new notes";
		if (imported === 1) {
			written = "Imported 1 note";
		} else if (imported > 1) {
			written = `Imported ${imported} notes`;
		}
		if (failed === 0) {
			return written;
		}
		const failedText = failed === 1 ? "1 note failed" : `${failed} notes failed`;
		return `${written}, ${failedText}`;
	}

	private tokenProblem(token: string): string | null {
		if (!token) {
			return "Token is required";
		}
		if (token.length < 6) {
			return "Token must be at least 6 characters";
		}
		return null;
	}

	private async fetchApi(url: string, token: string): Promise<{ status: number; text: string }> {
		const response = await requestUrl({
			url,
			method: "GET",
			headers: tokenHeader(token),
			throw: false,
		});
		return { status: response.status, text: response.text };
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const trimmed = folderPath.trim();
		if (!trimmed) {
			return;
		}
		const normalized = normalizePath(trimmed.replace(/[\\/]+$/g, ""));
		const parts = normalized.split("/").filter((part) => part !== "");
		let current = "";
		for (const part of parts) {
			current = current === "" ? part : `${current}/${part}`;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) {
				continue;
			}
			if (existing) {
				throw new Error(`A file already exists at ${current}`);
			}
			await this.app.vault.createFolder(current);
		}
	}

	/** Embeds one imported note in the daily note for its capture date. */
	private async linkImportedNote(file: TFile, date: string): Promise<"ok" | "disabled" | "failed"> {
		const cfg = dailyConfigFromApp(this.app);
		if (!cfg) {
			return "disabled";
		}
		const stamp = formatDailyStamp(date, cfg.format);
		if (!stamp) {
			return "failed";
		}
		const dailyPath = dailyNotePath(cfg.folder, stamp);
		const dailyFile = await this.ensureDailyFile(dailyPath, cfg.template, date, stamp);
		if (!dailyFile) {
			return "failed";
		}
		const currentContent = await this.app.vault.read(dailyFile);
		const markdownLink = this.app.fileManager.generateMarkdownLink(file, dailyFile.path, "", "");
		const embedLink = `!${markdownLink}`;
		const next = insertDailyEmbed(currentContent, embedLink, this.settings.dailyNoteHeading);
		if (next === null) {
			return "ok";
		}
		await this.app.vault.modify(dailyFile, next);
		return "ok";
	}

	/** Creates the daily note from the core template file when it's missing. */
	private async ensureDailyFile(path: string, template: string, date: string, stamp: string): Promise<TFile | null> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			return existing;
		}
		if (existing) {
			return null;
		}
		const slash = path.lastIndexOf("/");
		const dir = slash === -1 ? "" : path.substring(0, slash);
		if (dir) {
			await this.ensureFolder(dir);
		}
		let initialContent = "";
		if (template) {
			const templateFile = this.app.vault.getAbstractFileByPath(normalizePath(`${template}.md`));
			if (templateFile instanceof TFile) {
				initialContent = this.fillDailyTemplate(await this.app.vault.read(templateFile), date, stamp);
			}
		}
		return await this.app.vault.create(path, initialContent);
	}

	/** Replaces `{{date}}`, `{{time}}`, and `{{title}}` the way the core Daily Notes plugin does. */
	private fillDailyTemplate(content: string, date: string, stamp: string): string {
		const capture = parseListDate(date);
		const dateText = capture ? moment(capture).format("YYYY-MM-DD") : "";
		const timeText = capture ? moment(capture).format("HH:mm") : "";
		return content.replace(/\{\{date\}\}/g, dateText).replace(/\{\{time\}\}/g, timeText).replace(/\{\{title\}\}/g, stamp);
	}
}

/** Settings tab for the endpoint, token, folder, schedule, and the connection test. */
class PebbleIndexSyncSettingTab extends PluginSettingTab {
	plugin: PebbleIndexSyncPlugin;

	constructor(app: App, plugin: PebbleIndexSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Declarative settings used by Obsidian 1.13 and newer. */
	getSettingDefinitions() {
		return [
			{
				name: "When import runs",
				desc: "The Import notes command and the ribbon icon always run an import. Sync on startup runs one import about 10 seconds after Obsidian opens when that option is on. A sync interval above 0 repeats the import on a timer. Notes already imported are skipped.",
			},
			{
				name: "Sync on startup",
				desc: "Run one import about 10 seconds after Obsidian opens. Takes effect the next time you open Obsidian, not when you turn this on.",
				control: { type: "toggle" as const, key: "syncOnStartup" },
			},
			{
				name: "Sync interval (minutes)",
				desc: "Repeat the import after this many minutes. 0 turns the timer off. Changing the value restarts the timer; the next run waits the full interval.",
				control: { type: "number" as const, key: "syncIntervalMinutes", min: 0, step: 1, placeholder: "0" },
			},
			{
				name: "Only sync notes newer than (days)",
				desc: "Skip listed notes older than this. 0 keeps every listed note. A missing or unparseable date is skipped while this is on.",
				control: { type: "number" as const, key: "newerThanDays", min: 0, step: 1, placeholder: "0" },
			},
			{
				name: "API endpoint",
				desc: "Full HTTPS URL of your NSync instance, for example https://nsync.example.com/index.php.",
				control: {
					type: "text" as const,
					key: "apiUrl",
					placeholder: "https://nsync.example.com/index.php",
					validate: apiUrlError,
				},
			},
			{
				name: "Token",
				desc: "Secret sent in the Token header.",
				render: this.renderToken.bind(this),
			},
			{
				name: "Note folder",
				desc: "Vault folder where imported notes are written. Created if it is missing.",
				control: {
					type: "text" as const,
					key: "folder",
					placeholder: "Pebble",
					validate: folderValidation,
				},
			},
			{
				name: "Use dated subfolders",
				desc: "Store notes in monthly folders under the note folder, for example Pebble/2026/08/Title.md.",
				control: { type: "toggle" as const, key: "useDatedSubfolders" },
			},
			{
				name: "Link in daily note",
				desc: "Embed each new note in the daily note from the core Daily Notes plugin.",
				control: { type: "toggle" as const, key: "linkDailyNote" },
			},
			{
				name: "Daily note heading",
				desc: "Markdown heading where new embeds are added. An existing section with the same title is reused.",
				control: {
					type: "text" as const,
					key: "dailyNoteHeading",
					placeholder: DEFAULT_DAILY_NOTE_HEADING,
					validate: dailyHeadingValidation,
				},
			},
			{
				name: "Test connection",
				desc: "Check the endpoint and token. Does not write notes.",
				render: this.renderTestButton.bind(this),
			},
		];
	}

	private renderToken(setting: Setting): void {
		setting.addText(this.configureTokenField.bind(this));
	}

	/** Hides the token and saves it when the field changes. */
	private configureTokenField(text: TextComponent): void {
		text
			.setPlaceholder("Token")
			.setValue(this.plugin.settings.token)
			.onChange(this.onTokenChange.bind(this));
		text.inputEl.type = "password";
	}

	private onTokenChange(value: string): void {
		this.plugin.settings.token = value.trim();
		void this.plugin.saveSettings();
	}

	private renderTestButton(setting: Setting): void {
		setting.addButton(this.configureTestButton.bind(this));
	}

	private configureTestButton(button: ButtonComponent): void {
		button.setButtonText("Test");
		button.onClick(this.onTestClick.bind(this));
	}

	private onTestClick(): void {
		void this.plugin.testConnection();
	}

	/**
	 * Saves a declarative control.
	 * The interval restarts here because that control does not call `saveSettings` itself.
	 * Sync on startup only applies on the next Obsidian load; turning it off cancels a pending startup import.
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		const stored = key === "syncIntervalMinutes" || key === "newerThanDays" ? this.wholeControlValue(value) : value;
		await super.setControlValue(key, stored);
		if (key === "syncIntervalMinutes") {
			this.plugin.setupInterval();
		} else if (key === "syncOnStartup" && value !== true) {
			this.plugin.cancelStartupImport();
		}
	}

	/** Blank or invalid numbers become zero, positive numbers lose their fraction. */
	private wholeControlValue(value: unknown): number {
		return typeof value === "number" ? nonNegativeWhole(value) : 0;
	}
}
