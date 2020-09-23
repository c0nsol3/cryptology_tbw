/**
 *
 * @param publicKey
 * @param startBlockHeight
 * @param endBlockHeight
 * @param limit
 */
export const getForgedBlocks = (
    publicKey: string,
    startBlockHeight: number,
    endBlockHeight: number,
    limit: number
): string => {
    let query = `SELECT blocks.height, blocks.timestamp, blocks.reward, \
                        blocks.total_fee AS "totalFee" \
          FROM public.blocks \
          WHERE blocks."generator_public_key" = '${publicKey}' \
          AND blocks.height >= ${startBlockHeight}`;

    if (Number.isInteger(endBlockHeight)) {
        query = `${query} AND blocks.height <= ${endBlockHeight}`;
    }

    query = `${query} ORDER BY blocks.height DESC LIMIT ${limit};`;

    return query;
};

/**
 *
 * @param startBlockHeight
 * @param endBlockHeight
 */
export const getVotingDelegates = (
    startBlockHeight: number,
    endBlockHeight: number
): string => {
    let query = `SELECT blocks."generator_public_key", blocks."height", blocks."total_fee", blocks."reward" \
          FROM blocks \
          WHERE blocks.height >= ${startBlockHeight}`;

    if (Number.isInteger(endBlockHeight)) {
        query = `${query} AND blocks.height <= ${endBlockHeight}`;
    }

    query = `${query} ORDER BY blocks."height" ASC;`;

    return query;
};

export const getCurrentVoters = (delegatePublicKey: string): string => {
    return `SELECT * FROM ( \
    SELECT DISTINCT ON (transactions."sender_public_key") transactions."sender_public_key" AS "senderPublicKey", * \
    FROM transactions \
    WHERE transactions."type" = 3 AND transactions."type_group" = 1 \
    AND transactions."asset"->>'votes' LIKE '%${delegatePublicKey}%' \
    ORDER BY transactions."sender_public_key", transactions."timestamp" DESC ) t \
    WHERE t."asset"->>'votes' LIKE '%+%' ORDER BY t."timestamp" DESC;`;
};

/**
 *
 * @param startBlockHeight
 * @param delegatePublicKey
 */
export const getVoterSinceHeight = (
    startBlockHeight: number,
    delegatePublicKey: string
): string => {
    return `SELECT transactions."asset", transactions."sender_public_key" AS "senderPublicKey", \ 
          blocks."height" \
          FROM transactions INNER JOIN blocks ON blocks."id" = transactions."block_id"  
          WHERE transactions."type" = 3 AND transactions."type_group" = 1 \
          AND transactions."asset"->>'votes' LIKE '%${delegatePublicKey}%'
          AND blocks.height >= ${startBlockHeight} ORDER BY blocks."height" ASC;`;
};

/**
 *
 * @param voters
 * @param votersKeys
 * @param startBlockHeight
 * @param endBlockHeight
 */
export const getTransactions = (
    voters: string[],
    votersKeys: string[],
    startBlockHeight: number,
    endBlockHeight: number
): string => {
    const votersAddresses = voters.map((address) => `'${address}'`).join(",");
    const votersPublicKeys = votersKeys
        .map((publicKey) => `'${publicKey}'`)
        .join(",");

    let query = `SELECT transactions."amount", transactions."fee", transactions."recipient_id" AS "recipientId", \
          transactions."timestamp", transactions."sender_public_key" AS "senderPublicKey", \
          transactions."type", transactions."asset", blocks."height" \
          FROM transactions INNER JOIN blocks ON blocks."id" = transactions."block_id"  
          WHERE blocks."height" >= ${startBlockHeight}`;

    if (Number.isInteger(endBlockHeight)) {
        query = `${query} AND blocks.height <= ${endBlockHeight}`;
    }

    query = `${query} AND ( transactions."sender_public_key" in (${votersPublicKeys}) \
          OR transactions."recipient_id" in (${votersAddresses}) OR transactions."type" = 6) \
          ORDER BY blocks."height" DESC;`;

    return query;
};

/**
 *
 * @param startBlockHeight
 * @param endBlockHeight
 * @param delegatePublicKey
 */
export const getDelegateTransactions = (
    startBlockHeight: number,
    endBlockHeight: number,
    delegatePublicKey: string
): string => {
    let query = `SELECT transactions."asset", transactions."recipient_id" AS "recipientId", transactions."timestamp", \
          transactions.type, blocks."height" \
          FROM transactions INNER JOIN blocks ON blocks."id" = transactions."block_id"  
          WHERE blocks."height" >= ${startBlockHeight} \
          AND transactions."type_group" = 1 \
          AND (transactions."type" = 6 OR transactions."type" = 0)`;

    if (Number.isInteger(endBlockHeight)) {
        query = `${query} AND blocks.height <= ${endBlockHeight}`;
    }

    query = `${query} AND transactions."sender_public_key" = '${delegatePublicKey}' \
          ORDER BY blocks."height" DESC;`;

    return query;
};
