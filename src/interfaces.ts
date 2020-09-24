import { Interfaces } from "@arkecosystem/crypto";
import BigNumber from "bignumber.js";

export interface SmallWalletBonus {
    walletLimit: BigNumber;
    percentage: BigNumber;
}

export interface SmallWalletBonusConfig {
    walletLimit: number;
    percentage: number;
}

export interface AdminShareConfig {
    percentage: number;
    vendorField?: string;
}

export interface DatabaseConfig {
    user: string;
    host: string;
    database: string;
    password: string;
    port: number;
}

export interface Node {
    host: string;
    port: number;
}

export interface APIResults {
    meta?: any;
    data?: any;
}

export interface BroadcastResult {
    node: string;
    response: any;
}
export interface StakeTimestamp {
    created: BigNumber;
    graceEnd: BigNumber;
    powerUp: BigNumber;
    redeemable: BigNumber;
}

export interface Stake {
    id: string;
    amount: BigNumber;
    duration: BigNumber;
    power: BigNumber;
    timestamps: StakeTimestamp;
}

export interface Voter {
    address: string;
    publicKey: string;
    secondPublicKey?: string;
    balance: BigNumber;
    power: BigNumber;
    stakes?: any;
    processedStakes?: Stake[];
    isDelegate?: boolean;
    vote?: string;
    username?: string;
}

export interface VotersSince {
    address: string;
    timeVoter: BigNumber;
}

export interface Voters {
    votersPerForgedBlock: Map<number, string[]>;
    voters: string[];
    currentVoters: string[];
    voterWallets: Voter[];
}

export interface VotersPerForgedBlock {
    validVoters: string[];
    votersPerForgedBlock: Map<number, string[]>;
}

export interface VoterMutation {
    height: number;
    address: string;
    vote: string;
}

export interface VoterBlock {
    height: number;
    address: string;
    fees: BigNumber;
    reward: BigNumber;
}

export interface VoterBalances {
    balances: Voter[];
    publicKeys: string[];
}

export interface ForgedBlock {
    height: number;
    timestamp: BigNumber;
    fees: BigNumber;
    reward: BigNumber;
}

export interface Block {
    height: number;
    totalFee: number;
    removedFee: number;
    reward: number;
    timestamp: BigNumber;
}

export interface VoteTransaction {
    height: number;
    asset: any;
    senderPublicKey: string;
}

export interface VoterSinceTransaction {
    timestamp: number;
    asset: any;
    senderPublicKey: string;
}

export interface DelegateTransaction {
    height: number;
    recipientId: string;
    multiPayment: Interfaces.IMultiPaymentItem[];
    timestamp: BigNumber;
}

export interface Transaction {
    amount: BigNumber;
    height: number;
    recipientId: string;
    senderId: string;
    senderPublicKey: string;
    multiPayment: Interfaces.IMultiPaymentItem[];
    fee: BigNumber;
    timestamp: BigNumber;
    stakeRedeem: string;
}

export interface MutatedVotersPerRound {
    voters: string[];
    votersPerRound: string[];
}

export interface VoterBalancesPerForgedBlock {
    votersBalancePerForgedBlock: Map<number, Map<string, BigNumber>>;
    smallWallets: Map<string, boolean>;
}

export interface Payouts {
    payouts: Map<string, BigNumber>;
    businessPayouts: Map<string, BigNumber>;
    delegateProfit: BigNumber;
    acfDonation: BigNumber;
    timestamp: BigNumber;
}

export interface PayoutBalances {
    payouts: Map<string, BigNumber>;
    feesPayouts: Map<string, BigNumber>;
    businessPayouts: Map<string, BigNumber>;
}

export interface LatestPayouts {
    latestPayouts: Map<string, number>;
    latestPayoutsTimeStamp: Map<string, BigNumber>;
}

export interface Receiver {
    wallet: string;
    percentage?: BigNumber;
    amount?: BigNumber;
    vendorField?: string;
}

export interface Transfers {
    totalAmount: BigNumber;
    totalBusinessAmount: BigNumber;
    totalFees: BigNumber;
    totalBusinessFees: BigNumber;
    transactions: Interfaces.ITransactionData[];
    businessTransactions: Interfaces.ITransactionData[];
}
