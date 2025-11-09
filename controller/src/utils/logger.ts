// controller/src/utils/logger.ts
import * as fs from 'fs';
import * as path from 'path';
import winston, { Logform } from 'winston';
import Transport from 'winston-transport';

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

// --- ★ ステップ1: カスタムレベルと色の定義 ---
const customLevels = {
	levels: {
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
		info: 'magenta', // ピンクの代用
		debug: 'cyan',
	},
};

// winston にカスタムカラーを登録
winston.addColors(customLevels.colors);

// ログレベル (デフォルトは 'info')
let logLevel = process.env.LOG_LEVEL || 'info';
// --- ★ isDebugMode は不要になったため削除 ---

// ログフォーマット
const fileLogFormat = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
	winston.format.errors({ stack: true }), // エラー時のスタックトレースを含める
	winston.format.splat(),
	winston.format.printf((info: Logform.TransformableInfo) => {
		const stackInfo = info.stack ? `\n${info.stack}` : '';
		return `[${info.timestamp}] [${info.level.toUpperCase()}] - ${info.message}${stackInfo}`;
	})
);

// --- ★ コンソールフォーマットの変更 (色付けとレベルの大文字化) ---
const consoleLogFormat = winston.format.combine(
	winston.format.timestamp({ format: 'HH:mm:ss' }),
	winston.format.colorize(), // ★ colorize() を呼び出す
	winston.format.printf((info: Logform.TransformableInfo) => {
		// colorize() がレベルに色を付けてくれる
		return `[${info.timestamp}] [${info.level.toUpperCase()}] - ${info.message}`;
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
	// --- ★ カスタムレベルとデフォルトレベルを設定 ---
	levels: customLevels.levels,
	level: logLevel,
	format: fileLogFormat, // ファイル出力の基本フォーマット
	transports: [
		// 1. 全ログファイル (デバッグレベル以上)
		new winston.transports.File({
			filename: ALL_LOG_FILE,
			level: 'debug', // ファイルには常に 'debug' 以上を書き込む
			options: { flags: 'w' } // 実行のたびに上書き
		}),
		// 2. エラーログファイル (警告レベル以上)
		new winston.transports.File({
			filename: ERROR_LOG_FILE,
			level: 'warn', // 警告レベル以上を書き込む
			options: { flags: 'w' }
		}),
		// 3. コンソール出力 (設定されたログレベルに基づく)
		new winston.transports.Console({
			format: consoleLogFormat,
			level: logLevel, // コンソールに出力するレベル (setLogLevelで変更可能)
		}),
		// 4. メモリバッファ (エラー/警告のみ)
		new MemoryTransport({ level: 'warn' }),
	],
	exitOnError: false, // エラー発生時にプロセスを終了しない
});

// --- ★ デバッグモード切り替え関数を setLogLevel に変更 ---
/**
 * ロガーの表示レベルを動的に変更します。
 * @param newLevel 設定する新しいレベル (error, warn, success, info, debug)
 */
const setLogLevel = (newLevel: string): void => {
	const validLevels = Object.keys(customLevels.levels);
	if (!validLevels.includes(newLevel)) {
		console.warn(`[Logger] 無効なログレベル: ${newLevel}。 'info' を使用します。`);
		newLevel = 'info';
	}

	logLevel = newLevel;
	logger.level = logLevel;

	// コンソールトランスポートのレベルも更新
	const consoleTransport = logger.transports.find(t => t instanceof winston.transports.Console);
	if (consoleTransport) {
		consoleTransport.level = logLevel;
	}
	// 新しいレベルでログ出力 (このログ自体がレベル設定によって表示されない可能性あり)
	logger.log('info', `ログレベルが '${logLevel}' に設定されました。`);
};

// 終了時にエラーログを要約して表示する関数
const flushErrorLogs = async (): Promise<void> => {
	if (memoryTransportBuffer.length > 0) {
		console.error(`\n--- 🚨 エラー/警告 (${memoryTransportBuffer.length}件) ---`);
		memoryTransportBuffer.forEach(info => {
			// コンソール用にシンプルなフォーマットで出力
			// この出力は winston のフォーマットを経由しないため、手動で色付け
			const levelUpper = info.level.toUpperCase();
			let coloredLevel: string;
			switch (info.level) {
				case 'error': coloredLevel = `\x1b[31m${levelUpper}\x1b[0m`; break; // red
				case 'warn': coloredLevel = `\x1b[33m${levelUpper}\x1b[0m`; break; // yellow
				default: coloredLevel = levelUpper;
			}
			console.error(`[${coloredLevel}] ${info.message}${info.stack ? '\n' + info.stack : ''}`);
		});
		console.error(`--- 全てのログは ${ALL_LOG_FILE} を参照してください ---`);
		console.error(`--- エラー/警告ログは ${ERROR_LOG_FILE} を参照してください ---`);
	} else {
		// 正常終了時は logger.success を使いたいが、プロセス終了間際なので console.log を使う
		console.log(`\n\x1b[32m✅ エラーや警告は記録されませんでした。\x1b[0m`); // 手動で緑色
		console.log(`--- 全てのログは ${ALL_LOG_FILE} を参照してください ---`);
	}
};

// ログ出力用の便利なメソッドを追加
const log = {
	info: (message: string, ...meta: any[]) => logger.info(message, ...meta),
	warn: (message: string, ...meta: any[]) => logger.warn(message, ...meta),
	error: (message: string, error?: Error | any, ...meta: any[]) => {
		if (error instanceof Error) {
			logger.error(message, { stack: error.stack, ...meta });
		} else {
			logger.error(message, error, ...meta); // errorがErrorオブジェクトでない場合
		}
	},
	debug: (message: string, ...meta: any[]) => logger.debug(message, ...meta),
	// --- ★ `success` メソッドを追加 ---
	success: (message: string, ...meta: any[]) => logger.log('success', message, ...meta),

	// --- ★ `step` メソッドは変更なし (内部で logger.info を呼ぶ) ---
	step: (message: string) => logger.info(`\n--- STEP: ${message} ---`),

	// --- ★ `setDebugMode` を `setLogLevel` に変更 ---
	setLogLevel,
	flushErrorLogs,
	// --- ★ `isDebug` を修正 ---
	isDebug: () => logLevel === 'debug',
	getLogLevel: () => logLevel,
};

// 初期ログ出力
log.info(`ロガーが初期化されました。ログレベル: ${logLevel}`);
log.info(`全ログファイル: ${ALL_LOG_FILE}`);
log.info(`エラーログファイル: ${ERROR_LOG_FILE}`);

export { log }; // log オブジェクトをエクスポート
