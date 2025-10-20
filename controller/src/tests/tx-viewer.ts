import { stringToPath } from '@cosmjs/crypto';
import { DirectSecp256k1HdWallet, EncodeObject, GeneratedType, Registry } from '@cosmjs/proto-signing';
import { calculateFee, GasPrice, SigningStargateClient } from '@cosmjs/stargate';
import { Buffer } from 'buffer';
import { AuthInfo, TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { Reader, Writer } from 'protobufjs/minimal'; // ★ 修正1: ReaderとWriterを明示的にインポート
import winston from 'winston';

// =================================================================================================
// 📚 I. CONFIG & TYPE DEFINITIONS (修正あり)
// =================================================================================================
const CONFIG = {
	HD_PATH: "m/44'/118'/0'/0/2",
	GAS_PRICE_STRING: '0.0000001uatom',
	GAS_MULTIPLIER: 1.5,
	DATA_SIZE_BYTES: 50 * 1024,
	// 署名に必要なダミー情報
	DUMMY_CHAIN_ID: 'dummy-chain-id-0',
	DUMMY_ACCOUNT_NUMBER: 100,
	DUMMY_MNEMONIC: "legal winner thank year wave sausage worth useful legal winner thank yellow",
	DUMMY_GAS_ESTIMATED: 500000,
};
interface MsgCreateStoredChunk { creator: string; index: string; data: Uint8Array; }

// Protobufの型定義
const MsgCreateStoredChunkProto = {
	create(base?: Partial<MsgCreateStoredChunk>): MsgCreateStoredChunk { return { creator: base?.creator ?? "", index: base?.index ?? "", data: base?.data ?? new Uint8Array(), }; },
	encode(message: MsgCreateStoredChunk, writer: Writer = Writer.create()): Writer {
		if (message.creator !== '') { writer.uint32(10).string(message.creator); }
		if (message.index !== '') { writer.uint32(18).string(message.index); }
		if (message.data.length !== 0) { writer.uint32(26).bytes(message.data); }
		return writer;
	},
	// ★ 修正2: decodeメソッドを修正
	// エラーの核心: inputがReaderまたはUint8Arrayであることを保証し、Readerとして処理する
	decode(input: Reader | Uint8Array, length?: number | undefined): MsgCreateStoredChunk {
		// ★ 修正3: inputがUint8Arrayの場合、Reader.create()でReader型に変換する
		const reader = input instanceof Uint8Array ? Reader.create(input) : input;

		// ★ 修正4: endを計算。readerは常にReader型であるため、posとlenが利用可能
		const end = length === undefined ? reader.len : reader.pos + length;
		const message = MsgCreateStoredChunkProto.create();

		// ★ 修正5: ループ条件。readerは常にReader型であるため、posが利用可能
		while (reader.pos < end) {
			// ★ 修正6: 各デコード操作（uint32, string, bytes, skipType）はreaderに対して実行される
			const tag = reader.uint32();
			switch (tag >>> 3) {
				case 1:
					message.creator = reader.string();
					break;
				case 2:
					message.index = reader.string();
					break;
				case 3:
					message.data = reader.bytes();
					break;
				default:
					reader.skipType(tag & 7); // ★ 修正7: skipTypeがreaderに対して実行される
					break;
			}
		}
		return message;
	}
};

// Any型のデコードのためのカスタムレジストリ
const customRegistry = new Registry([
	['/datachain.datastore.v1.MsgCreateStoredChunk', MsgCreateStoredChunkProto as GeneratedType],
]);

// =================================================================================================
// 📝 II. LOGGER UTILITIES (簡略化 - コンソール出力のみに)
// =================================================================================================
const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp({ format: 'HH:mm:ss' }),
		winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}] - ${info.message}`)
	),
	transports: [
		new winston.transports.Console()
	],
});

// =================================================================================================
// ⚙️ III. CORE LOGIC (TxRaw 生成 & デコード)
// =================================================================================================

/**
 * TxBodyのメッセージフィールド（Any型）をデコードし、読みやすいJSONオブジェクトに変換する
 * @param body TxBodyのデコード済みオブジェクト
 * @returns JSONとして整形されたTxBodyオブジェクト
 */
function decodeTxBody(body: TxBody): object {
	const messages = body.messages.map(msgAny => {
		// 1. Any型を、カスタムレジストリを使ってデコードする
		const decodedMsg = customRegistry.decode(msgAny);

		// 2. デコードされたメッセージを整形
		let formattedValue: any = {};
		for (const key in decodedMsg) {
			if (decodedMsg.hasOwnProperty(key)) {
				const value = (decodedMsg as any)[key];
				if (value instanceof Uint8Array) {
					// データフィールドがUint8Arrayの場合、Base64文字列に変換して表示
					formattedValue[key] = {
						size: value.length,
						base64: Buffer.from(value).toString('base64').substring(0, 50) + "...",
						preview: Buffer.from(value).toString('utf8').substring(0, 50).replace(/\n/g, '\\n') + "...",
					};
				} else {
					formattedValue[key] = value;
				}
			}
		}

		return {
			"@type": msgAny.typeUrl,
			...formattedValue,
		};
	});

	return {
		messages: messages,
		memo: body.memo,
		timeoutHeight: body.timeoutHeight.toString(),
	};
}


/**
 * AuthInfoをデコードし、読みやすいJSONオブジェクトに変換する
 * @param authInfo AuthInfoのデコード済みオブジェクト
 * @returns JSONとして整形されたAuthInfoオブジェクト
 */
function decodeAuthInfo(authInfo: AuthInfo): object {
	const signerInfos = authInfo.signerInfos.map(info => ({
		publicKey: info.publicKey ? {
			"@type": info.publicKey.typeUrl,
			"key": Buffer.from(info.publicKey.value).toString('base64'),
		} : null,
		modeInfo: info.modeInfo,
		sequence: info.sequence.toString(),
	}));

	const fee = {
		amount: authInfo.fee?.amount.map(coin => ({
			denom: coin.denom,
			amount: coin.amount.toString(),
		})),
		gasLimit: authInfo.fee?.gasLimit.toString(),
		payer: authInfo.fee?.payer,
		granter: authInfo.fee?.granter,
	};

	return {
		signerInfos: signerInfos,
		fee: fee,
	};
}


/**
 * ダミー情報を使って署名済みのTxRawを生成し、その内容を表示する
 */
async function generateAndPrintTxRaw() {
	logger.info("Starting TxRaw generation simulation...");
	const gasPrice = GasPrice.fromString(CONFIG.GAS_PRICE_STRING);

	// 1. ウォレットとアカウントのセットアップ（署名に必須）
	const wallet = await DirectSecp256k1HdWallet.fromMnemonic(CONFIG.DUMMY_MNEMONIC, { hdPaths: [stringToPath(CONFIG.HD_PATH)], prefix: "cosmos" });
	const [account] = await wallet.getAccounts();
	if (!account) {
		throw new Error("Failed to get account from wallet.");
	}

	logger.info(`✅ Account setup complete. Address: ${account.address}`);

	// 2. 送信メッセージの作成
	const uniqueSuffix = `tx-raw-sim-${Date.now()}`;
	const index = `${uniqueSuffix}-0`;
	const data = Buffer.alloc(CONFIG.DATA_SIZE_BYTES, `Data for ${index}`);

	const message: EncodeObject = {
		typeUrl: '/datachain.datastore.v1.MsgCreateStoredChunk',
		value: { creator: account.address, index: index, data: data },
	};
	const messages = [message];

	logger.info(`✅ Message created. Index: ${index}, Data Size: ${data.length} bytes.`);

	// 3. 手数料の計算
	const gasWanted = Math.round(CONFIG.DUMMY_GAS_ESTIMATED * CONFIG.GAS_MULTIPLIER);
	const fee = calculateFee(gasWanted, gasPrice);
	if (fee.amount[0]) {
		logger.info(`✅ Fee calculated. Gas Wanted: ${gasWanted}, Amount: ${fee.amount[0].amount}${fee.amount[0].denom}.`);
	}


	// 4. トランザクションへの署名
	// DirectSecp256k1HdWallet の signDirect メソッドを直接使用
	// const a = await wallet.signDirect(
	// 	account.address,
	// 	{
	// 		bodyBytes: new Uint8Array(), // TxBodyは別途生成
	// 		authInfoBytes: new Uint8Array(), // AuthInfoは別途生成
	// 		chainId: CONFIG.DUMMY_CHAIN_ID,
	// 		accountNumber: BigInt(CONFIG.DUMMY_ACCOUNT_NUMBER),
	// 	}
	// );

	// SigningStargateClientのロジックを再現
	const simulatedSigner = await SigningStargateClient.connectWithSigner(
		'http://127.0.0.1:30251', // 接続はしないが、オブジェクト作成に必要
		wallet,
		{ registry: customRegistry, gasPrice }
	);

	const currentSequence = 0;
	// signedTxはTxRawの内部構造（bodyBytes, authInfoBytes, signatures）を持つオブジェクト
	const signedTx = await simulatedSigner.sign(
		account.address,
		messages,
		fee,
		'Tx Simulation Memo',
		{
			accountNumber: CONFIG.DUMMY_ACCOUNT_NUMBER,
			sequence: currentSequence,
			chainId: CONFIG.DUMMY_CHAIN_ID
		}
	);

	logger.info(`✅ Transaction signed successfully with Sequence ${currentSequence}.`);

	// 5. TxRaw形式へのエンコード
	const txRaw = Uint8Array.from(TxRaw.encode(signedTx).finish());

	// 6. デコード処理の実行と表示

	// TxBodyとAuthInfoをデコード
	const decodedTxBody = TxBody.decode(signedTx.bodyBytes);
	const decodedAuthInfo = AuthInfo.decode(signedTx.authInfoBytes);

	// JSON構造を構築
	const txJson = {
		tx: {
			body: decodeTxBody(decodedTxBody),
			auth_info: decodeAuthInfo(decodedAuthInfo),
			signatures: signedTx.signatures.map(sig => Buffer.from(sig).toString('base64')),
		},
	};

	console.log('\n=========================================================================');
	console.log('🚀 生のトランザクションデータ (TxRaw) のバイナリ情報');
	console.log('=========================================================================');
	console.log(`  - 送信元アドレス: ${account.address}`);
	console.log(`  - トランザクションサイズ (TxRaw): ${txRaw.length} bytes`);
	console.log(`  - 署名データ (Base64): ${txJson.tx.signatures[0]?.substring(0, 50)}...`);
	console.log('=========================================================================');

	console.log('\n=========================================================================');
	console.log('💡 実際に送信されるトランザクションをデコードしたJSON形式');
	console.log('=========================================================================');
	// 見やすいように整形してJSON出力
	console.log(JSON.stringify(txJson, null, 2));
	console.log('=========================================================================');
}

// 実行
main().then(() => {
	process.exit(0);
}).catch(err => {
	console.error("Test script failed:", err);
	process.exit(1);
});

// スクリプトの実行関数をmainに統一
async function main() {
	await generateAndPrintTxRaw();
}