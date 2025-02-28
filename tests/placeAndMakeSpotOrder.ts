import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

import {
	AdminClient,
	BN,
	PRICE_PRECISION,
	DriftClient,
	PositionDirection,
	User,
	Wallet,
	EventSubscriber,
	BASE_PRECISION,
	getLimitOrderParams,
	OracleSource,
} from '../sdk/src';

import {
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	printTxLogs,
	sleep,
} from './testHelpers';

describe('place and make spot order', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let makerDriftClient: AdminClient;
	let makerDriftClientUser: User;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;

	const usdcAmount = new BN(100 * 10 ** 6);

	let solUsd;
	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(32.821);

		marketIndexes = [];
		spotMarketIndexes = [0, 1];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		makerDriftClient = new AdminClient({
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
		await makerDriftClient.initialize(usdcMint.publicKey, true);
		await makerDriftClient.subscribe();
		await initializeQuoteSpotMarket(makerDriftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(makerDriftClient, solUsd);
		await makerDriftClient.updatePerpAuctionDuration(new BN(0));

		await makerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const oneSol = new BN(LAMPORTS_PER_SOL);
		await makerDriftClient.deposit(oneSol, 1, provider.wallet.publicKey);

		makerDriftClientUser = new User({
			driftClient: makerDriftClient,
			userAccountPublicKey: await makerDriftClient.getUserAccountPublicKey(),
		});
		await makerDriftClientUser.subscribe();
	});

	after(async () => {
		await makerDriftClient.unsubscribe();
		await makerDriftClientUser.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('make', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		await sleep(1000);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const takerDriftClient = new DriftClient({
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
			userStats: true,
		});
		await takerDriftClient.subscribe();
		await takerDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const takerDriftClientUser = new User({
			driftClient: takerDriftClient,
			userAccountPublicKey: await takerDriftClient.getUserAccountPublicKey(),
		});
		await takerDriftClientUser.subscribe();

		const marketIndex = 1;
		const baseAssetAmount = BASE_PRECISION;
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(40).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: false,
		});
		await takerDriftClient.placeSpotOrder(takerOrderParams);
		await takerDriftClientUser.fetchAccounts();
		const order = takerDriftClientUser.getOrderByUserOrderId(1);
		assert(!order.postOnly);

		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(40).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: true,
			immediateOrCancel: true,
		});

		const txSig = await makerDriftClient.placeAndMakeSpotOrder(
			makerOrderParams,
			{
				taker: await takerDriftClient.getUserAccountPublicKey(),
				order: takerDriftClient.getOrderByUserId(1),
				takerUserAccount: takerDriftClient.getUserAccount(),
				takerStats: takerDriftClient.getUserStatsAccountPublicKey(),
			}
		);

		await printTxLogs(connection, txSig);

		const makerUSDCAmount = makerDriftClient.getQuoteAssetTokenAmount();
		const makerSolAmount = makerDriftClient.getTokenAmount(1);
		assert(makerUSDCAmount.eq(new BN(140008000)));
		assert(makerSolAmount.eq(new BN(0)));

		const takerUSDCAmount = takerDriftClient.getQuoteAssetTokenAmount();
		const takerSolAmount = takerDriftClient.getTokenAmount(1);
		assert(takerUSDCAmount.eq(new BN(59960000)));
		assert(takerSolAmount.eq(new BN(1000000000)));

		await takerDriftClientUser.unsubscribe();
		await takerDriftClient.unsubscribe();
	});
});
