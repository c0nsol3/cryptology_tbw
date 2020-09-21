// @ts-ignore
import { Client, Result } from "pg";
import { DatabaseConfig } from "../interfaces";
import { logger } from "./";

export class Postgres {
    private client: Client;
    private readonly databaseConfig: DatabaseConfig;

    constructor(databaseConfig: DatabaseConfig) {
        this.databaseConfig = databaseConfig;
        this.client = new Client(this.databaseConfig);
    }

    public async connect(): Promise<void> {
        try {
            await this.client.connect();
        } catch (error) {
            logger.error(error);
        }
    }

    public async close(): Promise<void> {
        try {
            await this.client.end();
            this.client = new Client(this.databaseConfig);
        } catch (error) {
            logger.error(error);
        }
    }

    public async query(query: string): Promise<Result> {
        try {
            const result: Result = await this.client.query(query);
            if (typeof result !== "undefined") {
                return result;
            }
            logger.warn("Query did not return results");
        } catch (error) {
            logger.error(error);
        }
        return null;
    }
}
