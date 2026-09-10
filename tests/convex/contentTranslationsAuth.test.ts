/**
 * Auth guard for the content-translation writes.
 *
 * These rows overlay text on public blog pages, so a caller with no admin
 * session must not be able to write them. The tests check that:
 *  - the public `upsert` and `bulkUpsert` mutations reject an unauthenticated caller
 *  - the public `bulkUpsert` accepts an authenticated admin
 *  - the internal `bulkUpsertInternal` (used by the translation agent) writes
 *    without a session
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.*s");

const sampleRow = {
  contentType: "blogPosts",
  contentId: "post123",
  locale: "fr",
  translations: [{ field: "title", value: "Bonjour" }],
  status: "published",
  translatedBy: "auto",
};

describe("contentTranslations auth", () => {
  it("rejects bulkUpsert from an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.contentTranslations.bulkUpsert, sampleRow)).rejects.toThrow(
      /Authentication required/,
    );

    const rows = await t.run((ctx) => ctx.db.query("contentTranslations").collect());
    expect(rows).toHaveLength(0);
  });

  it("rejects upsert from an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.contentTranslations.upsert, {
        contentType: "blogPosts",
        contentId: "post123",
        locale: "fr",
        field: "title",
        value: "Bonjour",
      }),
    ).rejects.toThrow(/Authentication required/);
  });

  it("accepts bulkUpsert from an authenticated admin", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("userRoles", { userId: id, role: "admin", assignedAt: Date.now() });
      return id;
    });

    await t
      .withIdentity({ subject: userId })
      .mutation(api.contentTranslations.bulkUpsert, sampleRow);

    const rows = await t.run((ctx) => ctx.db.query("contentTranslations").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("Bonjour");
  });

  it("rejects bulkUpsert from an authenticated non-admin", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));

    await expect(
      t.withIdentity({ subject: userId }).mutation(api.contentTranslations.bulkUpsert, sampleRow),
    ).rejects.toThrow(/Admin access required/);
  });

  it("lets the internal bulkUpsert write without a session (agent path)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.contentTranslations.bulkUpsertInternal, sampleRow);

    const rows = await t.run((ctx) => ctx.db.query("contentTranslations").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].field).toBe("title");
  });
});
