/** Stand-in for the obsidian package, which ships types and no JavaScript entry. */

export function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}

/** Minimal moment stand-in. Dates format common daily-note patterns; "bad" stays invalid. */
export function moment(value?: string | Date): { isValid: () => boolean; format: (fmt: string) => string } {
	return {
		isValid: momentIsValid.bind(null, value),
		format: momentFormat.bind(null, value),
	};
}

/** Treats the sample value "bad" as an unparseable timestamp. */
function momentIsValid(value: string | Date | undefined): boolean {
	if (value instanceof Date) {
		return !Number.isNaN(value.getTime());
	}
	return value !== "bad";
}

function formatMomentDate(date: Date, fmt: string): string {
	const year = date.getFullYear();
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const pad = (part: number): string => String(part).padStart(2, "0");
	if (fmt === "YYYY-MM-DD" || fmt === "") {
		return `${year}-${pad(month)}-${pad(day)}`;
	}
	return `${date.toISOString()}:${fmt}`;
}

function momentFormat(value: string | Date | undefined, fmt: string): string {
	if (value instanceof Date) {
		return formatMomentDate(value, fmt);
	}
	return `${value ?? "now"}:${fmt}`;
}

/** Empty plugin base so the real class can extend it under Vitest. */
export class Plugin {}

/** Empty settings-tab base so the real class can extend it under Vitest. */
export class PluginSettingTab {}

/** Ignores notices during unit tests. */
export class Notice {
	setMessage(_message: string): void {
		return;
	}

	hide(): void {
		return;
	}
}

/** Marker class for `instanceof` checks in the importer. */
export class TFile {}

/** Marker class for `instanceof` checks in the importer. */
export class TFolder {}

/** Network helper. Unit tests don't call the live API. */
export function requestUrl(): Promise<never> {
	return Promise.reject(new Error("requestUrl is not used in unit tests"));
}
