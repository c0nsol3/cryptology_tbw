import BigNumber from "bignumber.js";
import { ARKTOSHI, SEPARATOR } from "../constants";
import { Payouts } from "../interfaces";
import { Config, logger } from "../services";

export class ProposalEngine {
    private readonly config: Config;

    constructor() {
        BigNumber.config({
            ROUNDING_MODE: BigNumber.ROUND_DOWN,
        });

        try {
            this.config = new Config();
        } catch (e) {
            logger.error(e.message);
            process.exit(1);
        }
    }

    /**
     *
     * @param currentBlock
     * @param latestPayouts
     * @param smallWallets
     * @param payouts
     * @param feesPayouts
     * @param businessPayouts
     * @param currentVoters
     * @param currentBalances
     * @param votersSince
     */
    public applyProposal(
        currentBlock: number,
        latestPayouts: Map<string, number>,
        smallWallets: Map<string, boolean>,
        payouts: Map<string, BigNumber>,
        feesPayouts: Map<string, BigNumber>,
        businessPayouts: Map<string, BigNumber>,
        currentVoters: string[],
        currentBalances: Map<string, BigNumber>,
        votersSince: Map<string, BigNumber>
    ): Payouts {
        let totalPayout: BigNumber = new BigNumber(0);
        let totalDelegateProfit: BigNumber = new BigNumber(0);
        let totalLicenseFee: BigNumber = new BigNumber(0);
        let totalBusinessPayout: BigNumber = new BigNumber(0);

        if (this.config.poolHoppingProtection) {
            payouts = ProposalEngine.filterPoolHoppers(
                payouts,
                currentVoters,
                currentBalances
            );
        }

        for (const [address, balance] of payouts) {
            if (
                balance.gt(0) &&
                this.isFrequencyMinimumReached(
                    address,
                    currentBlock,
                    latestPayouts
                )
            ) {
                let voterSeconds = votersSince.get(address);
                if (!voterSeconds) {
                    voterSeconds = new BigNumber(0);
                }
                // Percentages
                const percentage: BigNumber = this.getSharePercentage(
                    address,
                    smallWallets,
                    voterSeconds
                );

                let voterLicenseFee: BigNumber = new BigNumber(
                    balance
                        .times(this.config.donationShare)
                        .integerValue(BigNumber.ROUND_CEIL)
                );

                let voterRewardsShare: BigNumber = new BigNumber(
                    balance.times(percentage).integerValue(BigNumber.ROUND_DOWN)
                );

                let delegateRewardsShare: BigNumber = balance;

                const voterFeesShare = feesPayouts.get(address);
                if (voterFeesShare && voterFeesShare.gt(0)) {
                    const voterFeesLicenseFee: BigNumber = voterFeesShare.times(
                        this.config.donationShare
                    );
                    voterLicenseFee = voterLicenseFee.plus(voterFeesLicenseFee);

                    const voterFeePayout: BigNumber = voterFeesShare
                        .times(this.config.voterFeeShare)
                        .integerValue(BigNumber.ROUND_DOWN);

                    voterRewardsShare = voterRewardsShare.plus(voterFeePayout);
                    delegateRewardsShare = delegateRewardsShare.plus(
                        voterFeesShare
                    );
                }

                delegateRewardsShare = delegateRewardsShare
                    .minus(voterLicenseFee)
                    .minus(voterRewardsShare);

                payouts.set(address, voterRewardsShare);

                const payoutForVoter = payouts.get(address);
                if (
                    payoutForVoter &&
                    (new BigNumber(payoutForVoter).lt(
                        this.config.minimalPayoutValue
                    ) ||
                        new BigNumber(payoutForVoter).eq(0))
                ) {
                    if (new BigNumber(payoutForVoter).gt(0)) {
                        logger.warn(
                            `Payout to ${address} pending (min. value ${this.config.minimalPayoutValue
                                .div(ARKTOSHI)
                                .toNumber()}): ${new BigNumber(payoutForVoter)
                                .div(ARKTOSHI)
                                .toFixed(8)}`
                        );
                    }
                    payouts.delete(address);
                    businessPayouts.delete(address);
                } else if (payoutForVoter) {
                    totalDelegateProfit = totalDelegateProfit.plus(
                        delegateRewardsShare
                    );
                    totalLicenseFee = totalLicenseFee.plus(voterLicenseFee);
                    totalPayout = totalPayout.plus(voterRewardsShare);
                }
            } else {
                payouts.delete(address);
                businessPayouts.delete(address);
            }
        }

        for (const [address, balance] of businessPayouts) {
            const willBePaid = payouts.get(address);
            if (!willBePaid || balance.lte(0)) {
                businessPayouts.delete(address);
            } else {
                const businessPayout: BigNumber = balance
                    .times(this.config.voterBusinessShare)
                    .integerValue(BigNumber.ROUND_DOWN);
                businessPayouts.set(address, businessPayout);
                totalBusinessPayout = totalBusinessPayout.plus(businessPayout);
            }
        }

        // FairFees
        const multiPaymentFees: BigNumber = this.getMultiFeesTotal(
            payouts.size
        );
        const businessMultiPaymentFees: BigNumber = this.getMultiFeesTotal(
            businessPayouts.size
        );

        const businessFeeRation = totalBusinessPayout
            .minus(businessMultiPaymentFees)
            .div(totalBusinessPayout);
        totalBusinessPayout = totalBusinessPayout.minus(
            businessMultiPaymentFees
        );

        const totalFees: BigNumber = this.config.transferFee
            .times(this.getACFFeeCount())
            .plus(multiPaymentFees)
            .plus(this.getAdminFeeCount());

        if (this.config.adminFees && totalDelegateProfit.lt(totalFees)) {
            this.config.adminFees = false;
            logger.warn(
                "Admin share not large enough to cover fees: Fair Fees will be applied."
            );
        }

        if (this.config.adminFees) {
            logger.info(
                `${totalFees
                    .div(ARKTOSHI)
                    .toFixed(
                        8
                    )} Transfer Fees will be deducted from Admin share (${totalDelegateProfit
                    .div(ARKTOSHI)
                    .toFixed(8)}).`
            );
            totalDelegateProfit = totalDelegateProfit.minus(totalFees);
        }

        for (const [address, balance] of payouts) {
            const fairFees: BigNumber = balance
                .div(totalPayout)
                .times(totalFees);
            if (!this.config.adminFees) {
                if (balance.minus(fairFees).lt(0)) {
                    totalPayout = totalPayout.minus(balance);
                    payouts.set(address, new BigNumber(0));
                } else {
                    payouts.set(address, balance.minus(fairFees));
                    totalPayout = totalPayout.minus(fairFees);
                }
            }

            let businessPayoutForVoter = businessPayouts.get(address);
            if (businessPayoutForVoter) {
                businessPayoutForVoter = businessPayoutForVoter.times(
                    businessFeeRation
                );
                if (businessPayoutForVoter.lt(0)) {
                    businessPayouts.delete(address);
                } else {
                    businessPayouts.set(address, businessPayoutForVoter);
                }
            }
        }

        logger.info(SEPARATOR);
        logger.info(
            `Next payout run: ${
                payouts.size
            } payouts with total amount: ${totalPayout
                .plus(totalDelegateProfit)
                .plus(totalLicenseFee)
                .plus(totalFees)
                .div(ARKTOSHI)
                .toFixed(8)}`
        );
        logger.info(`Voter rewards: ${totalPayout.div(ARKTOSHI).toFixed(8)}`);
        logger.info(
            `Admin profits: ${totalDelegateProfit.div(ARKTOSHI).toFixed(8)}`
        );
        logger.info(`License fee: ${totalLicenseFee.div(ARKTOSHI).toFixed(8)}`);
        logger.info(`Transaction fees: ${totalFees.div(ARKTOSHI).toFixed(8)}`);
        if (totalBusinessPayout.gt(0)) {
            logger.info(SEPARATOR);
            logger.info(
                `Business revenue payout run: ${
                    businessPayouts.size
                } payouts with total amount: ${totalBusinessPayout
                    .plus(businessMultiPaymentFees)
                    .div(ARKTOSHI)
                    .toFixed(8)}`
            );
            logger.info(
                `Business shares: ${totalBusinessPayout
                    .div(ARKTOSHI)
                    .toFixed(8)}`
            );
            logger.info(
                `Business transaction fees: ${businessMultiPaymentFees
                    .div(ARKTOSHI)
                    .toFixed(8)}`
            );
        }
        logger.info(SEPARATOR);

        return {
            payouts,
            businessPayouts,
            acfDonation: totalLicenseFee,
            delegateProfit: totalDelegateProfit,
            timestamp: new BigNumber(0),
        };
    }

    /**
     *
     * @param address
     * @param currentBlock
     * @param latestPayouts
     */
    public isFrequencyMinimumReached(
        address: string,
        currentBlock: number,
        latestPayouts: Map<string, number>
    ): boolean {
        const frequency: number = this.getFrequencyAddress(address);
        const lastPayoutHeight = latestPayouts.get(address);

        if (!lastPayoutHeight || !frequency) {
            return true;
        }

        const blockMinimums: number = lastPayoutHeight + frequency;
        if (blockMinimums < currentBlock) {
            return true;
        }

        logger.warn(
            `Payout to ${address} pending (delay of ${frequency} blocks not yet reached) [${blockMinimums}/${currentBlock}]`
        );
        return false;
    }

    /**
     *
     * @param address
     */
    public getFrequencyAddress(address: string): number {
        if (this.config.customPayoutFrequencies.hasOwnProperty(address)) {
            return this.config.customPayoutFrequencies[address];
        }
        return 0;
    }

    /**
     *
     * @param address
     * @param smallWallets
     * @param voterSeconds
     */
    public getSharePercentage(
        address: string,
        smallWallets: Map<string, boolean>,
        voterSeconds: BigNumber
    ): BigNumber {
        if (this.config.customShares.hasOwnProperty(address)) {
            let customShare: BigNumber = new BigNumber(
                this.config.customShares[address]
            );
            if (customShare.plus(this.config.donationShare).gt(1)) {
                customShare = customShare.minus(this.config.donationShare);
            }
            if (customShare.lt(0)) {
                customShare = new BigNumber(0);
            }

            logger.info(
                `Custom share percentage found for ${address}: ${customShare
                    .times(100)
                    .toString()}%`
            );
            return customShare;
        }

        // check if maximum wallet balance for this voter is <= small wallet limit and then return small wallet share
        if (smallWallets.get(address) === true) {
            for (const durationShare of this.config.smallWalletShareSince) {
                const duration: BigNumber = new BigNumber(
                    durationShare.duration
                );
                if (voterSeconds.gt(duration)) {
                    return new BigNumber(durationShare.percentage);
                }
            }
            return this.config.smallWalletBonus.percentage;
        }

        for (const durationShare of this.config.voterShareSince) {
            const duration: BigNumber = new BigNumber(durationShare.duration);
            if (voterSeconds.gt(duration)) {
                return new BigNumber(durationShare.percentage);
            }
        }

        return this.config.voterShare;
    }

    public getAdminFeeCount(): BigNumber {
        const ADMIN_PAYOUT_LIST = process.env.ADMIN_PAYOUT_LIST
            ? JSON.parse(process.env.ADMIN_PAYOUT_LIST)
            : {};

        return this.getMultiFeesTotal(Object.keys(ADMIN_PAYOUT_LIST).length);
    }

    /**
     *
     */
    public getMultiFeesTotal(amount: number): BigNumber {
        const singleTransactionFee: BigNumber = new BigNumber(amount)
            .mod(this.config.transactionsPerMultiTransfer)
            .eq(1)
            ? new BigNumber(this.config.transferFee).minus(
                  this.config.multiTransferFee
              )
            : new BigNumber(0);

        return new BigNumber(amount)
            .div(this.config.transactionsPerMultiTransfer)
            .integerValue(BigNumber.ROUND_CEIL)
            .times(this.config.multiTransferFee)
            .plus(singleTransactionFee);
    }

    /**
     *
     */
    public getACFFeeCount(): number {
        if (this.config.donationShare.gt(0)) {
            return 1;
        }
        return 0;
    }

    /**
     *
     * @param payouts
     * @param currentVoters
     * @param currentBalances
     */
    private static filterPoolHoppers(
        payouts: Map<string, BigNumber>,
        currentVoters: string[],
        currentBalances: Map<string, BigNumber>
    ): Map<string, BigNumber> {
        for (const [address, pendingBalance] of payouts) {
            const isCurrentVoter: boolean = currentVoters.indexOf(address) >= 0;
            const balance = currentBalances.get(address);
            if (
                !isCurrentVoter ||
                !balance ||
                balance.lte(0) ||
                pendingBalance.lte(0)
            ) {
                payouts.delete(address);
            }
        }
        return new Map(payouts);
    }
}
