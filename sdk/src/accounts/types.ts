import {
	SpotMarketAccount,
	PerpMarketAccount,
	OracleSource,
	StateAccount,
	UserAccount,
	UserStatsAccount,
} from '../types';
import StrictEventEmitter from 'strict-event-emitter-types';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { AccountInfo } from '@solana/spl-token';
import { OracleInfo, OraclePriceData } from '..';

export interface AccountSubscriber<T> {
	dataAndSlot?: DataAndSlot<T>;
	subscribe(onChange: (data: T) => void): Promise<void>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;
}

export class NotSubscribedError extends Error {
	name = 'NotSubscribedError';
}

export interface DriftClientAccountEvents {
	stateAccountUpdate: (payload: StateAccount) => void;
	perpMarketAccountUpdate: (payload: PerpMarketAccount) => void;
	spotMarketAccountUpdate: (payload: SpotMarketAccount) => void;
	oraclePriceUpdate: (publicKey: PublicKey, data: OraclePriceData) => void;
	userAccountUpdate: (payload: UserAccount) => void;
	update: void;
	error: (e: Error) => void;
}

export interface DriftClientAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, DriftClientAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	addPerpMarket(marketIndex: number): Promise<boolean>;
	addSpotMarket(marketIndex: number): Promise<boolean>;
	addOracle(oracleInfo: OracleInfo): Promise<boolean>;

	getStateAccountAndSlot(): DataAndSlot<StateAccount>;
	getMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<PerpMarketAccount> | undefined;
	getMarketAccountsAndSlots(): DataAndSlot<PerpMarketAccount>[];
	getSpotMarketAccountAndSlot(
		marketIndex: number
	): DataAndSlot<SpotMarketAccount> | undefined;
	getSpotMarketAccountsAndSlots(): DataAndSlot<SpotMarketAccount>[];
	getOraclePriceDataAndSlot(
		oraclePublicKey: PublicKey
	): DataAndSlot<OraclePriceData> | undefined;
}

export interface UserAccountEvents {
	userAccountUpdate: (payload: UserAccount) => void;
	update: void;
	error: (e: Error) => void;
}

export interface UserAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getUserAccountAndSlot(): DataAndSlot<UserAccount>;
}

export interface TokenAccountEvents {
	tokenAccountUpdate: (payload: AccountInfo) => void;
	update: void;
	error: (e: Error) => void;
}

export interface TokenAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, TokenAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getTokenAccountAndSlot(): DataAndSlot<AccountInfo>;
}

export interface OracleEvents {
	oracleUpdate: (payload: OraclePriceData) => void;
	update: void;
	error: (e: Error) => void;
}

export interface OracleAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, OracleEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getOraclePriceData(): DataAndSlot<OraclePriceData>;
}

export type AccountToPoll = {
	key: string;
	publicKey: PublicKey;
	eventType: string;
	callbackId?: string;
	mapKey?: number;
};

export type OraclesToPoll = {
	publicKey: PublicKey;
	source: OracleSource;
	callbackId?: string;
};

export type BufferAndSlot = {
	slot: number;
	buffer: Buffer | undefined;
};

export type DataAndSlot<T> = {
	data: T;
	slot: number;
};

export interface UserStatsAccountEvents {
	userStatsAccountUpdate: (payload: UserStatsAccount) => void;
	update: void;
	error: (e: Error) => void;
}

export interface UserStatsAccountSubscriber {
	eventEmitter: StrictEventEmitter<EventEmitter, UserStatsAccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;
	fetch(): Promise<void>;
	unsubscribe(): Promise<void>;

	getUserStatsAccountAndSlot(): DataAndSlot<UserStatsAccount>;
}
