import { GeneratedType, Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { Reader, Writer } from 'protobufjs/minimal';

// -----------------------------------------------------------------------------
// MsgCreateStoredChunk の型定義
// -----------------------------------------------------------------------------

export interface MsgCreateStoredChunk {
	creator: string;
	index: string;
	data: Uint8Array;
}

const MsgCreateStoredChunk = {
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
		if (message.data.length !== 0) {
			writer.uint32(26).bytes(message.data);
		}
		return writer;
	},

	decode(input: Reader | Uint8Array, length?: number): MsgCreateStoredChunk {
		const reader = input instanceof Reader ? input : new Reader(input);
		return { creator: '', index: '', data: new Uint8Array() };
	},
};

// -----------------------------------------------------------------------------
// MsgCreateManifest の型定義
// -----------------------------------------------------------------------------

export interface MsgCreateStoredManifest {
	creator: string;
	url: string;
	manifest: string;
}

const MsgCreateStoredManifest = {
	create(base?: Partial<MsgCreateStoredManifest>): MsgCreateStoredManifest {
		return {
			creator: base?.creator ?? "",
			url: base?.url ?? "",
			manifest: base?.manifest ?? "",
		};
	},

	encode(message: MsgCreateStoredManifest, writer: Writer = Writer.create()): Writer {
		if (message.creator !== "") {
			writer.uint32(10).string(message.creator);
		}
		if (message.url !== "") {
			writer.uint32(18).string(message.url);
		}
		if (message.manifest !== "") {
			writer.uint32(26).string(message.manifest);
		}
		return writer;
	},

	decode(input: Reader | Uint8Array, length?: number): MsgCreateStoredManifest {
		const reader = input instanceof Reader ? input : new Reader(input);
		return { creator: "", url: "", manifest: "" };
	}
};


// -----------------------------------------------------------------------------
// カスタム型をRegistryに登録
// -----------------------------------------------------------------------------

const myTypes: ReadonlyArray<[string, GeneratedType]> = [
	// ★★★ 修正箇所 ★★★
	['/datachain.datastore.v1.MsgCreateStoredChunk', MsgCreateStoredChunk as GeneratedType],
	// ★★★ 修正箇所 ★★★
	['/metachain.metastore.v1.MsgCreateStoredManifest', MsgCreateStoredManifest as GeneratedType],
];

export const customRegistry = new Registry([...defaultRegistryTypes, ...myTypes]);