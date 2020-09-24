import { Identities, Interfaces } from "@arkecosystem/crypto";
import BigNumber from "bignumber.js";
import {
    DatabaseConfig,
    DelegateTransaction,
    ForgedBlock,
    LatestPayouts,
    MutatedVotersPerRound,
    PayoutBalances,
    Payouts,
    Stake,
    StakeTimestamp,
    Transaction,
    Voter,
    VoterBalances,
    VoterBalancesPerForgedBlock,
    VoterBlock,
    VoterMutation,
    Voters,
    VotersPerForgedBlock,
} from "../interfaces";
import { Config, logger, Network } from "../services";
import { DatabaseAPI } from "./database-api";
import { ProposalEngine } from "./proposal-engine";
import moment from "moment";
import { BusinessEngine } from "./business-engine";
import { Crypto } from "./crypto";

export class TrueBlockWeightEngine {
    /**
     * Create an array of the current voters
     * @param currentVotersFromAPI
     */
    private static formatCurrentVoters(
        currentVotersFromAPI: Voter[]
    ): string[] {
        if (currentVotersFromAPI.length === 0) {
            return [];
        }
        return currentVotersFromAPI.map((voter) => voter.address);
    }

    private readonly config: Config;
    private readonly network: Network;
    private readonly databaseAPI: DatabaseAPI;
    private readonly proposalEngine: ProposalEngine;
    private readonly businessEngine: BusinessEngine;
    private startBlockHeight: number;
    private readonly endBlockHeight: number;
    private networkConfig: Interfaces.INetworkConfig | undefined;
    private epochTimestamp: BigNumber = new BigNumber(0);
    private networkVersion: number = Number.NaN;

    constructor() {
        BigNumber.config({
            ROUNDING_MODE: BigNumber.ROUND_DOWN,
        });

        this.config = new Config();
        this.startBlockHeight = this.config.startFromBlockHeight;
        this.endBlockHeight = this.config.endAtBlockHeight;
        this.network = new Network(this.config.server, this.config.nodes);
        const databaseConfig: DatabaseConfig = {
            host: this.config.databaseHost,
            user: this.config.databaseUser,
            database: this.config.databaseDB,
            password: this.config.databasePassword,
            port: this.config.databasePort,
        };
        this.databaseAPI = new DatabaseAPI(databaseConfig);
        this.proposalEngine = new ProposalEngine();
        this.businessEngine = new BusinessEngine();
    }

    /**
     * @dev Calculate a timestamp based on an epoch
     * @param epoch {string} Epoch (e.g. "2019-05-24T11:48:58.165Z")
     * @returns {number}    The calculated timestamp
     * @private
     */
    private static calculateTimestamp(epoch: string): BigNumber {
        const epochTime = moment(epoch).utc().valueOf();
        return new BigNumber(Math.floor(epochTime / 1000));
    }

    /**
     *
     */
    public async generatePayouts(): Promise<Payouts> {
        try {
            this.networkConfig = await this.network.getNetworkConfig();
            this.epochTimestamp = TrueBlockWeightEngine.calculateTimestamp(
                this.networkConfig.milestones[0].epoch
            );
            this.networkVersion = this.networkConfig.network.pubKeyHash;

            const delegatePublicKey: string = Crypto.getPublicKeyFromSeed(
                this.config.seed
            );

            logger.info("Retrieving blocks forged by delegate.");
            const forgedBlocks: ForgedBlock[] = await this.databaseAPI.getForgedBlocks(
                delegatePublicKey,
                this.startBlockHeight,
                this.endBlockHeight,
                this.config.historyAmountBlocks
            );

            const currentBlock: number = forgedBlocks[0].height;
            const timestamp: BigNumber = forgedBlocks[0].timestamp.plus(1);
            const oldestBlock: number =
                forgedBlocks[forgedBlocks.length - 1].height;

            if (this.startBlockHeight < oldestBlock - 1) {
                this.startBlockHeight = oldestBlock - 1;
            }

            logger.info(`Starting calculations from ${this.startBlockHeight}`);

            logger.info("Retrieving previous delegate payouts.");
            const delegatePayoutTransactions: DelegateTransaction[] = await this.databaseAPI.getDelegatePayoutTransactions(
                delegatePublicKey,
                this.startBlockHeight,
                this.endBlockHeight
            );

            logger.info("Retrieving voters.");
            const voters: Voters = await this.getVoters(
                delegatePublicKey,
                forgedBlocks
            );

            logger.info("Retrieving voter balances.");
            const voterBalances: VoterBalances = await this.getVoterBalances(
                voters.voters,
                voters.voterWallets
            );

            logger.info("Retrieving blocks forged by voters.");
            const votingDelegateBlocks: VoterBlock[] = await this.databaseAPI.getVotingDelegateBlocks(
                voters.voterWallets,
                this.startBlockHeight,
                this.endBlockHeight
            );

            logger.info("Retrieving voter transactions.");
            const transactions: Transaction[] = await this.databaseAPI.getTransactions(
                voters.voters,
                voterBalances.publicKeys,
                this.startBlockHeight,
                this.endBlockHeight,
                this.networkVersion
            );

            const previousPayouts: LatestPayouts = this.findLatestPayouts(
                delegatePayoutTransactions
            );

            logger.info("Processing voter balances.");
            const processedBalances: VoterBalancesPerForgedBlock = this.processBalances(
                forgedBlocks,
                voterBalances.balances,
                transactions,
                votingDelegateBlocks
            );

            const businessRevenuePerForgedBlock: Map<
                number,
                BigNumber
            > = await this.businessEngine.getBusinessIncome(
                forgedBlocks,
                this.networkVersion,
                this.startBlockHeight,
                this.endBlockHeight
            );

            const voterShares: PayoutBalances = this.generateShares(
                voters.votersPerForgedBlock,
                forgedBlocks,
                businessRevenuePerForgedBlock,
                previousPayouts.latestPayoutsTimeStamp,
                processedBalances.votersBalancePerForgedBlock
            );

            const votersSince: Map<
                string,
                BigNumber
            > = await this.databaseAPI.getCurrentVotersSince(
                delegatePublicKey,
                this.networkVersion,
                timestamp
            );

            logger.info("Applying Proposal.");
            let currentBalances = processedBalances.votersBalancePerForgedBlock.get(
                forgedBlocks[0].height
            );
            if (!currentBalances) {
                currentBalances = new Map();
            }

            const proposal: Payouts = this.proposalEngine.applyProposal(
                currentBlock,
                previousPayouts.latestPayouts,
                processedBalances.smallWallets,
                voterShares.payouts,
                voterShares.feesPayouts,
                voterShares.businessPayouts,
                voters.currentVoters,
                currentBalances,
                votersSince
            );
            proposal.timestamp = timestamp;

            return proposal;
        } catch (error) {
            throw error;
        }
    }

    /**
     *
     * @param delegatePublicKey
     * @param forgedBlocks
     */
    public async getVoters(
        delegatePublicKey: string,
        forgedBlocks: ForgedBlock[]
    ): Promise<Voters> {
        logger.info("Retrieving current voters from API.");
        const currentVotersFromAPI: Voter[] = await this.network.getVoters(
            this.config.seed
        );
        const currentVoters: string[] = TrueBlockWeightEngine.formatCurrentVoters(
            currentVotersFromAPI
        );

        logger.info(
            `There are ${currentVoters.length} wallets currently voting.`
        );

        logger.info("Retrieving voter mutations.");
        const voterMutations: VoterMutation[] = await this.databaseAPI.getVoterMutations(
            delegatePublicKey,
            this.startBlockHeight,
            this.networkVersion
        );

        const perForgedBlock: VotersPerForgedBlock = this.setVotersPerForgedBlock(
            voterMutations,
            currentVoters.slice(0),
            forgedBlocks
        );

        const voterWallets: Voter[] = await this.network.addMutatedVoters(
            voterMutations,
            currentVotersFromAPI,
            currentVoters,
            this.epochTimestamp
        );

        if (voterWallets.length === 0) {
            throw new Error("There are no voters to be calculated.");
        }

        return {
            votersPerForgedBlock: perForgedBlock.votersPerForgedBlock,
            voters: perForgedBlock.validVoters,
            currentVoters,
            voterWallets,
        };
    }

    /**
     *
     * @param voterMutations
     * @param voters
     * @param forgedBlocks
     */
    public setVotersPerForgedBlock(
        voterMutations: VoterMutation[],
        voters: string[],
        forgedBlocks: ForgedBlock[]
    ): VotersPerForgedBlock {
        let votersRound: string[] = voters.slice(0);
        const calculatedVotersPerForgedBlock: Map<number, string[]> = new Map(
            forgedBlocks.map((block) => [block.height, []])
        );

        let previousHeight: number =
            voterMutations.length > 0
                ? voterMutations[voterMutations.length - 1].height + 1
                : forgedBlocks[forgedBlocks.length - 1].height + 1;

        forgedBlocks.forEach((block: ForgedBlock) => {
            const filteredVotersForRound: VoterMutation[] = this.filterVoteTransactionsForRound(
                voterMutations,
                block.height,
                previousHeight
            );

            const mutatedVoters: MutatedVotersPerRound = this.mutateVoters(
                votersRound,
                voters,
                filteredVotersForRound
            );
            voters = mutatedVoters.voters.splice(0);
            votersRound = mutatedVoters.votersPerRound.slice(0);
            previousHeight = block.height;
            calculatedVotersPerForgedBlock.set(
                block.height,
                votersRound.slice(0)
            );
        });

        const votersPerForgedBlock: Map<number, string[]> = new Map(
            calculatedVotersPerForgedBlock
        );

        const validVoters: string[] = this.processWhiteList(voters);
        return { votersPerForgedBlock, validVoters };
    }

    /**
     *
     * @param voterMutations
     * @param height
     * @param previousHeight
     */
    public filterVoteTransactionsForRound(
        voterMutations: VoterMutation[],
        height: number,
        previousHeight: number
    ): VoterMutation[] {
        return voterMutations.filter((transaction) => {
            return (
                transaction.height >= height &&
                transaction.height < previousHeight
            );
        });
    }

    /**
     *
     * @param votersPerRound
     * @param voters
     * @param voteTransactions
     */
    public mutateVoters(
        votersPerRound: string[],
        voters: string[],
        voteTransactions: VoterMutation[]
    ): MutatedVotersPerRound {
        for (const item of voteTransactions) {
            if (item.hasOwnProperty("address") && item.hasOwnProperty("vote")) {
                // Check if we have seen this voter before
                if (voters.indexOf(item.address) < 0) {
                    voters.push(item.address);
                }

                // Process the mutation
                if (item.vote.includes("+")) {
                    const index = votersPerRound.indexOf(item.address);
                    votersPerRound.splice(index, 1);
                } else if (item.vote.includes("-")) {
                    votersPerRound.push(item.address);
                }
            }
        }

        return { voters, votersPerRound };
    }

    /**
     *
     * @param voters
     */
    public processWhiteList(voters: string[]): string[] {
        const whitelisted: string[] = [];
        for (const address of voters) {
            if (this.config.blacklistedVoters.indexOf(address) >= 0) {
                logger.warn(
                    `Blacklisted address: ${address} removed from payout pool.`
                );
            } else if (
                this.config.whitelistedVoters.length > 0 &&
                this.config.whitelistedVoters.indexOf(address) >= 0
            ) {
                logger.warn(`Whitelisted: ${address} added to payout pool.`);
                whitelisted.push(address);
            } else if (this.config.whitelistedVoters.length === 0) {
                whitelisted.push(address);
            }
        }
        logger.info(`${whitelisted.length} voters will be calculated.`);
        return whitelisted;
    }

    /**
     *
     * @param voters
     * @param voterWallets
     */
    public async getVoterBalances(
        voters: string[],
        voterWallets: Voter[]
    ): Promise<VoterBalances> {
        let voterBalances: Voter[] = voterWallets.map((row) => {
            const power: BigNumber = row.power
                ? new BigNumber(row.power)
                : new BigNumber(0);
            const balance: BigNumber = power.gt(new BigNumber(row.balance))
                ? power
                : new BigNumber(row.balance);
            return {
                address: row.address,
                publicKey: row.publicKey,
                balance,
                power: new BigNumber(row.power),
                processedStakes: this.network.processStakes(
                    row,
                    this.epochTimestamp
                ),
            };
        });
        voterBalances = voterBalances.filter((wallet) => {
            return voters.indexOf(wallet.address) > -1;
        });

        const votersPublicKeys: string[] = voterBalances.map(
            (balances) => balances.publicKey
        );
        return { balances: voterBalances, publicKeys: votersPublicKeys };
    }

    /**
     *
     * @param delegatePayoutTransactions
     */
    public findLatestPayouts(
        delegatePayoutTransactions: DelegateTransaction[]
    ): LatestPayouts {
        const latestPayouts: Map<string, number> = new Map();
        const latestPayoutsTimeStamp: Map<string, BigNumber> = new Map();

        for (const transaction of delegatePayoutTransactions) {
            if (transaction.recipientId !== null) {
                const latestPayoutForVoter = latestPayouts.get(
                    transaction.recipientId
                );
                if (latestPayoutForVoter) {
                    const height: BigNumber = new BigNumber(
                        latestPayoutForVoter
                    );
                    if (
                        height.isNaN() ||
                        height.lt(new BigNumber(transaction.height))
                    ) {
                        latestPayouts.set(
                            transaction.recipientId,
                            transaction.height
                        );
                        latestPayoutsTimeStamp.set(
                            transaction.recipientId,
                            transaction.timestamp
                        );
                    }
                }
            } else if (transaction.multiPayment !== null) {
                for (const receiver of transaction.multiPayment) {
                    const latestPayoutForVoter = latestPayouts.get(
                        receiver.recipientId
                    );
                    let height: BigNumber = new BigNumber(0);
                    if (latestPayoutForVoter) {
                        height = new BigNumber(latestPayoutForVoter);
                    }
                    if (
                        !latestPayoutForVoter ||
                        height.isNaN() ||
                        height.lt(new BigNumber(transaction.height))
                    ) {
                        latestPayouts.set(
                            receiver.recipientId,
                            transaction.height
                        );
                        latestPayoutsTimeStamp.set(
                            receiver.recipientId,
                            transaction.timestamp
                        );
                    }
                }
            }
        }
        return { latestPayouts, latestPayoutsTimeStamp };
    }

    /**
     *
     * @param forgedBlocks
     * @param voterBalances
     * @param transactions
     * @param votingDelegateBlocks
     */
    public processBalances(
        forgedBlocks: ForgedBlock[],
        voterBalances: Voter[],
        transactions: Transaction[],
        votingDelegateBlocks: VoterBlock[]
    ): VoterBalancesPerForgedBlock {
        const smallWallets: Map<string, boolean> = new Map(
            voterBalances.map((voterBalances) => [voterBalances.address, true])
        );
        let calculatedVoters: Map<string, BigNumber> = new Map(
            voterBalances.map((voterBalances) => [
                voterBalances.address,
                new BigNumber(voterBalances.balance),
            ])
        );
        let previousHeight: number = Number.NaN;
        let minTimestamp: BigNumber = new BigNumber(0);
        let maxTimestamp: BigNumber = new BigNumber(0);

        const timestampPerForgedBlock: Map<number, BigNumber> = new Map(
            forgedBlocks.map((block) => [block.height, block.timestamp])
        );

        const votersBalancePerForgedBlock: Map<
            number,
            Map<string, BigNumber>
        > = new Map(forgedBlocks.map((block) => [block.height, new Map()]));

        forgedBlocks.forEach((block: ForgedBlock) => {
            if (Number.isNaN(previousHeight)) {
                previousHeight = block.height + 1;
            }

            const timestamp = timestampPerForgedBlock.get(block.height);
            if (timestamp) {
                maxTimestamp = minTimestamp;
                minTimestamp = timestamp.minus(1);

                if (maxTimestamp.eq(0)) {
                    maxTimestamp = timestamp;
                }
            } else {
                throw new Error(`Block at ${block.height} has no timestamp.`);
            }

            calculatedVoters = this.mutateVotersBalances(
                block.height,
                previousHeight,
                maxTimestamp,
                minTimestamp,
                calculatedVoters,
                transactions,
                voterBalances,
                votingDelegateBlocks
            );
            previousHeight = block.height;
            votersBalancePerForgedBlock.set(
                block.height,
                new Map(calculatedVoters)
            );
            calculatedVoters.forEach((balance: BigNumber, address: string) => {
                if (
                    new BigNumber(balance).gt(
                        this.config.smallWalletBonus.walletLimit
                    ) &&
                    smallWallets.get(address) === true
                ) {
                    smallWallets.set(address, false);
                }
            });
        });

        return { votersBalancePerForgedBlock, smallWallets };
    }

    /**
     *
     * @param height
     * @param previousHeight
     * @param maxTimestamp
     * @param minTimestamp
     * @param votersBalancePerForgedBlock
     * @param transactions
     * @param voters
     * @param votingDelegateBlocks
     */
    public mutateVotersBalances(
        height: number,
        previousHeight: number,
        maxTimestamp: BigNumber,
        minTimestamp: BigNumber,
        votersBalancePerForgedBlock: Map<string, BigNumber>,
        transactions: Transaction[],
        voters: Voter[],
        votingDelegateBlocks: VoterBlock[]
    ): Map<string, BigNumber> {
        // Only process mutations that are in range
        const calculatedTransactions: Transaction[] = transactions.filter(
            (transaction) => {
                return (
                    transaction.height >= height &&
                    transaction.height < previousHeight
                );
            }
        );

        for (const item of calculatedTransactions) {
            const recipientId: string = item.recipientId;
            const senderId: string = item.senderId;
            let amount: BigNumber = item.amount;
            const fee: BigNumber = item.fee;
            const stakeRedeemID = item.stakeRedeem;

            if (item.multiPayment) {
                for (const transaction of item.multiPayment) {
                    const transactionAmount: BigNumber = new BigNumber(
                        transaction.amount.toString()
                    );
                    amount = amount.plus(transactionAmount);
                    const balanceForgedBlockForVoter = votersBalancePerForgedBlock.get(
                        transaction.recipientId
                    );
                    if (balanceForgedBlockForVoter) {
                        let balance: BigNumber = new BigNumber(
                            balanceForgedBlockForVoter
                        );
                        balance = balance.minus(transactionAmount);
                        if (balance.lt(0)) {
                            balance = new BigNumber(0);
                        }
                        votersBalancePerForgedBlock.set(
                            transaction.recipientId,
                            balance
                        );
                    }
                }
            } else {
                const balanceForVoterInBlock = votersBalancePerForgedBlock.get(
                    recipientId
                );
                if (balanceForVoterInBlock) {
                    let balance: BigNumber = new BigNumber(
                        balanceForVoterInBlock
                    );

                    balance = balance.minus(amount);

                    if (balance.lt(0)) {
                        balance = new BigNumber(0);
                    }
                    votersBalancePerForgedBlock.set(recipientId, balance);
                }
            }

            const balanceForVoterInBlock = votersBalancePerForgedBlock.get(
                senderId
            );
            if (balanceForVoterInBlock) {
                let balance: BigNumber = new BigNumber(balanceForVoterInBlock);

                if (stakeRedeemID !== null) {
                    let processedStakes: Stake[] = [];
                    for (const item in voters) {
                        if (voters[item] && voters[item].address === senderId) {
                            const processedStakesForVoter =
                                voters[item].processedStakes;
                            if (processedStakesForVoter) {
                                processedStakes = processedStakesForVoter;
                                break;
                            }
                        }
                    }
                    const redeemValue: BigNumber = TrueBlockWeightEngine.getStakeRedeemValue(
                        processedStakes,
                        stakeRedeemID
                    );
                    balance = balance.plus(redeemValue);
                } else {
                    balance = balance.plus(amount);
                    balance = balance.plus(fee);
                }
                votersBalancePerForgedBlock.set(senderId, balance);
            }
        }

        for (const item in voters) {
            if (
                voters[item] &&
                voters[item].hasOwnProperty("processedStakes")
            ) {
                const stakes = voters[item].processedStakes;
                if (stakes) {
                    const wallet: string = voters[item].address;
                    for (const stake in stakes) {
                        if (stakes[stake].hasOwnProperty("timestamps")) {
                            const stakeTimestamp: StakeTimestamp =
                                stakes[stake].timestamps;

                            let balance = votersBalancePerForgedBlock.get(
                                wallet
                            );
                            if (balance) {
                                if (
                                    stakeTimestamp.powerUp.lte(maxTimestamp) &&
                                    stakeTimestamp.powerUp.gt(minTimestamp)
                                ) {
                                    balance = balance
                                        .minus(stakes[stake].power)
                                        .plus(stakes[stake].amount);
                                    votersBalancePerForgedBlock.set(
                                        wallet,
                                        balance
                                    );
                                }

                                if (
                                    stakeTimestamp.redeemable.lte(
                                        maxTimestamp
                                    ) &&
                                    stakeTimestamp.redeemable.gt(minTimestamp)
                                ) {
                                    const redeemValue: BigNumber = TrueBlockWeightEngine.getStakeRedeemValue(
                                        stakes,
                                        stakes[stake].id
                                    );
                                    balance = balance.plus(redeemValue);
                                    votersBalancePerForgedBlock.set(
                                        wallet,
                                        balance
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        const calculatedVotingDelegateBlocks: VoterBlock[] = votingDelegateBlocks.filter(
            (block) => {
                return block.height > height && block.height <= previousHeight;
            }
        );

        for (const item of calculatedVotingDelegateBlocks) {
            const delegateAddress: string = item.address;
            const gains: BigNumber = item.fees.plus(item.reward);

            let balance = votersBalancePerForgedBlock.get(delegateAddress);
            if (
                gains.gt(0) &&
                balance &&
                votersBalancePerForgedBlock.has(delegateAddress)
            ) {
                balance = balance.minus(gains);
                if (balance.lt(0)) {
                    balance = new BigNumber(0);
                }
                votersBalancePerForgedBlock.set(delegateAddress, balance);
            }
        }

        return votersBalancePerForgedBlock;
    }

    private static getStakeRedeemValue(
        processedStakes: Stake[],
        stakeID: string
    ): BigNumber {
        let stakeRedeemAmount: BigNumber = new BigNumber(0);
        for (const stake in processedStakes) {
            if (
                processedStakes[stake] &&
                processedStakes[stake].hasOwnProperty("id") &&
                processedStakes[stake].id === stakeID
            ) {
                stakeRedeemAmount = processedStakes[stake].power.minus(
                    processedStakes[stake].amount
                );
            }
        }
        return stakeRedeemAmount.div(2);
    }

    private getAdminPayoutTimestamp(
        latestPayoutsTimeStamp: Map<string, BigNumber>
    ): BigNumber {
        // Get latest payouts to admins in case share = 0 and calculate from there
        let latestAdminPayout: BigNumber = new BigNumber(0);
        if (this.config.voterShare.eq(0)) {
            logger.warn(
                "Not sharing with voters, latest payout to admins will be used to calculate."
            );
            for (const admin of this.config.admins) {
                const latestPayout = latestPayoutsTimeStamp.get(admin.wallet);
                if (latestPayout && latestPayout.gt(latestAdminPayout)) {
                    latestAdminPayout = new BigNumber(latestPayout);
                }
            }
        }

        return latestAdminPayout;
    }

    /**
     *
     * @param votersPerForgedBlock
     * @param forgedBlocks
     * @param businessRevenue
     * @param latestPayoutsTimeStamp
     * @param votersBalancePerForgedBlock
     */
    public generateShares(
        votersPerForgedBlock: Map<number, string[]>,
        forgedBlocks: ForgedBlock[],
        businessRevenue: Map<number, BigNumber>,
        latestPayoutsTimeStamp: Map<string, BigNumber>,
        votersBalancePerForgedBlock: Map<number, Map<string, BigNumber>>
    ): PayoutBalances {
        logger.info("Starting to calculate shares...");
        const payouts: Map<string, BigNumber> = new Map();
        const feesPayouts: Map<string, BigNumber> = new Map();
        const businessPayouts: Map<string, BigNumber> = new Map();
        const latestAdminPayout: BigNumber = this.getAdminPayoutTimestamp(
            latestPayoutsTimeStamp
        );

        for (const item of forgedBlocks) {
            const height: number = item.height;
            const timestamp: BigNumber = item.timestamp;
            const rewardThisBlock: BigNumber = item.reward;
            const totalFeesThisBlock: BigNumber = new BigNumber(item.fees);
            let totalBusinessIncomeThisBlock = businessRevenue.get(height);
            if (!totalBusinessIncomeThisBlock) {
                totalBusinessIncomeThisBlock = new BigNumber(0);
            }

            let validVoters = votersPerForgedBlock.get(height);
            if (!validVoters) {
                validVoters = [];
            }
            const walletBalances = votersBalancePerForgedBlock.get(height);
            let balance: BigNumber = new BigNumber(0);
            if (walletBalances) {
                balance = new BigNumber(
                    this.sumBalances(walletBalances, validVoters)
                );
            }

            for (const address of validVoters) {
                const payoutAddress: string = this.getRedirectAddress(address);
                const latestPayout = latestPayoutsTimeStamp.get(payoutAddress);

                if (
                    timestamp.gt(latestAdminPayout) &&
                    (typeof latestPayout === "undefined" ||
                        latestPayout.lte(timestamp))
                ) {
                    let pendingPayout = payouts.get(address);
                    if (!pendingPayout) {
                        pendingPayout = new BigNumber(0);
                    }

                    const voterBalance = walletBalances
                        ? walletBalances.get(address)
                        : undefined;

                    // Only payout voters that had a balance that exceeds or equals the configured minimum balance.
                    if (
                        voterBalance &&
                        voterBalance.gte(this.config.minimalBalance)
                    ) {
                        const voterShare: BigNumber = voterBalance.div(balance);
                        const rewardShare: BigNumber = new BigNumber(
                            voterShare.times(rewardThisBlock)
                        ).decimalPlaces(8);

                        pendingPayout = pendingPayout.plus(rewardShare);
                        payouts.set(address, pendingPayout);

                        if (totalFeesThisBlock.gt(0)) {
                            let pendingFeesPayout = feesPayouts.get(address);
                            if (!pendingFeesPayout) {
                                pendingFeesPayout = new BigNumber(0);
                            }
                            const feeShare: BigNumber = new BigNumber(
                                voterShare.times(totalFeesThisBlock)
                            ).decimalPlaces(8);
                            pendingFeesPayout = pendingFeesPayout.plus(
                                feeShare
                            );
                            feesPayouts.set(address, pendingFeesPayout);
                        }

                        if (totalBusinessIncomeThisBlock.gt(0)) {
                            let pendingBusinessPayout = businessPayouts.get(
                                address
                            );

                            if (!pendingBusinessPayout) {
                                pendingBusinessPayout = new BigNumber(0);
                            }
                            const businessShare: BigNumber = new BigNumber(
                                voterShare.times(totalBusinessIncomeThisBlock)
                            ).decimalPlaces(8);
                            pendingBusinessPayout = pendingBusinessPayout.plus(
                                businessShare
                            );
                            businessPayouts.set(address, pendingBusinessPayout);
                        }
                    }
                }
            }
        }

        logger.info("Finished calculating shares...");
        return { payouts, feesPayouts, businessPayouts };
    }

    /**
     *
     * @param walletBalances
     * @param validVoters
     */
    private sumBalances(
        walletBalances: Map<string, BigNumber>,
        validVoters: string[]
    ): BigNumber {
        let balance: BigNumber = new BigNumber(0);

        walletBalances.forEach((bal: BigNumber, voter: string) => {
            // Only add this voter's balance to the total if it exceeds or equals the configured minimum balance.
            bal = new BigNumber(bal);
            if (
                validVoters.indexOf(voter) >= 0 &&
                bal.gte(this.config.minimalBalance)
            ) {
                balance = balance.plus(bal);
            }
        });

        return balance;
    }

    /**
     *
     * @param address
     */
    private getRedirectAddress(address: string): string {
        if (this.config.walletRedirections.hasOwnProperty(address)) {
            address = this.config.walletRedirections[address];
        }

        if (!Identities.Address.validate(address, this.networkVersion)) {
            throw new Error(
                `${address} is not a valid address for this blockchain.`
            );
        }
        return address;
    }
}
