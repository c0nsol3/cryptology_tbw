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
    private nonce: number = null;
    private businessNonce: number = null;

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

        for (
            let i = 0;
            i < receivers.length;
            i += this.config.transactionsPerMultitransfer
        ) {
            const chunk: Receiver[] = receivers.slice(
                i,
                i + this.config.transactionsPerMultitransfer
            );

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
                let transaction: MultiPaymentBuilder = Transactions.BuilderFactory.multiPayment()
                    .fee(this.config.multiTransferFee.toFixed(0))
                    .nonce(nonce);

                if (!this.config.noSignature) {
                    transaction = transaction.vendorField(vendorField);
                }

                for (const receiver of chunk) {
                    transaction.addPayment(
                        receiver.wallet,
                        receiver.amount.toFixed(0)
                    );
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

        let transaction: TransferBuilder = Transactions.BuilderFactory.transfer()
            .amount(receiver.amount.toFixed(0))
            .recipientId(receiver.wallet)
            .fee(this.config.transferFee.toFixed(0))
            .nonce(nonce);

        if (!this.config.noSignature) {
            transaction = transaction.vendorField(receiver.vendorField);
            if (
                Buffer.from(receiver.vendorField).length > 64 &&
                Buffer.from(receiver.vendorField).length <= 255
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

        if (this.nonce === null) {
            this.nonce = await this.network.getNonceForDelegate(
                this.config.delegate
            );
        }

        if (this.businessNonce === null && this.config.businessSeed !== "") {
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
