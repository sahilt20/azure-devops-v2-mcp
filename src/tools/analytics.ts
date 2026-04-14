// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";
import { z } from "zod";
import { logger } from "../logger.js";

const ANALYTICS_TOOLS = {
  pbi_journey: "analytics_pbi_journey",
  repo_change_summary: "analytics_repo_change_summary",
  sprint_velocity: "analytics_sprint_velocity",
  pipeline_health: "analytics_pipeline_health",
  deployment_frequency: "analytics_deployment_frequency",
};

function buildVsrmBaseUrl(orgUrl: string): string {
  if (orgUrl.includes("dev.azure.com")) {
    const orgName = orgUrl.replace(/^https:\/\/dev\.azure\.com\//, "").replace(/\/$/, "").split("/")[0];
    return `https://vsrm.dev.azure.com/${orgName}`;
  }
  return orgUrl.replace(/\/$/, "");
}

async function apiFetch(url: string, token: string, userAgent: string): Promise<any> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`,
      "Content-Type": "application/json",
      "User-Agent": userAgent,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed [${response.status}]: ${text}`);
  }
  return response.json();
}

function configureAnalyticsTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  connectionProvider: () => Promise<WebApi>,
  userAgentProvider: () => string,
  defaultProject?: string
) {
  // ─────────────────────────────────────────────────────────────────────────
  // TOOL: PBI Journey
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    ANALYTICS_TOOLS.pbi_journey,
    "Trace the full journey of a Product Backlog Item (PBI) or User Story: state transitions from revision history, linked pull requests, associated builds, and linked releases. Returns a chronological timeline summary.",
    {
      project: z.string().optional().describe("The Azure DevOps project name or ID. Falls back to the server default project if not set."),
      workItemId: z.coerce.number().min(1).describe("The ID of the work item (PBI, User Story, Bug, Task, etc.) to trace."),
      includeBuilds: z.boolean().default(true).describe("Whether to look up builds that include changes linked to this work item. Defaults to true."),
      includeReleases: z.boolean().default(true).describe("Whether to look up releases that include this work item. Defaults to true."),
    },
    async ({ project, workItemId, includeBuilds, includeReleases }) => {
      try {
        const connection = await connectionProvider();
        const resolvedProject = project ?? defaultProject;

        if (!resolvedProject) {
          return {
            content: [{ type: "text", text: "Error: project is required. Pass a project name or configure a default project at server startup." }],
            isError: true,
          };
        }

        const token = await tokenProvider();
        const orgUrl = connection.serverUrl;
        const ua = userAgentProvider();

        // 1. Fetch the work item with all relations
        const workItemApi = await connection.getWorkItemTrackingApi();
        const workItem = await workItemApi.getWorkItem(workItemId, undefined, undefined, 4 /* All expand */, resolvedProject);

        if (!workItem) {
          return { content: [{ type: "text", text: `Work item ${workItemId} not found.` }], isError: true };
        }

        const journey: any = {
          workItemId,
          title: workItem.fields?.["System.Title"],
          type: workItem.fields?.["System.WorkItemType"],
          currentState: workItem.fields?.["System.State"],
          assignedTo: workItem.fields?.["System.AssignedTo"]?.displayName ?? workItem.fields?.["System.AssignedTo"],
          areaPath: workItem.fields?.["System.AreaPath"],
          iterationPath: workItem.fields?.["System.IterationPath"],
          createdDate: workItem.fields?.["System.CreatedDate"],
          createdBy: workItem.fields?.["System.CreatedBy"]?.displayName ?? workItem.fields?.["System.CreatedBy"],
          stateTransitions: [],
          linkedPullRequests: [],
          linkedBuilds: [],
          linkedReleases: [],
          childWorkItems: [],
          relatedWorkItems: [],
        };

        // 2. Fetch revision history for state transitions
        try {
          const revisions = await workItemApi.getRevisions(workItemId, undefined, undefined, undefined, resolvedProject);
          if (revisions && revisions.length > 0) {
            let prevState = "";
            revisions.forEach((rev) => {
              const state = rev.fields?.["System.State"];
              const changedDate = rev.fields?.["System.ChangedDate"];
              const changedBy = rev.fields?.["System.ChangedBy"]?.displayName ?? rev.fields?.["System.ChangedBy"];
              if (state && state !== prevState) {
                journey.stateTransitions.push({
                  from: prevState || "(created)",
                  to: state,
                  changedDate,
                  changedBy,
                  rev: rev.rev,
                });
                prevState = state;
              }
            });
          }
        } catch (revErr) {
          logger.warn(`analytics_pbi_journey: Failed to fetch revisions for ${workItemId}: ${revErr}`);
        }

        // 3. Parse relations for PRs, child items, related items
        const relations = workItem.relations ?? [];
        const prArtifactUrls: string[] = [];

        for (const rel of relations) {
          const url = rel.url ?? "";
          const relType = rel.rel ?? "";

          if (relType === "ArtifactLink" && url.includes("PullRequestId")) {
            prArtifactUrls.push(url);
          } else if (relType === "System.LinkTypes.Hierarchy-Forward") {
            // Child work item
            const childIdMatch = url.match(/\/(\d+)$/);
            if (childIdMatch) {
              journey.childWorkItems.push({ id: parseInt(childIdMatch[1]), url });
            }
          } else if (relType === "System.LinkTypes.Related") {
            const relIdMatch = url.match(/\/(\d+)$/);
            if (relIdMatch) {
              journey.relatedWorkItems.push({ id: parseInt(relIdMatch[1]) });
            }
          }
        }

        // 4. Resolve PR artifact links → actual PR details
        for (const artifactUrl of prArtifactUrls) {
          try {
            // vstfs:///Git/PullRequestId/{project}/{repoId}/{prId}
            const decoded = decodeURIComponent(artifactUrl.replace("vstfs:///Git/PullRequestId/", ""));
            const parts = decoded.split("/");
            if (parts.length >= 3) {
              const prProjectId = parts[0];
              const repoId = parts[1];
              const prId = parseInt(parts[2]);

              const gitApi = await connection.getGitApi();
              const pr = await gitApi.getPullRequest(repoId, prId, prProjectId).catch(() => null);

              if (pr) {
                journey.linkedPullRequests.push({
                  pullRequestId: pr.pullRequestId,
                  title: pr.title,
                  status: pr.status,
                  repository: pr.repository?.name,
                  sourceBranch: pr.sourceRefName,
                  targetBranch: pr.targetRefName,
                  createdBy: pr.createdBy?.displayName,
                  creationDate: pr.creationDate,
                  closedDate: pr.closedDate,
                  mergeCommitId: pr.lastMergeCommit?.commitId,
                });
              }
            }
          } catch (prErr) {
            logger.warn(`analytics_pbi_journey: Failed to resolve PR artifact: ${prErr}`);
          }
        }

        // 5. Look up builds that include this work item (via build changes API)
        if (includeBuilds) {
          try {
            const buildUrl = `${orgUrl}/${encodeURIComponent(resolvedProject)}/_apis/build/builds?workItemIds=${workItemId}&api-version=7.0&$top=10`;
            const buildsData = await apiFetch(buildUrl, token, ua).catch(() => null);
            if (buildsData?.value) {
              journey.linkedBuilds = buildsData.value.map((b: any) => ({
                buildId: b.id,
                buildNumber: b.buildNumber,
                status: b.status,
                result: b.result,
                definitionName: b.definition?.name,
                sourceBranch: b.sourceBranch,
                startTime: b.startTime,
                finishTime: b.finishTime,
                requestedBy: b.requestedBy?.displayName,
              }));
            }
          } catch (buildErr) {
            logger.warn(`analytics_pbi_journey: Failed to fetch builds: ${buildErr}`);
          }
        }

        // 6. Look up releases that include this work item
        if (includeReleases) {
          try {
            const vsrmUrl = buildVsrmBaseUrl(orgUrl);
            const releaseUrl = `${vsrmUrl}/${encodeURIComponent(resolvedProject)}/_apis/release/releases?workItemId=${workItemId}&api-version=7.0&$top=10&$expand=environments`;
            const releasesData = await apiFetch(releaseUrl, token, ua).catch(() => null);
            if (releasesData?.value) {
              journey.linkedReleases = releasesData.value.map((r: any) => ({
                releaseId: r.id,
                releaseName: r.name,
                status: r.status,
                definitionName: r.releaseDefinition?.name,
                createdOn: r.createdOn,
                environments: (r.environments ?? []).map((env: any) => ({
                  name: env.name,
                  status: env.status,
                  deployStartedOn: env.deployStartedOn,
                })),
              }));
            }
          } catch (releaseErr) {
            logger.warn(`analytics_pbi_journey: Failed to fetch releases: ${releaseErr}`);
          }
        }

        // 7. Build chronological timeline
        const timelineEvents: Array<{ timestamp: string; event: string; detail: string }> = [];

        if (journey.createdDate) {
          timelineEvents.push({ timestamp: journey.createdDate, event: "Created", detail: `By ${journey.createdBy}` });
        }

        journey.stateTransitions.forEach((t: any) => {
          if (t.changedDate) {
            timelineEvents.push({ timestamp: t.changedDate, event: `State: ${t.from} → ${t.to}`, detail: `By ${t.changedBy} (rev ${t.rev})` });
          }
        });

        journey.linkedPullRequests.forEach((pr: any) => {
          if (pr.creationDate) {
            timelineEvents.push({ timestamp: pr.creationDate, event: `PR Created: ${pr.title}`, detail: `PR #${pr.pullRequestId} in ${pr.repository}` });
          }
          if (pr.closedDate && pr.status === "completed") {
            timelineEvents.push({ timestamp: pr.closedDate, event: `PR Merged: ${pr.title}`, detail: `Merged commit: ${pr.mergeCommitId ?? "N/A"}` });
          }
        });

        journey.linkedBuilds.forEach((b: any) => {
          if (b.startTime) {
            timelineEvents.push({ timestamp: b.startTime, event: `Build Started: ${b.buildNumber}`, detail: `${b.definitionName} — ${b.result ?? b.status}` });
          }
        });

        journey.linkedReleases.forEach((r: any) => {
          if (r.createdOn) {
            timelineEvents.push({ timestamp: r.createdOn, event: `Release Created: ${r.releaseName}`, detail: `Definition: ${r.definitionName}` });
          }
          r.environments?.forEach((env: any) => {
            if (env.deployStartedOn) {
              timelineEvents.push({ timestamp: env.deployStartedOn, event: `Deployed to: ${env.name}`, detail: `Release: ${r.releaseName} — Status: ${env.status}` });
            }
          });
        });

        timelineEvents.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        journey.timeline = timelineEvents;

        return { content: [{ type: "text", text: JSON.stringify(journey, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error tracing PBI journey: ${msg}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TOOL: Repo Change Summary
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    ANALYTICS_TOOLS.repo_change_summary,
    "Summarize all changes in a repository over a date range or sprint: commits, PRs merged, unique authors, files changed, and work items linked. Perfect for release notes or sprint retrospectives.",
    {
      project: z.string().optional().describe("The Azure DevOps project name or ID."),
      repositoryId: z.string().describe("The repository name or ID."),
      fromDate: z.string().describe("Start of the date range (ISO 8601, e.g. 2024-01-01)."),
      toDate: z.string().optional().describe("End of the date range (ISO 8601). Defaults to now."),
      branch: z.string().optional().default("main").describe("Branch to analyze. Defaults to 'main'."),
      top: z.coerce.number().default(200).describe("Max commits to inspect. Defaults to 200."),
    },
    async ({ project, repositoryId, fromDate, toDate, branch, top }) => {
      try {
        const connection = await connectionProvider();
        const resolvedProject = project ?? defaultProject;

        if (!resolvedProject) {
          return {
            content: [{ type: "text", text: "Error: project is required. Pass a project name or configure a default project at server startup." }],
            isError: true,
          };
        }

        const gitApi = await connection.getGitApi();

        // Fetch commits in date range
        const toDateObj = toDate ? new Date(toDate) : new Date();
        const commits = await gitApi
          .getCommits(
            repositoryId,
            {
              fromDate,
              toDate: toDateObj.toISOString(),
              itemVersion: { version: branch, versionType: 0 },
              $top: top,
            },
            resolvedProject
          )
          .catch(() => []);

        // Fetch merged PRs in date range
        const prs = await gitApi
          .getPullRequests(
            repositoryId,
            {
              status: 3, // Completed
              targetRefName: `refs/heads/${branch}`,
            },
            resolvedProject,
            undefined,
            0,
            200
          )
          .catch(() => []);

        const fromDateObj = new Date(fromDate);
        const filteredPrs = (prs ?? []).filter((pr) => {
          const closed = pr.closedDate ? new Date(pr.closedDate) : null;
          return closed && closed >= fromDateObj && closed <= toDateObj;
        });

        // Aggregate author stats
        const authorMap: Record<string, { commits: number; email: string }> = {};
        for (const commit of commits ?? []) {
          const name = commit.author?.name ?? "Unknown";
          const email = commit.author?.email ?? "";
          if (!authorMap[name]) authorMap[name] = { commits: 0, email };
          authorMap[name].commits++;
        }

        // Build file change summary from PRs (using PR change counts)
        const fileChangeSummary = {
          totalPRs: filteredPrs.length,
          filesChanged: "See individual PRs for file-level details",
        };

        // Collect linked work item IDs from commits
        const linkedWorkItemIds = new Set<number>();
        (commits ?? []).forEach((c) => {
          (c.workItems ?? []).forEach((wi) => {
            if (wi.id) linkedWorkItemIds.add(parseInt(wi.id));
          });
        });

        const summary = {
          repository: repositoryId,
          project: resolvedProject,
          branch,
          dateRange: { from: fromDate, to: toDateObj.toISOString() },
          totals: {
            commits: (commits ?? []).length,
            mergedPullRequests: filteredPrs.length,
            uniqueAuthors: Object.keys(authorMap).length,
            linkedWorkItems: linkedWorkItemIds.size,
          },
          authors: Object.entries(authorMap)
            .sort((a, b) => b[1].commits - a[1].commits)
            .map(([name, stats]) => ({ name, email: stats.email, commits: stats.commits })),
          mergedPullRequests: filteredPrs.map((pr) => ({
            pullRequestId: pr.pullRequestId,
            title: pr.title,
            mergedBy: pr.closedBy?.displayName,
            closedDate: pr.closedDate,
            sourceBranch: pr.sourceRefName,
            description: pr.description?.substring(0, 200),
          })),
          linkedWorkItemIds: Array.from(linkedWorkItemIds),
          fileChangeSummary,
          recentCommits: (commits ?? []).slice(0, 20).map((c) => ({
            commitId: c.commitId?.substring(0, 8),
            author: c.author?.name,
            date: c.author?.date,
            comment: c.comment?.split("\n")[0]?.substring(0, 100),
          })),
        };

        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error generating repo change summary: ${msg}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TOOL: Sprint Velocity
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    ANALYTICS_TOOLS.sprint_velocity,
    "Calculate sprint velocity for a team over the last N sprints. Returns completed story points and work item counts per sprint.",
    {
      project: z.string().optional().describe("The Azure DevOps project name or ID."),
      team: z.string().optional().describe("The team name. Defaults to the project default team."),
      numberOfSprints: z.coerce.number().min(1).max(20).default(6).describe("Number of past sprints to analyze. Defaults to 6."),
    },
    async ({ project, team, numberOfSprints }) => {
      try {
        const connection = await connectionProvider();
        const resolvedProject = project ?? defaultProject;

        if (!resolvedProject) {
          return {
            content: [{ type: "text", text: "Error: project is required. Pass a project name or configure a default project at server startup." }],
            isError: true,
          };
        }

        const workApi = await connection.getWorkApi();
        const teamContext = { project: resolvedProject, team: team ?? resolvedProject };

        // Get team iterations
        const iterations = await workApi.getTeamIterations(teamContext, "past").catch(() => []);
        const recentIterations = (iterations ?? []).slice(-numberOfSprints);

        if (recentIterations.length === 0) {
          return { content: [{ type: "text", text: "No past iterations found for this team." }] };
        }

        const workItemApi = await connection.getWorkItemTrackingApi();
        const velocityData: any[] = [];

        for (const iteration of recentIterations) {
          try {
            const iterationWorkItems = await workApi.getIterationWorkItems(teamContext, iteration.id!);
            const workItemIds = (iterationWorkItems?.workItemRelations ?? [])
              .filter((rel) => !rel.rel) // top-level items only
              .map((rel) => rel.target?.id)
              .filter((id): id is number => id !== undefined);

            if (workItemIds.length === 0) {
              velocityData.push({
                sprint: iteration.name,
                startDate: iteration.attributes?.startDate,
                finishDate: iteration.attributes?.finishDate,
                committed: 0,
                completed: 0,
                completedStoryPoints: 0,
                committedStoryPoints: 0,
                completionRate: 0,
              });
              continue;
            }

            const workItems = await workItemApi.getWorkItemsBatch(
              { ids: workItemIds.slice(0, 200), fields: ["System.State", "Microsoft.VSTS.Scheduling.StoryPoints", "System.WorkItemType"] },
              resolvedProject
            );

            const completedStates = ["Done", "Closed", "Resolved", "Completed"];
            const relevantTypes = ["User Story", "Product Backlog Item", "Bug", "Feature"];

            const scored = (workItems ?? []).filter((wi) => relevantTypes.includes(wi.fields?.["System.WorkItemType"] ?? ""));
            const completed = scored.filter((wi) => completedStates.includes(wi.fields?.["System.State"] ?? ""));

            const committedPoints = scored.reduce((sum, wi) => sum + (wi.fields?.["Microsoft.VSTS.Scheduling.StoryPoints"] ?? 0), 0);
            const completedPoints = completed.reduce((sum, wi) => sum + (wi.fields?.["Microsoft.VSTS.Scheduling.StoryPoints"] ?? 0), 0);

            velocityData.push({
              sprint: iteration.name,
              startDate: iteration.attributes?.startDate,
              finishDate: iteration.attributes?.finishDate,
              committed: scored.length,
              completed: completed.length,
              committedStoryPoints: committedPoints,
              completedStoryPoints: completedPoints,
              completionRate: scored.length > 0 ? Math.round((completed.length / scored.length) * 100) : 0,
            });
          } catch (iterErr) {
            logger.warn(`analytics_sprint_velocity: Failed to process iteration ${iteration.name}: ${iterErr}`);
          }
        }

        const avgVelocity =
          velocityData.length > 0
            ? Math.round(velocityData.reduce((sum, s) => sum + s.completedStoryPoints, 0) / velocityData.length)
            : 0;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  project: resolvedProject,
                  team: team ?? resolvedProject,
                  averageVelocity: avgVelocity,
                  sprintsAnalyzed: velocityData.length,
                  sprints: velocityData,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error calculating sprint velocity: ${msg}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TOOL: Pipeline Health
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    ANALYTICS_TOOLS.pipeline_health,
    "Analyze the health of a pipeline definition: pass/fail rate, average duration, and recent failures over a date range.",
    {
      project: z.string().optional().describe("The Azure DevOps project name or ID."),
      definitionId: z.coerce.number().min(1).describe("The build/pipeline definition ID."),
      branch: z.string().optional().describe("Filter to a specific branch (e.g. 'refs/heads/main'). Defaults to all branches."),
      top: z.coerce.number().default(50).describe("Number of recent builds to analyze. Defaults to 50."),
      minTime: z.string().optional().describe("ISO 8601 start date to filter builds."),
      maxTime: z.string().optional().describe("ISO 8601 end date to filter builds."),
    },
    async ({ project, definitionId, branch, top, minTime, maxTime }) => {
      try {
        const connection = await connectionProvider();
        const resolvedProject = project ?? defaultProject;

        if (!resolvedProject) {
          return {
            content: [{ type: "text", text: "Error: project is required. Pass a project name or configure a default project at server startup." }],
            isError: true,
          };
        }

        const buildApi = await connection.getBuildApi();
        const builds = await buildApi.getBuilds(
          resolvedProject,
          [definitionId],
          undefined, // queues
          undefined, // buildNumber
          minTime ? new Date(minTime) : undefined,
          maxTime ? new Date(maxTime) : undefined,
          undefined, // requestedFor
          undefined, // reasonFilter
          undefined, // statusFilter
          undefined, // resultFilter
          undefined, // tagFilters
          undefined, // properties
          top,
          undefined, // continuationToken
          undefined, // maxBuildsPerDefinition
          undefined, // deletedFilter
          undefined, // queryOrder
          branch
        );

        if (!builds || builds.length === 0) {
          return { content: [{ type: "text", text: "No builds found for the specified criteria." }] };
        }

        // Compute stats
        const succeeded = builds.filter((b) => b.result === 2 /* Succeeded */);
        const failed = builds.filter((b) => b.result === 8 /* Failed */);
        const canceled = builds.filter((b) => b.result === 32 /* Canceled */);
        const partiallySucceeded = builds.filter((b) => b.result === 4 /* PartiallySucceeded */);

        const durationsMs = builds
          .filter((b) => b.startTime && b.finishTime)
          .map((b) => new Date(b.finishTime!).getTime() - new Date(b.startTime!).getTime());

        const avgDurationMs = durationsMs.length > 0 ? durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length : 0;
        const minDurationMs = durationsMs.length > 0 ? Math.min(...durationsMs) : 0;
        const maxDurationMs = durationsMs.length > 0 ? Math.max(...durationsMs) : 0;

        const health = {
          project: resolvedProject,
          definitionId,
          branch: branch ?? "all",
          analyzedBuilds: builds.length,
          passRate: Math.round((succeeded.length / builds.length) * 100),
          failRate: Math.round((failed.length / builds.length) * 100),
          results: {
            succeeded: succeeded.length,
            failed: failed.length,
            partiallySucceeded: partiallySucceeded.length,
            canceled: canceled.length,
          },
          duration: {
            averageMinutes: Math.round(avgDurationMs / 60000),
            minMinutes: Math.round(minDurationMs / 60000),
            maxMinutes: Math.round(maxDurationMs / 60000),
          },
          recentFailures: failed.slice(0, 5).map((b) => ({
            buildId: b.id,
            buildNumber: b.buildNumber,
            startTime: b.startTime,
            finishTime: b.finishTime,
            requestedBy: b.requestedBy?.displayName,
            sourceBranch: b.sourceBranch,
            sourceVersion: b.sourceVersion?.substring(0, 8),
          })),
          recentBuilds: builds.slice(0, 10).map((b) => ({
            buildId: b.id,
            buildNumber: b.buildNumber,
            result: b.result,
            status: b.status,
            sourceBranch: b.sourceBranch,
            startTime: b.startTime,
            finishTime: b.finishTime,
          })),
        };

        return { content: [{ type: "text", text: JSON.stringify(health, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error analyzing pipeline health: ${msg}` }], isError: true };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // TOOL: Deployment Frequency
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    ANALYTICS_TOOLS.deployment_frequency,
    "Measure deployment frequency to an environment (e.g. Production) over a time period. Groups deployments by week and shows DORA-style deployment frequency metrics.",
    {
      project: z.string().optional().describe("The Azure DevOps project name or ID."),
      definitionId: z.coerce.number().optional().describe("Filter by release definition ID."),
      environmentName: z.string().optional().describe("Filter by environment name (e.g. 'Production', 'Staging'). Case-insensitive partial match."),
      fromDate: z.string().describe("Start of analysis period (ISO 8601, e.g. 2024-01-01)."),
      toDate: z.string().optional().describe("End of analysis period (ISO 8601). Defaults to now."),
      groupBy: z.enum(["day", "week", "month"]).default("week").describe("Group deployment counts by day, week, or month. Defaults to week."),
    },
    async ({ project, definitionId, environmentName, fromDate, toDate, groupBy }) => {
      try {
        const connection = await connectionProvider();
        const resolvedProject = project ?? defaultProject;

        if (!resolvedProject) {
          return {
            content: [{ type: "text", text: "Error: project is required. Pass a project name or configure a default project at server startup." }],
            isError: true,
          };
        }

        const token = await tokenProvider();
        const orgUrl = connection.serverUrl;
        const vsrmUrl = buildVsrmBaseUrl(orgUrl);
        const ua = userAgentProvider();

        const toDateObj = toDate ? new Date(toDate) : new Date();
        const fromDateObj = new Date(fromDate);

        const params = new URLSearchParams({
          "api-version": "7.0",
          "$top": "200",
          minStartedTime: fromDateObj.toISOString(),
          maxStartedTime: toDateObj.toISOString(),
          deploymentStatus: "succeeded",
        });
        if (definitionId) params.set("definitionId", String(definitionId));

        const url = `${vsrmUrl}/${encodeURIComponent(resolvedProject)}/_apis/release/deployments?${params}`;
        const data = await apiFetch(url, token, ua);

        let deployments: any[] = data.value ?? [];

        // Filter by environment name if provided
        if (environmentName) {
          const lowerEnv = environmentName.toLowerCase();
          deployments = deployments.filter((d) => d.releaseEnvironment?.name?.toLowerCase().includes(lowerEnv));
        }

        // Group by period
        function getPeriodKey(dateStr: string): string {
          const d = new Date(dateStr);
          if (groupBy === "day") {
            return d.toISOString().split("T")[0];
          } else if (groupBy === "week") {
            const day = d.getDay();
            const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Mon
            const monday = new Date(d.setDate(diff));
            return monday.toISOString().split("T")[0];
          } else {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          }
        }

        const buckets: Record<string, number> = {};
        for (const dep of deployments) {
          const key = getPeriodKey(dep.completedOn ?? dep.startedOn ?? dep.queuedOn ?? fromDate);
          buckets[key] = (buckets[key] ?? 0) + 1;
        }

        const periods = Object.entries(buckets)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([period, count]) => ({ period, deployments: count }));

        const totalDays = Math.round((toDateObj.getTime() - fromDateObj.getTime()) / (1000 * 60 * 60 * 24));
        const avgPerWeek = totalDays > 0 ? Math.round((deployments.length / totalDays) * 7 * 10) / 10 : 0;

        // DORA classification
        let doraLevel = "Low";
        if (avgPerWeek >= 7) doraLevel = "Elite (multiple times per day)";
        else if (avgPerWeek >= 1) doraLevel = "High (between once per day and once per week)";
        else if (avgPerWeek >= 0.25) doraLevel = "Medium (between once per week and once per month)";
        else doraLevel = "Low (less than once per month)";

        const result = {
          project: resolvedProject,
          environment: environmentName ?? "all",
          dateRange: { from: fromDate, to: toDateObj.toISOString() },
          totalDeployments: deployments.length,
          averageDeploymentsPerWeek: avgPerWeek,
          doraClassification: doraLevel,
          groupBy,
          periodicBreakdown: periods,
          environments: [...new Set(deployments.map((d) => d.releaseEnvironment?.name).filter(Boolean))],
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error analyzing deployment frequency: ${msg}` }], isError: true };
      }
    }
  );
}

export { ANALYTICS_TOOLS, configureAnalyticsTools };
