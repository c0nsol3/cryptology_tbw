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
     */
    public applyProposal(
        currentBlock: number,
        latestPayouts: Map<string, number>,
        smallWallets: Map<string, boolean>,
        payouts: Map<string, BigNumber>,
        feesPayouts: Map<string, BigNumber>,
        businessPayouts: Map<string, BigNumber>,
        currentVoters:string[],
        currentBalances: Map<string, BigNumber>
    ): Payouts {
        let totalPayout: BigNumber = new BigNumber(0);
        let delegateProfit: BigNumber = new BigNumber(0);
        let acfDonation: BigNumber = new BigNumber(0);
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
                // Percentages
                const percentage: BigNumber = this.getSharePercentage(
                    address,
                    smallWallets
                );

                const acfPayout: BigNumber = new BigNumber(
                    balance
                        .times(this.config.donationShare)
                        .integerValue(BigNumber.ROUND_CEIL)
                );
                let voterPayout: BigNumber = new BigNumber(
                    balance.times(percentage).integerValue(BigNumber.ROUND_DOWN)
                );
                let delegatePayout: BigNumber = new BigNumber(balance)
                    .minus(acfPayout)
                    .minus(voterPayout);

                if (delegatePayout.lt(0)) {
                    voterPayout = voterPayout.minus(delegatePayout);
                    delegatePayout = new BigNumber(0);
                }

                const businessPayoutForAddress = businessPayouts.get(address);
                if (
                    businessPayoutForAddress &&
                    new BigNumber(businessPayoutForAddress).gt(0)
                ) {
                    let businessBalance = new BigNumber(
                        businessPayoutForAddress
                    );
                    const businessPayout: BigNumber = new BigNumber(
                        businessBalance
                            .times(this.config.voterBusinessShare)
                            .integerValue(BigNumber.ROUND_DOWN)
                    );
                    totalBusinessPayout = totalBusinessPayout.plus(
                        businessPayout
                    );
                    businessPayouts.set(address, businessPayout);
                }

                delegateProfit = delegateProfit.plus(delegatePayout);
                acfDonation = acfDonation.plus(acfPayout);

                let voterFeePayout: BigNumber = new BigNumber(0);
                const voterFeesPayout = feesPayouts.get(address);
                if (voterFeesPayout && new BigNumber(voterFeePayout).gt(0)) {
                    const feePayout: BigNumber = new BigNumber(voterFeesPayout);
                    const acfFeesPayout: BigNumber = new BigNumber(
                        feePayout.times(this.config.donationShare)
                    );
                    acfDonation = acfDonation.plus(acfFeesPayout);

                    voterFeePayout = new BigNumber(
                        feePayout
                            .minus(acfFeesPayout)
                            .times(this.config.voterFeeShare)
                            .integerValue(BigNumber.ROUND_DOWN)
                    );

                    feesPayouts.set(address, voterFeePayout);
                    delegateProfit = delegateProfit.plus(
                        feePayout.minus(voterFeePayout).minus(acfFeesPayout)
                    );
                }
                payouts.set(address, voterPayout.plus(voterFeePayout));

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
                    totalPayout = totalPayout.plus(
                        new BigNumber(payoutForVoter)
                    );
                }
            } else {
                payouts.delete(address);
                businessPayouts.delete(address);
            }
        }

        // FairFees
        const multiPaymentFees: BigNumber = this.getMultiFeesTotal(
            payouts.size
        );
        const totalFees: BigNumber = this.config.transferFee
            .times(this.getACFFeeCount())
            .plus(multiPaymentFees)
            .plus(this.getAdminFeeCount());

        if (this.config.adminFees && delegateProfit.lt(totalFees)) {
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
                    )} Transfer Fees will be deducted from Admin share (${delegateProfit
                    .div(ARKTOSHI)
                    .toFixed(8)}).`
            );
            delegateProfit = delegateProfit.minus(totalFees);
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

            const businessPayoutForVoter = businessPayouts.get(address);
            if (businessPayoutForVoter) {
                let businessPayout: BigNumber = new BigNumber(
                    businessPayoutForVoter
                ).minus(fairFees);
                if (businessPayout.lt(0)) {
                    businessPayout = new BigNumber(0);
                }
                businessPayouts.set(address, businessPayout);
            }
        }

        logger.info(SEPARATOR);
        logger.info(
            `Next payout run: ${
                payouts.size
            } share payouts with total amount: ${totalPayout
                .plus(delegateProfit)
                .plus(acfDonation)
                .div(ARKTOSHI)
                .toFixed(8)}:`
        );
        logger.info(`Voter Share: ${totalPayout.div(ARKTOSHI).toFixed(8)}`);
        logger.info(
            `Delegate Profits: ${delegateProfit.div(ARKTOSHI).toFixed(8)}`
        );
        logger.info(`License Fee: ${acfDonation.div(ARKTOSHI).toFixed(8)}`);
        logger.info(`Transaction Fees: ${totalFees.div(ARKTOSHI).toFixed(8)}`);
        if (totalBusinessPayout.gt(0)) {
            logger.info(
                `Business Revenue Payout: ${totalBusinessPayout
                    .div(ARKTOSHI)
                    .toFixed(8)}`
            );
        }
        logger.info(SEPARATOR);

        return {
            payouts,
            businessPayouts,
            acfDonation,
            delegateProfit,
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
     */
    public getSharePercentage(
        address: string,
        smallWallets: Map<string, boolean>
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
            return this.config.smallWalletBonus.percentage;
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
            .mod(this.config.transactionsPerMultitransfer)
            .eq(1)
            ? new BigNumber(this.config.transferFee).minus(
                  this.config.multiTransferFee
              )
            : new BigNumber(0);

        return new BigNumber(amount)
            .div(this.config.transactionsPerMultitransfer)
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
    ): Map<string, BigNumber>  {

        for (const [address, pendingBalance] of payouts) {
            const isCurrentVoter: boolean = currentVoters.indexOf(address) >= 0;
            const balance = currentBalances.get(address);
            if(!isCurrentVoter || !balance || balance.lte(0) || pendingBalance.lte(0)) {
                payouts.delete(address);
            }
        }
        return new Map(payouts);
    }
}
