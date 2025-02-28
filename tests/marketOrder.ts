import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	AdminClient,
	BN,
	PRICE_PRECISION,
	DriftClient,
	PositionDirection,
	User,
	Wallet,
	getMarketOrderParams,
	EventSubscriber,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	isVariant,
	OracleSource,
	PEG_PRECISION,
	ZERO,
} from '../sdk';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

describe('market order', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: AdminClient;
	let driftClientUser: User;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;

	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	let discountMint: Token;
	let discountTokenAccount: AccountInfo;

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerDriftClient: DriftClient;
	let fillerUser: User;

	const marketIndex = 0;
	let solUsd;
	let btcUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		btcUsd = await mockOracle(60000);

		const marketIndexes = [0, 1];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH },
			{ publicKey: btcUsd, source: OracleSource.PYTH },
		];

		driftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();
		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await driftClient.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializePerpMarket(
			btcUsd,
			ammInitialBaseAssetReserve.div(new BN(3000)),
			ammInitialQuoteAssetReserve.div(new BN(3000)),
			periodicity,
			new BN(60000).mul(PEG_PRECISION) // btc-ish price level
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		driftClientUser = new User({
			driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftClientUser.subscribe();

		discountMint = await Token.createMint(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			provider.wallet.publicKey,
			provider.wallet.publicKey,
			6,
			TOKEN_PROGRAM_ID
		);

		await driftClient.updateDiscountMint(discountMint.publicKey);

		discountTokenAccount = await discountMint.getOrCreateAssociatedAccountInfo(
			provider.wallet.publicKey
		);

		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000 * 10 ** 6
		);

		provider.connection.requestAirdrop(fillerKeyPair.publicKey, 10 ** 9);
		fillerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			fillerKeyPair.publicKey
		);
		fillerDriftClient = new DriftClient({
			connection,
			wallet: new Wallet(fillerKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await fillerDriftClient.subscribe();

		await fillerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			fillerUSDCAccount.publicKey
		);

		fillerUser = new User({
			driftClient: fillerDriftClient,
			userAccountPublicKey: await fillerDriftClient.getUserAccountPublicKey(),
		});
		await fillerUser.subscribe();
	});

	after(async () => {
		await driftClient.unsubscribe();
		await driftClientUser.unsubscribe();
		await fillerUser.unsubscribe();
		await fillerDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('Fill market long order with base asset', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = PRICE_PRECISION.mul(new BN(1049)).div(new BN(1000)); // dont breach oracle price bands

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
		});
		await driftClient.placeAndTakePerpOrder(orderParams);
		const orderIndex = new BN(0);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const order =
			driftClientUser.getUserAccount().orders[orderIndex.toString()];

		const market = driftClient.getPerpMarketAccount(marketIndex);
		const expectedFeeToMarket = new BN(1001);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex === 0);

		const firstPosition = driftClientUser.getUserAccount().perpPositions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));

		const expectedQuoteAssetAmount = new BN(-1000001);
		assert(firstPosition.quoteEntryAmount.eq(expectedQuoteAssetAmount));
		assert(firstPosition.quoteBreakEvenAmount.eq(new BN(-1001002)));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert.ok(
			orderActionRecord.quoteAssetAmountFilled.eq(
				expectedQuoteAssetAmount.abs()
			)
		);

		const expectedFillRecordId = new BN(1);
		const expectedFee = new BN(1001);
		assert(orderActionRecord.ts.gt(ZERO));
		assert(orderActionRecord.takerFee.eq(expectedFee));
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(
			orderActionRecord.taker.equals(
				await driftClientUser.getUserAccountPublicKey()
			)
		);
		assert(orderActionRecord.fillerReward.eq(ZERO));
		assert(orderActionRecord.fillRecordId.eq(expectedFillRecordId));
	});

	it('Fill market short order with base asset', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const orderParams = getMarketOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(orderParams);

		await driftClient.fetchAccounts();
		await driftClientUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const firstPosition = driftClientUser.getUserAccount().perpPositions[0];
		assert(firstPosition.baseAssetAmount.eq(ZERO));

		assert(firstPosition.quoteBreakEvenAmount.eq(ZERO));

		const orderActionRecord =
			eventSubscriber.getEventsArray('OrderActionRecord')[0];

		assert.ok(orderActionRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		const expectedQuoteAssetAmount = new BN(1000000);
		assert.ok(
			orderActionRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount)
		);

		const expectedFillRecord = new BN(2);
		const expectedFee = new BN(1000);
		assert(orderActionRecord.ts.gt(ZERO));
		assert(orderActionRecord.takerFee.eq(expectedFee));
		assert(isVariant(orderActionRecord.action, 'fill'));
		assert(
			orderActionRecord.taker.equals(
				await driftClientUser.getUserAccountPublicKey()
			)
		);
		assert(orderActionRecord.fillerReward.eq(ZERO));
		assert(orderActionRecord.fillRecordId.eq(expectedFillRecord));
	});
});
