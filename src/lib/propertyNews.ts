export type PropertyNewsSignal =
  | "development_plan"
  | "sale_or_listing"
  | "rezoning_or_land_use"
  | "litigation_or_distress"
  | "permit_or_construction"
  | "community_or_political"
  | "other";

export interface PropertyNewsArticle {
  title: string;
  source: string | null;
  url: string;
  publishedDate: string | null;
  snippet: string;
  signalType: PropertyNewsSignal;
  relevance: "high" | "medium" | "low";
}

export interface PropertyNewsContext {
  articles: PropertyNewsArticle[];
  query: string;
  searchedAt: number;
  sourceNotes: string[];
}

type ResponsesApiOutput = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

const NEWS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    articles: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          source: { type: ["string", "null"] },
          url: { type: "string" },
          publishedDate: { type: ["string", "null"] },
          snippet: { type: "string" },
          signalType: {
            type: "string",
            enum: [
              "development_plan",
              "sale_or_listing",
              "rezoning_or_land_use",
              "litigation_or_distress",
              "permit_or_construction",
              "community_or_political",
              "other",
            ],
          },
          relevance: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
        },
        required: ["title", "source", "url", "publishedDate", "snippet", "signalType", "relevance"],
      },
    },
  },
  required: ["articles"],
};

export async function fetchRecentPropertyNews({
  address,
  bbl,
  borough,
  block,
  lot,
  owner,
}: {
  address: string | null;
  bbl: string | null;
  borough: string | null;
  block: string | null;
  lot: string | null;
  owner: string | null;
}): Promise<PropertyNewsContext | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      articles: [],
      query: buildNewsQuery({ address, bbl, borough, block, lot, owner }),
      searchedAt: Date.now(),
      sourceNotes: ["Recent news lookup skipped because OPENAI_API_KEY is not set."],
    };
  }

  const query = buildNewsQuery({ address, bbl, borough, block, lot, owner });
  if (!address && !bbl) {
    return {
      articles: [],
      query,
      searchedAt: Date.now(),
      sourceNotes: ["Recent news lookup skipped because the parcel has no address or BBL."],
    };
  }

  const model = process.env.OPENAI_NEWS_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
  const currentDate = new Date().toISOString().slice(0, 10);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        tools: [
          {
            type: "web_search",
            search_context_size: "low",
            user_location: {
              type: "approximate",
              country: "US",
              region: "New York",
              city: "New York",
              timezone: "America/New_York",
            },
          },
        ],
        tool_choice: "auto",
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: `You find recent, property-specific public information for NYC real estate acquisition analysis.

The current date is ${currentDate}.

Return only items that appear tied to the exact property, BBL, owner, immediate site, or a named development that clearly includes the property. Useful signals include development plans, assemblage, rezoning or land-use actions, sales/listings, lawsuits, foreclosure or distress, community board activity, and construction or permit news.

Do not include generic neighborhood articles unless they name the property, owner, block, lot, or project site. Prefer articles and official public pages from the last 36 months. Use older sources only if they describe still-relevant development plans.`,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Search for recent news or public activity about this NYC property and return JSON only.

Search query: ${query}
Address: ${address ?? "unknown"}
BBL: ${bbl ?? "unknown"}
Borough: ${borough ?? "unknown"}
Block: ${block ?? "unknown"}
Lot: ${lot ?? "unknown"}
Owner: ${owner ?? "unknown"}`,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "property_news_context",
            strict: true,
            schema: NEWS_SCHEMA,
          },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return newsFailure(query, `Recent news lookup failed (${res.status}): ${body.slice(0, 160)}`);
    }

    const json = await res.json() as ResponsesApiOutput;
    const text = extractOutputText(json);
    if (!text) return newsFailure(query, "Recent news lookup returned no text.");

    const parsed = JSON.parse(text) as { articles?: PropertyNewsArticle[] };
    return {
      articles: normalizeArticles(parsed.articles ?? []),
      query,
      searchedAt: Date.now(),
      sourceNotes: [],
    };
  } catch (error) {
    return newsFailure(query, error instanceof Error ? error.message : "Recent news lookup failed.");
  }
}

function buildNewsQuery({
  address,
  bbl,
  borough,
  block,
  lot,
  owner,
}: {
  address: string | null;
  bbl: string | null;
  borough: string | null;
  block: string | null;
  lot: string | null;
  owner: string | null;
}): string {
  const terms = [
    address ? `"${address}"` : null,
    bbl ? `"${bbl}"` : null,
    borough && block && lot ? `"block ${block}" "lot ${lot}" ${borough}` : null,
    owner ? `"${owner}"` : null,
    "development OR rezoning OR permit OR foreclosure OR sale OR community board",
    "NYC",
  ].filter(Boolean);

  return terms.join(" ");
}

function newsFailure(query: string, message: string): PropertyNewsContext {
  return {
    articles: [],
    query,
    searchedAt: Date.now(),
    sourceNotes: [message],
  };
}

function normalizeArticles(articles: PropertyNewsArticle[]): PropertyNewsArticle[] {
  const seen = new Set<string>();
  const out: PropertyNewsArticle[] = [];

  for (const article of articles) {
    if (!article.url || seen.has(article.url)) continue;
    seen.add(article.url);
    out.push({
      title: article.title.slice(0, 180),
      source: article.source ? article.source.slice(0, 80) : null,
      url: article.url,
      publishedDate: article.publishedDate || null,
      snippet: article.snippet.slice(0, 360),
      signalType: article.signalType,
      relevance: article.relevance,
    });
  }

  return out;
}

function extractOutputText(response: ResponsesApiOutput): string | null {
  if (response.output_text) return response.output_text;

  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }

  return null;
}
