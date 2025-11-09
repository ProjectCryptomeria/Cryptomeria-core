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
		success: 2, // ★ 追加
		info: 3,
		debug: 4,
	},
	colors: {
		error: 'red',
		warn: 'yellow',
		success: 'green',
		info: 'magenta', // (ピンク)
		debug: 'cyan',   // (水色)
	},
};

// winston にカスタム色を登録
winston.addColors(customLevels.colors);

// ログレベル (デフォルトは 'info')
let currentLogLevel = 'info'; // ★ 修正: setLogLevel で変更するため let に

// ログフォーマット
const fileLogFormat = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
	winston.format.errors({ stack: true }), // エラー時のスタックトレースを含める
	winston.format.splat(),
	winston.format.printf((info: Logform.TransformableInfo) => {
		const stackInfo = info.stack ? `\n${info.stack}` : '';
		// ★ 修正: レベルを大文字に + 右パディングで揃える
		const level = info.level.toUpperCase().padEnd(7); // 7文字幅 (SUCCESS) で揃える
		return `[${info.timestamp}] [${level}] - ${info.message}${stackInfo}`;
	})
);

// ★★★ コンソール用フォーマット (修正) ★★★

// 1. レベル文字列を大文字にし、パディングするカスタムフォーマット
const levelAlign = winston.format((info) => {
	info.level = info.level.toUpperCase().padEnd(7);
	return info;
});

const consoleLogFormat = winston.format.combine(
	winston.format.timestamp({ format: 'HH:mm:ss' }), // 1. タイムスタンプ
	levelAlign(), // 2. 'success' -> 'SUCCESS  '
	winston.format.colorize(), // 3. 'SUCCESS  ' -> '\x1B[32mSUCCESS  \x1B[39m'
	winston.format.printf((info: Logform.TransformableInfo) => { // 4. 組み立て
		// この時点で info.level は完全にフォーマット済み
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
	level: currentLogLevel, // デフォルトレベル (setLogLevelで上書きされる)
	levels: customLevels.levels, // ★ カスタムレベルを設定
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
			format: consoleLogFormat, // ★ 修正されたコンソール用フォーマット
			level: currentLogLevel, // コンソールに出力するレベル (setLogLevelで上書き)
		}),
		// 4. メモリバッファ (エラー/警告のみ)
		new MemoryTransport({ level: 'warn' }),
	],
	exitOnError: false, // エラー発生時にプロセスを終了しない
});

// ★ 修正: ログレベル変更関数 (setDebugMode から変更)
const setLogLevel = (newLevel: string): void => {
	if (customLevels.levels[newLevel as keyof typeof customLevels.levels] === undefined) {
		logger.warn(`無効なログレベル: "${newLevel}"。 'info' を使用します。`);
		newLevel = 'info';
	}

	currentLogLevel = newLevel;
	logger.level = currentLogLevel;

	// コンソールトランスポートのレベルも更新
	const consoleTransport = logger.transports.find(t => t instanceof winston.transports.Console);
	if (consoleTransport) {
		consoleTransport.level = currentLogLevel;
	}
	logger.info(`ログレベルが "${currentLogLevel}" に設定されました。`); // このログは設定後に表示される
};

// 終了時にエラーログを要約して表示する関数
const flushErrorLogs = async (): Promise<void> => {
	if (memoryTransportBuffer.length > 0) {
		console.error(`\n--- 🚨 エラー/警告 (${memoryTransportBuffer.length}件) ---`);
		memoryTransportBuffer.forEach(info => {
			const transformed = logger.format.transform(info, {});
			if (transformed && (transformed as Logform.TransformableInfo).message) {
				// コンソール用にシンプルなフォーマットで出力
				// (この時点では colorize は適用されないため、レベル文字列をそのまま使用)
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
	error: (message: string, error?: Error | any, ...meta: any[]) => {
		if (error instanceof Error) {
			logger.error(message, { stack: error.stack, ...meta });
		} else {
			logger.error(message, error, ...meta); // errorがErrorオブジェクトでない場合
		}
	},
	warn: (message: string, ...meta: any[]) => logger.warn(message, ...meta),
	success: (message: string, ...meta: any[]) => logger.log('success', message, ...meta), // ★ 追加
	info: (message: string, ...meta: any[]) => logger.info(message, ...meta),
	debug: (message: string, ...meta: any[]) => logger.debug(message, ...meta),
	step: (message: string) => logger.info(`\n--- STEP: ${message} ---`), // INFOレベルで出力
	setLogLevel, // ★ setDebugMode から変更
	flushErrorLogs,
	isDebug: () => currentLogLevel === 'debug',
};

// 初期ログ出力 (★ 修正: info -> debug)
// これらは main() で setLogLevel が呼ばれる前に実行されるため、
// デフォルト('info')で表示されてしまうのを防ぐ
log.debug(`ロガーが初期化されました。デフォルトログレベル: ${currentLogLevel}`);
log.debug(`全ログファイル: ${ALL_LOG_FILE}`);
log.debug(`エラーログファイル: ${ERROR_LOG_FILE}`);

export { log }; // log オブジェクトをエクスポート
