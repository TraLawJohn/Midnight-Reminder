/**
 * Test cases for midnight-reminder logic.
 *
 * Uses a supplied clock, controllable timer, and fake notification function
 * so tests can advance time and count deliveries without relying on Pi's
 * ExtensionAPI or real timers.
 */

import {
	MESSAGE,
	getLocalDateString,
	isLateNight,
	MidnightReminder,
	startReminderSession,
	type Clock,
	type TimerService,
	type Notifier,
} from "./midnight-reminder";

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, description: string) {
	if (actual !== expected) {
		throw new Error(`${description}\n  Expected: ${expected}\n  Actual: ${actual}`);
	}
}

function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`PASS: ${name}`);
		passed++;
	} catch (err) {
		console.log(`FAIL: ${name}`);
		console.error(`  ${err instanceof Error ? err.message : err}`);
		failed++;
	}
}

/** Fake clock for simulated dates. */
class FakeClock implements Clock {
	constructor(private time: number) {}
	now(): Date {
		return new Date(this.time);
	}
	advance(ms: number): void {
		this.time += ms;
	}
}

/** Fake timer that lets tests fire callbacks on demand. */
class FakeTimer implements TimerService {
	private callbacks = new Map<number, () => void>();
	private nextId = 1;

	setInterval(callback: () => void, _ms: number): unknown {
		const id = this.nextId++;
		this.callbacks.set(id, callback);
		return id;
	}

	clearInterval(handle: unknown): void {
		if (typeof handle === "number") {
			this.callbacks.delete(handle);
		}
	}

	/** Fire every active interval callback once. */
	tick(): void {
		for (const cb of this.callbacks.values()) {
			cb();
		}
	}

	get activeCount(): number {
		return this.callbacks.size;
	}
}

/** Fake notifier that records every message. */
class FakeNotifier implements Notifier {
	messages: string[] = [];
	notify(message: string): void {
		this.messages.push(message);
	}
}

function dateTime(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
	return new Date(year, month, day, hour, minute, second).getTime();
}

// --- Core policy tests ---

test("23:59 → no reminder", () => {
	const clock = new FakeClock(dateTime(2024, 0, 1, 23, 59));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();
	const reminder = new MidnightReminder(clock, timer, notifier);

	reminder.start();
	assertEqual(notifier.messages.length, 0, "No reminder at 23:59 startup");
});

test("00:00 → reminder on startup", () => {
	const clock = new FakeClock(dateTime(2024, 0, 2, 0, 0));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();
	const reminder = new MidnightReminder(clock, timer, notifier);

	reminder.start();
	assertEqual(notifier.messages.length, 1, "Immediate reminder at 00:00");
	assertEqual(notifier.messages[0], MESSAGE, "Message should match");
});

test("Already reminded today → no duplicate", () => {
	const clock = new FakeClock(dateTime(2024, 0, 2, 0, 0));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();
	const reminder = new MidnightReminder(clock, timer, notifier);

	reminder.start();
	assertEqual(notifier.messages.length, 1, "First check should trigger");

	clock.advance(30000);
	timer.tick();
	assertEqual(notifier.messages.length, 1, "Duplicate check same day should be suppressed");
});

test("05:59 → reminder", () => {
	const clock = new FakeClock(dateTime(2024, 0, 2, 5, 59));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();
	const reminder = new MidnightReminder(clock, timer, notifier);

	reminder.start();
	assertEqual(notifier.messages.length, 1, "05:59 should trigger a reminder");
});

test("06:00 → no reminder", () => {
	const clock = new FakeClock(dateTime(2024, 0, 2, 6, 0));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();
	const reminder = new MidnightReminder(clock, timer, notifier);

	reminder.start();
	assertEqual(notifier.messages.length, 0, "06:00 should not trigger a reminder");

	clock.advance(30000);
	timer.tick();
	assertEqual(notifier.messages.length, 0, "Still no reminder after tick at 06:00");
});

// --- Automatic delivery while idle ---

test("Crossing midnight while idle delivers within 60 simulated seconds", () => {
	const clock = new FakeClock(dateTime(2024, 0, 1, 23, 59, 0));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();
	const reminder = new MidnightReminder(clock, timer, notifier);

	reminder.start();
	assertEqual(notifier.messages.length, 0, "No reminder before midnight");

	// Tick at 23:59:30
	clock.advance(30000);
	timer.tick();
	assertEqual(notifier.messages.length, 0, "No reminder at 23:59:30");

	// Tick at 00:00:00
	clock.advance(30000);
	timer.tick();
	assertEqual(notifier.messages.length, 1, "Reminder should fire at 00:00");
	assertEqual(notifier.messages[0], MESSAGE, "Message should match");

	// Repeated checks do not duplicate
	clock.advance(30000);
	timer.tick();
	assertEqual(notifier.messages.length, 1, "Should not duplicate after midnight");
});

// --- Timer lifecycle ---

test("Timer cleanup on stop prevents future deliveries", () => {
	const clock = new FakeClock(dateTime(2024, 0, 1, 23, 59, 0));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();
	const reminder = new MidnightReminder(clock, timer, notifier);

	reminder.start();
	assertEqual(timer.activeCount, 1, "Timer should be active after start");

	reminder.stop();
	assertEqual(timer.activeCount, 0, "Timer should be cleared after stop");
	assertEqual(notifier.messages.length, 0, "No reminder before midnight");

	// Advance past midnight and tick - nothing should happen
	clock.advance(60000);
	timer.tick();
	assertEqual(notifier.messages.length, 0, "No reminder after stop even past midnight");
});

test("Shutdown and reload leaves no old timer", () => {
	const clock = new FakeClock(dateTime(2024, 0, 2, 0, 0));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();

	// First session
	const firstReminder = new MidnightReminder(clock, timer, notifier);
	firstReminder.start();
	assertEqual(notifier.messages.length, 1, "First session should remind");
	assertEqual(timer.activeCount, 1, "First timer active");

	// Simulate shutdown
	firstReminder.stop();
	assertEqual(timer.activeCount, 0, "First timer cleared");

	// Simulate reload / new session with same timer service
	// A fresh session MAY remind again (persistence across reloads is optional).
	const secondNotifier = new FakeNotifier();
	const secondReminder = new MidnightReminder(clock, timer, secondNotifier);
	secondReminder.start();
	assertEqual(timer.activeCount, 1, "Only one timer active after reload");

	// Stop again
	secondReminder.stop();
	assertEqual(timer.activeCount, 0, "All timers cleared after second shutdown");
});

// --- Noninteractive mode ---

test("Noninteractive startup creates no timer", () => {
	const clock = new FakeClock(dateTime(2024, 0, 2, 0, 0));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();

	const mockCtx = {
		hasUI: false,
		ui: { notify: (_msg: string, _type: string) => {} },
	};

	const result = startReminderSession(mockCtx as any, clock, timer);
	assertEqual(result, null, "Should return null in noninteractive mode");
	assertEqual(timer.activeCount, 0, "No timer created in noninteractive mode");
	assertEqual(notifier.messages.length, 0, "No notification in noninteractive mode");
});

// --- Preview command ---

test("\/bedtime-test preview shows notification without changing state", () => {
	const clock = new FakeClock(dateTime(2024, 0, 2, 0, 0));
	const timer = new FakeTimer();
	const notifier = new FakeNotifier();
	const reminder = new MidnightReminder(clock, timer, notifier);

	reminder.preview();
	assertEqual(notifier.messages.length, 1, "Preview should deliver one notification");
	assertEqual(notifier.messages[0], MESSAGE, "Preview message should match");

	// Starting automatic checks should still fire because preview did not update state
	reminder.start();
	assertEqual(notifier.messages.length, 2, "Automatic reminder should still fire after preview");
});

// --- Date formatting ---

test("getLocalDateString uses local timezone at midnight rollover", () => {
	const date = new Date(2024, 0, 2, 0, 0);
	assertEqual(getLocalDateString(date), "2024-01-02", "Date string should reflect local calendar date");
});

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
