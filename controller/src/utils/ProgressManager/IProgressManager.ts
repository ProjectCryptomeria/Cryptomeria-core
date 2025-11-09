// controller/src/utils/ProgressManager/IProgressManager.ts

/**
 * 個々のプログレスバー（SingleBar）を抽象化するインターフェース
 */
export interface IProgressBar {
	/**
	 * 進捗をインクリメントします。
	 * @param value インクリメントする量 (デフォルト: 1)
	 * @param payload バーのペイロード（{status, height}など）を更新
	 */
	increment(value?: number, payload?: object): void;

	/**
	 * 進捗を特定の値に設定します。
	 * @param value 新しい進捗値
	 * @param payload バーのペイロードを更新
	 */
	update(value: number, payload?: object): void;

	/**
	 * 進捗は変更せず、ペイロード（表示テキスト）のみを更新します。
	 * @param payload バーのペイロードを更新
	 */
	updatePayload(payload: object): void;

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
	addBar(name: string, total: number, startValue?: number, payload?: object): IProgressBar;

	/**
	 * MultiBar から指定されたバーを削除します。
	 * @param bar 削除する IProgressBar インスタンス
	 */
	removeBar(bar: IProgressBar): void;
}