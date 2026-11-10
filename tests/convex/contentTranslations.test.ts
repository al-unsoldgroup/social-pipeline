/**
 * convex-test integration tests for contentTranslations.listByTypeAndLocale pagination.
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

describe("contentTranslations.listByTypeAndLocale", () => {
  it("returns one page at a time and walks the full type + locale range", async () => {
    const t = convexTest(schema);
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.contentTranslations.upsert, {
        contentType: "blogPosts",
        contentId: `post${i}`,
        locale: "fr",
        field: "title",
        value: `Titre ${i}`,
      });
    }
    await t.mutation(api.contentTranslations.upsert, {
      contentType: "blogPosts",
      contentId: "post0",
      locale: "es",
      field: "title",
      value: "Título",
    });

    const first = await t.query(api.contentTranslations.listByTypeAndLocale, {
      contentType: "blogPosts",
      locale: "fr",
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const seen = [...first.page];
    let cursor = first.continueCursor;
    let isDone = first.isDone;
    while (!isDone) {
      const next = await t.query(api.contentTranslations.listByTypeAndLocale, {
        contentType: "blogPosts",
        locale: "fr",
        paginationOpts: { numItems: 2, cursor },
      });
      expect(next.page.length).toBeLessThanOrEqual(2);
      seen.push(...next.page);
      cursor = next.continueCursor;
      isDone = next.isDone;
    }

    expect(seen).toHaveLength(5);
    expect(seen.every((r) => r.locale === "fr")).toBe(true);
  });
});
