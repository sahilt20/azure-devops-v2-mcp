// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";
import { z } from "zod";
import { logger } from "../logger.js";

const RELEASE_TOOLS = {
  list_definitions: "releases_list_definitions",
  get_definition: "releases_get_definition",
  list_releases: "releases_list_releases",
  get_release: "releases_get_release",
  get_release_timeline: "releases_get_release_timeline",
  list_deployments: "releases_list_deployments",
  get_release_environments: "releases_get_release_environments",
};

/**
 * Build the VSRM (Release Management) base URL from the org URL.
 * The Release Management API lives at vsrm.dev.azure.com, not dev.azure.com.
 */
function buildVsrmBaseUrl(orgUrl: string): string {
  // orgUrl examples:
  //   https://dev.azure.com/contoso
  //   https://contoso.visualstudio.com
  if (orgUrl.includes("dev.azure.com")) {
    const orgName = orgUrl.replace(/^https:\/\/dev\.azure\.com\//, "").replace(/\/$/, "").split("/")[0];
    return `https://vsrm.dev.azure.com/${orgName}`;
  }
  // For VSTS / visualstudio.com, the release API is on the same host
  return orgUrl.replace(/\/$/, "");
}

async function releaseApiFetch(url: string, token: string, userAgent: string): Promise<unknown> {
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
    throw new Error(`Release API request failed [${response.status}]: ${text}`);
  }

  return response.json();
}

function configureReleaseTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  connectionProvider: () => Promise<WebApi>,
  userAgentProvider: () => string
) {
  server.tool(
    RELEASE_TOOLS.list_definitions,
    "List release pipeline definitions for a project. Returns id, name, path, and last release info.",
    {
      project: z.string().describe("The Azure DevOps project name or ID."),
      searchText: z.string().optional().describe("Filter definitions by name (partial match)."),
      top: z.coerce.number().default(50).describe("Maximum number of definitions to return. Defaults to 50."),
      isDeleted: z.boolean().default(false).describe("Whether to include deleted definitions. Defaults to false."),
    },
    async ({ project, searchText, top, isDeleted }) => {
      try {
        const connection = await connectionProvider();
        const vsrmUrl = buildVsrmBaseUrl(connection.serverUrl);
        const token = await tokenProvider();

        const params = new URLSearchParams({
          "api-version": "7.0",
          "$top": String(top),
          isDeleted: String(isDeleted),
        });
        if (searchText) params.set("searchText", searchText);

        const url = `${vsrmUrl}/${encodeURIComponent(project)}/_apis/release/definitions?${params}`;
        logger.debug(`releases_list_definitions: GET ${url}`);

        const data = await releaseApiFetch(url, token, userAgentProvider());
        const result = data as { value: unknown[]; count: number };

        // Trim to essential properties
        const trimmed = (result.value ?? []).map((def: any) => ({
          id: def.id,
          name: def.name,
          path: def.path,
          releaseNameFormat: def.releaseNameFormat,
          createdBy: def.createdBy?.displayName,
          createdOn: def.createdOn,
          modifiedOn: def.modifiedOn,
          lastRelease: def.lastRelease
            ? { id: def.lastRelease.id, name: def.lastRelease.name, createdOn: def.lastRelease.createdOn }
            : null,
        }));

        return { content: [{ type: "text", text: JSON.stringify({ count: trimmed.length, value: trimmed }, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error listing release definitions: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    RELEASE_TOOLS.get_definition,
    "Get a single release pipeline definition by ID, including all stages/environments and triggers.",
    {
      project: z.string().describe("The Azure DevOps project name or ID."),
      definitionId: z.coerce.number().min(1).describe("The release definition ID."),
    },
    async ({ project, definitionId }) => {
      try {
        const connection = await connectionProvider();
        const vsrmUrl = buildVsrmBaseUrl(connection.serverUrl);
        const token = await tokenProvider();

        const url = `${vsrmUrl}/${encodeURIComponent(project)}/_apis/release/definitions/${definitionId}?api-version=7.0`;
        const data = await releaseApiFetch(url, token, userAgentProvider()) as any;

        const trimmed = {
          id: data.id,
          name: data.name,
          path: data.path,
          description: data.description,
          releaseNameFormat: data.releaseNameFormat,
          environments: (data.environments ?? []).map((env: any) => ({
            id: env.id,
            name: env.name,
            rank: env.rank,
            owner: env.owner?.displayName,
            deployPhases: (env.deployPhases ?? []).map((phase: any) => ({
              name: phase.name,
              phaseType: phase.phaseType,
              rank: phase.rank,
            })),
            preDeployApprovals: env.preDeployApprovals?.approvals?.length ?? 0,
            postDeployApprovals: env.postDeployApprovals?.approvals?.length ?? 0,
          })),
          triggers: (data.triggers ?? []).map((t: any) => ({
            triggerType: t.triggerType,
            artifactAlias: t.artifactAlias,
            triggerConditions: t.triggerConditions,
          })),
          artifacts: (data.artifacts ?? []).map((a: any) => ({
            alias: a.alias,
            type: a.type,
            definitionReference: {
              definition: a.definitionReference?.definition?.name,
              project: a.definitionReference?.project?.name,
            },
          })),
          createdBy: data.createdBy?.displayName,
          createdOn: data.createdOn,
          modifiedBy: data.modifiedBy?.displayName,
          modifiedOn: data.modifiedOn,
        };

        return { content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error getting release definition: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    RELEASE_TOOLS.list_releases,
    "List releases for a project. Filter by definition, status, date range, or who created them.",
    {
      project: z.string().describe("The Azure DevOps project name or ID."),
      definitionId: z.coerce.number().optional().describe("Filter by release pipeline definition ID."),
      status: z
        .enum(["active", "abandoned", "draft", "undefined"])
        .optional()
        .describe("Filter releases by status. Defaults to all statuses."),
      minCreatedTime: z.string().optional().describe("ISO 8601 date string — only include releases created after this time."),
      maxCreatedTime: z.string().optional().describe("ISO 8601 date string — only include releases created before this time."),
      top: z.coerce.number().default(25).describe("Maximum number of releases to return. Defaults to 25."),
      createdBy: z.string().optional().describe("Filter releases by creator UPN/email."),
      environmentStatusFilter: z
        .number()
        .optional()
        .describe("Filter by environment status (bit flags: 1=undefined, 2=notStarted, 4=inProgress, 8=succeeded, 16=canceled, 32=rejected, 64=queued, 128=scheduled, 256=partiallySucceeded)."),
    },
    async ({ project, definitionId, status, minCreatedTime, maxCreatedTime, top, createdBy, environmentStatusFilter }) => {
      try {
        const connection = await connectionProvider();
        const vsrmUrl = buildVsrmBaseUrl(connection.serverUrl);
        const token = await tokenProvider();

        const params = new URLSearchParams({
          "api-version": "7.0",
          "$top": String(top),
          "$expand": "environments",
        });
        if (definitionId) params.set("definitionId", String(definitionId));
        if (status) params.set("statusFilter", status);
        if (minCreatedTime) params.set("minCreatedTime", minCreatedTime);
        if (maxCreatedTime) params.set("maxCreatedTime", maxCreatedTime);
        if (createdBy) params.set("createdBy", createdBy);
        if (environmentStatusFilter !== undefined) params.set("environmentStatusFilter", String(environmentStatusFilter));

        const url = `${vsrmUrl}/${encodeURIComponent(project)}/_apis/release/releases?${params}`;
        const data = await releaseApiFetch(url, token, userAgentProvider()) as any;

        const trimmed = (data.value ?? []).map((rel: any) => ({
          id: rel.id,
          name: rel.name,
          status: rel.status,
          createdOn: rel.createdOn,
          createdBy: rel.createdBy?.displayName,
          modifiedOn: rel.modifiedOn,
          description: rel.description,
          environments: (rel.environments ?? []).map((env: any) => ({
            id: env.id,
            name: env.name,
            status: env.status,
            deployStartedOn: env.deployStartedOn,
            lastModifiedOn: env.lastModifiedOn,
            triggerReason: env.triggerReason,
          })),
          artifacts: (rel.artifacts ?? []).map((a: any) => ({
            alias: a.alias,
            type: a.type,
            buildVersion: a.definitionReference?.version?.name,
            buildId: a.definitionReference?.version?.id,
          })),
        }));

        return { content: [{ type: "text", text: JSON.stringify({ count: trimmed.length, value: trimmed }, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error listing releases: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    RELEASE_TOOLS.get_release,
    "Get a specific release by ID with full environment and approval details.",
    {
      project: z.string().describe("The Azure DevOps project name or ID."),
      releaseId: z.coerce.number().min(1).describe("The release ID."),
    },
    async ({ project, releaseId }) => {
      try {
        const connection = await connectionProvider();
        const vsrmUrl = buildVsrmBaseUrl(connection.serverUrl);
        const token = await tokenProvider();

        const url = `${vsrmUrl}/${encodeURIComponent(project)}/_apis/release/releases/${releaseId}?api-version=7.0`;
        const data = await releaseApiFetch(url, token, userAgentProvider()) as any;

        const trimmed = {
          id: data.id,
          name: data.name,
          status: data.status,
          description: data.description,
          createdOn: data.createdOn,
          createdBy: data.createdBy?.displayName,
          modifiedOn: data.modifiedOn,
          modifiedBy: data.modifiedBy?.displayName,
          releaseDefinition: { id: data.releaseDefinition?.id, name: data.releaseDefinition?.name },
          artifacts: (data.artifacts ?? []).map((a: any) => ({
            alias: a.alias,
            type: a.type,
            buildVersion: a.definitionReference?.version?.name,
            buildId: a.definitionReference?.version?.id,
            sourceBranch: a.definitionReference?.sourceBranch?.id,
            repositoryId: a.definitionReference?.repository?.id,
          })),
          environments: (data.environments ?? []).map((env: any) => ({
            id: env.id,
            name: env.name,
            status: env.status,
            rank: env.rank,
            deployStartedOn: env.deployStartedOn,
            lastModifiedOn: env.lastModifiedOn,
            triggerReason: env.triggerReason,
            scheduledDeploymentTime: env.scheduledDeploymentTime,
            preApprovalsSnapshot: (env.preApprovalsSnapshot?.approvals ?? []).map((a: any) => ({
              approver: a.approver?.displayName,
              isAutomated: a.isAutomated,
              rank: a.rank,
            })),
            postApprovalsSnapshot: (env.postApprovalsSnapshot?.approvals ?? []).map((a: any) => ({
              approver: a.approver?.displayName,
              isAutomated: a.isAutomated,
            })),
            deploySteps: (env.deploySteps ?? []).map((step: any) => ({
              id: step.id,
              deploymentId: step.deploymentId,
              attempt: step.attempt,
              reason: step.reason,
              status: step.status,
              operationStatus: step.operationStatus,
              requestedBy: step.requestedBy?.displayName,
              requestedOn: step.requestedOn,
              lastModifiedOn: step.lastModifiedOn,
            })),
          })),
        };

        return { content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error getting release: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    RELEASE_TOOLS.get_release_timeline,
    "Get a deployment timeline for a release showing when each environment started, completed, duration, and approval status.",
    {
      project: z.string().describe("The Azure DevOps project name or ID."),
      releaseId: z.coerce.number().min(1).describe("The release ID."),
    },
    async ({ project, releaseId }) => {
      try {
        const connection = await connectionProvider();
        const vsrmUrl = buildVsrmBaseUrl(connection.serverUrl);
        const token = await tokenProvider();

        const url = `${vsrmUrl}/${encodeURIComponent(project)}/_apis/release/releases/${releaseId}?api-version=7.0`;
        const data = await releaseApiFetch(url, token, userAgentProvider()) as any;

        const timeline = {
          releaseId: data.id,
          releaseName: data.name,
          status: data.status,
          createdOn: data.createdOn,
          definitionName: data.releaseDefinition?.name,
          environments: (data.environments ?? [])
            .sort((a: any, b: any) => (a.rank ?? 0) - (b.rank ?? 0))
            .map((env: any) => {
              const startTime = env.deployStartedOn ? new Date(env.deployStartedOn) : null;
              const endTime = env.lastModifiedOn && env.status !== "inProgress" ? new Date(env.lastModifiedOn) : null;
              const durationMs = startTime && endTime ? endTime.getTime() - startTime.getTime() : null;

              return {
                environmentId: env.id,
                environmentName: env.name,
                status: env.status,
                rank: env.rank,
                deployStartedOn: env.deployStartedOn,
                completedOn: env.status !== "inProgress" ? env.lastModifiedOn : null,
                durationMinutes: durationMs !== null ? Math.round(durationMs / 60000) : null,
                triggerReason: env.triggerReason,
                preApprovals: (env.preApprovalsSnapshot?.approvals ?? []).map((a: any) => ({
                  approver: a.approver?.displayName,
                  isAutomated: a.isAutomated,
                })),
              };
            }),
        };

        return { content: [{ type: "text", text: JSON.stringify(timeline, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error getting release timeline: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    RELEASE_TOOLS.list_deployments,
    "List deployments to environments across releases. Useful for tracking deployment frequency and patterns.",
    {
      project: z.string().describe("The Azure DevOps project name or ID."),
      definitionId: z.coerce.number().optional().describe("Filter by release definition ID."),
      definitionEnvironmentId: z.coerce.number().optional().describe("Filter by a specific environment ID within the definition."),
      top: z.coerce.number().default(25).describe("Maximum number of deployments to return. Defaults to 25."),
      minStartedTime: z.string().optional().describe("ISO 8601 date — only include deployments started after this time."),
      maxStartedTime: z.string().optional().describe("ISO 8601 date — only include deployments started before this time."),
      deploymentStatus: z
        .enum(["all", "inProgress", "succeeded", "canceled", "failed", "notDeployed", "partiallySucceeded"])
        .optional()
        .default("all")
        .describe("Filter by deployment status. Defaults to 'all'."),
    },
    async ({ project, definitionId, definitionEnvironmentId, top, minStartedTime, maxStartedTime, deploymentStatus }) => {
      try {
        const connection = await connectionProvider();
        const vsrmUrl = buildVsrmBaseUrl(connection.serverUrl);
        const token = await tokenProvider();

        const params = new URLSearchParams({
          "api-version": "7.0",
          "$top": String(top),
        });
        if (definitionId) params.set("definitionId", String(definitionId));
        if (definitionEnvironmentId) params.set("definitionEnvironmentId", String(definitionEnvironmentId));
        if (minStartedTime) params.set("minStartedTime", minStartedTime);
        if (maxStartedTime) params.set("maxStartedTime", maxStartedTime);
        if (deploymentStatus && deploymentStatus !== "all") params.set("deploymentStatus", deploymentStatus);

        const url = `${vsrmUrl}/${encodeURIComponent(project)}/_apis/release/deployments?${params}`;
        const data = await releaseApiFetch(url, token, userAgentProvider()) as any;

        const trimmed = (data.value ?? []).map((dep: any) => ({
          id: dep.id,
          release: { id: dep.release?.id, name: dep.release?.name },
          releaseDefinition: dep.releaseDefinition?.name,
          releaseEnvironment: dep.releaseEnvironment?.name,
          attempt: dep.attempt,
          reason: dep.reason,
          deploymentStatus: dep.deploymentStatus,
          operationStatus: dep.operationStatus,
          requestedBy: dep.requestedBy?.displayName,
          requestedFor: dep.requestedFor?.displayName,
          queuedOn: dep.queuedOn,
          startedOn: dep.startedOn,
          completedOn: dep.completedOn,
        }));

        return { content: [{ type: "text", text: JSON.stringify({ count: trimmed.length, value: trimmed }, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error listing deployments: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    RELEASE_TOOLS.get_release_environments,
    "Get the environment/stage details for a specific release, including approval history and deployment task logs summary.",
    {
      project: z.string().describe("The Azure DevOps project name or ID."),
      releaseId: z.coerce.number().min(1).describe("The release ID."),
      environmentId: z.coerce.number().min(1).describe("The environment/stage ID within the release."),
    },
    async ({ project, releaseId, environmentId }) => {
      try {
        const connection = await connectionProvider();
        const vsrmUrl = buildVsrmBaseUrl(connection.serverUrl);
        const token = await tokenProvider();

        const url = `${vsrmUrl}/${encodeURIComponent(project)}/_apis/release/releases/${releaseId}/environments/${environmentId}?api-version=7.0&$expand=deploySteps,approvals`;
        const data = await releaseApiFetch(url, token, userAgentProvider()) as any;

        const trimmed = {
          id: data.id,
          name: data.name,
          status: data.status,
          rank: data.rank,
          deployStartedOn: data.deployStartedOn,
          lastModifiedOn: data.lastModifiedOn,
          triggerReason: data.triggerReason,
          deploySteps: (data.deploySteps ?? []).map((step: any) => ({
            id: step.id,
            attempt: step.attempt,
            status: step.status,
            operationStatus: step.operationStatus,
            requestedBy: step.requestedBy?.displayName,
            requestedOn: step.requestedOn,
            lastModifiedOn: step.lastModifiedOn,
            issues: (step.issues ?? []).map((issue: any) => ({
              issueType: issue.issueType,
              message: issue.message,
            })),
          })),
          preApprovalsSnapshot: (data.preApprovalsSnapshot?.approvals ?? []).map((a: any) => ({
            approver: a.approver?.displayName,
            approvedBy: a.approvedBy?.displayName,
            status: a.status,
            isAutomated: a.isAutomated,
            comments: a.comments,
            modifiedOn: a.modifiedOn,
          })),
          postApprovalsSnapshot: (data.postApprovalsSnapshot?.approvals ?? []).map((a: any) => ({
            approver: a.approver?.displayName,
            approvedBy: a.approvedBy?.displayName,
            status: a.status,
            isAutomated: a.isAutomated,
            comments: a.comments,
            modifiedOn: a.modifiedOn,
          })),
        };

        return { content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error getting release environment: ${msg}` }], isError: true };
      }
    }
  );
}

export { RELEASE_TOOLS, configureReleaseTools };
