// controller/src/utils/ProgressManager/IProgressManager.ts

/**
 * プログレスバーのペイロード（表示テキスト）の型定義
 * RealProgressManager の format 文字列 '{status}' に対応
 */
export interface ProgressPayload {
	status?: string;
	// ※ 他のカスタムフィールドを format で使用する場合はここに追加
}

/**
 * 個々のプログレスバー（SingleBar）を抽象化するインターフェース
 */
export interface IProgressBar {
	/**
	 * 進捗をインクリメントします。
	 * @param value インクリメントする量 (デフォルト: 1)
	 * @param payload バーのペイロード（{status}など）を更新
	 */
	increment(value?: number, payload?: ProgressPayload): void;

	/**
	 * 進捗を特定の値に設定します。
	 * @param value 新しい進捗値
	 * @param payload バーのペイロードを更新
	 */
	update(value: number, payload?: ProgressPayload): void;

	/**
	 * 進捗は変更せず、ペイロード（表示テキスト）のみを更新します。
	 * @param payload バーのペイロードを更新
	 */
	updatePayload(payload: ProgressPayload): void;

	/**
	 * バーの最大値（total）を更新します。
	 * @param newTotal 新しい最大値
	 */
	setTotal(newTotal: number): void;

	/**
	 * バーの現在の値を取得します。
	 */
	getTotal(): number;
}

/**
 * プログレスバーUI（MultiBar）全体を管理するインターフェース
 */
export interface IProgressManager {
	/**
	 * プログレスバーの描画を開始します。
	 */
	start(): void;

	/**
	 * プログレスバーの描画を停止（クリーンアップ）します。
	 */
	stop(): void;

	/**
	 * MultiBar に新しいプログレスバー（SingleBar）を追加します。
	 * @param name バーの名前 (例: 'data-0', 'Total Upload')
	 * @param total 最大値
	 * @param startValue 初期値
	 * @param payload 初期ペイロード
	 * @returns IProgressBar インスタンス
	 */
	addBar(name: string, total: number, startValue?: number, payload?: ProgressPayload): IProgressBar;

	/**
	 * MultiBar から指定されたバーを削除します。
	 * @param bar 削除する IProgressBar インスタンス
	 */
	removeBar(bar: IProgressBar): void;
}