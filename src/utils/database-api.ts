import BigNumber from "bignumber.js";
// @ts-ignore
import { Result } from "pg";
import {
    Block,
    DatabaseConfig,
    DelegateTransaction,
    ForgedBlock,
    Transaction,
    Voter,
    VoterBlock,
    VoterMutation,
    VoteTransaction,
} from "../interfaces";
import { logger, Postgres } from "../services";
import { Crypto } from "./crypto";
import {
    getDelegateTransactions,
    getForgedBlocks,
    getTransactions,
    getVoterSinceHeight,
    getVotingDelegates,
} from "./queries";

export class DatabaseAPI {
    private readonly psql: Postgres;

    constructor(databaseConfig: DatabaseConfig) {
        this.psql = new Postgres(databaseConfig);
    }

    /**
     *
     * @param delegatePublicKey
     * @param startBlockHeight
     * @param endBlockHeight
     * @param historyAmountBlocks
     */
    public async getForgedBlocks(
        delegatePublicKey: string,
        startBlockHeight: number,
        endBlockHeight: number,
        historyAmountBlocks: number
    ): Promise<ForgedBlock[]> {
        await this.psql.connect();
        const getForgedBlocksQuery: string = getForgedBlocks(
            delegatePublicKey,
            startBlockHeight,
            endBlockHeight,
            historyAmountBlocks
        );
        const result: Result = await this.psql.query(getForgedBlocksQuery);
        await this.psql.close();

        if (result.rows.length === 0) {
            throw new Error(
                "Could not retrieve forged blocks: did this delegate forge blocks? Is the configured Start Height in the future?"
            );
        }

        const forgedBlocks: ForgedBlock[] = result.rows.map((block: Block) => {
            return {
                height: new BigNumber(block.height).integerValue(),
                fees: new BigNumber(block.totalFee),
                timestamp: new BigNumber(block.timestamp),
                business: new BigNumber(0),
                reward: new BigNumber(block.reward),
            };
        });

        logger.info(
            `${JSON.stringify(forgedBlocks.length)} Forged blocks retrieved: (${
                forgedBlocks[forgedBlocks.length - 1].height
            } - ${forgedBlocks[0].height})`
        );
        return forgedBlocks;
    }

    /**
     *
     * @param delegatePublicKey
     * @param startBlockHeight
     * @param endBlockHeight
     */
    public async getDelegatePayoutTransactions(
        delegatePublicKey: string,
        startBlockHeight: number,
        endBlockHeight: number
    ): Promise<DelegateTransaction[]> {
        const getDelegateTransactionsQuery = getDelegateTransactions(
            startBlockHeight,
            endBlockHeight,
            delegatePublicKey
        );
        await this.psql.connect();
        const result: Result = await this.psql.query(
            getDelegateTransactionsQuery
        );
        await this.psql.close();

        if (result.rows.length === 0) {
            logger.info("No Delegate payouts retrieved.");
            return [];
        }
        const delegatePayoutTransactions: DelegateTransaction[] = [];
        for (const item of result.rows) {
            const transaction: DelegateTransaction = {
                recipientId: item.type === 0 ? item.recipientId : null,
                multiPayment:
                    item.hasOwnProperty("asset") &&
                    item.asset &&
                    item.asset.hasOwnProperty("payments")
                        ? item.asset.payments
                        : null,
                height: new BigNumber(item.height).toNumber(),
                timestamp: new BigNumber(item.timestamp),
            };
            delegatePayoutTransactions.push(transaction);
        }

        logger.info(
            `${delegatePayoutTransactions.length} Delegate Payout Transactions retrieved.`
        );

        return delegatePayoutTransactions;
    }

    /**
     * Get all the votes/unvotes for this delegate that are within range.
     * @param delegatePublicKey
     * @param startBlockHeight
     * @param networkVersion
     */
    public async getVoterMutations(
        delegatePublicKey: string,
        startBlockHeight: number,
        networkVersion: number
    ): Promise<VoterMutation[]> {
        const getVoterSinceHeightQuery: string = getVoterSinceHeight(
            startBlockHeight
        );
        await this.psql.connect();
        const result: Result = await this.psql.query(getVoterSinceHeightQuery);
        await this.psql.close();

        if (result.rows.length === 0) {
            logger.warn("0 Voter mutations retrieved.");
            return [];
        }

        try {
            const voterMutations: VoterMutation[] = result.rows
                .map((transaction: VoteTransaction) => {
                    const address: string = Crypto.getAddressFromPublicKey(
                        transaction.senderPublicKey,
                        networkVersion
                    );
                    return {
                        height: new BigNumber(
                            transaction.height
                        ).integerValue(),
                        address,
                        vote: transaction.asset.votes[0],
                    };
                })
                .filter((transaction: VoterMutation) => {
                    return (
                        transaction.vote &&
                        transaction.vote.includes(`${delegatePublicKey}`)
                    );
                });

            logger.info(`${voterMutations.length} Voter mutations retrieved.`);
            for (const vote in voterMutations) {
                if (voterMutations[vote]) {
                    const votingTransaction: VoterMutation =
                        voterMutations[vote];
                    const voterAction = votingTransaction.vote.startsWith("+")
                        ? "voted"
                        : "unvoted";
                    logger.info(
                        `Vote: ${votingTransaction.address} ${voterAction} at blockHeight ${votingTransaction.height}`
                    );
                }
            }
            return voterMutations;
        } catch (e) {
            logger.info("0 Voter mutations retrieved.");
            return [];
        }
    }

    /**
     *
     * @param voterWallets
     * @param startBlockHeight
     * @param endBlockHeight
     */
    public async getVotingDelegateBlocks(
        voterWallets: Voter[],
        startBlockHeight: number,
        endBlockHeight: number
    ): Promise<VoterBlock[]> {
        const wallets: Map<string, string> = new Map(
            voterWallets.map((wallet) => [wallet.publicKey, wallet.address])
        );
        const getVotingDelegatesQuery: string = getVotingDelegates(
            startBlockHeight,
            endBlockHeight
        );
        await this.psql.connect();
        const result: Result = await this.psql.query(getVotingDelegatesQuery);
        await this.psql.close();

        if (result.rows.length === 0) {
            return [];
        }

        const votingDelegateBlocks: VoterBlock[] = [];
        for (const item of result.rows) {
            const generatorPublicKey = item.generator_public_key;
            if (generatorPublicKey) {
                const address = wallets.get(generatorPublicKey);
                if (address) {
                    const block: VoterBlock = {
                        address,
                        height: parseInt(item.height, 10),
                        fees: new BigNumber(item.total_fee),
                        reward: new BigNumber(item.reward),
                    };
                    votingDelegateBlocks.push(block);
                }
            }
        }

        return votingDelegateBlocks;
    }

    /**
     *
     * @param voters
     * @param votersPublicKeys
     * @param startBlockHeight
     * @param endBlockHeight
     * @param networkVersion
     */
    public async getTransactions(
        voters: string[],
        votersPublicKeys: string[],
        startBlockHeight: number,
        endBlockHeight: number,
        networkVersion: number
    ): Promise<Transaction[]> {
        const getTransactionsQuery = getTransactions(
            voters,
            votersPublicKeys,
            startBlockHeight,
            endBlockHeight
        );

        if (voters.length === 0) {
            throw new Error(
                "There are no voters, please check blacklist/whitelist in your configuration."
            );
        }

        await this.psql.connect();
        const result: Result = await this.psql.query(getTransactionsQuery);
        await this.psql.close();

        if (result.rows.length === 0) {
            return [];
        }

        const transactions: Transaction[] = [];
        for (const item of result.rows) {
            const transaction: Transaction = {
                senderId: item.hasOwnProperty("senderPublicKey")
                    ? Crypto.getAddressFromPublicKey(
                          item.senderPublicKey,
                          networkVersion
                      )
                    : "",
                amount: new BigNumber(item.amount),
                recipientId: item.type === 0 ? item.recipientId : null,
                multiPayment:
                    item.type === 6 &&
                    item.hasOwnProperty("asset") &&
                    item.asset &&
                    item.asset.hasOwnProperty("payments")
                        ? item.asset.payments
                        : null,
                senderPublicKey: item.senderPublicKey,
                fee: new BigNumber(item.fee),
                height: new BigNumber(item.height).toNumber(),
                timestamp: new BigNumber(item.timestamp),
                stakeRedeem:
                    item.hasOwnProperty("asset") &&
                    item.asset &&
                    item.asset.hasOwnProperty("stakeRedeem") &&
                    item.asset.stakeRedeem.hasOwnProperty("id")
                        ? item.asset.stakeRedeem.id
                        : null,
            };

            if (
                item.hasOwnProperty("asset") &&
                item.asset &&
                item.asset.hasOwnProperty("stakeCreate") &&
                transaction.senderId !== transaction.recipientId
            ) {
                // Received staked amount from other wallet, like the 10% bonus
                transaction.amount = new BigNumber(
                    item.asset.stakeCreate.amount
                );
            }
            transactions.push(transaction);
        }
        logger.info(`${transactions.length} Transactions retrieved.`);
        return transactions;
    }
}
