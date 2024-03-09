import { assert } from "@std/assert/assert";
import { assertObjectMatch } from "@std/assert/assert_object_match";

import LibSqlCacheService from "./libsql.ts";

Deno.test("LibSqlCacheService", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  const libsqlCache = new LibSqlCacheService({
    libsql_url: Deno.env.get("LIBSQL_URL")!,
    libsql_auth_token: Deno.env.get("LIBSQL_AUTH_TOKEN")!,
  });
  const shop = crypto.randomUUID();

  await t.step("insert into cache", async () => {
    try {
      await libsqlCache.set({
        key: "test-cache",
        shop: shop,
        data: {
          test: 123,
          msg: "hello world",
        },
      });

      assert(true);
    } catch {
      assert(false);
    }
  });

  await t.step("get from cache", async () => {
    const data = await libsqlCache.get<{ test: number; msg: string }>(
      shop,
      "test-cache",
    );

    assertObjectMatch(data, { test: 123, msg: "hello world" });
  });

  await t.step("delete from cache", async () => {
    try {
      await libsqlCache.delete(shop, "test-cache");

      assert(true);
    } catch {
      assert(false);
    }
  });

  await t.step("insert into cache - expired", async () => {
    try {
      await libsqlCache.set({
        key: "test-cache-expire",
        shop: shop,
        expire: -10,
        data: {
          test: 123,
          msg: "hello world",
        },
      });

      assert(true);
    } catch {
      assert(false);
    }
  });

  await t.step("get from cache - expire", async () => {
    try {
      await libsqlCache.get<{ test: number; msg: string }>(
        shop,
        "test-cache-expire",
      );

      assert(false);
    } catch {
      assert(true);
    }
  });
});
