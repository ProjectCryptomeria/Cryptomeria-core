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

// ログレベル (デフォルトは 'info')
let logLevel = process.env.LOG_LEVEL || 'info';
let isDebugMode = logLevel === 'debug';

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

const consoleLogFormat = winston.format.combine(
	winston.format.timestamp({ format: 'HH:mm:ss' }),
	winston.format.colorize(), // レベルに応じて色付け
	winston.format.printf((info: Logform.TransformableInfo) => `[${info.timestamp}] [${info.level}] - ${info.message}`)
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
	level: logLevel, // デフォルトレベル
	format: fileLogFormat, // ファイル出力の基本フォーマット
	transports: [
		// 1. 全ログファイル (デバッグレベル以上)
		new winston.transports.File({
			filename: ALL_LOG_FILE,
			level: 'debug', // デバッグレベル以上の全ログを書き込む
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
			level: logLevel, // コンソールに出力するレベル
		}),
		// 4. メモリバッファ (エラー/警告のみ)
		new MemoryTransport({ level: 'warn' }),
	],
	exitOnError: false, // エラー発生時にプロセスを終了しない
});

// デバッグモード切り替え関数
const setDebugMode = (debugEnabled: boolean): void => {
	isDebugMode = debugEnabled;
	logLevel = debugEnabled ? 'debug' : 'info';
	logger.level = logLevel;
	// コンソールトランスポートのレベルも更新
	const consoleTransport = logger.transports.find(t => t instanceof winston.transports.Console);
	if (consoleTransport) {
		consoleTransport.level = logLevel;
	}
	logger.info(`デバッグモードが ${isDebugMode ? '有効' : '無効'} に設定されました。ログレベル: ${logLevel}`);
};

// 終了時にエラーログを要約して表示する関数
const flushErrorLogs = async (): Promise<void> => {
	if (memoryTransportBuffer.length > 0) {
		console.error(`\n--- 🚨 エラー/警告 (${memoryTransportBuffer.length}件) ---`);
		memoryTransportBuffer.forEach(info => {
			const transformed = logger.format.transform(info, {});
			if (transformed && (transformed as Logform.TransformableInfo).message) {
				// コンソール用にシンプルなフォーマットで出力
				console.error(`[${info.level.toUpperCase()}] ${info.message}${info.stack ? '\n' + info.stack : ''}`);
			}
		});
		console.error(`--- 全てのログは ${ALL_LOG_FILE} を参照してください ---`);
		console.error(`--- エラー/警告ログは ${ERROR_LOG_FILE} を参照してください ---`);
	} else {
		console.log(`\n✅ エラーや警告は記録されませんでした。`);
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
	step: (message: string) => logger.info(`\n--- STEP: ${message} ---`), // ステップ表示用
	setDebugMode,
	flushErrorLogs,
	isDebug: () => isDebugMode,
};

// 初期ログ出力
log.info(`ロガーが初期化されました。ログレベル: ${logLevel}`);
log.info(`全ログファイル: ${ALL_LOG_FILE}`);
log.info(`エラーログファイル: ${ERROR_LOG_FILE}`);

export { log }; // log オブジェクトをエクスポート
