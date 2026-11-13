import { createResponse, formatResult, summarize } from "./bailian.mjs";

const modelProperty = {
  type: "string",
  description:
    "Optional Model Studio model id to run the tool call with. Defaults to the server's BAILIAN_MODEL.",
};

export const TOOLS = [
  {
    name: "web_search",
    title: "Web search (Model Studio)",
    description:
      "Search the live web through Alibaba Cloud Model Studio's built-in web_search tool. Returns a synthesized answer with source links. Use for news, prices, releases and anything after your training cutoff.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "What to search for, in natural language." },
        max_output_tokens: {
          type: "number",
          description: "Upper bound on the answer length in tokens (default 4096).",
        },
        model: modelProperty,
      },
    },
  },
  {
    name: "web_extract",
    title: "Web extractor (Model Studio)",
    description:
      "Fetch one or more URLs through Model Studio's web_extractor tool and return the extracted content, summarized for a given goal. Use when a page must be read rather than searched.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["urls"],
      properties: {
        urls: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Absolute http(s) URLs to extract.",
        },
        prompt: {
          type: "string",
          description: "What to pull out of the pages. Defaults to the main content.",
        },
        max_output_tokens: { type: "number" },
        model: modelProperty,
      },
    },
  },
  {
    name: "code_interpreter",
    title: "Code interpreter (Model Studio sandbox)",
    description:
      "Run Python in Model Studio's sandbox for calculations, data analysis, file parsing and charting. Send the task, not necessarily the code; returns the answer plus the executed code and output.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "The computation or analysis to perform, including any inline data.",
        },
        max_output_tokens: { type: "number" },
        model: modelProperty,
      },
    },
  },
  {
    name: "image_search",
    title: "Search by image (Model Studio)",
    description:
      "Reverse image search: find visually similar images or trace where an image comes from, using Model Studio's image_search tool.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["image_url"],
      properties: {
        image_url: { type: "string", description: "Public http(s) URL of the image to match." },
        query: {
          type: "string",
          description: "Optional guidance, e.g. 'find where this photo was published'.",
        },
        max_output_tokens: { type: "number" },
        model: modelProperty,
      },
    },
  },
  {
    name: "text_to_image_search",
    title: "Text-to-image search (Model Studio)",
    description:
      "Find images on the web from a text description using Model Studio's web_search_image tool. Use for visual answers, illustration hunting and image recommendations.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Description of the images to find." },
        max_output_tokens: { type: "number" },
        model: modelProperty,
      },
    },
  },
];

const HANDLERS = {
  async web_search(args) {
    const payload = await createResponse({
      input: args.query,
      tools: [{ type: "web_search" }],
      model: args.model,
      maxOutputTokens: args.max_output_tokens,
      instructions:
        "Search the web and answer the question with concrete, recently published facts. Cite the pages you used.",
    });
    return summarize(payload);
  },

  async web_extract(args) {
    const urls = args.urls.map((url) => url.trim()).filter(Boolean);
    const goal = args.prompt || "Extract the main content of each page.";
    const input = `${goal}\n\nPages:\n${urls.map((url) => `- ${url}`).join("\n")}`;
    const payload = await createResponse({
      input,
      // Model Studio rejects web_extractor unless web_search is requested too.
      tools: [{ type: "web_search" }, { type: "web_extractor" }],
      model: args.model,
      maxOutputTokens: args.max_output_tokens,
    });
    return summarize(payload);
  },

  async code_interpreter(args) {
    const payload = await createResponse({
      input: args.task,
      tools: [{ type: "code_interpreter" }],
      model: args.model,
      maxOutputTokens: args.max_output_tokens,
      instructions:
        "Solve the task with Python in the sandbox, then report the result briefly and show the values you computed.",
    });
    return summarize(payload);
  },

  async image_search(args) {
    const text = args.query || "Find visually similar images and say what they show.";
    const payload = await createResponse({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text },
            { type: "input_image", image_url: args.image_url },
          ],
        },
      ],
      tools: [{ type: "image_search" }],
      model: args.model,
      maxOutputTokens: args.max_output_tokens,
    });
    return summarize(payload);
  },

  async text_to_image_search(args) {
    const payload = await createResponse({
      input: args.query,
      tools: [{ type: "web_search_image" }],
      model: args.model,
      maxOutputTokens: args.max_output_tokens,
    });
    return summarize(payload);
  },
};

export async function callTool(name, args = {}) {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}. Available tools: ${Object.keys(HANDLERS).join(", ")}`);
  }
  const summary = await handler(args);
  return { summary, text: formatResult(summary, { title: name }) };
}