import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

/**
 * Get all translations for a specific content item + locale.
 * Returns a Record<field, value> for easy overlay.
 */
export const getForContent = query({
  args: {
    contentType: v.string(),
    contentId: v.string(),
    locale: v.string(),
  },
  handler: async (ctx, { contentType, contentId, locale }) => {
    if (locale === "en") return {}; // English is source — no overlay needed

    const translations = await ctx.db
      .query("contentTranslations")
      .withIndex("by_content", (q) =>
        q.eq("contentType", contentType).eq("contentId", contentId).eq("locale", locale)
      )
      .collect();

    const result: Record<string, string> = {};
    for (const t of translations) {
      if (!t.status || t.status === "published") {
        result[t.field] = t.value;
      }
    }
    return result;
  },
});

/**
 * Get translations for multiple content items at once (batch).
 * Returns Record<contentId, Record<field, value>>.
 */
export const getForContentBatch = query({
  args: {
    contentType: v.string(),
    contentIds: v.array(v.string()),
    locale: v.string(),
  },
  handler: async (ctx, { contentType, contentIds, locale }) => {
    if (locale === "en") return {};

    const result: Record<string, Record<string, string>> = {};

    // For small batches, query per item. For large batches, query by type+locale.
    if (contentIds.length <= 10) {
      for (const contentId of contentIds) {
        const translations = await ctx.db
          .query("contentTranslations")
          .withIndex("by_content", (q) =>
            q.eq("contentType", contentType).eq("contentId", contentId).eq("locale", locale)
          )
          .collect();

        if (translations.length > 0) {
          result[contentId] = {};
          for (const t of translations) {
            if (!t.status || t.status === "published") {
              result[contentId][t.field] = t.value;
            }
          }
        }
      }
    } else {
      // Query all translations for this type+locale, then filter
      const idSet = new Set(contentIds);
      const allTranslations = await ctx.db
        .query("contentTranslations")
        .withIndex("by_type_locale", (q) =>
          q.eq("contentType", contentType).eq("locale", locale)
        )
        .collect();

      for (const t of allTranslations) {
        if (idSet.has(t.contentId) && (!t.status || t.status === "published")) {
          if (!result[t.contentId]) result[t.contentId] = {};
          result[t.contentId][t.field] = t.value;
        }
      }
    }

    return result;
  },
});

/**
 * Status of translations grouped by contentId + locale for a given type.
 * Returns Record<contentId, Record<locale, 'completed' | 'translating' | 'missing'>>.
 * "completed" = a row exists for that (id, locale) with valid content.
 * "translating" = a row exists with status === 'translating' or 'draft' and a stale-ish ts.
 * Absent = missing.
 */
export const getStatusByType = query({
  args: {
    contentType: v.string(),
    locales: v.array(v.string()),
  },
  handler: async (ctx, { contentType, locales }) => {
    const result: Record<string, Record<string, "completed" | "translating" | "missing">> = {};
    for (const locale of locales) {
      if (locale === "en") continue;
      const rows = await ctx.db
        .query("contentTranslations")
        .withIndex("by_type_locale", (q) =>
          q.eq("contentType", contentType).eq("locale", locale)
        )
        .collect();
      for (const r of rows) {
        if (!result[r.contentId]) result[r.contentId] = {};
        const status: "completed" | "translating" | "missing" =
          r.status === "draft" || r.status === "needs_review"
            ? "translating"
            : r.status === "published" || !r.status
              ? "completed"
              : "translating";
        // Prefer completed if any field is completed; otherwise translating
        const existing = result[r.contentId][locale];
        if (!existing || (existing !== "completed" && status === "completed")) {
          result[r.contentId][locale] = status;
        }
      }
    }
    return result;
  },
});

/**
 * Upsert a single translation (admin use).
 */
export const upsert = mutation({
  args: {
    contentType: v.string(),
    contentId: v.string(),
    locale: v.string(),
    field: v.string(),
    value: v.string(),
    status: v.optional(v.string()),
    translatedBy: v.optional(v.string()),
  },
  handler: async (ctx, { contentType, contentId, locale, field, value, status, translatedBy }) => {
    const existing = await ctx.db
      .query("contentTranslations")
      .withIndex("by_content", (q) =>
        q.eq("contentType", contentType).eq("contentId", contentId).eq("locale", locale)
      )
      .filter((q) => q.eq(q.field("field"), field))
      .first();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value,
        status: (status as "draft" | "published" | "needs_review") ?? existing.status,
        translatedBy: translatedBy ?? existing.translatedBy,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("contentTranslations", {
      contentType,
      contentId,
      locale,
      field,
      value,
      status: (status as "draft" | "published" | "needs_review") ?? "published",
      translatedBy: translatedBy ?? "auto",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Bulk upsert translations for a content item (admin use).
 */
export const bulkUpsert = mutation({
  args: {
    contentType: v.string(),
    contentId: v.string(),
    locale: v.string(),
    translations: v.array(v.object({
      field: v.string(),
      value: v.string(),
    })),
    status: v.optional(v.string()),
    translatedBy: v.optional(v.string()),
  },
  handler: async (ctx, { contentType, contentId, locale, translations, status, translatedBy }) => {
    const existing = await ctx.db
      .query("contentTranslations")
      .withIndex("by_content", (q) =>
        q.eq("contentType", contentType).eq("contentId", contentId).eq("locale", locale)
      )
      .collect();

    const existingByField = new Map(existing.map((t) => [t.field, t]));
    const now = Date.now();

    for (const { field, value } of translations) {
      const ex = existingByField.get(field);
      if (ex) {
        await ctx.db.patch(ex._id, {
          value,
          status: (status as "draft" | "published" | "needs_review") ?? ex.status,
          translatedBy: translatedBy ?? ex.translatedBy,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("contentTranslations", {
          contentType,
          contentId,
          locale,
          field,
          value,
          status: (status as "draft" | "published" | "needs_review") ?? "published",
          translatedBy: translatedBy ?? "auto",
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  },
});

/**
 * List translations for a content type + locale (admin UI), one page at a time.
 * Use with `usePaginatedQuery`. A type + locale can hold more rows than Convex
 * allows in one query result, so never collect the full range.
 */
export const listByTypeAndLocale = query({
  args: {
    contentType: v.string(),
    locale: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { contentType, locale, paginationOpts }) => {
    return await ctx.db
      .query("contentTranslations")
      .withIndex("by_type_locale", (q) =>
        q.eq("contentType", contentType).eq("locale", locale)
      )
      .paginate(paginationOpts);
  },
});
