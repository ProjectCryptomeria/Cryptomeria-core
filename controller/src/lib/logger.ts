// src/lib/logger.ts
let isDebugMode = false;

// ANSI escape codes for colors
const colors = {
	reset: "\x1b[0m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellowBold: "\x1b[1;33m",
};

/**
 * A simple logger utility with debug mode control.
 */
export const log = {
	/**
	 * Sets the debug mode for the logger.
	 * @param {boolean} enabled - If true, info and step logs will be displayed.
	 */
	setDebugMode: (enabled: boolean) => {
		isDebugMode = enabled;
	},

	/**
	 * Logs an informational message. Only shown in debug mode.
	 * @param {string} msg - The message to log.
	 */
	info: (msg: string) => {
		if (isDebugMode) console.log(`${colors.cyan}[INFO]${colors.reset} ${msg}`);
	},

	/**
	 * Logs a success message. Always shown.
	 * @param {string} msg - The message to log.
	 */
	success: (msg: string) => console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`),

	/**
	 * Logs an error message. Always shown.
	 * @param {string} msg - The message to log.
	 */
	error: (msg: string) => console.error(`${colors.red}[ERROR]${colors.reset} ${msg}`),

	/**
	 * Logs a step/section header. Only shown in debug mode.
	 * @param {string} msg - The message to log.
	 */
	step: (msg: string) => {
		if (isDebugMode) console.log(`\n${colors.yellowBold}--- ${msg} ---${colors.reset}`);
	},
};