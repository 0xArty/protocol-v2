import { Commitment, TransactionSignature } from '@solana/web3.js';
import {
	DepositRecord,
	FundingPaymentRecord,
	FundingRateRecord,
	LiquidationRecord,
	NewUserRecord,
	OrderActionRecord,
	OrderRecord,
	SettlePnlRecord,
	LPRecord,
	InsuranceFundRecord,
	SpotInterestRecord,
	InsuranceFundStakeRecord,
	CurveRecord,
} from '../index';

export type EventSubscriptionOptions = {
	eventTypes?: EventType[];
	maxEventsPerType?: number;
	orderBy?: EventSubscriptionOrderBy;
	orderDir?: EventSubscriptionOrderDirection;
	commitment?: Commitment;
	maxTx?: number;
	logProviderConfig?: LogProviderConfig;
	// when the subscription starts, client might want to backtrack and fetch old tx's
	// this specifies how far to backtrack
	untilTx?: TransactionSignature;
};

export const DefaultEventSubscriptionOptions: EventSubscriptionOptions = {
	eventTypes: [
		'DepositRecord',
		'FundingPaymentRecord',
		'LiquidationRecord',
		'OrderRecord',
		'OrderActionRecord',
		'FundingRateRecord',
		'NewUserRecord',
		'SettlePnlRecord',
		'LPRecord',
		'InsuranceFundRecord',
		'SpotInterestRecord',
		'InsuranceFundStakeRecord',
		'CurveRecord',
	],
	maxEventsPerType: 4096,
	orderBy: 'blockchain',
	orderDir: 'asc',
	commitment: 'confirmed',
	maxTx: 4096,
	logProviderConfig: {
		type: 'websocket',
	},
};

// Whether we sort events based on order blockchain produced events or client receives events
export type EventSubscriptionOrderBy = 'blockchain' | 'client';
export type EventSubscriptionOrderDirection = 'asc' | 'desc';

export type Event<T> = T & {
	txSig: TransactionSignature;
	slot: number;
};

export type WrappedEvent<Type extends EventType> = EventMap[Type] & {
	eventType: Type;
};

export type WrappedEvents = WrappedEvent<EventType>[];

export type EventMap = {
	DepositRecord: Event<DepositRecord>;
	FundingPaymentRecord: Event<FundingPaymentRecord>;
	LiquidationRecord: Event<LiquidationRecord>;
	FundingRateRecord: Event<FundingRateRecord>;
	OrderRecord: Event<OrderRecord>;
	OrderActionRecord: Event<OrderActionRecord>;
	SettlePnlRecord: Event<SettlePnlRecord>;
	NewUserRecord: Event<NewUserRecord>;
	LPRecord: Event<LPRecord>;
	InsuranceFundRecord: Event<InsuranceFundRecord>;
	SpotInterestRecord: Event<SpotInterestRecord>;
	InsuranceFundStakeRecord: Event<InsuranceFundStakeRecord>;
	CurveRecord: Event<CurveRecord>;
};

export type EventType = keyof EventMap;

export interface EventSubscriberEvents {
	newEvent: (event: WrappedEvent<EventType>) => void;
}

export type SortFn = (
	currentRecord: EventMap[EventType],
	newRecord: EventMap[EventType]
) => 'less than' | 'greater than';

export type logProviderCallback = (
	txSig: TransactionSignature,
	slot: number,
	logs: string[],
	mostRecentBlockTime: number | undefined
) => void;

export interface LogProvider {
	isSubscribed(): boolean;
	subscribe(callback: logProviderCallback, skipHistory?: boolean): boolean;
	unsubscribe(): Promise<boolean>;
}

export type WebSocketLogProviderConfig = {
	type: 'websocket';
};

export type PollingLogProviderConfig = {
	type: 'polling';
	frequency: number;
};

export type LogProviderConfig =
	| WebSocketLogProviderConfig
	| PollingLogProviderConfig;
