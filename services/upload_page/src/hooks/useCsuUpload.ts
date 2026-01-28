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

    const upload = async (files: InputFile[], projectName: string, projectVersion: string) => {
        if (!client || !address || files.length === 0) return;
        setIsProcessing(true);
        setUploadProgress(0);

        try {
            // Step 1: マークルツリーの計算とZIP圧縮
            addLog('Step 1: Merkle Rootの計算とZIP圧縮を開始...');
            const merkleCalc = new MerkleTreeCalculator();
            const rootProof = await merkleCalc.calculateRootProof(files, 1024);
            const zipBlob = await createZipBlob(files);
            addLog(`ZIPファイル作成完了: ${(zipBlob.size / 1024).toFixed(2)} KB`);

            // Step 2: セッションの初期化
            addLog('Step 2: セッションの初期化 (On-chain)...');
            // セッション期限を現在時刻から1時間後に設定（0だと即時失効する可能性があるため）
            const deadline = Math.floor(Date.now() / 1000) + 3600;
            const initRes = await client.signAndBroadcast(address, [{
                typeUrl: '/gwc.gateway.v1.MsgInitSession',
                value: {
                    owner: address,
                    fragmentSize: Long.fromNumber(1024),
                    deadlineUnix: Long.fromNumber(deadline)
                }
            }], { amount: [{ denom: CONFIG.denom, amount: '2000' }], gas: '200000' });

            if (initRes.code !== 0) throw new Error(initRes.rawLog);
            const initData = MsgInitSessionResponse.decode(initRes.msgResponses[0].value);

            // イベントからExecutor（実行者）のアドレスを取得
            const executor = initRes.events.find(e => e.type === 'csu_init_session')
                ?.attributes.find(a => a.key === 'executor')?.value.replace(/^"|"$/g, '') || "";

            // Step 3: Executorへの権限委譲 (Authz & Feegrant)
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
                // リトライ設定：サーバー側の一時的な検証エラー等に対処
                retryDelays: [0, 1000, 3000],
                headers: { Authorization: `Bearer ${initData.sessionUploadToken}` },
                metadata: {
                    session_id: initData.sessionId,
                    project_name: projectName,
                    version: projectVersion
                },
                onProgress: (bytes, total) => {
                    const percent = Math.floor((bytes / total) * 100);
                    setUploadProgress(percent);

                    if (percent % 10 === 0 && percent !== lastLoggedProgress) {
                        addLog(`↑ アップロード中... ${percent}% (${(bytes / 1024 / 1024).toFixed(2)} MB / ${(total / 1024 / 1024).toFixed(2)} MB)`);
                        lastLoggedProgress = percent;
                    }
                },
                onSuccess: () => {
                    addLog('✅ アップロード完了！');
                    const accessUrl = `${CONFIG.restEndpoint}/render/${projectName}/${projectVersion}/index.html`;
                    addLog(`🌐 アクセスURL: ${accessUrl}`);
                    setUploadProgress(100);
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
            setIsProcessing(false);
        }
    };

    return { upload, isProcessing, uploadProgress, logs, addLog };
}