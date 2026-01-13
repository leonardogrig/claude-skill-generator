import { NextRequest, NextResponse } from "next/server";

// Types for agent job creation response
interface AgentJobResponse {
  success: boolean;
  id?: string;
  error?: string;
}

// Reference file for endpoint documentation
interface ReferenceFile {
  name: string;
  content: string;
}

// Endpoint preview for UI display
interface EndpointPreview {
  name: string;
  description: string;
  method: string;
  path: string;
}

// Generated skill package from Firecrawl agent
interface GeneratedSkillPackage {
  serviceName: string;
  serviceDescription: string;
  hasDocumentation: boolean;
  skillMd: string;
  references: ReferenceFile[];
  endpoints: EndpointPreview[];
}

// Types for agent status/result response
interface AgentStatusResponse {
  success: boolean;
  status: "processing" | "completed" | "failed";
  data?: GeneratedSkillPackage;
  expiresAt?: string;
  creditsUsed?: number;
}

// Helper to poll for agent completion with retry logic
async function pollAgentStatus(
  jobId: string,
  apiKey: string,
  maxAttempts = 200, // ~10 minutes with 3s intervals
  intervalMs = 3000,
): Promise<AgentStatusResponse> {
  console.log(`[Agent] Starting to poll job ${jobId}`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    console.log(`[Agent] Poll attempt ${attempt + 1}/${maxAttempts}`);

    try {
      const response = await fetch(
        `https://api.firecrawl.dev/v2/agent/${jobId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Agent] HTTP error: ${response.status} - ${errorText}`);
        // Continue polling on HTTP errors (might be temporary)
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      const result = (await response.json()) as AgentStatusResponse;
      console.log(`[Agent] Status: ${result.status}`);

      if (result.status === "completed") {
        console.log("[Agent] Job completed!");
        return result;
      }

      if (result.status === "failed") {
        throw new Error("Agent job failed");
      }

      // Still processing, wait and retry
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      // Handle network errors with retry
      if (
        error instanceof Error &&
        (error.message.includes("ECONNRESET") ||
          error.message.includes("fetch failed"))
      ) {
        console.log(`[Agent] Network error, retrying... (${error.message})`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs * 2));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Agent job timed out after 10 minutes");
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json(
        { success: false, error: "URL is required" },
        { status: 400 },
      );
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid URL format" },
        { status: 400 },
      );
    }

    // Get API key from environment
    const apiKey = process.env.FIRECRAWL_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "No Firecrawl API key configured." },
        { status: 400 },
      );
    }

    // Use Firecrawl agent to extract AND generate the complete skill package
    const agentPrompt = `You are a Claude Code skill generator. Analyze this API documentation and generate a complete Claude Code skill package.

CRITICAL INSTRUCTIONS:
- You MUST explore the ENTIRE documentation site, not just the landing page
- Navigate to ALL endpoint pages, API reference sections, and subpages
- Look for navigation menus, sidebars, and links to find ALL available endpoints
- Do NOT rely on cached or outdated information - fetch the latest documentation
- Generate COMPLETE, ready-to-use markdown files with CURL examples (NOT Python scripts)

Return a JSON object with:

1. "serviceName": The name of the service/API (e.g., "Firecrawl", "Stripe", "OpenAI")

2. "serviceDescription": A VERY DETAILED and comprehensive description (5-10 sentences) that fully explains:
   - What this API/service does and its primary purpose
   - ALL the main capabilities and features it offers
   - What types of tasks/problems it solves
   - Key use cases and when someone would use this API
   - Any unique features or strengths
   This description should be detailed enough that a model reading ONLY this description understands everything the skill can do.

3. "hasDocumentation": true if this is API/developer docs, false otherwise

4. "skillMd": A complete SKILL.md file with:
   - YAML frontmatter with name (lowercase-with-hyphens) and a comprehensive description (same detailed description as serviceDescription)
   - "## When to Use" section with detailed scenarios explaining when Claude should use this skill
   - "## Available References" section listing all reference files with their paths (references/filename.md) and a brief description of what each contains
   - "## Authentication" section with environment variable name (SERVICE_NAME_API_KEY format) and how to use it
   - DO NOT include a Quick Examples section - just reference the markdown files

5. "references": An array of reference markdown files. IMPORTANT GROUPING RULES:
   - GROUP related endpoints into a SINGLE file (e.g., all scrape operations in scrape.md, all batch operations in batch.md, all crawl operations in crawl.md)
   - Do NOT create separate files for each HTTP method on the same resource (e.g., batch_scrape.md and batch_scrape_get.md should be combined into batch.md)
   - Each file should be named after the main concept/feature (scrape.md, crawl.md, map.md, search.md, agent.md, batch.md, etc.)
   - Always include a "common.md" for authentication, base URL, errors, and rate limits

   Each reference file should contain ALL related endpoints with:
   - A clear title describing the feature/capability
   - Detailed explanation of what this feature does and when to use it
   - For EACH endpoint in the file:
     - "### [Endpoint Name]" as a subsection
     - Method and full path
     - Comprehensive description of what it does, when to use it, and what it returns
     - Complete parameters table with name, type, required, description, and default values
     - A complete, working CURL example (only ONE example per endpoint)
     - Response example with explanation of key fields (maximum 2 response examples if showing different states like "in progress" vs "completed")
   - At the end of each reference file, include a "## Use Cases" section with MAXIMUM 3 bullet points

   The "common.md" should contain:
   - "## Authentication" with detailed instructions on how to authenticate
   - "## Base URL" for all requests
   - "## Rate Limits" with specific limits if documented
   - "## Error Handling" with all error codes and what they mean
   - "## SDKs" if any official SDKs are mentioned

6. "endpoints": Array of ALL endpoint previews for UI display, each with:
   - "name": Endpoint name in snake_case
   - "description": Detailed description (2-3 sentences) of what this endpoint does and when to use it
   - "method": HTTP method
   - "path": Endpoint path

IMPORTANT: Be extremely thorough - explore every page of the documentation. Extract ALL endpoints including any new or recently added ones. Do not miss any endpoints. Group related endpoints logically into consolidated reference files.`;

    const schema = {
      type: "object",
      properties: {
        serviceName: {
          type: "string",
          description: "Name of the service/API",
        },
        serviceDescription: {
          type: "string",
          description:
            "Very detailed description (5-10 sentences) covering all capabilities, features, use cases, and strengths of the API",
        },
        hasDocumentation: {
          type: "boolean",
          description: "Whether the page contains actual API documentation",
        },
        skillMd: {
          type: "string",
          description:
            "Complete SKILL.md with YAML frontmatter, When to Use, Available References (with paths), and Authentication sections. No Quick Examples.",
        },
        references: {
          type: "array",
          description:
            "Consolidated reference files grouping related endpoints (e.g., scrape.md, crawl.md, batch.md, common.md)",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "Filename grouping related endpoints (scrape.md, batch.md, common.md)",
              },
              content: {
                type: "string",
                description: "Complete markdown content for this reference",
              },
            },
          },
        },
        endpoints: {
          type: "array",
          description: "All endpoints for UI display",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Endpoint name in snake_case",
              },
              description: {
                type: "string",
                description:
                  "Detailed description (2-3 sentences) of what this endpoint does and when to use it",
              },
              method: {
                type: "string",
                description: "HTTP method",
              },
              path: {
                type: "string",
                description: "Endpoint path",
              },
            },
          },
        },
      },
      required: [
        "serviceName",
        "serviceDescription",
        "hasDocumentation",
        "skillMd",
        "references",
        "endpoints",
      ],
    };

    // Start the Firecrawl agent job
    console.log(`[Agent] Starting job for URL: ${url}`);
    const agentResponse = await fetch("https://api.firecrawl.dev/v2/agent", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        urls: [url],
        prompt: agentPrompt,
        schema,
      }),
    });

    if (!agentResponse.ok) {
      const errorText = await agentResponse.text();
      throw new Error(
        `Firecrawl API error: ${agentResponse.status} - ${errorText}`,
      );
    }

    const jobResponse = (await agentResponse.json()) as AgentJobResponse;
    console.log(`[Agent] Job response:`, JSON.stringify(jobResponse));

    if (!jobResponse.success || !jobResponse.id) {
      return NextResponse.json(
        {
          success: false,
          error: jobResponse.error || "Failed to start agent job",
        },
        { status: 500 },
      );
    }

    // Poll for job completion
    const result = await pollAgentStatus(jobResponse.id, apiKey);

    if (!result.success || !result.data) {
      return NextResponse.json(
        { success: false, error: "Failed to analyze documentation" },
        { status: 500 },
      );
    }

    const skillPackage = result.data;
    console.log(
      `[Agent] Generated skill package for: ${skillPackage.serviceName}`,
    );

    // Check if documentation was found
    if (!skillPackage.hasDocumentation) {
      return NextResponse.json({
        success: true,
        data: {
          hasDocumentation: false,
          message:
            "No API documentation found at this URL. Please provide a link to developer/API documentation.",
          sourceUrl: url,
        },
      });
    }

    // Return the generated skill package
    const serviceSlug = skillPackage.serviceName
      .toLowerCase()
      .replace(/\s+/g, "-");

    return NextResponse.json({
      success: true,
      data: {
        hasDocumentation: true,
        serviceName: skillPackage.serviceName,
        serviceDescription: skillPackage.serviceDescription,
        skillFolderName: `${serviceSlug}-skill`,
        files: {
          skillMd: skillPackage.skillMd,
          references: skillPackage.references,
        },
        endpoints: skillPackage.endpoints,
        sourceUrl: url,
        creditsUsed: result.creditsUsed,
      },
    });
  } catch (error) {
    console.error("Skill generation error:", error);

    const errorMessage =
      error instanceof Error ? error.message : "An unexpected error occurred";

    if (errorMessage.includes("402") || errorMessage.includes("insufficient")) {
      return NextResponse.json(
        { success: false, error: "Insufficient Firecrawl credits." },
        { status: 402 },
      );
    }

    if (errorMessage.includes("401") || errorMessage.includes("unauthorized")) {
      return NextResponse.json(
        { success: false, error: "Invalid API key." },
        { status: 401 },
      );
    }

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 },
    );
  }
}
