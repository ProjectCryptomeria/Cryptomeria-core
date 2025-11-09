// controller/src/utils/logger.ts
import * as fs from 'fs';
import * as path from 'path';
import winston, { Logform } from 'winston';
import Transport from 'winston-transport';
// ★ 修正 1: LogLevel のインポート元を変更 (または型を直接定義)
// (types/index.ts からエクスポートされている前提)
import { LogLevel } from '../types';

// --- 動的なログファイルパスの定義 ---
const args = process.argv;
const configIndex = args.indexOf('--config');
let baseFileName: string;

if (configIndex !== -1 && args[configIndex + 1]) {
	const configPath = args[configIndex + 1]!;
	baseFileName = path.basename(configPath, path.extname(configPath));
} else {
	baseFileName = path.basename(process.argv[1]!, path.extname(process.argv[1]!));
}

const LOG_DIR = path.join(__dirname, '..', 'experiments', 'results', 'logs');
const ALL_LOG_FILE = path.join(LOG_DIR, `${baseFileName}.all.log`);
const ERROR_LOG_FILE = path.join(LOG_DIR, `${baseFileName}.error.log`);


try {
	if (!fs.existsSync(LOG_DIR)) {
		fs.mkdirSync(LOG_DIR, { recursive: true });
	}
} catch (e) {
	console.error(`Error creating log directory ${LOG_DIR}:`, e);
}

// --- カスタムレベルと色の定義 ---
const customLevels = {
	levels: {
		none: -1,
		error: 0,
		warn: 1,
		success: 2,
		info: 3,
		debug: 4,
	},
	colors: {
		error: 'red',
		warn: 'yellow',
		success: 'green',
		info: 'magenta',
		debug: 'cyan',
		none: 'grey',
	},
};

winston.addColors(customLevels.colors);

let currentLogLevel: LogLevel = 'info';
let isFileLoggingEnabled: boolean = true;


// ログフォーマット (変更なし)
const fileLogFormat = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
	winston.format.errors({ stack: true }),
	winston.format.splat(),
	winston.format.printf((info: Logform.TransformableInfo) => {
		const stackInfo = info.stack ? `\n${info.stack}` : '';
		const level = info.level.toUpperCase().padEnd(7);
		return `[${info.timestamp}] [${level}] - ${info.message}${stackInfo}`;
	})
);

const MAX_LEVEL_LENGTH = 7;
const levelAlign = winston.format((info) => {
	const level = info.level.toUpperCase();
	const padding = MAX_LEVEL_LENGTH - level.length;
	if (padding > 0) {
		const padStart = Math.floor(padding / 2);
		const padEnd = padding - padStart;
		info.level = ' '.repeat(padStart) + level + ' '.repeat(padEnd);
	} else {
		info.level = level;
	}
	return info;
});

const consoleLogFormat = winston.format.combine(
	winston.format.timestamp({ format: 'HH:mm:ss' }),
	levelAlign(),
	winston.format.colorize(),
	winston.format.printf((info: Logform.TransformableInfo) => {
		return `[${info.timestamp}] [${info.level}] - ${info.message}`;
	})
);

// メモリバッファ用トランスポート (変更なし)
const memoryTransportBuffer: Logform.TransformableInfo[] = [];
class MemoryTransport extends Transport {
	log(info: Logform.TransformableInfo, callback: () => void) {
		setImmediate(() => { this.emit('logged', info); });
		if (info.level === 'error' || info.level === 'warn') {
			memoryTransportBuffer.push(info);
		}
		callback();
	}
}

// Winston ロガーインスタンスの作成 (変更なし)
const logger = winston.createLogger({
	level: currentLogLevel,
	levels: customLevels.levels,
	format: fileLogFormat,
	transports: [
		new winston.transports.File({
			filename: ALL_LOG_FILE,
			level: 'debug',
			options: { flags: 'w' },
			silent: !isFileLoggingEnabled
		}),
		new winston.transports.File({
			filename: ERROR_LOG_FILE,
			level: 'warn',
			options: { flags: 'w' },
			silent: !isFileLoggingEnabled
		}),
		new winston.transports.Console({
			format: consoleLogFormat,
			level: 'success', // ★ デフォルトは 'success'
			stderrLevels: ['error', 'warn', 'success', 'info', 'debug'],
		}),
		new MemoryTransport({ level: 'warn' }),
	],
	exitOnError: false,
});

// ファイルログ制御関数 (変更なし)
const setFileLogging = (enabled: boolean): void => {
	isFileLoggingEnabled = enabled;
	if (currentLogLevel === 'none') {
		logger.info(`(ファイルログ設定変更: ${enabled ? 'ON' : 'OFF'}。ただし現在LogLevel 'none' のため全ログ無効中)`);
		return;
	}
	logger.transports.forEach(transport => {
		if (transport instanceof winston.transports.File) {
			transport.silent = !enabled;
		}
	});
	logger.info(`ファイルログ書き込みが ${enabled ? '有効' : '無効'} に設定されました。`);
};

// ログレベル変更関数 (変更なし)
const setLogLevel = (newLevel: LogLevel): void => {
	if (newLevel === 'none') {
		currentLogLevel = 'none';
		logger.transports.forEach(transport => {
			transport.silent = true;
		});
		logger.level = 'none';
		console.log(`[Logger] LogLevel set to 'none'. All logging disabled.`);
		return;
	}

	currentLogLevel = newLevel;

	if (customLevels.levels[newLevel as keyof typeof customLevels.levels] === undefined) {
		logger.warn(`無効なログレベル: "${newLevel}"。 'info' を使用します。`);
		newLevel = 'info';
		currentLogLevel = 'info';
	}

	logger.level = currentLogLevel;

	logger.transports.forEach(transport => {
		if (transport instanceof winston.transports.File) {
			transport.silent = !isFileLoggingEnabled;
		} else if (transport instanceof winston.transports.Console) {
			transport.silent = false;
			// ★ 修正: ユーザー指定のレベルをそのままコンソールにも適用
			transport.level = newLevel;
		} else {
			transport.silent = false;
		}
	});

	const consoleTransport = logger.transports.find(t => t instanceof winston.transports.Console);
	logger.info(`ファイルログレベルが "${currentLogLevel}" に設定されました。 (コンソールは "${consoleTransport?.level ?? 'N/A'}" レベル以上のみ表示)`);
};

// エラーログ要約関数 (変更なし)
const flushErrorLogs = async (): Promise<void> => {
	if (currentLogLevel === 'none') {
		return;
	}
	if (memoryTransportBuffer.length > 0) {
		console.error(`\n--- 🚨 エラー/警告 (${memoryTransportBuffer.length}件) ---`);
		memoryTransportBuffer.forEach(info => {
			const transformed = logger.format.transform(info, {});
			if (transformed && (transformed as Logform.TransformableInfo).message) {
				console.error(`[${info.level.toUpperCase()}] ${info.message}${info.stack ? '\n' + info.stack : ''}`);
			}
		});
		console.error(`--- 全てのログは ${ALL_LOG_FILE} を参照してください ---`);
		console.error(`--- エラー/警告ログは ${ERROR_LOG_FILE} を参照してください ---`);
	} else {
		console.error(`\n✅ エラーや警告は記録されませんでした。`);
		console.error(`--- 全てのログは ${ALL_LOG_FILE} を参照してください ---`);
	}
};

// log オブジェクト (変更なし)
const log = {
	error: (message: string, error?: Error | any, ...meta: any[]) => {
		if (error instanceof Error) {
			logger.error(message, { stack: error.stack, ...meta });
		} else {
			logger.error(message, error, ...meta);
		}
	},
	warn: (message: string, ...meta: any[]) => logger.warn(message, ...meta),
	success: (message: string, ...meta: any[]) => logger.log('success', message, ...meta),
	info: (message: string, ...meta: any[]) => logger.info(message, ...meta),
	debug: (message: string, error?: Error | any, ...meta: any[]) => {
		if (error instanceof Error) {
			logger.debug(message, { stack: error.stack, ...meta });
		} else {
			logger.debug(message, error, ...meta);
		}
	},
	step: (message: string) => logger.info(`--- STEP: ${message} ---`),
	setLogLevel,
	setFileLogging,
	flushErrorLogs,
	isDebug: () => currentLogLevel === 'debug',
};

log.debug(`ロガーが初期化されました。デフォルトログレベル: ${currentLogLevel}`);
log.debug(`全ログファイル: ${ALL_LOG_FILE}`);
log.debug(`エラーログファイル: ${ERROR_LOG_FILE}`);

export { log };
