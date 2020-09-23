import { Config, logger } from "../services";
import BigNumber from "bignumber.js";
import { DatabaseConfig, ForgedBlock, Transaction } from "../interfaces";
import { Crypto } from "./crypto";
import { DatabaseAPI } from "./database-api";
import { ARKTOSHI } from "../constants";

export class BusinessEngine {
    private readonly config: Config;
    private readonly databaseAPI: DatabaseAPI;

    constructor() {
        BigNumber.config({
            DECIMAL_PLACES: 8,
            ROUNDING_MODE: BigNumber.ROUND_DOWN,
        });

        try {
            this.config = new Config();
            const databaseConfig: DatabaseConfig = {
                host: this.config.databaseHost,
                user: this.config.databaseUser,
                database: this.config.databaseDB,
                password: this.config.databasePassword,
                port: this.config.databasePort,
            };
            this.databaseAPI = new DatabaseAPI(databaseConfig);
        } catch (e) {
            logger.error(e.message);
            process.exit(1);
        }
    }

    public async getBusinessIncome(
        forgedBlocks: ForgedBlock[],
        networkVersion: number,
        startBlockHeight: number,
        endBlockHeight: number
    ): Promise<Map<number, BigNumber>> {
        if (this.config.businessSeed === "" || forgedBlocks.length === 0) {
            return new Map();
        }

        try {
            const businessPublicKey: string = Crypto.getPublicKeyFromSeed(
                this.config.businessSeed
            );
            const businessWallet: string = Crypto.getAddressFromPublicKey(
                businessPublicKey,
                networkVersion
            );
            logger.info("Retrieving business revenue transactions.")
            const businessTransactions: Transaction[] = await this.databaseAPI.getTransactions(
                [businessWallet],
                [businessPublicKey],
                startBlockHeight,
                endBlockHeight,
                networkVersion
            );
            if (businessTransactions.length === 0) {
                return new Map();
            }

            return this.getBusinessRevenuePerForgeBlock(
                forgedBlocks,
                businessTransactions,
                businessWallet
            );
        } catch (e) {
            throw e;
        }
    }

    private getBusinessRevenuePerForgeBlock(
        forgedBlocks: ForgedBlock[],
        businessTransactions: Transaction[],
        businessWallet: string
    ): Map<number, BigNumber> {
        let previousHeight: number = forgedBlocks[forgedBlocks.length - 1].height + 1;
        const revenuePerForgedBlock: Map<number, BigNumber> = new Map(
            forgedBlocks.map((block) => [block.height, new BigNumber(0)])
        );
        forgedBlocks.forEach((block: ForgedBlock) => {
            const calculatedTransactions: Transaction[] = businessTransactions.filter(
                (transaction) => {
                    return (
                        transaction.height >= block.height &&
                        transaction.height < previousHeight
                    );
                }
            );

            let amount: BigNumber = new BigNumber(0);
            for (const item of calculatedTransactions) {
                const recipientId: string = item.recipientId;

                if (item.multiPayment !== null && this.config.businessShareMultiTransactionIncome ) {
                    for (const transaction of item.multiPayment) {
                        const transactionAmount: BigNumber = new BigNumber(
                            transaction.amount.toString()
                        );

                        if (transaction.recipientId === businessWallet) {
                            amount = amount.plus(transactionAmount);
                        }
                    }
                } else if(!item.multiPayment) {
                    if (recipientId === businessWallet) {
                        amount = amount.plus(item.amount);
                    }
                }
            }
            //todo
            if(amount.gt(0)) {
                logger.warn(`BUSINESS REVENUE FOR FORGED BLOCK ${block.height} is ${amount.div(ARKTOSHI)}`);
            }
            revenuePerForgedBlock.set(previousHeight, amount);
            previousHeight = block.height;
        });

        return revenuePerForgedBlock;
    }
}
