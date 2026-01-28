// services/upload_page/src/App.tsx
import React, { useState } from 'react';
import { accountFromAny, GasPrice, SigningStargateClient, type StdFee } from '@cosmjs/stargate';
import { Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { MsgGrant } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { MsgGrantAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/tx';
import { GenericAuthorization } from 'cosmjs-types/cosmos/authz/v1beta1/authz';
import { BasicAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/feegrant';
import * as tus from 'tus-js-client';
import Long from 'long';

// 自動生成されたProto定義をインポート
// パスは yarn gen:proto の出力構造に合わせます
import {
  MsgInitSession,
  MsgInitSessionResponse,
  MsgCommitRootProof
} from './lib/proto/gwc/gateway/v1/tx';

// プロトコルパッケージ名 (Type URL構築用)
const PROTO_PKG = 'gwc.gateway.v1';

import { MerkleTreeCalculator, type InputFile } from './lib/merkle';
import { createZipBlob, processFileList } from './lib/zip';
import { Comet38Client } from '@cosmjs/tendermint-rpc';

// 環境設定 (devcontainer/localhost環境)
const CONFIG = {
  chainId: 'gwc',
  chainName: 'Cryptomeria Gateway',
  rpcEndpoint: 'http://localhost:30007', // Proxy経由 (config.tomlでCORS許可が必要)
  restEndpoint: 'http://localhost:30003', // TUS Upload用
};

// カスタムメッセージをRegistryに登録
const registry = new Registry(defaultRegistryTypes);
registry.register(`/${PROTO_PKG}.MsgInitSession`, MsgInitSession);
registry.register(`/${PROTO_PKG}.MsgCommitRootProof`, MsgCommitRootProof);

export default function App() {
  const [address, setAddress] = useState<string>('');
  const [client, setClient] = useState<SigningStargateClient | null>(null);
  const [files, setFiles] = useState<InputFile[]>([]);
  const [projectName, setProjectName] = useState('my-onchain-site');
  const [projectVersion, setProjectVersion] = useState('1.0.0');
  const [logs, setLogs] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const addLog = (msg: string) => setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // Keplr接続
  const connectWallet = async () => {
    if (!window.keplr) {
      alert('Keplr extension not found');
      return;
    }
    try {
      // 1. チェーン情報をKeplrに登録 (suggestChain)
      await window.keplr.experimentalSuggestChain({
        chainId: CONFIG.chainId,
        chainName: CONFIG.chainName,
        rpc: CONFIG.rpcEndpoint,
        rest: CONFIG.restEndpoint,
        bip44: {
          coinType: 118,
        },
        bech32Config: {
          bech32PrefixAccAddr: 'gwc',
          bech32PrefixAccPub: 'gwcpub',
          bech32PrefixValAddr: 'gwcvaloper',
          bech32PrefixValPub: 'gwcvaloperpub',
          bech32PrefixConsAddr: 'gwcvalcons',
          bech32PrefixConsPub: 'gwcvalconspub',
        },
        currencies: [
          {
            coinDenom: 'GWC',
            coinMinimalDenom: 'ugwc',
            coinDecimals: 6,
            coinGeckoId: 'cosmos', // 仮設定
          },
        ],
        feeCurrencies: [
          {
            coinDenom: 'GWC',
            coinMinimalDenom: 'ugwc',
            coinDecimals: 6,
            coinGeckoId: 'cosmos',
            gasPriceStep: {
              low: 0.01,
              average: 0.025,
              high: 0.04,
            },
          },
        ],
        stakeCurrency: {
          coinDenom: 'GWC',
          coinMinimalDenom: 'ugwc',
          coinDecimals: 6,
          coinGeckoId: 'cosmos',
        },
      });

      await window.keplr.enable(CONFIG.chainId);

      const offlineSigner = window.keplr.getOfflineSigner(CONFIG.chainId);
      const accounts = await offlineSigner.getAccounts();
      setAddress(accounts[0].address);

      // 変更点: Tendermintクライアントを手動作成し、オプションをフルコントロールする
      const tmClient = await Comet38Client.connect(CONFIG.rpcEndpoint);

      const signingClient = SigningStargateClient.createWithSigner(
        tmClient,
        offlineSigner,
        {
          registry,
          // ここでガス価格を指定しないと、tx送信時にエラーになる可能性があります
          gasPrice: GasPrice.fromString("0.025ugwc"),

          // アカウント取得時のプレフィックス不一致エラーを回避するための重要設定
          accountParser: accountFromAny,
        }
      );

      setClient(signingClient);
      addLog(`Connected: ${accounts[0].address}`);
    } catch (e: any) {
      console.error(e);
      addLog(`Connection failed: ${e.message}`);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addLog('Processing files...');
      const processed = await processFileList(e.target.files);
      setFiles(processed);
      addLog(`Selected ${processed.length} files.`);
    }
  };

  const handleUpload = async () => {
    if (!client || !address || files.length === 0) return;
    setIsProcessing(true);
    setUploadProgress(0);

    try {
      // 1. Merkle Root計算
      addLog('Step 1: Calculating Merkle Root...');
      const merkleCalc = new MerkleTreeCalculator();
      const rootProof = await merkleCalc.calculateRootProof(files, 1024);
      addLog(`Root Proof: ${rootProof}`);

      // 2. ZIP作成
      addLog('Step 2: Creating ZIP archive...');
      const zipBlob = await createZipBlob(files);
      addLog(`ZIP Size: ${zipBlob.size} bytes`);

      // 3. Init Session (Tx)
      addLog('Step 3: Initializing Session on-chain...');
      const msgInit = {
        typeUrl: `/${PROTO_PKG}.MsgInitSession`,
        value: {
          owner: address,
          fragmentSize: Long.fromNumber(1024), // ts-protoはLong型を使用
          deadlineUnix: Long.fromNumber(0), // default
        },
      };

      const fee: StdFee = { amount: [{ denom: 'ugwc', amount: '2000' }], gas: '200000' };
      const initRes = await client.signAndBroadcast(address, [msgInit], fee);
      if (initRes.code !== 0) throw new Error(`Init failed: ${initRes.rawLog}`);

      // レスポンスから SessionID と Token を取得
      // MsgInitSessionResponse をデコードする
      if (!initRes.msgResponses || initRes.msgResponses.length === 0) {
        throw new Error("No msgResponses found in transaction result");
      }

      const initResponse = MsgInitSessionResponse.decode(initRes.msgResponses[0].value);
      const sessionId = initResponse.sessionId;
      const uploadToken = initResponse.sessionUploadToken;

      addLog(`Session ID: ${sessionId}`);
      addLog(`Upload Token obtained.`);

      // Executorの取得 (イベントから取得するのが確実)
      // csu_init_session イベントを探す
      const initEvent = initRes.events.find((e) => e.type === 'csu_init_session');
      const executorAttr = initEvent?.attributes.find((a) => a.key === 'executor');
      // キーや値が引用符で囲まれている場合があるので除去
      const executorAddr = executorAttr?.value.replace(/^"|"$/g, '') || "";

      if (!executorAddr) throw new Error("Could not find Executor address in events");
      addLog(`Executor: ${executorAddr}`);

      // 4. Grant Authz & Feegrant
      addLog('Step 4: Granting permissions to executor...');

      const msgsToGrant = [
        `/${PROTO_PKG}.MsgDistributeBatch`,
        `/${PROTO_PKG}.MsgFinalizeAndCloseSession`,
        `/${PROTO_PKG}.MsgAbortAndCloseSession`
      ];

      const grantMsgs = msgsToGrant.map(msgType => ({
        typeUrl: '/cosmos.authz.v1beta1.MsgGrant',
        value: MsgGrant.fromPartial({
          granter: address,
          grantee: executorAddr,
          grant: {
            authorization: {
              typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
              value: GenericAuthorization.encode(
                GenericAuthorization.fromPartial({ msg: msgType })
              ).finish(),
            },
            expiration: { seconds: BigInt(Math.floor(Date.now() / 1000) + 3600), nanos: 0 },
          },
        }),
      }));

      const feeGrantMsg = {
        typeUrl: '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
        value: MsgGrantAllowance.fromPartial({
          granter: address,
          grantee: executorAddr,
          allowance: {
            typeUrl: '/cosmos.feegrant.v1beta1.BasicAllowance',
            value: BasicAllowance.encode(
              BasicAllowance.fromPartial({
                spendLimit: [],
                expiration: { seconds: BigInt(Math.floor(Date.now() / 1000) + 3600), nanos: 0 },
              })
            ).finish(),
          },
        }),
      };

      const grantTxRes = await client.signAndBroadcast(
        address,
        [...grantMsgs, feeGrantMsg],
        { amount: [{ denom: 'ugwc', amount: '5000' }], gas: '500000' }
      );
      if (grantTxRes.code !== 0) throw new Error(`Grant failed: ${grantTxRes.rawLog}`);
      addLog('Permissions granted.');

      // 5. Commit Root Proof
      addLog('Step 5: Committing Root Proof...');
      const msgCommit = {
        typeUrl: `/${PROTO_PKG}.MsgCommitRootProof`,
        value: {
          owner: address,
          sessionId: sessionId,
          rootProofHex: rootProof,
        },
      };
      const commitRes = await client.signAndBroadcast(address, [msgCommit], fee);
      if (commitRes.code !== 0) throw new Error(`Commit proof failed: ${commitRes.rawLog}`);
      addLog('Root Proof committed.');

      // 6. TUS Upload
      addLog('Step 6: Starting TUS Upload...');

      const upload = new tus.Upload(zipBlob, {
        endpoint: `${CONFIG.restEndpoint}/upload/tus-stream/`,
        retryDelays: [0, 3000, 5000],
        headers: {
          Authorization: `Bearer ${uploadToken}`,
        },
        metadata: {
          session_id: sessionId,
          project_name: projectName,
          version: projectVersion
        },
        onError: function (error) {
          addLog(`Upload Failed: ${error}`);
          setIsProcessing(false);
        },
        onProgress: function (bytesUploaded, bytesTotal) {
          const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
          setUploadProgress(Number(percentage));
        },
        onSuccess: function () {
          addLog('Upload Finished!');
          addLog(`Verify URL: ${CONFIG.restEndpoint}/render/${projectName}/${projectVersion}/index.html`);
          setIsProcessing(false);
        },
      });

      upload.start();

    } catch (e: any) {
      console.error(e);
      addLog(`Error: ${e.message}`);
      setIsProcessing(false);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h1>🌲 Cryptomeria Web Uploader</h1>

      {/* Wallet Connection */}
      <div style={sectionStyle}>
        <h2>1. Connect Wallet</h2>
        {!address ? (
          <button onClick={connectWallet} style={buttonStyle}>Connect Keplr</button>
        ) : (
          <p>Connected: <strong>{address}</strong></p>
        )}
      </div>

      {/* Project Info */}
      <div style={sectionStyle}>
        <h2>2. Project Info</h2>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text" placeholder="Project Name" value={projectName}
            onChange={e => setProjectName(e.target.value)} style={inputStyle}
          />
          <input
            type="text" placeholder="Version" value={projectVersion}
            onChange={e => setProjectVersion(e.target.value)} style={inputStyle}
          />
        </div>
      </div>

      {/* File Selection */}
      <div style={sectionStyle}>
        <h2>3. Select Directory</h2>
        <input
          type="file"
          // @ts-ignore
          webkitdirectory="" directory="" multiple
          onChange={handleFileSelect}
        />
        <p>{files.length} files selected.</p>
      </div>

      {/* Upload Button */}
      <div style={{ marginBottom: '20px' }}>
        <button
          onClick={handleUpload}
          disabled={!address || files.length === 0 || isProcessing}
          style={{
            ...buttonStyle,
            backgroundColor: isProcessing ? '#ccc' : '#2ecc71',
            cursor: isProcessing ? 'not-allowed' : 'pointer'
          }}
        >
          {isProcessing ? 'Processing...' : '🚀 Upload to On-chain Web'}
        </button>
      </div>

      {/* Progress Bar */}
      {isProcessing && (
        <div style={{ marginBottom: '20px' }}>
          <label>Progress: {uploadProgress}%</label>
          <div style={{ width: '100%', backgroundColor: '#eee', height: '20px', borderRadius: '4px' }}>
            <div style={{ width: `${uploadProgress}%`, backgroundColor: '#3498db', height: '100%', borderRadius: '4px', transition: 'width 0.3s' }}></div>
          </div>
        </div>
      )}

      {/* Logs */}
      <div style={{ backgroundColor: '#f9f9f9', padding: '10px', height: '200px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '4px' }}>
        <h3>Logs</h3>
        {logs.map((log, i) => (
          <div key={i} style={{ borderBottom: '1px solid #eee', padding: '2px 0', fontSize: '0.9em' }}>{log}</div>
        ))}
      </div>
    </div>
  );
}

const sectionStyle = { marginBottom: '20px', padding: '15px', border: '1px solid #eee', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' };
const inputStyle = { padding: '8px', border: '1px solid #ccc', borderRadius: '4px', flex: 1 };
const buttonStyle = { padding: '10px 20px', backgroundColor: '#3498db', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '16px' };