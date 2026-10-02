/**
 * Midnight Reminder Extension
 *
 * Displays a reminder to stop working during late-night hours
 * (00:00 local time inclusive to 06:00 exclusive).
 *
 * - Reminds at most once per local calendar date per extension runtime.
 * - Shows on startup if Pi starts within the late-night window.
 * - Checks every 30 seconds so the reminder appears within one minute of midnight.
 * - Provides /bedtime-test to preview the message without affecting state.
 * - Skips timers and notifications in non-interactive mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MESSAGE = "It is after midnight. Consider saving your work and getting some sleep.";
export const CHECK_INTERVAL_MS = 30000; // 30 seconds

/** Format a Date as YYYY-MM-DD in the machine's local timezone. */
export function getLocalDateString(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** Determine whether the given local time falls in the late-night window. */
export function isLateNight(date: Date): boolean {
	const hour = date.getHours();
	return hour >= 0 && hour < 6;
}

/** Dependencies injected for testability. */
export interface Clock {
	now(): Date;
}

export interface TimerService {
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface Notifier {
	notify(message: string): void;
}

/** Encapsulates the per-session reminder logic. */
export class MidnightReminder {
	private lastRemindedDate: string | null = null;
	private timerHandle: unknown | null = null;

	constructor(
		private readonly clock: Clock,
		private readonly timer: TimerService,
		private readonly notifier: Notifier,
	) {}

	/** Start automatic checks: one immediate and then periodic. */
	start(): void {
		this.checkAndRemind();
		this.timerHandle = this.timer.setInterval(() => {
			this.checkAndRemind();
		}, CHECK_INTERVAL_MS);
	}

	/** Stop periodic checks. Idempotent. */
	stop(): void {
		if (this.timerHandle !== null) {
			this.timer.clearInterval(this.timerHandle);
			this.timerHandle = null;
		}
	}

	/** Show the reminder without affecting automatic state. */
	preview(): void {
		this.notifier.notify(MESSAGE);
	}

	private checkAndRemind(): void {
		const now = this.clock.now();
		if (!isLateNight(now)) return;
		const today = getLocalDateString(now);
		if (this.lastRemindedDate === today) return;
		this.lastRemindedDate = today;
		this.notifier.notify(MESSAGE);
	}
}

/** Real clock for production use. */
export const realClock: Clock = { now: () => new Date() };

/** Real timer service for production use. */
export const realTimer: TimerService = {
	setInterval: (cb, ms) => setInterval(cb, ms),
	clearInterval: (id) => clearInterval(id),
};

/** Build a notifier backed by the Pi UI. */
export function makeNotifier(ctx: ExtensionContext): Notifier {
	return {
		notify: (msg) => ctx.ui.notify(msg, "warning"),
	};
}

/** Create and start a reminder for the current session. */
export function startReminderSession(
	ctx: ExtensionContext,
	clock: Clock,
	timer: TimerService,
): MidnightReminder | null {
	if (!ctx.hasUI) {
		return null;
	}
	const notifier = makeNotifier(ctx);
	const reminder = new MidnightReminder(clock, timer, notifier);
	reminder.start();
	return reminder;
}

export default function (pi: ExtensionAPI) {
	let reminder: MidnightReminder | null = null;

	// Manual test command – does not change automatic reminder state.
	pi.registerCommand("bedtime-test", {
		description: "Preview the midnight bedtime reminder",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (reminder) {
				reminder.preview();
			} else {
				ctx.ui.notify(MESSAGE, "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Guard against duplicate timers if the runtime is reused or reloaded.
		if (reminder) {
			reminder.stop();
			reminder = null;
		}

		reminder = startReminderSession(ctx, realClock, realTimer);
	});

	pi.on("session_shutdown", () => {
		if (reminder) {
			reminder.stop();
			reminder = null;
		}
	});
}
