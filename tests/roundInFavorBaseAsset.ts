import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import {
	BASE_PRECISION,
	BN,
	getMarketOrderParams,
	OracleSource,
	Wallet,
	MarketStatus,
	AdminClient,
	DriftClient,
	PositionDirection,
} from '../sdk/src';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';

describe('round in favor', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let usdcMint;

	let primaryDriftClient: AdminClient;

	// ammInvariant == k == x * y
	const ammInitialQuoteAssetReserve = new anchor.BN(
		17 * BASE_PRECISION.toNumber()
	);
	const ammInitialBaseAssetReserve = new anchor.BN(
		17 * BASE_PRECISION.toNumber()
	);

	const usdcAmount = new BN(9999 * 10 ** 3);

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		const solUsd = await mockOracle(63000);

		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		primaryDriftClient = new AdminClient({
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
		await primaryDriftClient.initialize(usdcMint.publicKey, true);
		await primaryDriftClient.subscribe();

		await initializeQuoteSpotMarket(primaryDriftClient, usdcMint.publicKey);
		await primaryDriftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await primaryDriftClient.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(63000000000)
		);
		await primaryDriftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);
	});

	after(async () => {
		await primaryDriftClient.unsubscribe();
	});

	it('short', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new DriftClient({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await driftClient.subscribe();
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		await driftClient.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = new BN(789640);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(orderParams);

		assert(driftClient.getQuoteAssetTokenAmount().eq(new BN(9999000)));

		await driftClient.fetchAccounts();
		await driftClient.closePosition(marketIndex);

		await driftClient.fetchAccounts();

		console.log(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString()
		);
		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-88262))
		);
		await driftClient.unsubscribe();
	});

	it('long', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const driftClient = new DriftClient({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await driftClient.subscribe();

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		await driftClient.fetchAccounts();

		const marketIndex = 0;
		const baseAssetAmount = new BN(789566);
		const orderParams = getMarketOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
		});
		await driftClient.placeAndTakePerpOrder(orderParams);

		assert(driftClient.getQuoteAssetTokenAmount().eq(new BN(9999000)));

		await driftClient.closePosition(marketIndex);
		await driftClient.fetchAccounts();

		console.log(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.toString()
		);
		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-88268))
		);
		await driftClient.unsubscribe();
	});
});
