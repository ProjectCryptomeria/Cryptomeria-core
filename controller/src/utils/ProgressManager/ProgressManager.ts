// controller/src/utils/ProgressManager/ProgressManager.ts
import cliProgress from 'cli-progress';
// ★ 修正: インポートパス と ProgressPayload をインポート
import { IProgressBar, IProgressManager, ProgressPayload } from './IProgressManager';

// TTY でない場合に使用するダミー（何もしない）実装
class SilentProgressBar implements IProgressBar {
	// ★ 修正: payload の型を ProgressPayload に
	increment(value?: number, payload?: ProgressPayload): void { }
	update(value: number, payload?: ProgressPayload): void { }
	updatePayload(payload: ProgressPayload): void { }
	setTotal(newTotal: number): void { }
	getTotal(): number { return 0; }
}
const silentProgressBar = new SilentProgressBar();

/**
 * プログレスバーを一切表示しない、何もしない IProgressManager の実装。
 * TTYでない環境や、--no-progress フラグ指定時に使用されます。
 * (★ 修正: export を追加)
 */
export class SilentProgressManager implements IProgressManager {
	start(): void { }
	stop(): void { }
	// ★ 修正: payload の型を ProgressPayload に
	addBar(name: string, total: number, startValue?: number, payload?: ProgressPayload): IProgressBar {
		return silentProgressBar;
	}
	removeBar(bar: IProgressBar): void { }
}

// SingleBar を IProgressBar でラップする
class ProgressBarWrapper implements IProgressBar {
	private total: number;

	constructor(public readonly bar: cliProgress.SingleBar, initialTotal: number) {
		this.total = initialTotal;
	}

	// ★ 修正: payload の型を ProgressPayload に
	increment(value: number = 1, payload?: ProgressPayload): void {
		this.bar.increment(value, payload);
	}

	// ★ 修正: payload の型を ProgressPayload に
	update(value: number, payload?: ProgressPayload): void {
		this.bar.update(value, payload);
	}

	// ★ 修正: payload の型を ProgressPayload に
	updatePayload(payload: ProgressPayload): void {
		this.bar.update(undefined as any, payload);
	}

	setTotal(newTotal: number): void {
		this.total = newTotal;
		this.bar.setTotal(newTotal);
	}

	getTotal(): number {
		return this.total;
	}
}

/**
 * cli-progress を使った IProgressManager の具象実装
 */
class RealProgressManager implements IProgressManager {
	private multiBar: cliProgress.MultiBar | null = null;
	private bars: Set<cliProgress.SingleBar> = new Set();

	constructor() { }

	public start(): void {
		if (this.multiBar) {
			// ★ 修正: 既に開始されている場合は何もしない (stop() しない)
			return;
		}

		this.multiBar = new cliProgress.MultiBar({
			stream: process.stdout,
			hideCursor: true,
			// ★ Note: format が {status} を使用しているため、Payload は { status: string } を想定
			format: '{name} | {bar} | {percentage}% ({value}/{total}) | ETA: {eta_formatted} | {status}',
		}, cliProgress.Presets.shades_classic);
	}

	public stop(): void {
		if (this.multiBar) {
			this.multiBar.stop();
			this.multiBar = null;
		}
	}

	// ★ 修正: payload の型を ProgressPayload に
	public addBar(name: string, total: number, startValue: number = 0, payload: ProgressPayload = { status: 'Initializing...' }): IProgressBar {
		if (!this.multiBar) {
			this.start();
		}

		const bar = this.multiBar!.create(total, startValue, {
			name: name.padEnd(8),
			...payload
		});

		this.bars.add(bar);
		return new ProgressBarWrapper(bar, total);
	}

	public removeBar(bar: IProgressBar): void {
		if (this.multiBar) {
			const wrapper = bar as ProgressBarWrapper;
			if (wrapper.bar) {
				this.multiBar.remove(wrapper.bar);
				this.bars.delete(wrapper.bar);
			}
		}
	}
}

// TTY（対話型端末）かどうかを判定
const isTTY = process.stdout.isTTY;

/**
 * TTY の場合のみ RealProgressManager を、それ以外は SilentProgressManager を
 * エクスポート（インスタンス化）するファクトリクラス
 */
export class ProgressManager extends (isTTY ? RealProgressManager : SilentProgressManager) {
	constructor() {
		super();
		if (!isTTY) {
			// (ファイルログにのみ記録される)
			// ★ 修正: console.log -> log.info
			// (log をインポートすると循環参照になるため console.log を使う)
			console.log('[ProgressManager] STDOUT is not a TTY. Progress bar is disabled (Silent Mode).');
		}
	}
}