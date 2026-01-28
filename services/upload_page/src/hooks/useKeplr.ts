// src/hooks/useKeplr.ts
import { useState, useCallback } from 'react';
import {
    SigningStargateClient,
    GasPrice,
    accountFromAny,
    defaultRegistryTypes
} from '@cosmjs/stargate';
import { Comet38Client } from '@cosmjs/tendermint-rpc';
import { Registry } from '@cosmjs/proto-signing';
import { MsgInitSession, MsgCommitRootProof } from '../lib/proto/gwc/gateway/v1/tx';
import { CONFIG } from '../constants/config';

const registry = new Registry(defaultRegistryTypes);
registry.register(`/gwc.gateway.v1.MsgInitSession`, MsgInitSession);
registry.register(`/gwc.gateway.v1.MsgCommitRootProof`, MsgCommitRootProof);

export function useKeplr() {
    const [address, setAddress] = useState<string>('');
    const [client, setClient] = useState<SigningStargateClient | null>(null);
    const [balance, setBalance] = useState<string>('0');

    // 残高をクエリして状態を更新する関数
    const updateBalance = useCallback(async (addr: string, signingClient: SigningStargateClient) => {
        try {
            const bal = await signingClient.getBalance(addr, CONFIG.denom);
            setBalance(bal.amount);
            return bal.amount;
        } catch (e) {
            console.error("残高取得失敗:", e);
            return null;
        }
    }, []);

    const requestFaucet = useCallback(async (targetAddr: string) => {
        try {
            const faucetUrl = `${CONFIG.faucetEndpoint}/send/${targetAddr}`;
            const response = await fetch(faucetUrl);
            return response.ok;
        } catch (e) {
            console.error("Faucetリクエスト失敗:", e);
            return false;
        }
    }, []);

    const connect = useCallback(async () => {
        if (!window.keplr) throw new Error('Keplrが見つかりません。');

        // プレフィックスを 'cosmos' に設定
        await window.keplr.experimentalSuggestChain({
            chainId: CONFIG.chainId,
            chainName: CONFIG.chainName,
            rpc: CONFIG.rpcEndpoint,
            rest: CONFIG.restEndpoint,
            bip44: { coinType: 118 },
            bech32Config: {
                bech32PrefixAccAddr: 'cosmos',
                bech32PrefixAccPub: 'cosmospub',
                bech32PrefixValAddr: 'cosmosvaloper',
                bech32PrefixValPub: 'cosmosvaloperpub',
                bech32PrefixConsAddr: 'cosmosvalcons',
                bech32PrefixConsPub: 'cosmosvalconspub',
            },
            currencies: [{ coinDenom: 'ATOM', coinMinimalDenom: 'uatom', coinDecimals: 6 }],
            feeCurrencies: [{
                coinDenom: 'ATOM', coinMinimalDenom: 'uatom', coinDecimals: 6,
                gasPriceStep: { low: 0.01, average: 0.025, high: 0.04 },
            }],
            stakeCurrency: { coinDenom: 'ATOM', coinMinimalDenom: 'uatom', coinDecimals: 6 },
        });

        await window.keplr.enable(CONFIG.chainId);
        const offlineSigner = window.keplr.getOfflineSigner(CONFIG.chainId);
        const accounts = await offlineSigner.getAccounts();

        const tmClient = await Comet38Client.connect(CONFIG.rpcEndpoint);
        const signingClient = SigningStargateClient.createWithSigner(
            tmClient,
            offlineSigner,
            {
                registry,
                gasPrice: GasPrice.fromString("0.025ugwc"),
                accountParser: accountFromAny,
            }
        );

        setAddress(accounts[0].address);
        setClient(signingClient);

        // 接続完了後に残高を取得
        await updateBalance(accounts[0].address, signingClient);

        return accounts[0].address;
    }, [updateBalance]);

    return { address, client, balance, connect, requestFaucet, updateBalance };
}