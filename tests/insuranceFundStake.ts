import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey, Keypair } from '@solana/web3.js';

import {
	AdminClient,
	OracleGuardRails,
	DriftClient,
	User,
	BN,
	OracleSource,
	EventSubscriber,
	getInsuranceFundStakeAccountPublicKey,
	InsuranceFundStake,
	ZERO,
	QUOTE_SPOT_MARKET_INDEX,
	QUOTE_PRECISION,
	ONE,
	getTokenAmount,
	SpotBalanceType,
	getBalance,
	isVariant,
	PEG_PRECISION,
	SPOT_MARKET_RATE_PRECISION,
	findComputeUnitConsumption,
	convertToNumber,
	AMM_RESERVE_PRECISION,
	unstakeSharesToAmount,
	MarketStatus,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	initializeQuoteSpotMarket,
	initializeSolSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	printTxLogs,
	setFeedPrice,
	sleep,
} from './testHelpers';

describe('insurance fund stake', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: AdminClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount: Keypair;

	let solOracle: PublicKey;

	const usdcAmount = new BN(1000000 * 10 ** 6); //1M

	let secondUserDriftClient: DriftClient;
	let secondUserDriftClientWSOLAccount: PublicKey;
	let secondUserDriftClientUSDCAccount: PublicKey;

	const solAmount = new BN(10000 * 10 ** 9);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(2)), // 2x it
			provider
		);

		solOracle = await mockOracle(22500); // a future we all need to believe in

		driftClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
			userStats: true,
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await initializeSolSpotMarket(driftClient, solOracle);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await driftClient.initializePerpMarket(
			solOracle,
			AMM_RESERVE_PRECISION,
			AMM_RESERVE_PRECISION,
			periodicity,
			new BN(22500 * PEG_PRECISION.toNumber()),
			undefined,
			1000
		);
		await driftClient.updatePerpMarketStatus(0, MarketStatus.ACTIVE);
		await driftClient.updatePerpMarketBaseSpread(0, 2000);
		await driftClient.updatePerpMarketCurveUpdateIntensity(0, 100);

		const subAccountId = 0;
		const name = 'BIGZ';
		await driftClient.initializeUserAccount(subAccountId, name);
		await driftClient.deposit(
			usdcAmount,
			QUOTE_SPOT_MARKET_INDEX,
			userUSDCAccount.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await secondUserDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('initialize if stake', async () => {
		const marketIndex = 0;
		await driftClient.initializeInsuranceFundStake(marketIndex);

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);
		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		assert(ifStakeAccount.marketIndex === marketIndex);
		assert(ifStakeAccount.authority.equals(provider.wallet.publicKey));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.numberOfSubAccounts === 1);
		assert(userStats.ifStakedQuoteAssetAmount.eq(ZERO));
	});

	it('user if stake', async () => {
		const marketIndex = 0;
		const spotMarketBefore = driftClient.getSpotMarketAccount(marketIndex);
		// console.log(spotMarketBefore);
		console.log(
			'spotMarketBefore.totalIfShares:',
			spotMarketBefore.insuranceFund.totalShares.toString()
		);

		try {
			const txSig = await driftClient.addInsuranceFundStake(
				marketIndex,
				usdcAmount,
				userUSDCAccount.publicKey
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		console.log(
			'spotMarket0.insurance.totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		// console.log(spotMarket0);

		assert(spotMarket0.revenuePool.scaledBalance.eq(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount));

		const userStats = driftClient.getUserStats().getAccount();
		console.log(userStats);
		assert(userStats.ifStakedQuoteAssetAmount.eq(usdcAmount));
	});

	it('user request if unstake (half)', async () => {
		const marketIndex = 0;
		const nShares = usdcAmount.div(new BN(2));

		const spotMarket0Before = driftClient.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFund.vault
				)
			).value.amount
		);

		const amountFromShare = unstakeSharesToAmount(
			nShares,
			spotMarket0Before.insuranceFund.totalShares,
			insuranceVaultAmountBefore
		);

		console.log(amountFromShare.toString());

		try {
			const txSig = await driftClient.requestRemoveInsuranceFundStake(
				marketIndex,
				amountFromShare
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.eq(usdcAmount));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.gt(ZERO));
		console.log(ifStakeAccount.lastWithdrawRequestShares.toString());
		console.log(nShares.toString());
		assert(ifStakeAccount.lastWithdrawRequestShares.eq(nShares));
		assert(ifStakeAccount.lastWithdrawRequestValue.eq(amountFromShare));
	});

	it('user if unstake (half)', async () => {
		const marketIndex = 0;
		// const nShares = usdcAmount.div(new BN(2));
		const txSig = await driftClient.removeInsuranceFundStake(
			marketIndex,
			userUSDCAccount.publicKey
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		console.log(
			'totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		console.log(
			'userIfShares:',
			spotMarket0.insuranceFund.userShares.toString()
		);

		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount.div(new BN(2))));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount.div(new BN(2))));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.eq(usdcAmount.div(new BN(2))));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const balance = await connection.getBalance(userUSDCAccount.publicKey);
		console.log('sol balance:', balance.toString());
		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '500000000000');

		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));
	});

	it('user request if unstake with escrow period (last half)', async () => {
		const txSig = await driftClient.updateInsuranceFundUnstakingPeriod(
			0,
			new BN(10)
		);
		await printTxLogs(connection, txSig);

		const marketIndex = 0;
		const nShares = usdcAmount.div(new BN(2));
		const txSig2 = await driftClient.requestRemoveInsuranceFundStake(
			marketIndex,
			nShares
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig2, { commitment: 'confirmed' }))
				.meta.logMessages
		);

		try {
			const txSig3 = await driftClient.removeInsuranceFundStake(
				marketIndex,
				userUSDCAccount.publicKey
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig3, { commitment: 'confirmed' }))
					.meta.logMessages
			);
			assert(false); // todo
		} catch (e) {
			console.error(e);
		}

		await driftClient.fetchAccounts();

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.insuranceFund.unstakingPeriod.eq(new BN(10)));
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.eq(usdcAmount.div(new BN(2))));
		assert(spotMarket0.insuranceFund.userShares.eq(usdcAmount.div(new BN(2))));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.gt(ZERO));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.gt(ZERO));
	});

	it('user if unstake with escrow period (last half)', async () => {
		const marketIndex = 0;

		try {
			await driftClient.updateSpotMarketIfFactor(
				0,
				new BN(90000),
				new BN(100000)
			);
		} catch (e) {
			console.log('cant set reserve factor');
			console.error(e);
			assert(false);
		}

		const spotMarket0Pre = driftClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0Pre.insuranceFund.unstakingPeriod.eq(new BN(10)));

		let slot = await connection.getSlot();
		let now = await connection.getBlockTime(slot);

		const ifStakePublicKeyPre = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccountPre =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKeyPre
			)) as InsuranceFundStake;

		while (
			ifStakeAccountPre.lastWithdrawRequestTs
				.add(spotMarket0Pre.insuranceFund.unstakingPeriod)
				.gte(new BN(now))
		) {
			console.log(
				ifStakeAccountPre.lastWithdrawRequestTs.toString(),
				' + ',
				spotMarket0Pre.insuranceFund.unstakingPeriod.toString(),
				'>',
				now
			);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		// const nShares = usdcAmount.div(new BN(2));
		const txSig = await driftClient.removeInsuranceFundStake(
			marketIndex,
			userUSDCAccount.publicKey
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);
		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		console.log(
			'totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		console.log(
			'userIfShares:',
			spotMarket0.insuranceFund.userShares.toString()
		);

		assert(spotMarket0.insuranceFund.totalShares.eq(ZERO));
		assert(spotMarket0.insuranceFund.userShares.eq(ZERO));

		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);

		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		assert(ifStakeAccount.lastWithdrawRequestShares.eq(ZERO));

		const userStats = driftClient.getUserStats().getAccount();
		assert(userStats.ifStakedQuoteAssetAmount.eq(ZERO));

		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '999999999999');
	});

	it('Second User Deposit SOL', async () => {
		[
			secondUserDriftClient,
			secondUserDriftClientWSOLAccount,
			secondUserDriftClientUSDCAccount,
		] = await createUserWithUSDCAndWSOLAccount(
			provider,
			usdcMint,
			chProgram,
			solAmount,
			ZERO,
			[0],
			[0, 1],
			[
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			]
		);

		const marketIndex = 1;
		const txSig = await secondUserDriftClient.deposit(
			solAmount,
			marketIndex,
			secondUserDriftClientWSOLAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await driftClient.getSpotMarketAccount(marketIndex);
		console.log(spotMarket.depositBalance.toString());
		// assert(spotMarket.depositBalance.eq('10000000000'));

		const vaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(spotMarket.vault)
			).value.amount
		);
		assert(vaultAmount.eq(solAmount));

		const expectedBalance = getBalance(
			solAmount,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		const userspotMarketBalance =
			secondUserDriftClient.getUserAccount().spotPositions[1];
		assert(isVariant(userspotMarketBalance.balanceType, 'deposit'));
		assert(userspotMarketBalance.scaledBalance.eq(expectedBalance));
	});

	it('Second User Withdraw First half USDC', async () => {
		const marketIndex = 0;
		const withdrawAmount = usdcAmount.div(new BN(2));
		const txSig = await secondUserDriftClient.withdraw(
			withdrawAmount,
			marketIndex,
			secondUserDriftClientUSDCAccount
		);
		await printTxLogs(connection, txSig);

		const spotMarket = await driftClient.getSpotMarketAccount(marketIndex);
		const expectedBorrowBalance = new BN(500000000000001);
		console.log(
			'spotMarket.borrowBalance:',
			spotMarket.borrowBalance.toString()
		);
		assert(spotMarket.borrowBalance.eq(expectedBorrowBalance));

		const vaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(spotMarket.vault)
			).value.amount
		);
		const expectedVaultAmount = usdcAmount.sub(withdrawAmount);
		assert(vaultAmount.eq(expectedVaultAmount));

		const expectedBalance = getBalance(
			withdrawAmount,
			spotMarket,
			SpotBalanceType.BORROW
		);

		const userspotMarketBalance =
			secondUserDriftClient.getUserAccount().spotPositions[0];
		assert(isVariant(userspotMarketBalance.balanceType, 'borrow'));
		assert(userspotMarketBalance.scaledBalance.eq(expectedBalance));

		const actualAmountWithdrawn = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					secondUserDriftClientUSDCAccount
				)
			).value.amount
		);

		assert(withdrawAmount.eq(actualAmountWithdrawn));
	});

	it('if pool revenue from borrows', async () => {
		let spotMarket = driftClient.getSpotMarketAccount(0);

		// await mintToInsuranceFund(
		// 	spotMarket.insurance.vault,
		// 	usdcMint,
		// 	new BN(80085).mul(QUOTE_PRECISION),
		// 	provider
		// );

		const ifPoolBalance = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		assert(spotMarket.borrowBalance.gt(ZERO));
		assert(ifPoolBalance.eq(new BN(0)));

		await driftClient.updateSpotMarketCumulativeInterest(0);

		await driftClient.fetchAccounts();
		spotMarket = driftClient.getSpotMarketAccount(0);

		console.log(
			'cumulativeBorrowInterest:',
			spotMarket.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			spotMarket.cumulativeDepositInterest.toString()
		);
		const ifPoolBalanceAfterUpdate = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(ifPoolBalanceAfterUpdate.gt(new BN(0)));
		assert(spotMarket.cumulativeBorrowInterest.gt(SPOT_MARKET_RATE_PRECISION));
		assert(spotMarket.cumulativeDepositInterest.gt(SPOT_MARKET_RATE_PRECISION));

		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket.insuranceFund.vault
				)
			).value.amount
		);
		console.log('insuranceVaultAmount:', insuranceVaultAmountBefore.toString());
		assert(insuranceVaultAmountBefore.eq(ONE));

		await driftClient.updateSpotMarketRevenueSettlePeriod(0, ONE);

		try {
			const txSig = await driftClient.settleRevenueToInsuranceFund(0);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
		}

		const insuranceVaultAmount = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket.insuranceFund.vault
				)
			).value.amount
		);
		console.log(
			'insuranceVaultAmount:',
			insuranceVaultAmountBefore.toString(),
			'->',
			insuranceVaultAmount.toString()
		);
		assert(insuranceVaultAmount.gt(ONE));

		await driftClient.fetchAccounts();
		spotMarket = driftClient.getSpotMarketAccount(0);
		const ifPoolBalanceAfterSettle = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		assert(ifPoolBalanceAfterSettle.eq(new BN(0)));
	});

	it('no user -> user stake when there is a vault balance', async () => {
		const marketIndex = 0;
		const spotMarket0Before = driftClient.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFund.vault
				)
			).value.amount
		);
		assert(spotMarket0Before.revenuePool.scaledBalance.eq(ZERO));

		assert(spotMarket0Before.insuranceFund.userShares.eq(ZERO));
		assert(spotMarket0Before.insuranceFund.totalShares.eq(ZERO));

		const usdcbalance = await connection.getTokenAccountBalance(
			userUSDCAccount.publicKey
		);
		console.log('usdc balance:', usdcbalance.value.amount);
		assert(usdcbalance.value.amount == '999999999999');

		try {
			const txSig = await driftClient.addInsuranceFundStake(
				marketIndex,
				new BN(usdcbalance.value.amount),
				userUSDCAccount.publicKey
			);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const spotMarket0 = driftClient.getSpotMarketAccount(marketIndex);
		assert(spotMarket0.revenuePool.scaledBalance.eq(ZERO));
		const insuranceVaultAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFund.vault
				)
			).value.amount
		);
		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		console.log(
			'userIfShares:',
			spotMarket0.insuranceFund.userShares.toString(),
			'totalIfShares:',
			spotMarket0.insuranceFund.totalShares.toString()
		);
		assert(spotMarket0.insuranceFund.totalShares.gt(ZERO));
		assert(spotMarket0.insuranceFund.totalShares.gt(usdcAmount));
		assert(spotMarket0.insuranceFund.totalShares.gt(new BN('1000000004698')));
		// totalIfShares lower bound, kinda random basd on timestamps

		assert(
			spotMarket0.insuranceFund.userShares.eq(new BN(usdcbalance.value.amount))
		);

		const userStats = driftClient.getUserStats().getAccount();
		assert(
			userStats.ifStakedQuoteAssetAmount.eq(new BN(usdcbalance.value.amount))
		);
	});

	it('user stake misses out on gains during escrow period after cancel', async () => {
		const marketIndex = 0;
		const spotMarket0Before = driftClient.getSpotMarketAccount(marketIndex);
		const insuranceVaultAmountBefore = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFund.vault
				)
			).value.amount
		);
		assert(spotMarket0Before.revenuePool.scaledBalance.eq(ZERO));

		console.log(
			'cumulativeBorrowInterest:',
			spotMarket0Before.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			spotMarket0Before.cumulativeDepositInterest.toString()
		);

		// user requests partial withdraw
		const ifStakePublicKey = getInsuranceFundStakeAccountPublicKey(
			driftClient.program.programId,
			provider.wallet.publicKey,
			marketIndex
		);
		const ifStakeAccount =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;

		const amountFromShare = unstakeSharesToAmount(
			ifStakeAccount.ifShares.div(new BN(10)),
			spotMarket0Before.insuranceFund.totalShares,
			insuranceVaultAmountBefore
		);

		await driftClient.requestRemoveInsuranceFundStake(
			marketIndex,
			amountFromShare
		);

		console.log('letting interest accum (2s)');
		await sleep(2000);
		await driftClient.updateSpotMarketCumulativeInterest(0);
		const spotMarketIUpdate = await driftClient.getSpotMarketAccount(
			marketIndex
		);

		console.log(
			'cumulativeBorrowInterest:',
			spotMarketIUpdate.cumulativeBorrowInterest.toString()
		);
		console.log(
			'cumulativeDepositInterest:',
			spotMarketIUpdate.cumulativeDepositInterest.toString()
		);

		console.log(spotMarketIUpdate.revenuePool.scaledBalance.toString());
		assert(spotMarketIUpdate.revenuePool.scaledBalance.gt(ZERO));

		try {
			const txSig = await driftClient.settleRevenueToInsuranceFund(marketIndex);
			console.log(
				'tx logs',
				(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
					.meta.logMessages
			);
		} catch (e) {
			console.error(e);
			assert(false);
		}

		const insuranceVaultAmountAfter = new BN(
			(
				await provider.connection.getTokenAccountBalance(
					spotMarket0Before.insuranceFund.vault
				)
			).value.amount
		);
		assert(insuranceVaultAmountAfter.gt(insuranceVaultAmountBefore));
		const txSig = await driftClient.cancelRequestRemoveInsuranceFundStake(
			marketIndex
		);
		await printTxLogs(connection, txSig);

		const ifStakeAccountAfter =
			(await driftClient.program.account.insuranceFundStake.fetch(
				ifStakePublicKey
			)) as InsuranceFundStake;
		const userStats = driftClient.getUserStats().getAccount();

		console.log(
			'ifshares:',
			ifStakeAccount.ifShares.toString(),
			'->',
			ifStakeAccountAfter.ifShares.toString(),
			'(quoteAssetInsuranceFundStake=',
			userStats.ifStakedQuoteAssetAmount.toString(),
			')'
		);

		assert(ifStakeAccountAfter.ifShares.lt(ifStakeAccount.ifShares));

		// the user should have slightly less quote staked than the total quote in if
		assert(
			insuranceVaultAmountAfter
				.sub(userStats.ifStakedQuoteAssetAmount)
				.lt(QUOTE_PRECISION)
		);
	});

	it('liquidate borrow (w/ IF revenue)', async () => {
		const spotMarketBefore = driftClient.getSpotMarketAccount(0);

		const ifPoolBalance = getTokenAmount(
			spotMarketBefore.revenuePool.scaledBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		assert(spotMarketBefore.borrowBalance.gt(ZERO));
		assert(ifPoolBalance.eq(new BN(0)));

		const driftClientUser = new User({
			driftClient: secondUserDriftClient,
			userAccountPublicKey:
				await secondUserDriftClient.getUserAccountPublicKey(),
		});
		await driftClientUser.subscribe();

		const prevTC = driftClientUser.getTotalCollateral();
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(1),
				markOracleDivergenceDenominator: new BN(1),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(100000),
			},
			useForLiquidations: false,
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);
		await setFeedPrice(anchor.workspace.Pyth, 22500 / 10000, solOracle); // down 99.99%
		await sleep(2000);

		await driftClientUser.fetchAccounts();

		const newTC = driftClientUser.getTotalCollateral();
		console.log(
			"Borrower's TotalCollateral: ",
			convertToNumber(prevTC, QUOTE_PRECISION),
			'->',
			convertToNumber(newTC, QUOTE_PRECISION)
		);
		assert(!prevTC.eq(newTC));

		assert(driftClientUser.canBeLiquidated());

		const beforecbb0 = driftClient.getUserAccount().spotPositions[0];
		const beforecbb1 = driftClient.getUserAccount().spotPositions[1];

		const beforeLiquiderUSDCDeposit = getTokenAmount(
			beforecbb0.scaledBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		const beforeLiquiderSOLDeposit = getTokenAmount(
			beforecbb1.scaledBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'LD:',
			beforeLiquiderUSDCDeposit.toString(),
			beforeLiquiderSOLDeposit.toString()
		);

		assert(beforecbb0.marketIndex === 0);
		// assert(beforecbb1.marketIndex.eq(ONE));
		assert(isVariant(beforecbb0.balanceType, 'deposit'));
		// assert(isVariant(beforecbb1.balanceType, 'deposit'));

		const beforebb0 = secondUserDriftClient.getUserAccount().spotPositions[0];
		const beforebb1 = secondUserDriftClient.getUserAccount().spotPositions[1];

		const usdcDepositsBefore = getTokenAmount(
			spotMarketBefore.depositBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		const beforeLiquiteeUSDCBorrow = getTokenAmount(
			beforebb0.scaledBalance,
			spotMarketBefore,
			SpotBalanceType.BORROW
		);

		const beforeLiquiteeSOLDeposit = getTokenAmount(
			beforebb1.scaledBalance,
			spotMarketBefore,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'LT:',
			beforeLiquiteeUSDCBorrow.toString(),
			beforeLiquiteeSOLDeposit.toString()
		);

		assert(beforebb0.marketIndex === 0);
		assert(beforebb1.marketIndex === 1);
		assert(isVariant(beforebb0.balanceType, 'borrow'));
		assert(isVariant(beforebb1.balanceType, 'deposit'));

		assert(beforeLiquiderUSDCDeposit.gt(new BN('1000000066000')));
		assert(beforeLiquiderSOLDeposit.eq(new BN('0')));
		assert(beforeLiquiteeUSDCBorrow.gt(new BN('500000033001')));
		assert(beforeLiquiteeSOLDeposit.gt(new BN('10000000997')));

		const txSig = await driftClient.liquidateSpot(
			await secondUserDriftClient.getUserAccountPublicKey(),
			secondUserDriftClient.getUserAccount(),
			1,
			0,
			new BN(6 * 10 ** 8)
		);

		const computeUnits = await findComputeUnitConsumption(
			driftClient.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await driftClient.fetchAccounts();
		await secondUserDriftClient.fetchAccounts();

		const spotMarket = driftClient.getSpotMarketAccount(0);

		const cbb0 = driftClient.getUserAccount().spotPositions[0];
		const cbb1 = driftClient.getUserAccount().spotPositions[1];

		const afterLiquiderUSDCDeposit = getTokenAmount(
			cbb0.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		const afterLiquiderSOLDeposit = getTokenAmount(
			cbb1.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'LD:',
			afterLiquiderUSDCDeposit.toString(),
			afterLiquiderSOLDeposit.toString()
		);

		assert(cbb0.marketIndex === 0);
		assert(cbb1.marketIndex === 1);
		assert(isVariant(cbb0.balanceType, 'deposit'));
		assert(isVariant(cbb1.balanceType, 'deposit'));

		const bb0 = secondUserDriftClient.getUserAccount().spotPositions[0];
		const bb1 = secondUserDriftClient.getUserAccount().spotPositions[1];

		const afterLiquiteeUSDCBorrow = getTokenAmount(
			bb0.scaledBalance,
			spotMarket,
			SpotBalanceType.BORROW
		);

		const afterLiquiteeSOLDeposit = getTokenAmount(
			bb1.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'LT:',
			afterLiquiteeUSDCBorrow.toString(),
			afterLiquiteeSOLDeposit.toString()
		);

		assert(bb0.marketIndex === 0);
		assert(bb1.marketIndex === 1);
		assert(isVariant(bb0.balanceType, 'borrow'));
		assert(isVariant(bb1.balanceType, 'deposit'));

		assert(afterLiquiderUSDCDeposit.gt(new BN('999400065806')));
		assert(afterLiquiderSOLDeposit.gt(new BN('266660042')));
		console.log(afterLiquiteeUSDCBorrow.toString());
		console.log(afterLiquiteeSOLDeposit.toString());
		assert(afterLiquiteeUSDCBorrow.gte(new BN('499406475800')));
		assert(afterLiquiteeSOLDeposit.gte(new BN('9733337501')));

		// console.log(
		// 	secondUserDriftClient
		// 		.getUserAccount()
		// 		.spotPositions[0].scaledBalance.toString(),

		// 	secondUserDriftClient
		// 		.getUserAccount()
		// 		.spotPositions[0].marketIndex.toString(),
		// 	secondUserDriftClient.getUserAccount().spotPositions[0].balanceType
		// );

		// console.log(
		// 	secondUserDriftClient
		// 		.getUserAccount()
		// 		.spotPositions[1].scaledBalance.toString(),

		// 	secondUserDriftClient
		// 		.getUserAccount()
		// 		.spotPositions[1].marketIndex.toString(),
		// 	secondUserDriftClient.getUserAccount().spotPositions[1].balanceType
		// );

		assert(secondUserDriftClient.getUserAccount().isBeingLiquidated);
		assert(!secondUserDriftClient.getUserAccount().isBankrupt);

		const ifPoolBalanceAfter = getTokenAmount(
			spotMarket.revenuePool.scaledBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);
		console.log('ifPoolBalance: 0 ->', ifPoolBalanceAfter.toString());

		assert(ifPoolBalanceAfter.gte(new BN('6004698')));

		const usdcBefore = ifPoolBalanceAfter
			.add(afterLiquiderUSDCDeposit)
			.sub(afterLiquiteeUSDCBorrow);

		const usdcAfter = ZERO.add(beforeLiquiderUSDCDeposit).sub(
			beforeLiquiteeUSDCBorrow
		);

		const usdcDepositsAfter = getTokenAmount(
			spotMarket.depositBalance,
			spotMarket,
			SpotBalanceType.DEPOSIT
		);

		console.log(
			'usdc borrows in spotMarket:',
			getTokenAmount(
				spotMarketBefore.borrowBalance,
				spotMarketBefore,
				SpotBalanceType.BORROW
			).toString(),
			'->',
			getTokenAmount(
				spotMarket.borrowBalance,
				spotMarket,
				SpotBalanceType.BORROW
			).toString()
		);

		console.log(
			'usdc balances in spotMarket:',
			spotMarketBefore.depositBalance.toString(),
			'->',
			spotMarket.depositBalance.toString()
		);

		console.log(
			'usdc cum dep interest in spotMarket:',
			spotMarketBefore.cumulativeDepositInterest.toString(),
			'->',
			spotMarket.cumulativeDepositInterest.toString()
		);

		console.log(
			'usdc deposits in spotMarket:',
			usdcDepositsBefore.toString(),
			'->',
			usdcDepositsAfter.toString()
		);

		console.log(
			'usdc for users:',
			usdcBefore.toString(),
			'->',
			usdcAfter.toString()
		);

		await driftClientUser.unsubscribe();

		// TODO: resolve any issues in liq borrow before adding asserts in test here

		// assert(usdcBefore.eq(usdcAfter));
	});

	// it('settle spotMarket to insurance vault', async () => {
	// 	const marketIndex = new BN(0);

	// 	const spotMarket0Before = driftClient.getspotMarketAccount(marketIndex);

	// 	const insuranceVaultAmountBefore = new BN(
	// 		(
	// 			await provider.connection.getTokenAccountBalance(
	// 				spotMarket0Before.insurance.vault
	// 			)
	// 		).value.amount
	// 	);

	// 	assert(insuranceVaultAmountBefore.gt(ZERO));
	// 	assert(spotMarket0Before.revenuePool.scaledBalance.gt(ZERO));

	// 	console.log(
	// 		'userIfShares:',
	// 		spotMarket0Before.insurance.userIfShares.toString(),
	// 		'totalIfShares:',
	// 		spotMarket0Before.insurance.totalIfShares.toString()
	// 	);
	// 	assert(spotMarket0Before.insurance.userIfShares.eq(ZERO));
	// 	assert(spotMarket0Before.insurance.totalIfShares.eq(ZERO)); // 0_od

	// 	try {
	// 		const txSig = await driftClient.settleRevenueToInsuranceFund(marketIndex);
	// 		console.log(
	// 			'tx logs',
	// 			(await connection.getTransaction(txSig, { commitment: 'confirmed' }))
	// 				.meta.logMessages
	// 		);
	// 	} catch (e) {
	// 		console.error(e);
	// 		assert(false);
	// 	}

	// 	const spotMarket0 = driftClient.getspotMarketAccount(marketIndex);
	// 	assert(spotMarket0.revenuePool.scaledBalance.eq(ZERO));
	// 	assert(spotMarket0.insurance.totalIfShares.eq(ZERO));
	// });
});
