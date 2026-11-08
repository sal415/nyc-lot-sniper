import type { AIReport, AIPacket } from "./types";

type ResponsesApiOutput = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    recommendation: {
      type: "string",
      enum: ["Strong acquisition candidate", "Worth pursuing", "Low probability deal", "Likely skip"],
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 100,
    },
    why: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 6,
    },
    risks: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 5,
    },
    opportunityType: {
      type: "string",
      enum: [
        "Vacant development site",
        "Teardown candidate",
        "Assemblage opportunity",
        "Air rights / underbuilt multifamily",
        "Low-quality opportunity",
      ],
    },
    acquisitionStrategy: {
      type: "string",
    },
  },
  required: ["recommendation", "why", "risks", "opportunityType", "acquisitionStrategy", "confidence"],
};

export async function generateParcelReport(packet: AIPacket): Promise<AIReport> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
  const currentDate = new Date().toISOString().slice(0, 10);
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `You are an NYC real estate development analyst focused on identifying actionable acquisition opportunities.

The current date is ${currentDate}.

You must think like a developer evaluating whether to pursue a deal.

Use ONLY the provided parcel data. Do NOT assume missing data. Explicitly flag unknowns.

This is decision support, not legal, zoning, tax, or investment advice.

---

## ANALYSIS FRAMEWORK (VERY IMPORTANT)

Evaluate the parcel using these priorities (in order):

1. DEVELOPMENT POTENTIAL
- How much can be built? (max buildable sf)
- How underbuilt is it? (underbuilt ratio, unused FAR)
- Is the scale meaningful? (unused buildable sf)

2. FEASIBILITY
- Zoning quality (R6A vs R7A etc.)
- Lot usability (size, frontage if known)
- Building class (vacant vs teardown vs difficult asset)

3. ACQUISITION LIKELIHOOD
- Ownership duration (long-term ownership = positive)
- ACRIS activity (recent sale = negative)
- ACRIS legal distress filings such as tax liens, multiple liens, lis pendens, judgments, and foreclosure-related filings = possible motivated-seller signal, but verify title/current status
- Development activity (permits = negative)
- Distress signals (DOF open property charges, ACRIS legal filings, DOB/HPD violations)

4. MARKET SUPPORT
- Nearby comps ($/sf or land value)
- Evidence of nearby development
- Transit / location signals
- Recent property-specific news/public activity, if provided, such as development plans, land-use actions, sales/listings, litigation/distress, or community-board activity

---

## OUTPUT FORMAT (STRICT)

Return:

### 1. VERDICT (one line)
Choose ONE:
- Strong acquisition candidate
- Worth pursuing
- Low probability deal
- Likely skip

---

### 2. WHY (3-6 bullets, MOST IMPORTANT FACTORS ONLY)
Focus ONLY on the highest impact signals.

---

### 3. RISKS (3-5 bullets)
What could kill or weaken the deal?

---

### 4. OPPORTUNITY TYPE
Choose ONE:
- Vacant development site
- Teardown candidate
- Assemblage opportunity
- Air rights / underbuilt multifamily
- Low-quality opportunity

---

### 5. ACQUISITION STRATEGY (VERY IMPORTANT)
How would a developer realistically approach this?

Examples:
- Direct outreach to owner
- Target for assemblage
- Monitor for distress
- Prioritize outreach if ACRIS distress filings and meaningful development upside align
- Skip due to low motivation

---

### 6. CONFIDENCE (0-100)
How confident are you in this analysis given the available data?

---

## RULES

- Do NOT restate all data - synthesize it
- Prioritize signal over completeness
- Treat recentNews items as useful leads, not verified facts; cite/source them in plain language when they affect the recommendation
- If something is missing, explicitly say "unknown"
- Be decisive - avoid vague language
- Think like capital is at risk

---

Your goal is to answer:

"Is this a real, actionable development opportunity - and what would I do next?"`,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Analyze this parcel opportunity and return only JSON matching the requested report sections:\n${JSON.stringify(packet, null, 2)}`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "parcel_opportunity_report",
          strict: true,
          schema: REPORT_SCHEMA,
        },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI report failed (${res.status}): ${body.slice(0, 240)}`);
  }

  const json = await res.json() as ResponsesApiOutput;
  const text = extractOutputText(json);
  if (!text) throw new Error("OpenAI returned no report text.");

  const report = JSON.parse(text) as Omit<AIReport, "generatedAt" | "model">;
  return {
    ...report,
    generatedAt: Date.now(),
    model,
  };
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
