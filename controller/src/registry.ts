// controller/src/registry.ts
import { GeneratedType, Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { Reader, Writer } from 'protobufjs/minimal';
import { MsgCreateStoredChunk, MsgCreateStoredManifest } from './types'; // types/index.ts 経由でインポート

// --- MsgCreateStoredChunk のエンコード/デコード実装 ---

const MsgCreateStoredChunkProto: GeneratedType = {
	// ★ 修正点1: create メソッドを追加
	create(base?: Partial<MsgCreateStoredChunk>): MsgCreateStoredChunk {
		return {
			creator: base?.creator ?? "",
			index: base?.index ?? "",
			data: base?.data ?? new Uint8Array(),
		};
	},
	encode(message: MsgCreateStoredChunk, writer: Writer = Writer.create()): Writer {
		if (message.creator !== '') {
			writer.uint32(10).string(message.creator);
		}
		if (message.index !== '') {
			writer.uint32(18).string(message.index);
		}
		if (message.data && message.data.length > 0) {
			writer.uint32(26).bytes(message.data);
		}
		return writer;
	},
	decode(input: Reader | Uint8Array, length?: number): MsgCreateStoredChunk {
		const reader = input instanceof Reader ? input : new Reader(input);
		const end = length === undefined ? reader.len : reader.pos + length;
		const message: MsgCreateStoredChunk = { creator: "", index: "", data: new Uint8Array() };
		while (reader.pos < end) {
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
					reader.skipType(tag & 7);
					break;
			}
		}
		return message;
	},
};

// --- MsgCreateStoredManifest のエンコード/デコード実装 ---
const MsgCreateStoredManifestProto: GeneratedType = {
	// 1. create メソッド (これはユーザーのコードで正しかったです)
	create(base?: Partial<MsgCreateStoredManifest>): MsgCreateStoredManifest {
		return {
			creator: base?.creator ?? "",
			index: base?.index ?? "",
			domain: base?.domain ?? "",
			manifest: base?.manifest ?? "",
		};
	},

	// 2. encode メソッド (タグ番号と型を修正)
	encode(message: MsgCreateStoredManifest, writer: Writer = Writer.create()): Writer {
		if (message.creator !== "") {
			writer.uint32(10).string(message.creator); // Tag 1: creator
		}
		if (message.index !== "") {
			writer.uint32(18).string(message.index); // Tag 2: index
		}
		if (message.manifest !== "") {
			writer.uint32(26).string(message.manifest); // Tag 3: manifest
		}
		if (message.domain !== "") {
			writer.uint32(34).string(message.domain); // Tag 4: domain
		}
		return writer;
	},

	// 3. decode メソッド (タグの順序を修正)
	decode(input: Reader | Uint8Array, length?: number): MsgCreateStoredManifest {
		const reader = input instanceof Reader ? input : new Reader(input);
		const end = length === undefined ? reader.len : reader.pos + length;
		const message: MsgCreateStoredManifest = { creator: "", index: "", domain: "", manifest: "" };
		while (reader.pos < end) {
			const tag = reader.uint32();
			switch (tag >>> 3) {
				case 1:
					message.creator = reader.string();
					break;
				case 2:
					message.index = reader.string();
					break;
				case 3:
					message.manifest = reader.string(); // ★ Tag 3 は manifest
					break;
				case 4:
					message.domain = reader.string(); // ★ Tag 4 は domain
					break;
				default:
					reader.skipType(tag & 7);
					break;
			}
		}
		return message;
	},
};

// --- カスタム型を Registry に登録 ---

const customTypes: ReadonlyArray<[string, GeneratedType]> = [
	['/datachain.datastore.v1.MsgCreateStoredChunk', MsgCreateStoredChunkProto],
	['/metachain.metastore.v1.MsgCreateStoredManifest', MsgCreateStoredManifestProto],
];

export const customRegistry = new Registry([...defaultRegistryTypes, ...customTypes]);

console.log('[Registry] カスタム Protobuf 型が登録されました。');