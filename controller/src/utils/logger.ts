// controller/src/utils/logger.ts
import * as fs from 'fs';
import * as path from 'path';
import winston, { Logform } from 'winston';
import Transport from 'winston-transport';

// ★ 修正 1: LogLevel に 'none' を追加
export type LogLevel = 'error' | 'warn' | 'success' | 'info' | 'debug' | 'none';

// ログディレクトリを src/experiments/results/logs に変更
const LOG_DIR = path.join(__dirname, '..', 'experiments', 'results', 'logs');
const ALL_LOG_FILE = path.join(LOG_DIR, 'experiment.all.log');
const ERROR_LOG_FILE = path.join(LOG_DIR, 'experiment.error.log');

// ログディレクトリが存在しない場合は作成
try {
	if (!fs.existsSync(LOG_DIR)) {
		fs.mkdirSync(LOG_DIR, { recursive: true });
	}
} catch (e) {
	console.error(`Error creating log directory ${LOG_DIR}:`, e);
}

// --- カスタムレベルと色の定義 ---
const customLevels = {
	// ★ 修正 2: levels に 'none' を追加 (error より小さい値)
	levels: {
		none: -1, // このレベル自体は使わないが、設定用に定義
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
		none: 'grey', // 使われないが定義
	},
};

// winston にカスタム色を登録
winston.addColors(customLevels.colors);

// ログレベル (デフォルトは 'info')
let currentLogLevel: LogLevel = 'info';

// ★★★ 新規: ファイルログ書き込みフラグ ★★★
let isFileLoggingEnabled: boolean = true;


// ログフォーマット
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

// ★★★ コンソール用フォーマット (修正) ★★★

const MAX_LEVEL_LENGTH = 7; // "SUCCESS" の長さ
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

// メモリバッファ用トランスポート (エラーサマリー用)
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

// Winston ロガーインスタンスの作成
const logger = winston.createLogger({
	level: currentLogLevel, // ★ 修正: ファイル/メモリのデフォルトレベル
	levels: customLevels.levels,
	format: fileLogFormat,
	transports: [
		// 1. 全ログファイル (デバッグレベル以上)
		new winston.transports.File({
			filename: ALL_LOG_FILE,
			level: 'debug', // ★ 修正: ファイルは常に debug 以上を書き込む
			options: { flags: 'w' },
			silent: !isFileLoggingEnabled // ★ 初期状態をフラグに連動
		}),
		// 2. エラーログファイル (警告レベル以上)
		new winston.transports.File({
			filename: ERROR_LOG_FILE,
			level: 'warn',
			options: { flags: 'w' },
			silent: !isFileLoggingEnabled // ★ 初期状態をフラグに連動
		}),

		// ★★★ 3. コンソール出力 (修正) ★★★
		new winston.transports.Console({
			format: consoleLogFormat,
			// 要件1: コンソールには 'success' レベルのみ出力
			level: 'success',
			// 要件2: 'stdout' (プログレスバー) との競合を避けるため、全ログを 'stderr' に出力
			stderrLevels: ['error', 'warn', 'success', 'info', 'debug'],
		}),

		// 4. メモリバッファ (エラー/警告のみ)
		new MemoryTransport({ level: 'warn' }),
	],
	exitOnError: false,
});

// ★★★ 新規: ファイルログ制御関数 ★★★
/**
 * ファイルログトランスポート（'all' と 'error'）の有効/無効を切り替えます。
 * @param enabled true の場合ファイル書き込みを有効化、false の場合無効化
 */
const setFileLogging = (enabled: boolean): void => {
	isFileLoggingEnabled = enabled;

	// 現在のログレベルが 'none' の場合は、強制的に silent = true のままにする
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

// ★ 修正 3: ログレベル変更関数 (setFileLogging と連動)
const setLogLevel = (newLevel: LogLevel): void => {
	// 'none' の場合の特別処理
	if (newLevel === 'none') {
		currentLogLevel = 'none';
		// すべてのトランスポートを silent (無効化) にする
		logger.transports.forEach(transport => {
			transport.silent = true;
		});
		logger.level = 'none';
		// 'none' に設定したことを唯一 console.log (stderr ではない) で通知
		console.log(`[Logger] LogLevel set to 'none'. All logging disabled.`);
		return;
	}

	// 'none' 以外の場合
	currentLogLevel = newLevel; // 先にレベルを更新

	// レベルが存在するかチェック (none 以外)
	if (customLevels.levels[newLevel as keyof typeof customLevels.levels] === undefined) {
		logger.warn(`無効なログレベル: "${newLevel}"。 'info' を使用します。`);
		newLevel = 'info';
		currentLogLevel = 'info';
	}

	// logger.level (ファイル/メモリ用) はユーザー指定に従う
	logger.level = currentLogLevel;

	// 各トランスポートの silent 状態を再適用
	logger.transports.forEach(transport => {
		if (transport instanceof winston.transports.File) {
			// ファイルトランスポートは isFileLoggingEnabled フラグに従う
			transport.silent = !isFileLoggingEnabled;
		} else if (transport instanceof winston.transports.Console) {
			// コンソールは silent = false に戻し、レベルを調整
			transport.silent = false;
			const consoleLevel = (customLevels.levels[newLevel] < customLevels.levels.success)
				? newLevel
				: 'success';
			transport.level = consoleLevel;
		} else {
			// MemoryTransport など
			transport.silent = false;
		}
	});

	const consoleTransport = logger.transports.find(t => t instanceof winston.transports.Console);
	logger.info(`ファイルログレベルが "${currentLogLevel}" に設定されました。 (コンソールは "${consoleTransport?.level ?? 'success'}" レベル以上のみ表示)`);
};

// ★ 修正 4: 終了時にエラーログを要約して表示する関数
const flushErrorLogs = async (): Promise<void> => {
	// ログレベルが 'none' の場合はサマリーも表示しない
	if (currentLogLevel === 'none') {
		return;
	}

	// ★ 修正: エラー/警告のサマリーも console.error (stderr) に出力
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
	debug: (message: string, ...meta: any[]) => logger.debug(message, ...meta),
	// ★★★ 修正: `\n` を削除 ★★★
	step: (message: string) => logger.info(`--- STEP: ${message} ---`),
	setLogLevel,
	setFileLogging, // ★ 新規追加
	flushErrorLogs,
	isDebug: () => currentLogLevel === 'debug', // ★ 修正 5: 変更なし
};

log.debug(`ロガーが初期化されました。デフォルトログレベル: ${currentLogLevel}`);
log.debug(`全ログファイル: ${ALL_LOG_FILE}`);
log.debug(`エラーログファイル: ${ERROR_LOG_FILE}`);

export { log };
