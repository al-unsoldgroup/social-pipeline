/**
 * Competitor Intelligence Pipeline
 *
 * Manages the full lifecycle: R2 import → LLM tagging → clustering → gap analysis → brief generation.
 * All functions are CLI/action-driven (no admin UI).
 */

import { v } from "convex/values";
import { requireAdmin } from "../lib/adminAuth";
import { requireAdminAction } from "../lib/requireAdminAction";
import { action, mutation, query, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { tagCompetitorContent } from "../agents/competitorTagging";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { createModelFromConfig } from "../agents/config";

// ========================================
// MUTATIONS (public, called from CLI)
// ========================================

/**
 * Create a scrape job for a competitor
 */
export const createScrapeJob = mutation({
  args: {
    competitorName: v.string(),
    baseUrl: v.string(),
  },
  handler: async (ctx, { competitorName, baseUrl }) => {
    await requireAdmin(ctx);
    const now = Date.now();
    return await ctx.db.insert("competitorScrapeJobs", {
      competitorName,
      baseUrl,
      status: "pending",
      scrapedCount: 0,
      failedCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Add a single URL for a competitor
 */
export const addContent = mutation({
  args: {
    competitorName: v.string(),
    sourceUrl: v.string(),
    title: v.optional(v.string()),
    r2Key: v.optional(v.string()),
  },
  handler: async (ctx, { competitorName, sourceUrl, title, r2Key }) => {
    await requireAdmin(ctx);
    // Check if URL already exists
    const existing = await ctx.db
      .query("competitorContent")
      .withIndex("by_url", (q) => q.eq("sourceUrl", sourceUrl))
      .first();
    if (existing) return existing._id;

    const now = Date.now();
    return await ctx.db.insert("competitorContent", {
      competitorName,
      sourceUrl,
      title,
      r2Key,
      taggingStatus: "pending",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Bulk add URLs for a competitor
 */
export const batchAddUrls = mutation({
  args: {
    competitorName: v.string(),
    urls: v.array(
      v.object({
        sourceUrl: v.string(),
        title: v.optional(v.string()),
        r2Key: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, { competitorName, urls }) => {
    await requireAdmin(ctx);
    const now = Date.now();
    let added = 0;
    let skipped = 0;

    for (const { sourceUrl, title, r2Key } of urls) {
      const existing = await ctx.db
        .query("competitorContent")
        .withIndex("by_url", (q) => q.eq("sourceUrl", sourceUrl))
        .first();
      if (existing) {
        skipped++;
        continue;
      }

      await ctx.db.insert("competitorContent", {
        competitorName,
        sourceUrl,
        title,
        r2Key,
        taggingStatus: "pending",
        createdAt: now,
        updatedAt: now,
      });
      added++;
    }

    return { added, skipped };
  },
});

/**
 * Approve a content brief and send it to the article pipeline
 */
export const approveBrief = mutation({
  args: { briefId: v.id("contentBriefs") },
  handler: async (ctx, { briefId }) => {
    await requireAdmin(ctx);
    const brief = await ctx.db.get(briefId);
    if (!brief) throw new Error("Brief not found");
    if (brief.status !== "generated") {
      throw new Error(`Brief status is ${brief.status}, expected generated`);
    }

    // Create an articleWorkflows record (same pattern as contentPipeline.create)
    const now = Date.now();
    const workflowId = await ctx.db.insert("articleWorkflows", {
      topic: brief.topic,
      keywords: brief.keywords,
      targetAudience: brief.targetAudience,
      status: "research_in_progress",
      feedbackHistory: [],
      revisionCount: { research: 0, outline: 0, draft: 0 },
      createdAt: now,
      updatedAt: now,
    });

    // Link brief to workflow
    await ctx.db.patch(briefId, {
      status: "sent_to_pipeline",
      articleWorkflowId: workflowId,
      updatedAt: now,
    });

    return workflowId;
  },
});

/**
 * Reject a content brief
 */
export const rejectBrief = mutation({
  args: {
    briefId: v.id("contentBriefs"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { briefId }) => {
    await requireAdmin(ctx);
    const brief = await ctx.db.get(briefId);
    if (!brief) throw new Error("Brief not found");

    await ctx.db.patch(briefId, {
      status: "rejected",
      updatedAt: Date.now(),
    });
  },
});

// ========================================
// QUERIES
// ========================================

/**
 * List competitor content with optional filters
 */
export const list = query({
  args: {
    competitorName: v.optional(v.string()),
    taggingStatus: v.optional(v.string()),
    topicCluster: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { competitorName, taggingStatus, topicCluster, limit }) => {
    const maxResults = limit ?? 50;

    if (competitorName && taggingStatus) {
      return await ctx.db
        .query("competitorContent")
        .withIndex("by_competitor", (q) =>
          q
            .eq("competitorName", competitorName)
            .eq("taggingStatus", taggingStatus as "pending" | "scraped" | "tagged" | "failed")
        )
        .take(maxResults);
    }

    if (topicCluster) {
      return await ctx.db
        .query("competitorContent")
        .withIndex("by_cluster", (q) => q.eq("topicCluster", topicCluster))
        .take(maxResults);
    }

    if (competitorName) {
      return await ctx.db
        .query("competitorContent")
        .withIndex("by_competitor", (q) => q.eq("competitorName", competitorName))
        .take(maxResults);
    }

    if (taggingStatus) {
      return await ctx.db
        .query("competitorContent")
        .withIndex("by_status", (q) =>
          q.eq("taggingStatus", taggingStatus as "pending" | "scraped" | "tagged" | "failed")
        )
        .take(maxResults);
    }

    return await ctx.db.query("competitorContent").take(maxResults);
  },
});

/**
 * Get counts by status for each competitor
 */
export const getStats = query({
  args: {
    competitorName: v.optional(v.string()),
  },
  handler: async (ctx, { competitorName }) => {
    const competitors = competitorName
      ? [competitorName]
      : ["Squaremouth", "InsureMyTrip", "TravelInsurance.com", "AARDY", "World Nomads"];
    const statuses = ["pending", "scraped", "queued", "tagged", "failed"] as const;
    const stats: Record<string, Record<string, number>> = {};

    for (const name of competitors) {
      stats[name] = { pending: 0, scraped: 0, tagged: 0, failed: 0, total: 0 };
      for (const status of statuses) {
        // Take small batches to stay under byte limits
        const batch = await ctx.db
          .query("competitorContent")
          .withIndex("by_competitor", (q) =>
            q.eq("competitorName", name).eq("taggingStatus", status)
          )
          .take(10);
        // If we got 10, there may be more — take another batch to estimate
        let count = batch.length;
        if (count === 10) {
          const more = await ctx.db
            .query("competitorContent")
            .withIndex("by_competitor", (q) =>
              q.eq("competitorName", name).eq("taggingStatus", status)
            )
            .take(200);
          count = more.length;
        }
        stats[name][status] = count;
        stats[name].total += count;
      }
    }

    return stats;
  },
});

/**
 * Cluster matrix: topics × competitors
 */
/**
 * Lightweight tagged records for a single competitor — tags only.
 */
export const getTaggedLightweight = internalQuery({
  args: { competitorName: v.string() },
  handler: async (ctx, { competitorName }) => {
    const records = await ctx.db
      .query("competitorContent")
      .withIndex("by_competitor", (q) =>
        q.eq("competitorName", competitorName).eq("taggingStatus", "tagged")
      )
      .collect();

    return records.map((r) => ({
      competitorName: r.competitorName,
      topicTag: r.topicTag,
      topicCluster: r.topicCluster,
      contentAngle: r.contentAngle,
      qualityScore: r.qualityScore,
      searchKeywords: r.searchKeywords,
    }));
  },
});

export const getBlogPostTitles = internalQuery({
  args: {},
  handler: async (ctx) => {
    const posts = await ctx.db.query("blogPosts").collect();
    return posts.map((p) => ({ title: p.title, category: p.category }));
  },
});

/**
 * Get tagged records for a single competitor (lightweight projection).
 * Used by getClusterMatrix action to stay under 16MB per query.
 */
export const getTaggedByCompetitor = query({
  args: { competitorName: v.string() },
  handler: async (ctx, { competitorName }) => {
    const records = await ctx.db
      .query("competitorContent")
      .withIndex("by_competitor", (q) =>
        q.eq("competitorName", competitorName).eq("taggingStatus", "tagged")
      )
      .collect();

    return records.map((r) => ({
      topicCluster: r.topicCluster,
      contentAngle: r.contentAngle,
      qualityScore: r.qualityScore,
    }));
  },
});

/**
 * Cluster matrix: topics × competitors. Uses action to query per-competitor
 * (each runQuery has its own 16MB byte budget).
 */
export const getClusterMatrix = action({
  args: {},
  handler: async (ctx) => {
    await requireAdminAction(ctx);
    const competitors = ["Squaremouth", "InsureMyTrip", "TravelInsurance.com", "AARDY", "World Nomads"];
    const matrix: Record<
      string,
      Record<string, { pageCount: number; avgQuality: number; angles: string[] }>
    > = {};

    for (const comp of competitors) {
      const records: Array<{ topicCluster?: string; contentAngle?: string; qualityScore?: number }> =
        await ctx.runQuery(internal.admin.competitorIntel.getTaggedByCompetitor, {
          competitorName: comp,
        });

      for (const record of records) {
        const cluster = record.topicCluster || "uncategorized";
        if (!matrix[cluster]) matrix[cluster] = {};
        if (!matrix[cluster][comp]) {
          matrix[cluster][comp] = { pageCount: 0, avgQuality: 0, angles: [] };
        }

        matrix[cluster][comp].pageCount++;
        const prev = matrix[cluster][comp];
        prev.avgQuality =
          (prev.avgQuality * (prev.pageCount - 1) + (record.qualityScore || 0)) /
          prev.pageCount;

        if (record.contentAngle && !prev.angles.includes(record.contentAngle)) {
          prev.angles.push(record.contentAngle);
        }
      }
    }

    return Object.entries(matrix)
      .map(([cluster, comps]) => ({
        cluster,
        competitors: Object.entries(comps).map(([name, data]) => ({
          name,
          ...data,
          avgQuality: Math.round(data.avgQuality * 10) / 10,
        })),
        totalPages: Object.values(comps).reduce((sum, c) => sum + c.pageCount, 0),
      }))
      .sort((a, b) => b.totalPages - a.totalPages);
  },
});

/**
 * Topic depth: all competitor pages for a given cluster
 */
export const getTopicDepth = query({
  args: { topicCluster: v.string() },
  handler: async (ctx, { topicCluster }) => {
    const pages = await ctx.db
      .query("competitorContent")
      .withIndex("by_cluster", (q) => q.eq("topicCluster", topicCluster))
      .collect();

    return pages
      .map((p) => ({
        _id: p._id,
        competitorName: p.competitorName,
        sourceUrl: p.sourceUrl,
        title: p.title,
        topicTag: p.topicTag,
        contentAngle: p.contentAngle,
        qualityScore: p.qualityScore,
        summary: p.summary,
        searchKeywords: p.searchKeywords,
      }))
      .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
  },
});

/**
 * Gap analysis: topics competitors cover that we don't have blog posts for
 */
export const getGapAnalysis = action({
  args: {},
  handler: async (ctx) => {
    await requireAdminAction(ctx);
    // Query per-competitor to stay under 16MB (each runQuery has own budget)
    const competitors = ["Squaremouth", "InsureMyTrip", "TravelInsurance.com", "AARDY", "World Nomads"];
    const tagged: Array<{ competitorName: string; topicTag?: string; searchKeywords?: string[]; qualityScore?: number }> = [];
    for (const comp of competitors) {
      const records: Array<{ topicCluster?: string; contentAngle?: string; qualityScore?: number; topicTag?: string; searchKeywords?: string[]; competitorName: string }> =
        await ctx.runQuery(internal.admin.competitorIntel.getTaggedLightweight, {
          competitorName: comp,
        });
      tagged.push(...records);
    }

    // Get all our blog posts
    const blogPosts: Array<{ title?: string; category?: string }> =
      await ctx.runQuery(internal.admin.competitorIntel.getBlogPostTitles, {});
    const ourTopics = new Set<string>();
    const ourKeywords = new Set<string>();

    for (const post of blogPosts) {
      if (post.title) ourTopics.add(post.title.toLowerCase());
      if (post.category) ourTopics.add(post.category.toLowerCase());
      // Check tags if they exist
      if ((post as Record<string, unknown>).tags) {
        for (const tag of (post as Record<string, unknown>).tags as string[]) {
          ourKeywords.add(tag.toLowerCase());
        }
      }
    }

    // Aggregate competitor topics
    const topicMap: Record<
      string,
      { competitors: Set<string>; keywords: Set<string>; pageCount: number; avgQuality: number }
    > = {};

    for (const record of tagged) {
      const topic = record.topicTag || "unknown";
      if (!topicMap[topic]) {
        topicMap[topic] = { competitors: new Set(), keywords: new Set(), pageCount: 0, avgQuality: 0 };
      }
      topicMap[topic].competitors.add(record.competitorName);
      topicMap[topic].pageCount++;
      topicMap[topic].avgQuality =
        (topicMap[topic].avgQuality * (topicMap[topic].pageCount - 1) +
          (record.qualityScore || 0)) /
        topicMap[topic].pageCount;

      for (const kw of record.searchKeywords || []) {
        topicMap[topic].keywords.add(kw.toLowerCase());
      }
    }

    // Determine our coverage level
    const gaps = Object.entries(topicMap).map(([topic, data]) => {
      const topicLower = topic.toLowerCase();
      let ourCoverage: "none" | "weak" | "strong" = "none";

      if (ourTopics.has(topicLower)) {
        ourCoverage = "strong";
      } else {
        // Check if any of our content touches this topic
        for (const kw of data.keywords) {
          if (ourKeywords.has(kw)) {
            ourCoverage = "weak";
            break;
          }
        }
      }

      const competitorCount = data.competitors.size;
      let opportunity: "high" | "medium" | "low" = "low";
      if (ourCoverage === "none" && competitorCount >= 3) opportunity = "high";
      else if (ourCoverage === "none" && competitorCount >= 1) opportunity = "medium";
      else if (ourCoverage === "weak" && competitorCount >= 2) opportunity = "medium";

      return {
        topic,
        keywords: [...data.keywords].slice(0, 10),
        competitorsCovering: [...data.competitors],
        competitorCount,
        pageCount: data.pageCount,
        avgQuality: Math.round(data.avgQuality * 10) / 10,
        ourCoverage,
        opportunity,
      };
    });

    return gaps
      .filter((g) => g.opportunity !== "low")
      .sort((a, b) => {
        const oppOrder = { high: 0, medium: 1, low: 2 };
        return oppOrder[a.opportunity] - oppOrder[b.opportunity] || b.pageCount - a.pageCount;
      });
  },
});

/**
 * List content briefs with optional status filter
 */
export const listBriefs = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, { status }) => {
    if (status) {
      return await ctx.db
        .query("contentBriefs")
        .withIndex("by_status", (q) =>
          q.eq("status", status as "generated" | "approved" | "rejected" | "sent_to_pipeline")
        )
        .collect();
    }
    return await ctx.db.query("contentBriefs").collect();
  },
});

// ========================================
// INTERNAL MUTATIONS
// ========================================

export const updateContentRecord = internalMutation({
  args: {
    id: v.id("competitorContent"),
    updates: v.any(),
  },
  handler: async (ctx, { id, updates }) => {
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

export const getRecordStatus = internalQuery({
  args: { id: v.id("competitorContent") },
  handler: async (ctx, { id }) => {
    const record = await ctx.db.get(id);
    return record?.taggingStatus ?? null;
  },
});

export const updateScrapeJob = internalMutation({
  args: {
    id: v.id("competitorScrapeJobs"),
    updates: v.any(),
  },
  handler: async (ctx, { id, updates }) => {
    await ctx.db.patch(id, { ...updates, updatedAt: Date.now() });
  },
});

export const insertBrief = internalMutation({
  args: {
    title: v.string(),
    topic: v.string(),
    keywords: v.array(v.string()),
    targetAudience: v.string(),
    competitorGap: v.string(),
    suggestedAngle: v.string(),
    competitorCoverage: v.array(
      v.object({
        competitorName: v.string(),
        url: v.string(),
        angle: v.string(),
        qualityScore: v.number(),
      })
    ),
    briefContent: v.string(),
    estimatedWordCount: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("contentBriefs", {
      ...args,
      status: "generated",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Kick off the import → tag → brief pipeline for a competitor.
 * Schedules importScrapedContent which self-queues through all pages,
 * then tagNextBatch auto-queues until all content is tagged.
 *
 * Usage: pnpx convex run --prod admin/competitorIntel:kickoff '{"competitorName":"Squaremouth","domain":"squaremouth.com"}'
 */
export const kickoff = mutation({
  args: {
    competitorName: v.optional(v.string()),
    domain: v.optional(v.string()),
    step: v.union(v.literal("import"), v.literal("tag"), v.literal("briefs")),
    topicCluster: v.optional(v.string()),
    count: v.optional(v.number()),
  },
  handler: async (ctx, { competitorName, domain, step, topicCluster, count }) => {
    await requireAdmin(ctx);
    if (step === "import") {
      await ctx.scheduler.runAfter(0, internal.admin.competitorIntel.importScrapedContent, {
        competitorName: competitorName || "",
        domain: domain || "",
      });
      return { scheduled: "importScrapedContent", competitorName, domain };
    }

    if (step === "tag") {
      await ctx.scheduler.runAfter(0, internal.admin.competitorIntel.tagNextBatch, {});
      return { scheduled: "tagNextBatch" };
    }

    if (step === "briefs") {
      if (!topicCluster) throw new Error("topicCluster required for briefs step");
      await ctx.scheduler.runAfter(0, internal.admin.competitorIntel.generateBriefs, {
        topicCluster,
        count,
      });
      return { scheduled: "generateBriefs", topicCluster };
    }
  },
});

/**
 * Debug: tag a single record and return the full result or error.
 * Usage: pnpx convex run admin/competitorIntel:tagOne '{}'
 */
export const tagOne = action({
  args: {},
  handler: async (ctx) => {
    await requireAdminAction(ctx);
    const config: { provider: string; model: string } = await ctx.runQuery(
      internal.agents.config.getConfig,
      { key: "competitor-tagger" }
    );

    const untagged: Array<{
      _id: any;
      competitorName: string;
      sourceUrl: string;
      title: string | undefined;
      r2Key: string | undefined;
    }> = await ctx.runQuery(internal.admin.competitorIntel.getUntagged, {
      limit: 1,
    });

    if (untagged.length === 0) return { status: "no_untagged" };

    const record = untagged[0];
    if (!record.r2Key) return { status: "no_content", url: record.sourceUrl };

    // Fetch content from R2 via admin API
    const siteUrl = process.env.SITE_URL;
    const adminToken = process.env.ADMIN_API_TOKEN;
    if (!siteUrl || !adminToken) throw new Error("SITE_URL and ADMIN_API_TOKEN must be set");

    const r2Res = await fetch(
      `${siteUrl}/api/admin/competitor-intel/read?key=${encodeURIComponent(record.r2Key)}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    if (!r2Res.ok) return { status: "r2_fetch_failed", url: record.sourceUrl };
    const { content: markdown } = (await r2Res.json()) as { content: string };

    try {
      const tags = await tagCompetitorContent(
        ctx, crypto.randomUUID(),
        config.provider as "google" | "openrouter" | "workers-ai",
        config.model,
        record.title || "",
        markdown,
        record.sourceUrl,
        record.competitorName
      );

      await ctx.runMutation(internal.admin.competitorIntel.updateContentRecord, {
        id: record._id,
        updates: {
          ...tags,
          taggingStatus: "tagged",
          taggedAt: Date.now(),
        },
      });

      return { status: "tagged", url: record.sourceUrl, topicTag: tags.topicTag };
    } catch (err) {
      return {
        status: "error",
        url: record.sourceUrl,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
      };
    }
  },
});

/**
 * Fan out tagging to CF Workflows via the tagger Worker.
 * Pages through untagged records, POSTs each page to the Worker which creates
 * one Workflow instance per record.
 * Usage: pnpx convex run admin/competitorIntel:enqueueForTagging '{"limit":100}'
 */
export const enqueueForTagging = action({
  args: {
    limit: v.optional(v.number()),
    minPriority: v.optional(v.number()),
  },
  handler: async (ctx, { limit: limitArg, minPriority }) => {
    await requireAdminAction(ctx);
    const PAGE_SIZE = 10;
    const maxRecords = limitArg ?? 100;
    let totalEnqueued = 0;

    throw new Error("Remote tagger is disabled: owned gateway admission is not available");
    const workerUrl = process.env.TAGGER_WORKER_URL;
    const authSecret = process.env.TAGGER_AUTH_SECRET;
    if (!workerUrl || !authSecret) {
      throw new Error("TAGGER_WORKER_URL and TAGGER_AUTH_SECRET must be set");
    }

    while (totalEnqueued < maxRecords) {
      const take = Math.min(PAGE_SIZE, maxRecords - totalEnqueued);
      const batch: Array<{
        _id: any;
        title: string | undefined;
        sourceUrl: string;
        competitorName: string;
        r2Key: string | undefined;
      }> = await ctx.runQuery(internal.admin.competitorIntel.getStage2Candidates, {
        limit: take,
        minPriority,
      });

      if (batch.length === 0) break;

      const records = batch.map((r) => ({
        recordId: r._id,
        title: r.title || "",
        r2Key: r.r2Key || "",
        sourceUrl: r.sourceUrl,
        competitorName: r.competitorName,
      }));

      // Mark records as "queued" BEFORE firing the Worker — otherwise a
      // fast workflow may call /api/tagger-update before this mutation
      // writes, and that endpoint's idempotency check ("skip if status ===
      // 'tagged'") will drop the update. Result: record stuck in queued.
      await ctx.runMutation(internal.admin.competitorIntel.markBatchStatus, {
        ids: batch.map((r) => r._id),
        status: "queued",
      });

      const res = await fetch(`${workerUrl}/tag`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authSecret}`,
        },
        body: JSON.stringify({ records }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Worker /tag failed: ${res.status} — ${body.slice(0, 200)}`);
      }

      const result = await res.json() as { created: number };
      totalEnqueued += result.created;
      console.log(`[enqueueForTagging] Page sent: ${result.created} workflows created (${totalEnqueued}/${maxRecords})`);
    }

    return { enqueued: totalEnqueued };
  },
});

export const markBatchStatus = internalMutation({
  args: {
    ids: v.array(v.id("competitorContent")),
    status: v.string(),
  },
  handler: async (ctx, { ids, status }) => {
    const now = Date.now();
    for (const id of ids) {
      await ctx.db.patch(id, {
        taggingStatus: status as "queued" | "scraped" | "tagged" | "failed" | "skipped",
        updatedAt: now,
      });
    }
  },
});

// ========================================
// DEV → PROD SYNC (triage + deep-tag fields)
// ========================================

/**
 * Paginated export of every record for cross-env sync. Includes triage fields
 * and the "skipped" taggingStatus that importTaggedMetadata didn't cover.
 * Usage: pnpx convex run admin/competitorIntel:exportAllForSync '{"cursor":0}'
 */
export const exportAllForSync = query({
  args: { cursor: v.optional(v.number()), pageSize: v.optional(v.number()) },
  handler: async (ctx, { cursor, pageSize }) => {
    const size = pageSize ?? 500;
    const all = await ctx.db.query("competitorContent").collect();
    const sorted = all.sort((a, b) => a.createdAt - b.createdAt);
    const startIdx = cursor ?? 0;
    const page = sorted.slice(startIdx, startIdx + size);
    return {
      records: page.map((d) => ({
        sourceUrl: d.sourceUrl,
        competitorName: d.competitorName,
        r2Key: d.r2Key,
        title: d.title,
        contentType: d.contentType,
        wordCount: d.wordCount,
        scrapedAt: d.scrapedAt,
        topicTag: d.topicTag,
        searchKeywords: d.searchKeywords,
        contentAngle: d.contentAngle,
        topicCluster: d.topicCluster,
        destinations: d.destinations,
        contentTopics: d.contentTopics,
        qualityScore: d.qualityScore,
        summary: d.summary,
        triagePriority: d.triagePriority,
        triageCluster: d.triageCluster,
        triagedAt: d.triagedAt,
        skipReason: d.skipReason,
        taggingStatus: d.taggingStatus,
        taggedAt: d.taggedAt,
      })),
      nextCursor: startIdx + size < sorted.length ? startIdx + size : null,
      total: sorted.length,
    };
  },
});

/**
 * Upserts records by sourceUrl, patching all tag + triage fields. Safe to run
 * repeatedly. Pairs with exportAllForSync.
 */
export const importAllForSync = mutation({
  args: {
    batch: v.array(
      v.object({
        sourceUrl: v.string(),
        competitorName: v.string(),
        r2Key: v.optional(v.string()),
        title: v.optional(v.string()),
        contentType: v.optional(v.string()),
        wordCount: v.optional(v.number()),
        scrapedAt: v.optional(v.number()),
        topicTag: v.optional(v.string()),
        searchKeywords: v.optional(v.array(v.string())),
        contentAngle: v.optional(v.string()),
        topicCluster: v.optional(v.string()),
        destinations: v.optional(v.array(v.string())),
        contentTopics: v.optional(v.array(v.string())),
        qualityScore: v.optional(v.number()),
        summary: v.optional(v.string()),
        triagePriority: v.optional(v.number()),
        triageCluster: v.optional(v.string()),
        triagedAt: v.optional(v.number()),
        skipReason: v.optional(v.string()),
        taggingStatus: v.union(
          v.literal("pending"),
          v.literal("scraped"),
          v.literal("queued"),
          v.literal("tagged"),
          v.literal("failed"),
          v.literal("skipped"),
        ),
        taggedAt: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, { batch }) => {
    await requireAdmin(ctx);
    let updated = 0;
    let created = 0;
    const now = Date.now();

    for (const record of batch) {
      const existing = await ctx.db
        .query("competitorContent")
        .withIndex("by_url", (q) => q.eq("sourceUrl", record.sourceUrl))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, { ...record, updatedAt: now });
        updated++;
      } else {
        await ctx.db.insert("competitorContent", {
          ...record,
          createdAt: now,
          updatedAt: now,
        });
        created++;
      }
    }

    return { updated, created, total: batch.length };
  },
});

/**
 * Reset "queued" records back to "scraped". Useful after a Worker deploy when
 * previously-enqueued records failed at the workflow level and are stuck.
 * Usage: pnpx convex run admin/competitorIntel:resetQueued '{}'
 */
export const resetQueued = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const queued = await ctx.db
      .query("competitorContent")
      .withIndex("by_status", (q) => q.eq("taggingStatus", "queued"))
      .take(1000);
    const now = Date.now();
    for (const r of queued) {
      await ctx.db.patch(r._id, {
        taggingStatus: "scraped",
        taggingError: undefined,
        updatedAt: now,
      });
    }
    return { reset: queued.length };
  },
});

/**
 * Reset failed tagging records back to "scraped" so tagNextBatch retries them.
 * Usage: pnpx convex run --prod admin/competitorIntel:retryFailed '{}'
 */
export const retryFailed = mutation({
  args: {
    competitorName: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { competitorName, batchSize: batchSizeArg }) => {
    await requireAdmin(ctx);
    const limit = batchSizeArg ?? 100;

    // Query per competitor to use the index (avoids full table scan)
    const competitors = competitorName
      ? [competitorName]
      : ["Squaremouth", "InsureMyTrip", "TravelInsurance.com", "AARDY", "World Nomads"];

    const failed: Array<{ _id: any; taggingError?: string }> = [];
    for (const name of competitors) {
      if (failed.length >= limit) break;
      const batch = await ctx.db
        .query("competitorContent")
        .withIndex("by_competitor", (q) =>
          q.eq("competitorName", name).eq("taggingStatus", "failed")
        )
        .take(Math.min(20, limit - failed.length));
      failed.push(...batch);
    }

    let reset = 0;
    const now = Date.now();
    for (const record of failed) {
      // Only retry if it has content and was a tagging error (not import failure)
      if (record.taggingError) {
        await ctx.db.patch(record._id, {
          taggingStatus: "scraped",
          taggingError: undefined,
          updatedAt: now,
        });
        reset++;
      }
    }
    return { reset, remaining: failed.length - reset };
  },
});

// ========================================
// INTERNAL ACTIONS (R2 Import)
// ========================================

/**
 * Import sitemap from R2 and create competitorContent records
 */
export const importSitemap = internalAction({
  args: {
    competitorName: v.string(),
    domain: v.string(),
  },
  handler: async (ctx, { competitorName, domain }) => {
    const siteUrl = process.env.SITE_URL;
    const adminToken = process.env.ADMIN_API_TOKEN;
    if (!siteUrl || !adminToken) {
      throw new Error("SITE_URL and ADMIN_API_TOKEN must be set");
    }

    // Fetch sitemap from Worker endpoint
    const res = await fetch(
      `${siteUrl}/api/admin/competitor-intel/sitemap?domain=${encodeURIComponent(domain)}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to fetch sitemap: ${res.status} ${body}`);
    }

    const data = await res.json() as { sitemap: { urls?: string[]; pages?: Array<{ url: string; title?: string }> } };
    const sitemap = data.sitemap;

    // Handle different sitemap formats
    let urls: Array<{ sourceUrl: string; title?: string }> = [];
    if (Array.isArray(sitemap.urls)) {
      urls = sitemap.urls.map((u: string) => ({ sourceUrl: u }));
    } else if (Array.isArray(sitemap.pages)) {
      urls = sitemap.pages.map((p: { url: string; title?: string }) => ({
        sourceUrl: p.url,
        title: p.title,
      }));
    } else if (Array.isArray(sitemap)) {
      urls = (sitemap as Array<string | { url: string; title?: string }>).map(
        (item) =>
          typeof item === "string"
            ? { sourceUrl: item }
            : { sourceUrl: item.url, title: item.title }
      );
    }

    if (urls.length === 0) {
      throw new Error(`No URLs found in sitemap for ${domain}`);
    }

    // Batch insert (Convex mutations handle dedup)
    const batchSize = 100;
    let totalAdded = 0;
    let totalSkipped = 0;

    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      const result: { added: number; skipped: number } = await ctx.runMutation(
        internal.admin.competitorIntel.batchAddUrls,
        {
          competitorName,
          urls: batch,
        }
      );
      totalAdded += result.added;
      totalSkipped += result.skipped;
    }

    console.log(
      `[importSitemap] ${competitorName}: ${totalAdded} added, ${totalSkipped} skipped from ${urls.length} URLs`
    );

    return { added: totalAdded, skipped: totalSkipped, total: urls.length };
  },
});

/**
 * Import already-scraped markdown files from R2 into competitorContent records.
 * Self-schedules to process in batches.
 */
export const importScrapedContent = internalAction({
  args: {
    competitorName: v.string(),
    domain: v.string(),
    batchSize: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { competitorName, domain, batchSize: batchSizeArg, cursor }) => {
    const batchSize = batchSizeArg ?? 20;
    const siteUrl = process.env.SITE_URL;
    const adminToken = process.env.ADMIN_API_TOKEN;
    if (!siteUrl || !adminToken) {
      throw new Error("SITE_URL and ADMIN_API_TOKEN must be set");
    }

    // List R2 keys for this competitor's content
    // Content may be at competitor-intel/{domain}/content/ or competitor-intel/{domain}/{date}/content/
    // List all keys under the domain prefix and filter for .md in content dirs
    const prefix = `competitor-intel/${domain}/`;
    const listRes = await fetch(
      `${siteUrl}/api/admin/competitor-intel/list?prefix=${encodeURIComponent(prefix)}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    if (!listRes.ok) {
      throw new Error(`Failed to list R2 keys: ${listRes.status}`);
    }

    const { keys } = (await listRes.json()) as { keys: string[] };

    // Filter to .md files in content directories (any depth)
    const mdKeys = keys
      .filter((k: string) => k.endsWith(".md") && k.includes("/content/"))
      .sort();

    const startIdx = cursor
      ? mdKeys.findIndex((k: string) => k > cursor)
      : 0;

    if (startIdx === -1 || startIdx >= mdKeys.length) {
      console.log(`[importScrapedContent] ${competitorName}: all content imported`);
      return { imported: 0, remaining: 0 };
    }

    const batch = mdKeys.slice(startIdx, startIdx + batchSize);
    let imported = 0;

    for (const key of batch) {
      // Read content from R2
      const readRes = await fetch(
        `${siteUrl}/api/admin/competitor-intel/read?key=${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );

      if (!readRes.ok) {
        console.error(`[importScrapedContent] Failed to read ${key}: ${readRes.status}`);
        continue;
      }

      const { content } = (await readRes.json()) as { content: string };

      // Extract title from first markdown heading
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch?.[1] || undefined;

      // Try to derive sourceUrl from filename (pattern: slugified-url.md)
      const filename = key.split("/").pop()?.replace(".md", "") || "";

      // Find existing record by r2Key or create new one
      // We use the add mutation which deduplicates by sourceUrl
      const sourceUrl = `https://${domain}/${filename.replace(/-/g, "/")}`;

      await ctx.runMutation(internal.admin.competitorIntel.updateOrCreateFromR2, {
        competitorName,
        sourceUrl,
        r2Key: key,
        title,
        wordCount: content.split(/\s+/).length,
      });

      imported++;
    }

    const remaining = mdKeys.length - startIdx - batch.length;
    console.log(
      `[importScrapedContent] ${competitorName}: imported ${imported}, ${remaining} remaining`
    );

    // Self-schedule next batch if there's more
    if (remaining > 0) {
      const lastKey = batch[batch.length - 1];
      await ctx.scheduler.runAfter(0, internal.admin.competitorIntel.importScrapedContent, {
        competitorName,
        domain,
        batchSize: batchSizeArg,
        cursor: lastKey,
      });
    }

    return { imported, remaining };
  },
});

/**
 * Update or create a competitorContent record from R2 import
 */
export const updateOrCreateFromR2 = internalMutation({
  args: {
    competitorName: v.string(),
    sourceUrl: v.string(),
    r2Key: v.string(),
    title: v.optional(v.string()),
    wordCount: v.number(),
  },
  handler: async (ctx, { competitorName, sourceUrl, r2Key, title, wordCount }) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("competitorContent")
      .withIndex("by_url", (q) => q.eq("sourceUrl", sourceUrl))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        r2Key,
        title: title || existing.title,
        wordCount,
        taggingStatus: "scraped",
        scrapedAt: now,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("competitorContent", {
      competitorName,
      sourceUrl,
      r2Key,
      title,
      wordCount,
      taggingStatus: "scraped",
      scrapedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// ========================================
// INTERNAL ACTIONS (Firecrawl scraping)
// ========================================

/**
 * Scrape next batch of pending URLs using Firecrawl
 */
export const scrapeNextBatch = internalAction({
  args: {
    competitorName: v.string(),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { competitorName, batchSize: batchSizeArg }) => {
    const batchSize = batchSizeArg ?? 5;
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY must be set");

    // Get pending records for this competitor
    const pending: Array<{ _id: any; sourceUrl: string }> = await ctx.runQuery(
      internal.admin.competitorIntel.getPending,
      { competitorName, limit: batchSize }
    );

    if (pending.length === 0) {
      console.log(`[scrapeNextBatch] ${competitorName}: no more pending URLs`);
      return { scraped: 0, failed: 0, remaining: 0 };
    }

    let scraped = 0;
    let failed = 0;

    for (const record of pending) {
      try {
        const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: record.sourceUrl,
            formats: ["markdown"],
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Firecrawl ${res.status}: ${errText.slice(0, 300)}`);
        }

        const data = (await res.json()) as {
          data?: { markdown?: string; metadata?: { title?: string } };
        };
        const markdown = data.data?.markdown || "";
        const title = data.data?.metadata?.title;

        await ctx.runMutation(internal.admin.competitorIntel.updateContentRecord, {
          id: record._id,
          updates: {
            title,
            wordCount: markdown.split(/\s+/).length,
            taggingStatus: "scraped",
            scrapedAt: Date.now(),
          },
        });
        scraped++;
      } catch (err) {
        console.error(`[scrapeNextBatch] Failed ${record.sourceUrl}:`, err);
        await ctx.runMutation(internal.admin.competitorIntel.updateContentRecord, {
          id: record._id,
          updates: {
            taggingStatus: "failed",
            taggingError: err instanceof Error ? err.message : String(err),
          },
        });
        failed++;
      }
    }

    // Check remaining and self-schedule
    const remainingCount: number = await ctx.runQuery(
      internal.admin.competitorIntel.countByStatus,
      { competitorName, status: "pending" }
    );

    if (remainingCount > 0) {
      await ctx.scheduler.runAfter(
        1000, // 1s delay to avoid rate limits
        internal.admin.competitorIntel.scrapeNextBatch,
        { competitorName, batchSize: batchSizeArg }
      );
    }

    console.log(
      `[scrapeNextBatch] ${competitorName}: scraped ${scraped}, failed ${failed}, ${remainingCount} remaining`
    );
    return { scraped, failed, remaining: remainingCount };
  },
});

// ========================================
// INTERNAL ACTIONS (LLM Tagging)
// ========================================

/**
 * Tag next batch of scraped (untagged) content
 */
export const tagNextBatch = internalAction({
  args: {
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { batchSize: batchSizeArg }) => {
    const batchSize = batchSizeArg ?? 2;

    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new Error("Tagging batch must contain 1 to 10 records");
    // Get tagger config
    const config: { provider: string; model: string } = await ctx.runQuery(
      internal.agents.config.getConfig,
      { key: "competitor-tagger" }
    );

    // Get scraped (untagged) records
    const untagged: Array<{
      _id: any;
      competitorName: string;
      sourceUrl: string;
      title: string | undefined;
      r2Key: string | undefined;
    }> = await ctx.runQuery(internal.admin.competitorIntel.getUntagged, {
      limit: batchSize,
    });

    if (untagged.length === 0) {
      console.log("[tagNextBatch] No more untagged content");
      return { tagged: 0, failed: 0, remaining: 0 };
    }

    // Each explicit operator invocation processes one bounded batch.
    const hasMore = untagged.length >= batchSize;

    let tagged = 0;
    let failed = 0;

    // Fetch R2 content via admin API
    const siteUrl = process.env.SITE_URL;
    const adminToken = process.env.ADMIN_API_TOKEN;
    if (!siteUrl || !adminToken) throw new Error("SITE_URL and ADMIN_API_TOKEN must be set");

    // Process records in parallel for throughput
    const inferenceRunId = crypto.randomUUID();
    const results = await Promise.allSettled(
      untagged.map(async (record) => {
        if (!record.r2Key) {
          await ctx.runMutation(internal.admin.competitorIntel.updateContentRecord, {
            id: record._id,
            updates: {
              taggingStatus: "failed",
              taggingError: "No r2Key — content not in R2",
            },
          });
          return "failed" as const;
        }

        const r2Res = await fetch(
          `${siteUrl}/api/admin/competitor-intel/read?key=${encodeURIComponent(record.r2Key)}`,
          { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        if (!r2Res.ok) {
          await ctx.runMutation(internal.admin.competitorIntel.updateContentRecord, {
            id: record._id,
            updates: {
              taggingStatus: "failed",
              taggingError: `R2 fetch failed: ${r2Res.status}`,
            },
          });
          return "failed" as const;
        }
        const { content: markdown } = (await r2Res.json()) as { content: string };

        const tags = await tagCompetitorContent(
        ctx, inferenceRunId,
          config.provider as "google" | "openrouter" | "workers-ai",
          config.model,
          record.title || "",
          markdown,
          record.sourceUrl,
          record.competitorName
        );

        await ctx.runMutation(internal.admin.competitorIntel.updateContentRecord, {
          id: record._id,
          updates: {
            topicTag: tags.topicTag,
            searchKeywords: tags.searchKeywords,
            contentAngle: tags.contentAngle,
            topicCluster: tags.topicCluster,
            destinations: tags.destinations,
            contentTopics: tags.contentTopics,
            qualityScore: tags.qualityScore,
            summary: tags.summary,
            contentType: tags.contentType,
            taggingStatus: "tagged",
            taggedAt: Date.now(),
          },
        });
        return "tagged" as const;
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value === "tagged") {
        tagged++;
      } else if (result.status === "rejected") {
        failed++;
        console.error(`[tagNextBatch] Failed:`, result.reason);
        // Find the record that failed and mark it
        const idx = results.indexOf(result);
        const record = untagged[idx];
        if (record) {
          await ctx.runMutation(internal.admin.competitorIntel.updateContentRecord, {
            id: record._id,
            updates: {
              taggingStatus: "failed",
              taggingError: result.reason instanceof Error ? result.reason.message : String(result.reason),
            },
          });
        }
      } else {
        failed++;
      }
    }

    console.log(
      `[tagNextBatch] tagged ${tagged}, failed ${failed}, hasMore=${hasMore}`
    );
    return { tagged, failed, hasMore };
  },
});

// ========================================
// INTERNAL ACTIONS (Brief Generation)
// ========================================

/**
 * Generate content briefs from gap analysis for a topic cluster
 */
export const generateBriefs = internalAction({
  args: {
    topicCluster: v.string(),
    count: v.optional(v.number()),
  },
  handler: async (ctx, { topicCluster, count: countArg }) => {
    const count = countArg ?? 3;
    if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error("Brief count must be 1 to 3");

    // Get brief-generator config
    const config: { provider: string; model: string } = await ctx.runQuery(
      internal.agents.config.getConfig,
      { key: "brief-generator" }
    );

    // Get all tagged competitor content for this cluster
    const clusterContent: Array<{
      competitorName: string;
      sourceUrl: string;
      title: string | undefined;
      contentAngle: string | undefined;
      qualityScore: number | undefined;
      summary: string | undefined;
      searchKeywords: string[] | undefined;
    }> = await ctx.runQuery(internal.admin.competitorIntel.getTopicDepth, {
      topicCluster,
    });

    if (clusterContent.length === 0) {
      throw new Error(`No tagged content found for cluster: ${topicCluster}`);
    }

    // Build competitor summary for the LLM
    const competitorSummary = clusterContent
      .slice(0, 30) // Limit to top 30 pages to stay within token budget
      .map(
        (c) =>
          `- ${c.competitorName} | ${c.title || "Untitled"} | Angle: ${c.contentAngle || "unknown"} | Quality: ${c.qualityScore || "?"}/10 | Keywords: ${(c.searchKeywords || []).join(", ")}\n  Summary: ${c.summary || "No summary"}`
      )
      .join("\n\n");

    const model = await createModelFromConfig(ctx, "brief-generator", crypto.randomUUID(), config.provider, config.model);

    const briefSchema = z.object({
      briefs: z.array(
        z.object({
          title: z.string().describe("SEO-optimized article title"),
          topic: z.string().describe("Core topic in 3-5 words"),
          keywords: z.array(z.string()).describe("5-10 target keywords"),
          targetAudience: z
            .string()
            .describe("Specific target reader persona"),
          competitorGap: z
            .string()
            .describe(
              "What competitors miss that we'll uniquely cover"
            ),
          suggestedAngle: z
            .string()
            .describe("Our unique approach/angle for this piece"),
          briefContent: z
            .string()
            .describe(
              "Detailed brief for the writer: key points to cover, structure suggestions, data to include"
            ),
          estimatedWordCount: z
            .number()
            .describe("Recommended word count"),
        })
      ),
    });

    const systemPrompt = `You are a content strategist for your content publication.

Your job is to generate original article briefs that:
1. Fill gaps in competitor coverage
2. Provide deeper, more actionable content than what exists
3. Target high-intent search keywords
4. Leverage our unique expertise in expedition-specific insurance

Our competitive advantages:
- Deep knowledge of expedition operator insurance requirements
- Real pricing data and plan comparisons
- Expertise in medical evacuation for remote destinations
- Understanding of pre-existing condition coverage for older travelers (expedition demographics skew 60+)

Generate briefs that would be genuinely useful to someone planning an expensive expedition and trying to understand their insurance options.`;

    const userPrompt = `Analyze the following competitor content for the "${topicCluster}" topic cluster and generate ${count} original article briefs that fill gaps and outperform what exists.

**Competitor Coverage (${clusterContent.length} pages):**
${competitorSummary}

Generate ${count} article briefs that:
- Target keywords competitors haven't fully captured
- Provide a unique angle competitors don't cover
- Would be genuinely useful to expedition travelers
- Are specific enough for a writer to execute without additional research planning

Respond with a JSON object containing a "briefs" array. Each brief must have: title, topic, keywords (array of 5-10 SEO target keywords), targetAudience, competitorGap, suggestedAngle, briefContent, estimatedWordCount.`;

    let object: { briefs: Array<Record<string, any>> };
    try {
      const result = await generateObject({
        model, maxRetries: 0, maxOutputTokens: 4096,
        schema: briefSchema,
        system: systemPrompt,
        prompt: userPrompt,
      });
      object = result.object;
    } catch (error) {
      throw error;
    }

    // Save briefs to database
    const briefIds: string[] = [];
    for (const brief of object.briefs) {
      // Build competitorCoverage from cluster content
      const coverage = clusterContent
        .filter((c) => c.qualityScore && c.qualityScore >= 5)
        .slice(0, 5)
        .map((c) => ({
          competitorName: c.competitorName,
          url: c.sourceUrl,
          angle: c.contentAngle || "unknown",
          qualityScore: c.qualityScore || 0,
        }));

      const id = await ctx.runMutation(internal.admin.competitorIntel.insertBrief, {
        ...brief,
        targetAudience: brief.targetAudience,
        competitorCoverage: coverage,
      });
      briefIds.push(id as string);
    }

    console.log(
      `[generateBriefs] Generated ${briefIds.length} briefs for cluster: ${topicCluster}`
    );
    return { generated: briefIds.length, briefIds };
  },
});

// ========================================
// INTERNAL QUERIES (helpers)
// ========================================

export const getPending = query({
  args: {
    competitorName: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, { competitorName, limit }) => {
    return await ctx.db
      .query("competitorContent")
      .withIndex("by_competitor", (q) =>
        q.eq("competitorName", competitorName).eq("taggingStatus", "pending")
      )
      .take(limit);
  },
});

export const getUntagged = query({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("competitorContent")
      .withIndex("by_status", (q) => q.eq("taggingStatus", "scraped"))
      .take(limit);
  },
});

// ==========================================
// STAGE 1 — Triage (lightweight, title+URL only)
//
// Purpose: classify each page by whether it's worth deep-tagging, before we
// burn expensive model calls on author bios and boilerplate. Reads title +
// URL + competitor only — no R2 fetch. Batches 20 pages per AI call via
// Cloudflare AI Gateway (workers-ai/@cf/meta/llama-3.1-8b-instruct-fast).
// ==========================================


const TRIAGE_SYSTEM_PROMPT = `You are a content intelligence analyst for your content publication.

Your job is to triage scraped competitor pages into priority buckets, using only the page title + URL, so we decide which pages deserve expensive deep-tagging. Be strict: author bios, login pages, sitemaps, privacy/terms, and affiliate/admin URLs should ALL be priority 1. Reserve priority 4-5 for pages that teach a reader something specific about travel-insurance coverage, destinations, or expedition/cruise requirements.`;

const triageItemSchema = z.object({
  recordId: z.string().describe("Echo the recordId from the input exactly."),
  priority: z.number().min(1).max(5).describe("1=skip, 2=weak, 3=standard, 4=valuable, 5=core expedition/polar/safari topic."),
  coarseCluster: z.string().describe("snake_case cluster: trip_cancellation | medical_evacuation | cfar | pre_existing_conditions | adventure_travel | travel_insurance_basics | insurance_comparison | cruise_insurance | destination_specific | senior_travel | claims_process | baggage_delay | travel_medical | annual_multi_trip | group_travel | current_events | provider_info | polar_insurance | safari_insurance | expedition_cruise | operator_requirements | credit_card_vs_insurance | digital_nomad | student_travel | author_profile | legal_page | other."),
  skipReason: z.string().optional().describe("Required when priority===1. Short reason, e.g. 'author bio', 'privacy policy', 'sitemap'."),
});

const triageBatchSchema = z.object({
  results: z.array(triageItemSchema),
});

/**
 * Fetch records that haven't been triaged yet.
 * - taggingStatus="scraped" AND triagePriority is undefined.
 * - Optionally also pull from taggingStatus="tagged" (re-triage the noisy 500).
 */
export const getForTriage = query({
  args: {
    limit: v.number(),
    includeTagged: v.optional(v.boolean()),
    // Optional URL substring filter — a record is eligible if its sourceUrl
    // contains at least one of these strings. Used to scope triage to
    // e.g. blog-article URL patterns per competitor.
    urlIncludesAny: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { limit, includeTagged, urlIncludesAny }) => {
    const hasFilter = !!urlIncludesAny && urlIncludesAny.length > 0;
    // Always scan the whole corpus per query call. Already-triaged records are
    // filtered in memory and otherwise occupy index slots, so a small
    // `take(limit*3)` stalls once the first window fills with triaged rows.
    // 3000 rows × ~1KB ≈ 3MB, well under Convex's 8MB query read limit.
    const scrapedOversample = 3000;
    const taggedOversample = 3000;

    const matches = (r: any) => {
      if (r.triagePriority !== undefined) return false;
      if (!hasFilter) return true;
      return urlIncludesAny!.some((p) => r.sourceUrl.includes(p));
    };

    const scraped = await ctx.db
      .query("competitorContent")
      .withIndex("by_status", (q) => q.eq("taggingStatus", "scraped"))
      .take(scrapedOversample);
    const scrapedMatches = scraped.filter(matches).slice(0, limit);

    if (!includeTagged || scrapedMatches.length >= limit) {
      return scrapedMatches;
    }

    const need = limit - scrapedMatches.length;
    const tagged = await ctx.db
      .query("competitorContent")
      .withIndex("by_status", (q) => q.eq("taggingStatus", "tagged"))
      .take(taggedOversample);
    const taggedMatches = tagged.filter(matches).slice(0, need);
    let result = [...scrapedMatches, ...taggedMatches];

    // Also sweep up records stuck in "queued" from prior tagger runs.
    if (includeTagged && result.length < limit) {
      const stillNeed = limit - result.length;
      const queued = await ctx.db
        .query("competitorContent")
        .withIndex("by_status", (q) => q.eq("taggingStatus", "queued"))
        .take(3000);
      const queuedMatches = queued.filter(matches).slice(0, stillNeed);
      result = [...result, ...queuedMatches];
    }

    return result;
  },
});

/**
 * Apply AI-returned triage results to records.
 * priority===1 records are marked taggingStatus="skipped" so they don't enter Stage 2.
 */
export const applyTriageResults = internalMutation({
  args: {
    results: v.array(
      v.object({
        recordId: v.id("competitorContent"),
        priority: v.number(),
        coarseCluster: v.string(),
        skipReason: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, { results }) => {
    const now = Date.now();
    for (const r of results) {
      const patch: Record<string, unknown> = {
        triagePriority: r.priority,
        triageCluster: r.coarseCluster,
        triagedAt: now,
        updatedAt: now,
      };
      if (r.priority === 1) {
        patch.taggingStatus = "skipped";
        if (r.skipReason) patch.skipReason = r.skipReason;
      }
      await ctx.db.patch(r.recordId, patch);
    }
    return results.length;
  },
});

/**
 * Run Stage 1 triage — paginates scraped (and optionally tagged) records,
 * batches 20/call, applies results.
 * Usage:
 *   pnpx convex run --prod admin/competitorIntel:triageNextBatch '{"limit":5}'
 *   pnpx convex run --prod admin/competitorIntel:triageNextBatch '{"limit":1125,"includeTagged":true}'
 */
// Blog-article URL patterns per competitor — used when onlyBlogs=true.
const BLOG_URL_PATTERNS = [
  "aardy.com/blog_",                     // AARDY blog (540)
  "squaremouth.com/resources_",          // Squaremouth "Best X" + destinations (132)
  "squaremouth.com/travel/advice_",      // Squaremouth editorial (2)
  "worldnomads.com/explore_",            // World Nomads destination guides (89)
  "worldnomads.com/create_",             // World Nomads editorial / photography (97)
  "travelinsurance.com/20",              // TravelInsurance.com date-prefixed blog (58)
  "insuremytrip.com/travel/advice_",     // InsureMyTrip editorial
  "insuremytrip.com/travel/insurance/faqs_", // InsureMyTrip FAQ-as-blog
];

export const triageNextBatch = action({
  args: {
    limit: v.optional(v.number()),
    includeTagged: v.optional(v.boolean()),
    // Convenience flag: scope to blog-article URL patterns (see BLOG_URL_PATTERNS).
    onlyBlogs: v.optional(v.boolean()),
    // Or pass your own URL substring filter.
    urlIncludesAny: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { limit, includeTagged, onlyBlogs, urlIncludesAny }) => {
    await requireAdminAction(ctx);
    const PAGE_SIZE = 20;
    const maxRecords = limit ?? 100;
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100) throw new Error("Triage batch must contain 1 to 100 records");
    const effectiveUrlFilter = urlIncludesAny ?? (onlyBlogs ? BLOG_URL_PATTERNS : undefined);

    const config = await ctx.runQuery(internal.agents.config.getConfig, { key: "competitor-triage" });
    const model = await createModelFromConfig(ctx, "competitor-triage", crypto.randomUUID(), config.provider, config.model);

    let totalTriaged = 0;
    let totalSkipped = 0;
    const priorityCounts: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    let batchNumber = 0;

    while (totalTriaged < maxRecords) {
      const take = Math.min(PAGE_SIZE, maxRecords - totalTriaged);
      const batch = await ctx.runQuery(internal.admin.competitorIntel.getForTriage, {
        limit: take,
        includeTagged: includeTagged ?? false,
        urlIncludesAny: effectiveUrlFilter,
      });
      if (batch.length === 0) break;
      batchNumber++;

      const pagesForPrompt = batch.map((r: any) => ({
        recordId: r._id,
        competitor: r.competitorName,
        title: (r.title || "(untitled)").slice(0, 200),
        url: r.sourceUrl,
      }));

      const userPrompt = `Triage each page. Return one JSON object with a "results" array, one entry per input page (echo recordId exactly).

Priority rubric:
- 1 = skip. Author/contributor bios, About/Privacy/Terms/Sitemap pages, 404s, login, affiliate/admin. Provide skipReason.
- 2 = weak. Generic landing, company news, vendor press releases.
- 3 = standard. Standard product pages, city/country insurance pages, brand comparisons.
- 4 = valuable. Specific coverage guides (CFAR, evacuation, pre-existing), destination deep-dives, adventure/cruise insurance.
- 5 = core. Expedition / polar / safari insurance, operator requirements, claim stories.

Pages:
${JSON.stringify(pagesForPrompt, null, 2)}`;

      // Workers AI doesn't support structured output via the openai-compatible
      // adapter. Use generateText + manual JSON parse — same fallback pattern
      // as agents/competitorTagging.ts.
      let object: z.infer<typeof triageBatchSchema>;
      try {
        const { text } = await generateText({
          model, maxRetries: 0, maxOutputTokens: 4096,
          system:
            TRIAGE_SYSTEM_PROMPT +
            '\n\nIMPORTANT: Respond with ONLY a valid JSON object of shape { "results": [ { "recordId": string, "priority": number 1-5, "coarseCluster": string, "skipReason": string } ] }. Use EXACTLY those field names. No markdown code fences, no extra text.',
          prompt: userPrompt,

        });
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error(`No JSON object in response: ${text.slice(0, 200)}`);
        }
        const raw = JSON.parse(jsonMatch[0]);
        // Tolerate field-name aliases from smaller models.
        const normalized = {
          results: (raw.results ?? raw.data ?? raw.pages ?? []).map((r: any) => ({
            recordId: String(r.recordId ?? r.record_id ?? r.id ?? ""),
            priority: Number(r.priority ?? r.priorityLevel ?? r.score ?? 0),
            coarseCluster: String(
              r.coarseCluster ??
                r.cluster ??
                r.topic_cluster ??
                r.topicCluster ??
                r.category ??
                "other"
            ),
            skipReason: r.skipReason ?? r.skip_reason ?? r.reason ?? undefined,
          })),
        };
        object = triageBatchSchema.parse(normalized);
      } catch (err) {
        console.warn(`[triageNextBatch] batch ${batchNumber} triage call failed: ${err}`);
        break;
      }

      const idToRecord = new Map(batch.map((r: any) => [String(r._id), r]));
      const validResults = object.results.filter((r) => idToRecord.has(String(r.recordId)));

      if (validResults.length === 0) {
        console.warn(`[triageNextBatch] batch ${batchNumber} returned 0 valid results, breaking`);
        break;
      }

      await ctx.runMutation(internal.admin.competitorIntel.applyTriageResults, {
        results: validResults.map((r) => ({
          recordId: r.recordId as any,
          priority: r.priority,
          coarseCluster: r.coarseCluster,
          skipReason: r.skipReason,
        })),
      });

      for (const r of validResults) {
        totalTriaged++;
        if (r.priority === 1) totalSkipped++;
        const key = String(r.priority);
        priorityCounts[key] = (priorityCounts[key] ?? 0) + 1;
      }

      console.log(
        `[triageNextBatch] batch ${batchNumber}: ${validResults.length} triaged ` +
          `(total ${totalTriaged}/${maxRecords}, skipped=${totalSkipped})`
      );
    }

    return {
      triaged: totalTriaged,
      skipped: totalSkipped,
      priorityCounts,
      batches: batchNumber,
    };
  },
});

/**
 * Distribution of triage priorities (global + per-competitor).
 */
export const triageStats = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("competitorContent").collect();
    const mkBucket = () => ({ "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, untriaged: 0 });
    const byPriority = mkBucket() as Record<string, number>;
    const byCompetitor: Record<string, Record<string, number>> = {};
    let skipped = 0;
    for (const r of all) {
      const key = r.triagePriority !== undefined ? String(r.triagePriority) : "untriaged";
      byPriority[key] = (byPriority[key] ?? 0) + 1;
      if (!byCompetitor[r.competitorName]) byCompetitor[r.competitorName] = mkBucket();
      byCompetitor[r.competitorName][key] = (byCompetitor[r.competitorName][key] ?? 0) + 1;
      if (r.taggingStatus === "skipped") skipped++;
    }
    return { total: all.length, byPriority, byCompetitor, skippedStatus: skipped };
  },
});

/**
 * Stage-2 candidates — records eligible for deep tagging, ordered by
 * triage priority (descending) so high-value pages get tagged first.
 *
 * Status gate: accepts "scraped" and "tagged". "scraped" covers fresh prod
 * records; "tagged" lets us re-tag noisy prior runs (e.g. dev's 1,620 pages
 * originally tagged with the expensive gemma-4 model). "skipped", "queued",
 * and "failed" are intentionally excluded.
 *
 * Priority gate: default minPriority=2 (don't deep-tag priority-1 junk).
 * Pass minPriority=4 to run only P4+P5.
 */
export const getStage2Candidates = query({
  args: {
    limit: v.number(),
    minPriority: v.optional(v.number()),
  },
  handler: async (ctx, { limit, minPriority }) => {
    const floor = minPriority ?? 2;
    const scraped = await ctx.db
      .query("competitorContent")
      .withIndex("by_status", (q) => q.eq("taggingStatus", "scraped"))
      .take(3000);
    const tagged = await ctx.db
      .query("competitorContent")
      .withIndex("by_status", (q) => q.eq("taggingStatus", "tagged"))
      .take(3000);

    // Skip records that have already been deep-tagged AFTER their triage pass.
    // Without this, successfully-tagged records get re-picked on every
    // enqueueForTagging run and starve never-tagged "scraped" records.
    // "scraped" is authoritative: if status is scraped, always process — any
    // stale taggedAt from a prior retagger run means the record was partially
    // processed and got reset; we still want to re-run it.
    const needsProcessing = (r: any) => {
      if ((r.triagePriority ?? 0) < floor) return false;
      if (r.taggingStatus === "scraped") return true;
      const taggedAt = r.taggedAt ?? 0;
      const triagedAt = r.triagedAt ?? 0;
      return taggedAt < triagedAt;
    };

    return [...scraped, ...tagged]
      .filter(needsProcessing)
      // Scraped first (never tagged), then tagged — break ties by priority desc.
      .sort((a, b) => {
        const aScraped = a.taggingStatus === "scraped" ? 1 : 0;
        const bScraped = b.taggingStatus === "scraped" ? 1 : 0;
        if (aScraped !== bScraped) return bScraped - aScraped;
        return (b.triagePriority ?? 0) - (a.triagePriority ?? 0);
      })
      .slice(0, limit);
  },
});

/**
 * Export tagged metadata for cross-environment sync.
 * Returns lightweight tagged records for cross-environment sync.
 */
export const exportTaggedMetadata = query({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const docs = await ctx.db
      .query("competitorContent")
      .withIndex("by_status", (q) => q.eq("taggingStatus", "tagged"))
      .take(500);

    // Filter by cursor (createdAt) for pagination if needed
    const filtered = cursor ? docs.filter((d) => d.createdAt > cursor) : docs;

    return filtered.map((d) => ({
      sourceUrl: d.sourceUrl,
      competitorName: d.competitorName,
      r2Key: d.r2Key,
      title: d.title,
      contentType: d.contentType,
      wordCount: d.wordCount,
      scrapedAt: d.scrapedAt,
      topicTag: d.topicTag,
      searchKeywords: d.searchKeywords,
      contentAngle: d.contentAngle,
      topicCluster: d.topicCluster,
      destinations: d.destinations,
      contentTopics: d.contentTopics,
      qualityScore: d.qualityScore,
      summary: d.summary,
      taggingStatus: d.taggingStatus,
      taggedAt: d.taggedAt,
    }));
  },
});

/**
 * Import tagged metadata from another environment.
 * Upserts by sourceUrl — patches existing docs or creates new ones.
 */
export const importTaggedMetadata = mutation({
  args: {
    batch: v.array(
      v.object({
        sourceUrl: v.string(),
        competitorName: v.string(),
        r2Key: v.optional(v.string()),
        title: v.optional(v.string()),
        contentType: v.optional(v.string()),
        wordCount: v.optional(v.number()),
        scrapedAt: v.optional(v.number()),
        topicTag: v.optional(v.string()),
        searchKeywords: v.optional(v.array(v.string())),
        contentAngle: v.optional(v.string()),
        topicCluster: v.optional(v.string()),
        destinations: v.optional(v.array(v.string())),
        contentTopics: v.optional(v.array(v.string())),
        qualityScore: v.optional(v.number()),
        summary: v.optional(v.string()),
        taggingStatus: v.union(
          v.literal("pending"),
          v.literal("scraped"),
          v.literal("queued"),
          v.literal("tagged"),
          v.literal("failed"),
        ),
        taggedAt: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, { batch }) => {
    await requireAdmin(ctx);
    let updated = 0;
    let created = 0;
    const now = Date.now();

    for (const record of batch) {
      const existing = await ctx.db
        .query("competitorContent")
        .withIndex("by_url", (q) => q.eq("sourceUrl", record.sourceUrl))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          ...record,
          updatedAt: now,
        });
        updated++;
      } else {
        await ctx.db.insert("competitorContent", {
          ...record,
          createdAt: now,
          updatedAt: now,
        });
        created++;
      }
    }
    return { updated, created, total: batch.length };
  },
});

export const countByStatus = query({
  args: {
    competitorName: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, { competitorName, status }) => {
    // Count via iteration to stay under byte limits
    let q;
    if (competitorName) {
      q = ctx.db
        .query("competitorContent")
        .withIndex("by_competitor", (qb) =>
          qb
            .eq("competitorName", competitorName)
            .eq("taggingStatus", status as "pending" | "scraped" | "tagged" | "failed")
        );
    } else {
      q = ctx.db
        .query("competitorContent")
        .withIndex("by_status", (qb) =>
          qb.eq("taggingStatus", status as "pending" | "scraped" | "tagged" | "failed")
        );
    }
    let count = 0;
    for await (const _doc of q) {
      count++;
    }
    return count;
  },
});
