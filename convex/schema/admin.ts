import { defineTable } from "convex/server";
import { v } from "convex/values";

export const adminTables = {
  // ===== WORKSPACES =====

  workspaces: defineTable({
    name: v.string(),
    slug: v.string(),
    ownerId: v.id("users"),
    tier: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"])
    .index("by_owner", ["ownerId"]),

  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.optional(v.id("users")),
    role: v.string(),
    inviteEmail: v.optional(v.string()),
    inviteToken: v.optional(v.string()),
    inviteExpiresAt: v.optional(v.number()),
    status: v.string(),
    invitedBy: v.optional(v.id("users")),
    joinedAt: v.optional(v.number()),
  }).index("by_workspace", ["workspaceId", "status"])
    .index("by_user", ["userId", "status"])
    .index("by_invite_token", ["inviteToken"]),

  // ===== AGENT CONFIG =====

  agentConfigs: defineTable({
    owner: v.optional(v.string()),
    maxInputChars: v.optional(v.number()),
    maxOutputTokens: v.optional(v.number()),
    maxCalls: v.optional(v.number()),
    maxConcurrency: v.optional(v.number()),
    maxCallsPerMinute: v.optional(v.number()),
    key: v.string(),
    provider: v.string(),
    model: v.string(),
    description: v.optional(v.string()),
    isActive: v.boolean(),
    // Forward-compat for multi-tenant. Undefined = default workspace.
    workspaceId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"])
    .index("by_workspace_key", ["workspaceId", "key"]),

  aiAdmission: defineTable({
    key: v.string(), minute: v.number(), count: v.number(),
    leases: v.array(v.object({ id: v.string(), expiresAt: v.number() })),
  }).index("by_key", ["key"]),
  aiRunCounts: defineTable({ runId: v.string(), key: v.string(), count: v.number() }).index("by_run", ["runId", "key"]),

  availableModels: defineTable({
    provider: v.string(),
    modelId: v.string(),
    displayName: v.string(),
    description: v.string(),
    gatewayEndpoint: v.string(),
    category: v.union(v.literal("chat"), v.literal("embedding"), v.literal("all")),
    isRecommended: v.boolean(),
    isActive: v.boolean(),
    order: v.number(),
    inputCostPerMillionTokens: v.optional(v.number()),
    outputCostPerMillionTokens: v.optional(v.number()),
    createdAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_category", ["category", "isActive"])
    .index("by_provider", ["provider"])
    .index("by_provider_and_modelId", ["provider", "modelId"]),

  // ===== SITE SETTINGS =====

  siteSettings: defineTable({
    key: v.string(),
    workspaceId: v.optional(v.id("workspaces")),
    contactEmail: v.optional(v.string()),
    // Default Cloudflare Images ID used as the placeholder hero on freshly-created
    // blog posts (key="media"). Editors swap this on the post itself before publish.
    defaultBlogHeroImageId: v.optional(v.string()),
    // Zernio social-publishing config (key="zernio")
    zernioAutoPublish: v.optional(v.boolean()),
    zernioProfilesByFormat: v.optional(v.object({
      blog_post: v.optional(v.array(v.string())),
      twitter_thread: v.optional(v.array(v.string())),
      linkedin_article: v.optional(v.array(v.string())),
      newsletter_issue: v.optional(v.array(v.string())),
    })),
    // Resend newsletter config (key="resend")
    resendAutoSend: v.optional(v.boolean()),
    resendAudienceId: v.optional(v.string()),
    resendFromAddress: v.optional(v.string()),
    resendReplyTo: v.optional(v.string()),
    // Niche profile (key="niche") — input the operator gives the generator
    nicheWebsiteUrl: v.optional(v.string()),
    nicheDescription: v.optional(v.string()),
    nicheAudience: v.optional(v.string()),
    nicheLastGeneratedAt: v.optional(v.number()),
    nicheLastSourceModel: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"])
    .index("by_workspace_key", ["workspaceId", "key"]),

  // ===== EDITORIAL RULES =====

  editorialRules: defineTable({
    category: v.union(
      v.literal("commercial"),
      v.literal("tone"),
      v.literal("legal"),
      v.literal("structure"),
    ),
    title: v.string(),
    body: v.string(),
    isActive: v.boolean(),
    order: v.number(),
    workspaceId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_active_order", ["isActive", "order"])
    .index("by_workspace_active", ["workspaceId", "isActive", "order"]),

  // ===== AGENT INSTRUCTIONS (DB-driven prompts) =====
  // One row per (stage, format) pair. `format` is undefined for the base
  // stage prompt (research/outline/draft) and set for draft format
  // adapters (twitter_thread/linkedin_article/newsletter_issue).
  // `useDefault=true` makes the runtime resolver fall back to the constants
  // in convex/agents/instructions.ts and convex/agents/formatAdapters.ts.

  agentInstructions: defineTable({
    stage: v.union(
      v.literal("research"),
      v.literal("outline"),
      v.literal("draft"),
    ),
    format: v.optional(v.union(
      v.literal("twitter_thread"),
      v.literal("linkedin_article"),
      v.literal("newsletter_issue"),
    )),
    body: v.string(),
    useDefault: v.boolean(),
    workspaceId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_stage_format", ["stage", "format"])
    .index("by_workspace_stage_format", ["workspaceId", "stage", "format"]),

  // ===== CONTENT PODS (pillar strategy) =====

  contentPods: defineTable({
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    pillarKeyword: v.string(),
    isActive: v.boolean(),
    workspaceId: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"])
    .index("by_active", ["isActive"])
    .index("by_workspace_active", ["workspaceId", "isActive"]),

  // ===== CONTENT BRIEFS (competitor gap → topic) =====

  contentBriefs: defineTable({
    topic: v.string(),
    keywords: v.array(v.string()),
    targetAudience: v.optional(v.string()),
    podId: v.optional(v.id("contentPods")),
    sourceCompetitorUrls: v.optional(v.array(v.string())),
    gapSummary: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("sent_to_pipeline"),
      v.literal("completed"),
      v.literal("rejected"),
    ),
    workflowId: v.optional(v.id("articleWorkflows")),
    isCompleted: v.optional(v.boolean()),
    workspaceId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_status", ["status"])
    .index("by_pod", ["podId", "status"])
    .index("by_workspace_status", ["workspaceId", "status"]),

  // ===== COMPETITOR INTELLIGENCE =====

  competitorContent: defineTable({
    url: v.string(),
    title: v.optional(v.string()),
    domain: v.string(),
    scrapedAt: v.optional(v.number()),
    contentHash: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    primaryTopic: v.optional(v.string()),
    keywords: v.optional(v.array(v.string())),
    wordCount: v.optional(v.number()),
    taggedAt: v.optional(v.number()),
    tagModel: v.optional(v.string()),
    briefGenerated: v.optional(v.boolean()),
    briefId: v.optional(v.id("contentBriefs")),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_domain", ["domain", "createdAt"])
    .index("by_url", ["url"])
    .index("by_tagged", ["taggedAt"])
    .index("by_brief", ["briefGenerated"]),

  competitorScrapeJobs: defineTable({
    domain: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    urlsFound: v.optional(v.number()),
    urlsProcessed: v.optional(v.number()),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_status", ["status", "createdAt"])
    .index("by_domain", ["domain", "createdAt"]),

  // ===== CONTENT CALENDAR =====

  contentCalendar: defineTable({
    title: v.string(),
    scheduledDate: v.number(),
    workflowId: v.optional(v.id("articleWorkflows")),
    blogPostId: v.optional(v.id("blogPosts")),
    podId: v.optional(v.id("contentPods")),
    status: v.union(
      v.literal("planned"),
      v.literal("in_progress"),
      v.literal("published"),
      v.literal("cancelled"),
    ),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_date", ["scheduledDate"])
    .index("by_status", ["status", "scheduledDate"]),

  // ===== MEDIA (Cloudflare Images) =====

  media: defineTable({
    cloudflareImageId: v.string(),
    filename: v.optional(v.string()),
    altText: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    uploadedBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_createdAt", ["createdAt"])
    .index("by_imageId", ["cloudflareImageId"]),

  // ===== PUSH NOTIFICATIONS =====

  pushSubscriptions: defineTable({
    endpoint: v.string(),
    keyP256dh: v.string(),
    keyAuth: v.string(),
    userId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_endpoint", ["endpoint"]),

  // ===== ADMIN NOTIFICATIONS =====

  adminNotifications: defineTable({
    title: v.string(),
    body: v.string(),
    url: v.optional(v.string()),
    tag: v.optional(v.string()),
    category: v.optional(v.string()),
    isRead: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_read_createdAt", ["isRead", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // ===== POST-DEPLOY MIGRATIONS =====

  deployMigrations: defineTable({
    name: v.string(),
    ranAt: v.number(),
    durationMs: v.number(),
    result: v.optional(v.string()),
  }).index("by_name", ["name"]),

  // ===== ACTION LOG =====

  actionLog: defineTable({
    action: v.string(),
    entityType: v.optional(v.string()),
    entityId: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"])
    .index("by_entity", ["entityType", "entityId", "createdAt"]),
};
