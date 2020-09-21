import { Interfaces, Managers, Transactions } from "@arkecosystem/crypto";
import { MultiPaymentBuilder } from "@arkecosystem/crypto/dist/transactions/builders/transactions/multi-payment";
import { TransferBuilder } from "@arkecosystem/crypto/dist/transactions/builders/transactions/transfer";
import BigNumber from "bignumber.js";
import { Receiver } from "../interfaces";
import { Config, logger, Network } from "../services";
import { Crypto } from "./crypto";

export class TransactionEngine {
    private readonly config: Config;
    private readonly network: Network;
    private nonce: number = Number.NaN;
    private businessNonce: number = Number.NaN;

    constructor() {
        BigNumber.config({
            DECIMAL_PLACES: 8,
            ROUNDING_MODE: BigNumber.ROUND_DOWN,
        });

        try {
            this.config = new Config();
            this.network = new Network(this.config.server, this.config.nodes);
        } catch (e) {
            logger.error(e.message);
            process.exit(1);
        }
    }

    /**
     *
     * @param receivers
     * @param timestamp
     * @param vendorField
     * @param seed
     * @param secondPassphrase
     * @param business
     */
    public async createMultiPayment(
        receivers: Receiver[],
        timestamp: number,
        vendorField: string,
        seed: string,
        secondPassphrase: string,
        business: boolean
    ): Promise<Interfaces.ITransactionData[]> {
        await this.setupNetwork();
        const transactions: Interfaces.ITransactionData[] = [];

        try {
            for (
                let i = 0;
                i < receivers.length;
                i += this.config.transactionsPerMultitransfer
            ) {
                const chunk: Receiver[] = receivers.slice(
                    i,
                    i + this.config.transactionsPerMultitransfer
                );

                //todo
                logger.info(`RECEIVER: ${JSON.stringify(chunk)}`);
                if (chunk.length === 1) {
                    const receiver: Receiver = {
                        wallet: chunk[0].wallet,
                        amount: chunk[0].amount,
                        vendorField,
                    };
                    const transaction: Interfaces.ITransactionData = await this.createTransaction(
                        receiver,
                        timestamp,
                        business
                    );
                    transactions.push(transaction);
                } else {
                    let nonce: string;
                    if (business) {
                        this.businessNonce += 1;
                        nonce = this.businessNonce.toString();
                    } else {
                        this.nonce += 1;
                        nonce = this.nonce.toString();
                    }
                    //todo
                    logger.info(`NONCE: ${nonce}; BUSINESS: ${business}`);
                    let transaction: MultiPaymentBuilder = Transactions.BuilderFactory.multiPayment()
                        .fee(this.config.multiTransferFee.toFixed(0))
                        .nonce(nonce);

                    if (!this.config.noSignature) {
                        transaction = transaction.vendorField(vendorField);
                    }

                    for (const receiver of chunk) {
                        const amount = receiver.amount;
                        if (amount) {
                            transaction.addPayment(
                                receiver.wallet,
                                amount.toFixed(0)
                            );
                        }
                    }
                    if (timestamp) {
                        transaction.data.timestamp = timestamp;
                    }

                    transaction = transaction.sign(seed);

                    if (secondPassphrase !== "") {
                        transaction = transaction.secondSign(secondPassphrase);
                    }
                    transactions.push(transaction.getStruct());
                }
            }
            return transactions;
        } catch (e) {
            logger.error(e);
            throw e;
        }
    }

    /**
     *
     * @param receiver
     * @param timestamp
     * @param business
     */
    public async createTransaction(
        receiver: Receiver,
        timestamp: number,
        business: boolean = false
    ): Promise<Interfaces.ITransactionData> {
        await this.setupNetwork();

        let nonce: string;
        if (business) {
            this.businessNonce += 1;
            nonce = this.businessNonce.toString();
        } else {
            this.nonce += 1;
            nonce = this.nonce.toString();
        }
        let amount = receiver.amount;
        if(amount === undefined) {
            amount = new BigNumber(0);
        }
        let transaction: TransferBuilder = Transactions.BuilderFactory.transfer()
            .amount(amount.toFixed(0))
            .recipientId(receiver.wallet)
            .fee(this.config.transferFee.toFixed(0))
            .nonce(nonce);

        if (!this.config.noSignature) {
            let vendorField = receiver.vendorField;
            if(vendorField === undefined) {
                vendorField = "";
            }
            transaction = transaction.vendorField(vendorField);
            if (
                Buffer.from(vendorField).length > 64 &&
                Buffer.from(vendorField).length <= 255
            ) {
                transaction.data.vendorField = this.config.vendorField;
            }
        }

        if (timestamp) {
            transaction.data.timestamp = timestamp;
        }

        transaction = transaction.sign(this.config.seed);

        if (this.config.secondPassphrase !== "") {
            transaction = transaction.secondSign(this.config.secondPassphrase);
        }

        return transaction.getStruct();
    }

    /**
     *
     */
    private async setupNetwork() {
        const networkConfig: Interfaces.INetworkConfig = await this.network.getNetworkConfig();
        let networkVersion: number = 88;
        if (networkConfig !== null) {
            Managers.configManager.setConfig(networkConfig);
            networkVersion = networkConfig.network.pubKeyHash;
        }

        let height: number = await this.network.getCurrentHeight();
        if (height === null) {
            height = this.config.startFromBlockHeight;
        }
        Managers.configManager.setHeight(height);

        const milestone = Managers.configManager.getMilestone(height);
        this.config.transactionsPerMultitransfer = Math.min(
            this.config.transactionsPerMultitransfer,
            milestone.multiPaymentLimit
        );

        //todo
        logger.warn(`NONCE: ${this.nonce}`);
        if (this.nonce === Number.NaN) {
            this.nonce = await this.network.getNonceForDelegate(
                this.config.delegate
            );
        }

        if (this.businessNonce === Number.NaN && this.config.businessSeed !== "") {
            const businessPublicKey: string = Crypto.getPublicKeyFromSeed(
                this.config.businessSeed
            );
            const businessWallet: string = Crypto.getAddressFromPublicKey(
                businessPublicKey,
                networkVersion
            );
            this.businessNonce = await this.network.getNonceForWallet(
                businessWallet
            );
        }
    }
}
