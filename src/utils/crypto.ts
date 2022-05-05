import { Identities } from "@solar-network/crypto";

export class Crypto {
    /**
     * Generate an Address from a public key for a blockchain.
     * @param {string} publicKey The public key of the wallet to generate the address for.
     * @param {number} networkVersion The network version of the blockchain to generate the address for.
     * @returns {string} The generated address.
     * @static
     */
    public static getAddressFromPublicKey(
        publicKey: string,
        networkVersion: number
    ): string {
        return Identities.Address.fromPublicKey(publicKey, networkVersion);
    }

    public static getPublicKeyFromSeed(seed: string): string {
        return Identities.PublicKey.fromPassphrase(seed);
    }
}
