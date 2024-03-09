import { ICacheService } from "./deps.ts";
import { Client, createClient } from "npm:@libsql/client";

export default class LibSqlCacheService implements ICacheService {
  #db: Client;

  constructor(params: {
    libsql_url: string;
    libsql_auth_token: string;
  }) {
    const client = createClient({
      url: params.libsql_url,
      authToken: params.libsql_auth_token,
    });

    this.#db = client;

    this.#db.execute(
      "CREATE TABLE IF NOT EXISTS turquoze_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, value TEXT, expire TEXT);",
    ).catch((error: Error) => {
      console.error(`LibSqlCacheService init error: ${JSON.stringify(error)}`);
    });
  }

  async get<T>(shop: string, key: string): Promise<T> {
    const cacheKey = `${shop}-${key}`;
    const result = await this.#db.execute({
      sql: "SELECT * FROM turquoze_cache WHERE key = ? AND expire > ?",
      args: [cacheKey, new Date().toISOString()],
    });
    const row = result.rows[0];

    this.#deleteExpireItems();

    if (row == undefined) {
      throw new Error("Not in cache");
    }

    //@ts-expect-error not on type
    return JSON.parse(row["value"]) as T;
  }

  async set<T>(
    params: { shop: string; key: string; data: T; expire?: number | undefined },
  ): Promise<void> {
    try {
      const key = `${params.shop}-${params.key}`;
      const data = JSON.stringify(params.data);
      const expire = new Date();
      // default of 600 seconds
      expire.setSeconds(expire.getSeconds() + (params.expire ?? 60 * 10));

      await this.#db.execute({
        sql: `INSERT INTO turquoze_cache (key, value, expire) VALUES (?, ?, ?)`,
        args: [key, data, expire.toISOString()],
      });

      this.#deleteExpireItems();
    } catch (error) {
      if (
        error.name != "LibsqlError" && !error.code.includes("SQLITE_CONSTRAINT")
      ) {
        throw error;
      }
    }
  }

  async delete(shop: string, key: string): Promise<void> {
    const cacheKey = `${shop}-${key}`;
    await this.#db.execute({
      sql: "DELETE FROM turquoze_cache WHERE key = ?",
      args: [cacheKey],
    });
  }

  #deleteExpireItems() {
    const rand = Math.floor(Math.random() * (10 - 1 + 1) + 1);
    if (rand % 2 == 0) {
      this.#db.execute({
        sql: "DELETE FROM turquoze_cache WHERE expire <= ?",
        args: [new Date().toISOString()],
      }).then().catch((error) => {
        console.error(
          `LibSqlCacheService clean error: ${JSON.stringify(error)}`,
        );
      });
    }
  }
}
