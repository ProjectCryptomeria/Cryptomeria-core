// src/hooks/useCsuUpload.ts
import { useState, useCallback } from 'react';
import { SigningStargateClient } from '@cosmjs/stargate';
import Long from 'long';
import * as tus from 'tus-js-client';
import { MsgInitSessionResponse } from '../lib/proto/gwc/gateway/v1/tx';
import { MsgGrant } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { GenericAuthorization } from 'cosmjs-types/cosmos/authz/v1beta1/authz';
import { MsgGrantAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/tx';
import { BasicAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/feegrant';
import { MerkleTreeCalculator, type InputFile } from '../lib/merkle';
import { createZipBlob } from '../lib/zip';
import { CONFIG } from '../constants/config';
import { SessionState, sessionStateToJSON } from '../lib/proto/gwc/gateway/v1/types';

// デフォルト値として保持（UI側で指定がない場合に使用）
const DEFAULT_FRAGMENT_SIZE = 1024;

/**
 * CSU（Chain Storage Unit）へのアップロードロジックを管理するカスタムフック
 */
export function useCsuUpload(client: SigningStargateClient | null, address: string) {
    const [isProcessing, setIsProcessing] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [logs, setLogs] = useState<string[]>([]);

    const addLog = useCallback((msg: string) => {
        setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
    }, []);

    // REST API経由でセッション状態を取得するヘルパー関数
    const fetchSessionState = async (sessionId: string): Promise<string> => {
        try {
            // ignite scaffoldされたチェーンの標準的なRESTパス
            const url = `${CONFIG.restEndpoint}/gwc/gateway/v1/sessions/${sessionId}`;
            const res = await fetch(url);

            if (!res.ok) {
                // エラーの詳細をコンソールに出す
                console.warn(`Fetch failed: ${res.status} ${res.statusText} for URL: ${url}`);

                // 404の場合はまだインデックスされていない可能性があるためリトライさせる意味でUNKNOWNを返す
                if (res.status === 404) return "NOT_FOUND";

                // その他のエラー（500や400など）はログに残してエラー扱いにする
                throw new Error(`API Error: ${res.status} ${res.statusText}`);
            }

            const data = await res.json();
            // レスポンス構造の確認用ログ（必要なくなれば削除可）
            // console.log("Session State Response:", data);

            return data.session?.state || "UNKNOWN";
        } catch (e: any) {
            // ネットワークエラー（CORS含む）の場合
            console.error("Fetch Execution Error:", e);
            // エラーの内容を文字列として返すことで、呼び出し元でログに出せるようにしても良いが、
            // ここでは簡易的に "ERROR" を返しつつコンソールで詳細を確認する運用とする
            return "ERROR";
        }
    };

    /**
     * 指定されたミリ秒分待機するユーティリティ
     */
    const sleep = (ms: number): Promise<void> => {
        return new Promise((resolve) => setTimeout(resolve, ms));
    };

    /**
     * 非同期処理を指定回数リトライする汎用関数
     */
    async function withRetry<T>(
        task: () => Promise<T>,
        maxAttempts: number,
        delayMs: number
    ): Promise<T> {
        let lastError: Error | unknown;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await task();
            } catch (error) {
                lastError = error;
                if (attempt >= maxAttempts) break;
                console.warn(`[Retry] 試行 ${attempt}/${maxAttempts} 失敗。${delayMs}ms後に再試行します...`);
                await sleep(delayMs);
            }
        }
        throw lastError;
    }

    /**
     * アップロードされたサイトが実際に閲覧可能か確認するヘルパー関数
     * リトライロジックを内包し、指定回数チェックを繰り返します
     * * @param url 確認対象のURL
     * @param maxAttempts 最大試行回数 (デフォルト3回)
     * @param delayMs 再試行までの待機時間 (デフォルト2000ms)
     * @returns 閲覧可能であれば true
     */
    const verifyRendering = async (
        url: string,
        maxAttempts: number = 3,
        delayMs: number = 2000
    ): Promise<boolean> => {
        try {
            // withRetryを使用してfetch処理をラップする
            return await withRetry(async () => {
                const res = await fetch(url, { method: 'HEAD' });

                // ステータスが200でない場合はエラーを投げてリトライをトリガーする
                if (res.status !== 200) {
                    throw new Error(`サイトの準備ができていません (Status: ${res.status})`);
                }

                return true;
            }, maxAttempts, delayMs);
        } catch (e) {
            // 全てのリトライが失敗した、またはネットワークエラーが発生した場合
            console.error(`[Verify failed] ${url}:`, e);
            return false;
        }
    };

    // 引数に fragmentSize を追加
    const upload = async (files: InputFile[], projectName: string, projectVersion: string, fragmentSize: number = DEFAULT_FRAGMENT_SIZE) => {
        if (!client || !address || files.length === 0) return;
        setIsProcessing(true);
        setUploadProgress(0);
        setLogs([]); // ログをリセット

        try {
            // Step 1: マークルツリーの計算とZIP圧縮
            addLog(`Step 1: Merkle Rootの計算とZIP圧縮を開始 (Fragment Size: ${fragmentSize} bytes)...`);
            const merkleCalc = new MerkleTreeCalculator();
            // ここで動的なサイズを使用
            const rootProof = await merkleCalc.calculateRootProof(files, fragmentSize);
            const zipBlob = await createZipBlob(files);
            addLog(`ZIPファイル作成完了: ${(zipBlob.size / 1024).toFixed(2)} KB`);

            // Step 2: セッションの初期化
            addLog('Step 2: セッションの初期化 (On-chain)...');
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            const initRes = await client.signAndBroadcast(address, [{
                typeUrl: '/gwc.gateway.v1.MsgInitSession',
                value: {
                    owner: address,
                    // ここで動的なサイズを使用
                    fragmentSize: Long.fromNumber(fragmentSize),
                    deadlineUnix: Long.fromNumber(deadline)
                }
            }], { amount: [{ denom: CONFIG.denom, amount: '2000' }], gas: '200000' });

            if (initRes.code !== 0) throw new Error(initRes.rawLog);
            const initData = MsgInitSessionResponse.decode(initRes.msgResponses[0].value);

            // イベントログからExecutorを取得（引用符の除去処理を含む）
            const executor = initRes.events.find(e => e.type === 'csu_init_session')
                ?.attributes.find(a => a.key === 'executor')?.value.replace(/^"|"$/g, '') || "";

            // Step 3: Executorへの権限委譲
            addLog('Step 3: Executorへの権限委譲...');
            const grantMsgs = ['MsgDistributeBatch', 'MsgFinalizeAndCloseSession', 'MsgAbortAndCloseSession'].map(type => ({
                typeUrl: '/cosmos.authz.v1beta1.MsgGrant',
                value: MsgGrant.fromPartial({
                    granter: address, grantee: executor,
                    grant: {
                        authorization: {
                            typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
                            value: GenericAuthorization.encode({ msg: `/gwc.gateway.v1.${type}` }).finish()
                        },
                        expiration: { seconds: BigInt(Math.floor(Date.now() / 1000) + 3600), nanos: 0 }
                    }
                })
            }));

            const feeGrant = {
                typeUrl: '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
                value: MsgGrantAllowance.fromPartial({
                    granter: address, grantee: executor,
                    allowance: {
                        typeUrl: '/cosmos.feegrant.v1beta1.BasicAllowance',
                        value: BasicAllowance.encode({ spendLimit: [], expiration: { seconds: BigInt(Math.floor(Date.now() / 1000) + 3600), nanos: 0 } }).finish()
                    }
                })
            };
            await client.signAndBroadcast(address, [...grantMsgs, feeGrant], { amount: [{ denom: CONFIG.denom, amount: '5000' }], gas: '500000' });

            // Step 4: Root Proofのコミット
            addLog('Step 4: Root Proofのコミット...');
            await client.signAndBroadcast(address, [{
                typeUrl: '/gwc.gateway.v1.MsgCommitRootProof',
                value: { owner: address, sessionId: initData.sessionId, rootProofHex: rootProof }
            }], { amount: [{ denom: CONFIG.denom, amount: '2000' }], gas: '200000' });

            // Step 5: TUSプロトコルによるZIPファイルのアップロード
            addLog(`Step 5: TUSアップロードを開始 (合計サイズ: ${(zipBlob.size / 1024 / 1024).toFixed(2)} MB)...`);

            let lastLoggedProgress = -1;

            const tusUpload = new tus.Upload(zipBlob, {
                endpoint: `${CONFIG.restEndpoint}/upload/tus-stream/`,
                retryDelays: [0, 1000, 3000],
                headers: { Authorization: `Bearer ${initData.sessionUploadToken}` },
                metadata: {
                    session_id: initData.sessionId,
                    project_name: projectName,
                    version: projectVersion
                },
                onProgress: (bytes, total) => {
                    const percent = Math.floor((bytes / total) * 100);
                    setUploadProgress(Math.min(percent, 80));

                    if (percent % 10 === 0 && percent !== lastLoggedProgress) {
                        addLog(`↑ データ送信中... ${percent}%`);
                        lastLoggedProgress = percent;
                    }
                },
                onSuccess: async () => {
                    addLog('✅ データ送信完了。Gateway Chainでの分散処理を監視します...');

                    // Step 6: IBC分散処理の監視 (Polling)
                    addLog('Step 6: IBCパケット転送と分散保存の待機中...');
                    const closedSuccessState = sessionStateToJSON(SessionState.SESSION_STATE_CLOSED_SUCCESS);
                    const closedFailedState = sessionStateToJSON(SessionState.SESSION_STATE_CLOSED_FAILED);

                    let isCompleted = false;
                    let retryCount = 0;
                    const maxRetries = 100;

                    while (retryCount < maxRetries) {
                        const state = await fetchSessionState(initData.sessionId);

                        if (state === "ERROR") {
                            addLog(`⚠️ ステータス取得エラー (Consoleを確認してください)。リトライします...`);
                        } else if (retryCount % 5 === 0) {
                            addLog(`🔄 Status: ${state}`);
                        }

                        if (state === closedSuccessState) {
                            isCompleted = true;
                            break;
                        }
                        if (state === closedFailedState) {
                            throw new Error("セッションが異常終了しました (CLOSED_FAILED)");
                        }

                        setUploadProgress((prev) => Math.min(prev + 0.2, 95));

                        await new Promise(r => setTimeout(r, 3000));
                        retryCount++;
                    }

                    if (!isCompleted) {
                        throw new Error("タイムアウト: 分散処理が完了しませんでした。");
                    }

                    setUploadProgress(100);
                    addLog('🎉 セッション完了 (CLOSED_SUCCESS)');

                    // Step 7: 閲覧確認
                    const accessUrl = `${CONFIG.restEndpoint}/render/${projectName}/${projectVersion}/index.html`;
                    addLog(`🌐 アクセス確認中: ${accessUrl}`);

                    await new Promise(r => setTimeout(r, 2000));
                    const isAccessible = await verifyRendering(accessUrl);

                    if (isAccessible) {
                        addLog(`✅ サイトが表示可能です！以下のURLにアクセスしてください。`);
                        addLog(accessUrl);
                    } else {
                        addLog(`⚠️ 処理は完了しましたが、サイトへのアクセス確認に失敗しました（反映待ちの可能性があります）。`);
                        addLog(accessUrl);
                    }

                    setIsProcessing(false);
                },
                onError: (err) => {
                    addLog(`❌ アップロードエラー: ${err.message}`);
                    setIsProcessing(false);
                }
            });
            tusUpload.start();

        } catch (e: any) {
            addLog(`❌ エラー: ${e.message}`);
            console.error(e); // 詳細エラーをコンソールに出力
            setIsProcessing(false);
        }
    };

    return { upload, isProcessing, uploadProgress, logs, addLog };
}