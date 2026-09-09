import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { createModelFromConfig } from "./config";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { adminAction } from "../lib/adminAuth";
import type { TableNames } from "../_generated/dataModel";

/**
 * Generic internal query to fetch any document by table + ID.
 * Used by translateEntity so it doesn't need admin auth.
 */
export const getDocById = internalQuery({
  args: { table: v.string(), id: v.string() },
  handler: async (ctx, { table, id }) => {
    return await ctx.db.get(id as any);
  },
});

const LOCALE_NAMES: Record<string, string> = {
  es: "Spanish",
  fr: "French",
};

// ===== Generic entity translation config =====

interface EntityTranslationConfig {
  table: string;
  fields: string[];
  prompt: string;
  /** Public or internal list function for batch mode (no auth needed) */
  listApi: any;
  /** Optional list args */
  listArgs?: Record<string, unknown>;
  /** For FAQ listAll: flatten nested results */
  flatten?: string;
}

const ENTITY_CONFIGS: Record<string, EntityTranslationConfig> = {
  contentPods: {
    table: "contentPods",
    fields: ["name", "description", "pillarIntroContent"],
    prompt: "Translate the following content pod metadata (pillar topic cluster).",
    listApi: api.contentPods.listActive,
  },
  blogPosts: {
    table: "blogPosts",
    fields: ["title", "excerpt", "content"],
    prompt: "Translate the following blog post.",
    listApi: api.blogPosts.list,
  },
};

const translationSchema = z.object({
  title: z.string().describe("Translated blog post title"),
  excerpt: z.string().describe("Translated blog post excerpt/summary"),
  content: z.string().describe("Translated blog post content in Markdown"),
});

function buildPrompt(
  locale: string,
  title: string,
  excerpt: string,
  content: string
): string {
  const languageName = LOCALE_NAMES[locale] ?? locale;
  return `Translate the following blog post into ${languageName} (${locale}).

RULES:
- Preserve ALL markdown formatting exactly (headings, bold, italic, links, lists, code blocks, images, HTML tags)
- Do NOT translate URLs, email addresses, or code
- Do NOT translate brand names or proper nouns
- Do NOT add, remove, or reorder any content
- Use natural, fluent ${languageName} appropriate for a professional publication
- Maintain the same tone and register as the English source

TITLE:
${title}

EXCERPT:
${excerpt}

CONTENT (Markdown):
${content}`;
}

/**
 * Translate a single blog post into one or more locales.
 */
export const translatePost = internalAction({
  args: {
    postId: v.id("blogPosts"),
    locales: v.array(v.string()),
    runId: v.optional(v.string()),
  },
  handler: async (ctx, { postId, locales, runId }) => {
    if (locales.length > 10) throw new Error("Translation batch exceeds 10 locales");
    // Fetch the blog post
    const post = await ctx.runQuery(internal.blogPosts.getById, { id: postId });
    if (!post) throw new Error(`Blog post not found: ${postId}`);

    // Fetch translate agent config
    const config = await ctx.runQuery(internal.agents.config.getConfig, {
      key: "translate",
    });
    const model = await createModelFromConfig(ctx, "translate", runId ?? crypto.randomUUID(), config.provider, config.model);

    const results: Array<{ locale: string; status: string }> = [];

    for (const locale of locales) {
      if (locale === "en") continue;
      if (!LOCALE_NAMES[locale]) {
        results.push({ locale, status: "skipped — unknown locale" });
        continue;
      }

      try {
        const prompt = buildPrompt(
          locale,
          post.title,
          post.excerpt,
          post.content ?? ""
        );

        const { object: translated } = await generateObject({
          model, maxRetries: 0, maxOutputTokens: 4096,
          schema: translationSchema,
          prompt,
        });

        // Store via existing bulkUpsert
        await ctx.runMutation(api.contentTranslations.bulkUpsert, {
          contentType: "blogPosts",
          contentId: postId,
          locale,
          translations: [
            { field: "title", value: translated.title },
            { field: "excerpt", value: translated.excerpt },
            { field: "content", value: translated.content },
          ],
          status: "published",
          translatedBy: "auto",
        });

        results.push({ locale, status: "ok" });
        console.log(
          `[Translate] ${post.title} → ${locale}: done`
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `[Translate] ${post.title} → ${locale}: error — ${message}`
        );
        results.push({ locale, status: `error: ${message}` });
      }
    }

    return { postId, title: post.title, results };
  },
});

/**
 * Translate all published blog posts into the given locales.
 */
export const translateAllPosts = internalAction({
  args: {
    locales: v.array(v.string()),
  },
  handler: async (ctx, { locales }) => {
    // Fetch all published posts via the public list query
    const posts = await ctx.runQuery(api.blogPosts.list, {});

    const results: Array<{
      postId: string;
      title: string;
      results: Array<{ locale: string; status: string }>;
    }> = [];

    if (posts.length * locales.length > 10) throw new Error("Select individual posts: translation batch exceeds 10 calls");
    const runId = crypto.randomUUID();
    for (const post of posts) {
      const result = await ctx.runAction(
        internal.agents.translate.translatePost,
        { postId: post._id, locales, runId }
      );
      results.push(result);
    }

    console.log(
      `[Translate] Batch complete: ${results.length} posts translated`
    );
    return results;
  },
});

// ===== Admin-facing endpoints =====

/**
 * Translate a single blog post (admin UI trigger).
 */
export const triggerTranslatePost = adminAction({
  args: {
    postId: v.id("blogPosts"),
    locales: v.array(v.string()),
  },
  handler: async (ctx, { postId, locales }) => {
    await ctx.scheduler.runAfter(0, internal.agents.translate.translatePost, {
      postId,
      locales,
    });
    return { queued: true };
  },
});

/**
 * Translate all published blog posts (admin batch trigger).
 */
export const triggerTranslateAll = adminAction({
  args: {
    locales: v.array(v.string()),
  },
  handler: async (ctx, { locales }) => {
    await ctx.scheduler.runAfter(
      0,
      internal.agents.translate.translateAllPosts,
      { locales }
    );
    return { queued: true };
  },
});

// ===== Generic entity translation =====

function buildEntityPrompt(
  locale: string,
  entityConfig: EntityTranslationConfig,
  fields: Record<string, string>,
): string {
  const languageName = LOCALE_NAMES[locale] ?? locale;
  const fieldEntries = Object.entries(fields)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k.toUpperCase()}:\n${v}`)
    .join("\n\n");

  const fieldKeys = Object.keys(fields);

  return `${entityConfig.prompt}

Translate into ${languageName} (${locale}).

RULES:
- Preserve ALL markdown/HTML formatting exactly
- Do NOT translate URLs, email addresses, or code
- Do NOT translate brand names or proper nouns
- Do NOT add, remove, or reorder any content
- Use natural, fluent ${languageName} appropriate for a professional publication
- Maintain the same tone and register as the English source

${fieldEntries}

Respond ONLY with a JSON object with these exact keys: ${fieldKeys.map(k => `"${k}"`).join(", ")}. Each value must be the translated string. No markdown, no explanation — just the JSON object.`;
}

/**
 * Translate a single entity into one or more locales.
 * Generic version that works with any entity type configured in ENTITY_CONFIGS.
 */
export const translateEntity = internalAction({
  args: {
    contentType: v.string(),
    contentId: v.string(),
    runId: v.optional(v.string()),
    locales: v.array(v.string()),
  },
  handler: async (ctx, { contentType, contentId, locales, runId }) => {
    if (locales.length > 10) throw new Error("Translation batch exceeds 10 locales");
    const entityConfig = ENTITY_CONFIGS[contentType];
    if (!entityConfig) {
      throw new Error(`Unknown content type: ${contentType}. Available: ${Object.keys(ENTITY_CONFIGS).join(", ")}`);
    }

    // Fetch entity via generic internal query (no auth needed)
    const entity: any = await ctx.runQuery(
      internal.agents.translate.getDocById,
      { table: entityConfig.table, id: contentId },
    );
    if (!entity) throw new Error(`${contentType} not found: ${contentId}`);

    // Extract source fields. Arrays are flattened to dotted-path keys
    // (`features.0`, `features.1`, ...) so each element gets its own
    // contentTranslations row and the overlay helper can stitch them back.
    const sourceFields: Record<string, string> = {};
    for (const field of entityConfig.fields) {
      const value = entity[field];
      if (typeof value === "string" && value.trim()) {
        sourceFields[field] = value;
      } else if (Array.isArray(value)) {
        value.forEach((item, idx) => {
          if (typeof item === "string" && item.trim()) {
            sourceFields[`${field}.${idx}`] = item;
          }
        });
      }
    }

    if (Object.keys(sourceFields).length === 0) {
      return {
        contentId,
        contentType,
        results: locales.map((l) => ({ locale: l, status: "skipped — no translatable content" })),
      };
    }

    const fieldKeys = Object.keys(sourceFields);

    // Fetch translate agent config
    const config = await ctx.runQuery(internal.agents.config.getConfig, {
      key: "translate",
    });
    const model = await createModelFromConfig(ctx, "translate", runId ?? crypto.randomUUID(), config.provider, config.model);

    const entityLabel = entity.name || entity.title || entity.question || contentId;
    const results: Array<{ locale: string; status: string }> = [];

    for (const locale of locales) {
      if (locale === "en") continue;
      if (!LOCALE_NAMES[locale]) {
        results.push({ locale, status: "skipped — unknown locale" });
        continue;
      }

      try {
        const prompt = buildEntityPrompt(locale, entityConfig, sourceFields);

        // Use generateText + JSON parse instead of generateObject
        // (works better with AI Gateway which doesn't support responseFormat)
        const { text } = await generateText({ model, prompt, maxRetries: 0, maxOutputTokens: 4096 });

        // Extract JSON from response (handle markdown code fences)
        const jsonStr = text.replace(/```(?:json)?\n?/g, "").trim();
        const translated = JSON.parse(jsonStr);

        // Validate all expected fields are present
        const translations: Array<{ field: string; value: string }> = [];
        for (const field of fieldKeys) {
          if (typeof translated[field] === "string" && translated[field].trim()) {
            translations.push({ field, value: translated[field] });
          }
        }

        if (translations.length === 0) {
          throw new Error("No valid translations in response");
        }

        await ctx.runMutation(api.contentTranslations.bulkUpsert, {
          contentType,
          contentId,
          locale,
          translations,
          status: "published",
          translatedBy: "auto",
        });

        results.push({ locale, status: "ok" });
        console.log(`[Translate] ${contentType}/${entityLabel} → ${locale}: done (${translations.length} fields)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`[Translate] ${contentType}/${entityLabel} → ${locale}: error — ${message}`);
        results.push({ locale, status: `error: ${message}` });
      }
    }

    return { contentId, contentType, name: entityLabel, results };
  },
});

/**
 * Translate all entities of a given type into the specified locales.
 */
export const translateAllEntities = internalAction({
  args: {
    contentType: v.string(),
    locales: v.array(v.string()),
  },
  handler: async (ctx, { contentType, locales }) => {
    if (locales.length > 10) throw new Error("Translation batch exceeds 10 locales");
    const entityConfig = ENTITY_CONFIGS[contentType];
    if (!entityConfig) {
      throw new Error(`Unknown content type: ${contentType}`);
    }

    const rawResult: any = await ctx.runQuery(
      entityConfig.listApi,
      entityConfig.listArgs ?? {},
    );
    const items: any[] = entityConfig.flatten
      ? rawResult.flatMap((r: any) => r[entityConfig.flatten!] || [])
      : rawResult;

    const results: Array<any> = [];

    if (items.length * locales.length > 10) throw new Error("Select individual entities: translation batch exceeds 10 calls");
    const runId = crypto.randomUUID();
    for (const item of items) {
      const result = await ctx.runAction(
        internal.agents.translate.translateEntity,
        { contentType, contentId: item._id, locales, runId },
      );
      results.push(result);
    }

    console.log(`[Translate] Batch complete: ${results.length} ${contentType} items translated`);
    return results;
  },
});

// ===== Admin-facing generic entity endpoints =====

/**
 * Translate a single entity (admin/CLI trigger).
 */
export const triggerTranslateEntity = adminAction({
  args: {
    contentType: v.string(),
    contentId: v.string(),
    locales: v.array(v.string()),
  },
  handler: async (ctx, { contentType, contentId, locales }) => {
    return await ctx.runAction(internal.agents.translate.translateEntity, {
      contentType,
      contentId,
      locales,
    });
  },
});

/**
 * Translate all entities of a type (admin/CLI batch trigger).
 */
export const triggerTranslateAllEntities = adminAction({
  args: {
    contentType: v.string(),
    locales: v.array(v.string()),
  },
  handler: async (ctx, { contentType, locales }) => {
    return await ctx.runAction(internal.agents.translate.translateAllEntities, {
      contentType,
      locales,
    });
  },
});
