import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export const buildEmitter = new EventEmitter();

export class DockerService {
	/**
	 * 指定されたターゲットのDockerイメージをビルドします
	 */
	static async buildImage(target: 'datachain' | 'metachain' | 'relayer') {
		// プロジェクトルート（docker-composeで /workspace にマウントされている想定）
		const PROJECT_ROOT = '/workspace';

		const config = {
			datachain: {
				image: 'raidchain/datachain:latest',
				dockerfile: 'build/datachain/Dockerfile'
			},
			metachain: {
				image: 'raidchain/metachain:latest',
				dockerfile: 'build/metachain/Dockerfile'
			},
			relayer: {
				image: 'raidchain/relayer:latest',
				dockerfile: 'build/relayer/Dockerfile'
			}
		};

		const { image, dockerfile } = config[target];
		const command = 'docker';
		const args = ['build', '-t', image, '-f', dockerfile, '.'];

		// ログ配信開始の通知
		buildEmitter.emit('log', `\r\n\x1b[36m>>> START BUILDING: ${target} <<<\x1b[0m\r\n`);
		buildEmitter.emit('log', `> Command: ${command} ${args.join(' ')}\r\n`);

		return new Promise<void>((resolve, reject) => {
			const process = spawn(command, args, {
				cwd: PROJECT_ROOT, // プロジェクトルートで実行
				stdio: ['ignore', 'pipe', 'pipe'] // 標準入力を無視、出力とエラーをパイプ
			});

			process.stdout.on('data', (data) => {
				// 行ごとに分割して送信（Xtermでの表示崩れ防止のため）
				const lines = data.toString().split('\n');
				lines.forEach((line: string) => {
					if (line.trim()) buildEmitter.emit('log', `${line}\r\n`);
				});
			});

			process.stderr.on('data', (data) => {
				// 標準エラー出力は赤色で表示
				const lines = data.toString().split('\n');
				lines.forEach((line: string) => {
					if (line.trim()) buildEmitter.emit('log', `\x1b[31m${line}\x1b[0m\r\n`);
				});
			});

			process.on('close', (code) => {
				if (code === 0) {
					buildEmitter.emit('log', `\r\n\x1b[32m>>> BUILD SUCCESS: ${target} <<<\x1b[0m\r\n`);
					resolve();
				} else {
					buildEmitter.emit('log', `\r\n\x1b[31m>>> BUILD FAILED: ${target} (Exit Code: ${code}) <<<\x1b[0m\r\n`);
					reject(new Error(`Build failed with code ${code}`));
				}
			});

			process.on('error', (err) => {
				buildEmitter.emit('log', `\r\n\x1b[31m>>> PROCESS ERROR: ${err.message} <<<\x1b[0m\r\n`);
				reject(err);
			});
		});
	}
}