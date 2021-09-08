import { Interfaces } from "@arkecosystem/crypto";
import axios from "axios";
import BigNumber from "bignumber.js";
import {
    APIResults,
    BroadcastResult,
    Node,
    Stake,
    Voter,
    VoterMutation,
} from "../interfaces";
import { logger } from "./";
import { Crypto } from "../utils";

export class Network {
    private readonly server: string;
    private readonly nodes: Node[];

    constructor(server: string, nodes: Node[]) {
        this.server = server;
        this.nodes = nodes;
    }

    /**
     *
     */
    public async getNetworkConfig(): Promise<Interfaces.INetworkConfig> {
        try {
            const config: APIResults = await this.getFromAPI(
                "/api/node/configuration/crypto"
            );
            return config.data;
        } catch (e) {
            throw new Error(
                "Can't load network config. Please check your node(s) configuration."
            );
        }
    }

    /**
     *
     */
    public async getCurrentHeight(): Promise<number> {
        try {
            const config: APIResults = await this.getFromAPI("/api/blockchain");
            return config.data.block.height;
        } catch (e) {
            throw new Error(
                "Can't load current network block-height. Please check your node(s) configuration."
            );
        }
    }

    /**
     *
     * @param delegate
     */
    public async getNonceForDelegate(delegate: string): Promise<number> {
        try {
            const delegateWallet: string = await this.getDelegateAddress(
                delegate
            );
            return this.getNonceForWallet(delegateWallet);
        } catch (e) {
            throw new Error(
                `Can't load nonce for ${delegate}. Please check your node(s) configuration.`
            );
        }
    }

    public async getNonceForWallet(wallet: string): Promise<number> {
        try {
            const walletInfo: APIResults = await this.getFromAPI(
                `/api/wallets/${wallet}`
            );
            return walletInfo.hasOwnProperty("data") &&
                walletInfo.data.hasOwnProperty("nonce")
                ? parseInt(walletInfo.data.nonce, 10)
                : Number.NaN;
        } catch (e) {
            throw new Error(
                `Can't load nonce for ${wallet}. Please check your node(s) configuration.`
            );
        }
    }

    /**
     *
     * @param endPoint
     * @param params
     */
    public async getFromAPI(
        endPoint: string,
        params = {}
    ): Promise<APIResults> {
        for (const APINode of this.nodes) {
            const node: string =
                typeof APINode !== "undefined" &&
                APINode.hasOwnProperty("host") &&
                APINode.hasOwnProperty("port")
                    ? `http://${APINode.host}:${APINode.port}`
                    : this.server;

            try {
                const response = await axios.get(`${node}${endPoint}`, {
                    params,
                    headers: { "API-Version": 2 },
                    timeout: 5000,
                });

                if (
                    typeof response !== "undefined" &&
                    response.hasOwnProperty("data")
                ) {
                    return response.data;
                }
            } catch (error) {
                logger.warn(`${error} for URL: ${node}${endPoint}`);
            }
        }

        throw new Error("Could not connect to any of the configured nodes.");
    }

    public async getBalanceForSeed(seed: string): Promise<BigNumber> {
        const publicKey: string = Crypto.getPublicKeyFromSeed(seed);
        const getWalletByPubKLeyEndpoint: string = `/api/wallets?publicKey=${publicKey}`;
        const delegateNameAPIResults: APIResults = await this.getFromAPI(
            getWalletByPubKLeyEndpoint
        );

        if (
            delegateNameAPIResults &&
            delegateNameAPIResults.hasOwnProperty("data") &&
            delegateNameAPIResults.data.length > 0 &&
            delegateNameAPIResults.data[0].hasOwnProperty("balance") &&
            delegateNameAPIResults.data[0].balance
        ) {
            return new BigNumber(delegateNameAPIResults.data[0].balance);
        }

        throw new Error("Could not retrieve wallet balance.");
    }

    public async getDelegateNameForSeed(seed: string): Promise<string> {
        const publicKey: string = Crypto.getPublicKeyFromSeed(seed);
        const getWalletByPubKLeyEndpoint: string = `/api/wallets?publicKey=${publicKey}`;
        const delegateNameAPIResults: APIResults = await this.getFromAPI(
            getWalletByPubKLeyEndpoint
        );

        if (
            delegateNameAPIResults &&
            delegateNameAPIResults.hasOwnProperty("data") &&
            delegateNameAPIResults.data.length > 0 &&
            delegateNameAPIResults.data[0].hasOwnProperty("username") &&
            delegateNameAPIResults.data[0].username
        ) {
            return delegateNameAPIResults.data[0].username;
        }

        // Core V3
        if (
            delegateNameAPIResults &&
            delegateNameAPIResults.hasOwnProperty("data") &&
            delegateNameAPIResults.data.length > 0 &&
            delegateNameAPIResults.data[0].hasOwnProperty("attributes") &&
            delegateNameAPIResults.data[0].attributes.hasOwnProperty("delegate") &&
            delegateNameAPIResults.data[0].attributes.delegate.hasOwnProperty("username") &&
            delegateNameAPIResults.data[0].attributes.delegate.username
        ) {
            return delegateNameAPIResults.data[0].attributes.delegate.username;
        }

        throw new Error(
            "Could not retrieve delegate data: does the configured seed belong to a delegate wallet?"
        );
    }

    /**
     * @dev Retrieve the delegate public key from the API
     */
    public async getDelegatePublicKey(delegate: string): Promise<string> {
        const getDelegateEndpoint: string = `/api/delegates/${delegate}/`;
        const delegateAPIResults: APIResults = await this.getFromAPI(
            getDelegateEndpoint
        );

        if (
            delegateAPIResults &&
            delegateAPIResults.hasOwnProperty("data") &&
            delegateAPIResults.data.hasOwnProperty("publicKey") &&
            delegateAPIResults.data.publicKey
        ) {
            return delegateAPIResults.data.publicKey;
        }

        throw new Error(
            "Could not retrieve delegate data: is the configured delegate registered?"
        );
    }

    public async getDelegateAddress(delegate: string): Promise<string> {
        const getDelegateEndpoint: string = `/api/delegates/${delegate}/`;
        const delegateAPIResults: APIResults = await this.getFromAPI(
            getDelegateEndpoint
        );

        if (
            delegateAPIResults.hasOwnProperty("data") &&
            delegateAPIResults.data.hasOwnProperty("address")
        ) {
            return delegateAPIResults.data.address;
        }

        throw new Error("Could not retrieve delegate data.");
    }

    /**
     *
     * @param seed
     */
    public async getVoters(seed: string): Promise<Voter[]> {
        try {
            const delegate: string = await this.getDelegateNameForSeed(seed);
            const getVotersEndpoint: string = `/api/delegates/${delegate}/voters`;
            const params = {
                page: 1,
                limit: 100,
            };

            let votersAPIResults: APIResults;
            let voters: Voter[] = [];
            do {
                votersAPIResults = await this.getFromAPI(
                    getVotersEndpoint,
                    params
                );
                if (
                    votersAPIResults.hasOwnProperty("data") &&
                    votersAPIResults.data.length > 0
                ) {
                    voters = voters.concat(votersAPIResults.data);
                }
                params.page++;
            } while (
                votersAPIResults.hasOwnProperty("data") &&
                votersAPIResults.data.length > 0
            );

            if (voters.length === 0) {
                logger.warn(`There are no current voters for ${delegate!}`);
            }
            return voters;
        } catch (e) {
            throw e;
        }
    }

    public processStakes(voter: Voter, epochTimestamp: BigNumber): Stake[] {
        const stakes: Stake[] = [];
        if (voter.hasOwnProperty("stakes")) {
            const voterStakes: any[] = voter.stakes;
            for (const item in voterStakes) {
                if (
                    voterStakes.hasOwnProperty(item) &&
                    voterStakes[item].hasOwnProperty("status") &&
                    voterStakes[item].status !== "canceled"
                ) {
                    const stake: Stake = {
                        id: item,
                        amount: voterStakes[item].hasOwnProperty("amount")
                            ? new BigNumber(voterStakes[item].amount)
                            : new BigNumber(0),
                        duration: voterStakes[item].hasOwnProperty("duration")
                            ? new BigNumber(voterStakes[item].duration)
                            : new BigNumber(0),
                        power: voterStakes[item].hasOwnProperty("power")
                            ? new BigNumber(voterStakes[item].power)
                            : new BigNumber(0),
                        timestamps: {
                            created:
                                voterStakes[item].hasOwnProperty(
                                    "timestamps"
                                ) &&
                                voterStakes[item].timestamps.hasOwnProperty(
                                    "created"
                                )
                                    ? new BigNumber(
                                          voterStakes[item].timestamps.created
                                      ).minus(epochTimestamp)
                                    : new BigNumber(0),
                            graceEnd:
                                voterStakes[item].hasOwnProperty(
                                    "timestamps"
                                ) &&
                                voterStakes[item].timestamps.hasOwnProperty(
                                    "graceEnd"
                                )
                                    ? new BigNumber(
                                          voterStakes[item].timestamps.graceEnd
                                      ).minus(epochTimestamp)
                                    : new BigNumber(0),
                            powerUp:
                                voterStakes[item].hasOwnProperty(
                                    "timestamps"
                                ) &&
                                voterStakes[item].timestamps.hasOwnProperty(
                                    "powerUp"
                                )
                                    ? new BigNumber(
                                          voterStakes[item].timestamps.powerUp
                                      ).minus(epochTimestamp)
                                    : new BigNumber(0),
                            redeemable:
                                voterStakes[item].hasOwnProperty(
                                    "timestamps"
                                ) &&
                                voterStakes[item].timestamps.hasOwnProperty(
                                    "redeemable"
                                )
                                    ? new BigNumber(
                                          voterStakes[
                                              item
                                          ].timestamps.redeemable
                                      ).minus(epochTimestamp)
                                    : new BigNumber(0),
                        },
                    };
                    stakes.push(stake);
                }
            }
        }
        return stakes;
    }

    /**
     * @dev  Add wallets for voters that unvoted
     */
    public async addMutatedVoters(
        voterMutations: VoterMutation[],
        currentVotersFromAPI: Voter[],
        currentVoters: string[],
        epochTimestamp: BigNumber
    ): Promise<Voter[]> {
        const allVotersFromAPI: Voter[] = currentVotersFromAPI.slice(0);
        const voterCache: string[] = [];

        for (const item of voterMutations) {
            if (
                item.hasOwnProperty("address") &&
                currentVoters.indexOf(item.address) < 0
            ) {
                const address: string = item.address;

                if (voterCache.indexOf(address) < 0) {
                    const getWalletEndpoint: string = `/api/wallets/${address}/`;
                    const walletAPIResult: APIResults = await this.getFromAPI(
                        getWalletEndpoint
                    );
                    if (
                        walletAPIResult &&
                        walletAPIResult.hasOwnProperty("data") &&
                        walletAPIResult.data.hasOwnProperty("address") &&
                        walletAPIResult.data.hasOwnProperty("publicKey") &&
                        walletAPIResult.data.hasOwnProperty("balance") &&
                        walletAPIResult.data.hasOwnProperty("isDelegate")
                    ) {
                        const voter: Voter = {
                            address: walletAPIResult.data.address,
                            publicKey: walletAPIResult.data.publicKey,
                            balance: new BigNumber(
                                walletAPIResult.data.balance
                            ),
                            power: walletAPIResult.data.hasOwnProperty("power")
                                ? new BigNumber(walletAPIResult.data.power)
                                : new BigNumber(0),
                            isDelegate: walletAPIResult.data.isDelegate,
                            processedStakes: this.processStakes(
                                walletAPIResult.data,
                                epochTimestamp
                            ),
                        };
                        allVotersFromAPI.push(voter);
                        voterCache.push(address);
                    }
                }
            }
        }
        return allVotersFromAPI;
    }

    /**
     *
     * @param transactions
     */
    public async broadcastTransactions(
        transactions: Interfaces.ITransactionData[]
    ): Promise<BroadcastResult[]> {
        const results: BroadcastResult[] = [];
        for (const item in this.nodes) {
            if (
                typeof this.nodes[item] !== "undefined" &&
                this.nodes[item].hasOwnProperty("host") &&
                this.nodes[item].hasOwnProperty("port")
            ) {
                const node: string = `http://${this.nodes[item].host}:${this.nodes[item].port}`;
                logger.info(
                    `Sending ${transactions.length} transactions to ${node}.`
                );
                const response = await axios.post(
                    `${node}/api/transactions`,
                    {
                        transactions,
                    },
                    {
                        headers: { "Content-Type": "application/json" },
                    }
                );
                results.push({ node, response: response.data });
            }
        }

        return results;
    }
}
