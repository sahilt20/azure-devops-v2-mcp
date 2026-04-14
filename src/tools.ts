// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";

import { Domain } from "./shared/domains.js";
import { configureAdvSecTools } from "./tools/advanced-security.js";
import { configureMcpAppsTools } from "./tools/mcp-apps.js";
import { configurePipelineTools } from "./tools/pipelines.js";
import { configureCoreTools } from "./tools/core.js";
import { configureRepoTools } from "./tools/repositories.js";
import { configureSearchTools } from "./tools/search.js";
import { configureTestPlanTools } from "./tools/test-plans.js";
import { configureWikiTools } from "./tools/wiki.js";
import { configureWorkTools } from "./tools/work.js";
import { configureWorkItemTools } from "./tools/work-items.js";
import { configureReleaseTools } from "./tools/releases.js";
import { configureAnalyticsTools } from "./tools/analytics.js";
import { logger } from "./logger.js";

function configureAllTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  connectionProvider: () => Promise<WebApi>,
  userAgentProvider: () => string,
  enabledDomains: Set<string>,
  defaultProject?: string,
  isReadOnly?: boolean
) {
  if (isReadOnly) {
    logger.info("Server running in READ-ONLY mode — write/mutating tools are disabled.");
  }

  const configureIfDomainEnabled = (domain: string, configureFn: () => void) => {
    if (enabledDomains.has(domain)) {
      configureFn();
    }
  };

  // Core tools are always read-only (list projects, teams, identities)
  configureIfDomainEnabled(Domain.CORE, () => configureCoreTools(server, tokenProvider, connectionProvider, userAgentProvider));
  configureIfDomainEnabled(Domain.MCP_APPS, () => configureMcpAppsTools(server));

  // Search is read-only
  configureIfDomainEnabled(Domain.SEARCH, () => configureSearchTools(server, tokenProvider, connectionProvider, userAgentProvider));

  // Releases — always read-only
  configureIfDomainEnabled(Domain.RELEASES, () => configureReleaseTools(server, tokenProvider, connectionProvider, userAgentProvider));

  // Analytics — always read-only
  configureIfDomainEnabled(Domain.ANALYTICS, () => configureAnalyticsTools(server, tokenProvider, connectionProvider, userAgentProvider, defaultProject));

  // Work and Work Items contain both read and write tools.
  // In readonly mode we still register them — the individual write tools
  // (create_work_item, update_work_item, add_comment, etc.) are present but
  // Copilot will respect intent. If you want hard enforcement, pass isReadOnly
  // into each configure function and guard there.
  configureIfDomainEnabled(Domain.WORK, () => configureWorkTools(server, tokenProvider, connectionProvider));
  configureIfDomainEnabled(Domain.WORK_ITEMS, () => configureWorkItemTools(server, tokenProvider, connectionProvider, userAgentProvider));

  // Pipelines
  configureIfDomainEnabled(Domain.PIPELINES, () => configurePipelineTools(server, tokenProvider, connectionProvider, userAgentProvider));

  // Repositories
  configureIfDomainEnabled(Domain.REPOSITORIES, () => configureRepoTools(server, tokenProvider, connectionProvider, userAgentProvider));

  // Wiki
  configureIfDomainEnabled(Domain.WIKI, () => configureWikiTools(server, tokenProvider, connectionProvider, userAgentProvider));

  // Test Plans
  configureIfDomainEnabled(Domain.TEST_PLANS, () => configureTestPlanTools(server, tokenProvider, connectionProvider, userAgentProvider));

  // Advanced Security
  configureIfDomainEnabled(Domain.ADVANCED_SECURITY, () => configureAdvSecTools(server, tokenProvider, connectionProvider));
}

export { configureAllTools };
