// src/shared/notify-log.ts — the plugin's own log, written where the plugin sees it.
// v2 removed the host log sink (`app` is `{name, version, channel}`), so this writes
// SYNCHRONOUSLY to the plugin's own directory: no host round-trip, and the unbounded
// await behind it — the one call able to hold plugin boot open — is gone with it.
import { appendLogLine, getPluginLogPath } from "../debug-logger.js";
import { errorMessage } from "./host-shape.js";

/**
 * The level vocabulary this plugin writes; the only one it uses.
 *
 * An enum for the reason every other vocabulary here is one: a level is a
 * discriminator the log line is read by, and `safeLog("wran", ...)` compiled
 * clean — writing a line this plugin's own readers would not recognise as a
 * level, with nothing red. Spelling it as members makes the typo a type error.
 */
export enum LogLevel {
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export function safeLog(level: LogLevel, message: string): void {
  appendLogLine(getPluginLogPath(), `${new Date().toISOString()} ${level} ${message}`);
}

/**
 * Contain a failure the process walks away from: one normalization of the unknown,
 * one level, and the caller's own words. Not a wrapper for every catch — a child
 * created and then failed must be ABORTED, and that arm keeps its own body, because
 * that failure is undone rather than contained.
 */
export function containFailure(what: string, error: unknown, tail = ""): void {
  safeLog(LogLevel.Warn, `${what}: ${errorMessage(error)}${tail ? `; ${tail}` : ""}`);
}