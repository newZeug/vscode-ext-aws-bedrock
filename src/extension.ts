import * as vscode from 'vscode';
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message,
  type SystemContentBlock,
  type ContentBlock,
  type ConverseStreamCommandInput,
  type Tool,
  type ImageBlock,
  type ImageSource,
  ImageFormat,
} from '@aws-sdk/client-bedrock-runtime';
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';

const VENDOR = 'bedrock';
const SECRET_KEY = 'awsBedrock.apiKey';

interface ModelDef extends ModelMetadata {
  id: string;
  name: string;
  bedrockId: string;
}

// ---------------------------------------------------------------------------
// Pricing + context metadata keyed by pattern match on the model's bedrockId.
// Source: https://aws.amazon.com/bedrock/pricing/ (us-east-1 on-demand, per 1M tokens)
// The Bedrock API does not expose token limits or pricing.
// ---------------------------------------------------------------------------
interface ModelMetadata {
  maxInputTokens: number;
  maxOutputTokens: number;
  /** USD per 1M input tokens */
  inputCostPerMillion: number;
  /** USD per 1M output tokens */
  outputCostPerMillion: number;
  /** USD per 1M cache read tokens */
  cacheCostPerMillion?: number;
  /** USD per 1M cache write tokens */
  cacheWriteCostPerMillion?: number;
  supportsThinking: boolean;
  supportsImages: boolean;
}

const PRICING_TABLE: { pattern: RegExp; meta: ModelMetadata }[] = [
  // ── Anthropic Claude 4.x ──────────────────────────────────────────────────
  // Claude Sonnet 4 / 4.5 / 4.6  →  $3.00 / $15.00, cache: $0.30 read / $3.75 write, 200k ctx, 64k out
  { pattern: /claude-sonnet-4/, meta: { maxInputTokens: 200_000, maxOutputTokens: 64_000, inputCostPerMillion: 3.0, outputCostPerMillion: 15.0, cacheCostPerMillion: 0.30, cacheWriteCostPerMillion: 3.75, supportsThinking: true, supportsImages: true } },
  // Claude Opus 4.x  →  $5.00 / $25.00, cache: $0.50 read / $6.25 write, 200k ctx, 32k out
  { pattern: /claude-opus-4/, meta: { maxInputTokens: 200_000, maxOutputTokens: 32_000, inputCostPerMillion: 5.0, outputCostPerMillion: 25.0, cacheCostPerMillion: 0.50, cacheWriteCostPerMillion: 6.25, supportsThinking: true, supportsImages: true } },
  // Claude Haiku 4.5  →  $1.00 / $5.00, cache: $0.10 read / $1.25 write, 200k ctx
  { pattern: /claude-haiku-4/, meta: { maxInputTokens: 200_000, maxOutputTokens: 8_192, inputCostPerMillion: 1.0, outputCostPerMillion: 5.0, cacheCostPerMillion: 0.10, cacheWriteCostPerMillion: 1.25, supportsThinking: false, supportsImages: true } },
  // Claude Fable 5  →  $10.00 / $50.00, cache: $1.00 read / $12.50 write, 200k ctx
  { pattern: /claude-fable-5/, meta: { maxInputTokens: 200_000, maxOutputTokens: 32_000, inputCostPerMillion: 10.0, outputCostPerMillion: 50.0, cacheCostPerMillion: 1.0, cacheWriteCostPerMillion: 12.50, supportsThinking: true, supportsImages: true } },

  // ── Anthropic Claude 3.x ──────────────────────────────────────────────────
  // Claude 3.5 Sonnet v2  →  $3.00 / $15.00, cache: $0.30 read / $3.75 write
  { pattern: /claude-3-5-sonnet-20241022/, meta: { maxInputTokens: 200_000, maxOutputTokens: 8_192, inputCostPerMillion: 3.0, outputCostPerMillion: 15.0, cacheCostPerMillion: 0.30, cacheWriteCostPerMillion: 3.75, supportsThinking: false, supportsImages: true } },
  // Claude 3.5 Sonnet  →  $3.00 / $15.00, cache: $0.30 read / $3.75 write
  { pattern: /claude-3-5-sonnet/, meta: { maxInputTokens: 200_000, maxOutputTokens: 8_192, inputCostPerMillion: 3.0, outputCostPerMillion: 15.0, cacheCostPerMillion: 0.30, cacheWriteCostPerMillion: 3.75, supportsThinking: false, supportsImages: true } },
  // Claude 3.5 Haiku  →  $0.80 / $4.00, cache: $0.08 read / $1.00 write
  { pattern: /claude-3-5-haiku/, meta: { maxInputTokens: 200_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.8, outputCostPerMillion: 4.0, cacheCostPerMillion: 0.08, cacheWriteCostPerMillion: 1.0, supportsThinking: false, supportsImages: true } },
  // Claude 3 Opus  →  $15.00 / $75.00, cache: $1.50 read / $18.75 write
  { pattern: /claude-3-opus/, meta: { maxInputTokens: 200_000, maxOutputTokens: 4_096, inputCostPerMillion: 15.0, outputCostPerMillion: 75.0, cacheCostPerMillion: 1.50, cacheWriteCostPerMillion: 18.75, supportsThinking: false, supportsImages: true } },
  // Claude 3 Sonnet  →  $3.00 / $15.00, cache: $0.30 read / $3.75 write
  { pattern: /claude-3-sonnet/, meta: { maxInputTokens: 200_000, maxOutputTokens: 4_096, inputCostPerMillion: 3.0, outputCostPerMillion: 15.0, cacheCostPerMillion: 0.30, cacheWriteCostPerMillion: 3.75, supportsThinking: false, supportsImages: true } },
  // Claude 3 Haiku  →  $0.25 / $1.25, cache: $0.03 read / $0.30 write
  { pattern: /claude-3-haiku/, meta: { maxInputTokens: 200_000, maxOutputTokens: 4_096, inputCostPerMillion: 0.25, outputCostPerMillion: 1.25, cacheCostPerMillion: 0.03, cacheWriteCostPerMillion: 0.30, supportsThinking: false, supportsImages: true } },

  // ── Amazon Nova ───────────────────────────────────────────────────────────
  // Nova 2 Lite  →  $0.30 / $2.50, 300k ctx (supports images)
  { pattern: /nova-2-lite|nova-lite-2/, meta: { maxInputTokens: 300_000, maxOutputTokens: 5_120, inputCostPerMillion: 0.30, outputCostPerMillion: 2.50, supportsThinking: false, supportsImages: true } },
  // Nova 2 Pro  →  $1.25 / $1.25, 300k ctx (supports images)
  { pattern: /nova-2-pro|nova-pro-2/, meta: { maxInputTokens: 300_000, maxOutputTokens: 5_120, inputCostPerMillion: 1.25, outputCostPerMillion: 1.25, supportsThinking: false, supportsImages: true } },
  // Nova Pro  →  $0.80 / $3.20, 300k ctx (supports images)
  { pattern: /nova-pro/, meta: { maxInputTokens: 300_000, maxOutputTokens: 5_120, inputCostPerMillion: 0.80, outputCostPerMillion: 3.20, supportsThinking: false, supportsImages: true } },
  // Nova Lite  →  $0.06 / $0.24, 300k ctx (supports images)
  { pattern: /nova-lite/, meta: { maxInputTokens: 300_000, maxOutputTokens: 5_120, inputCostPerMillion: 0.06, outputCostPerMillion: 0.24, supportsThinking: false, supportsImages: true } },
  // Nova Micro  →  $0.035 / $0.14, 128k ctx (text-only)
  { pattern: /nova-micro/, meta: { maxInputTokens: 128_000, maxOutputTokens: 5_120, inputCostPerMillion: 0.035, outputCostPerMillion: 0.14, supportsThinking: false, supportsImages: false } },

  // ── Meta Llama ────────────────────────────────────────────────────────────
  // Llama 4 Maverick  →  $0.24 / $0.97, 1M ctx (supports images)
  { pattern: /llama4.*maverick|llama-4.*maverick/, meta: { maxInputTokens: 1_000_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.24, outputCostPerMillion: 0.97, supportsThinking: false, supportsImages: true } },
  // Llama 4 Scout  →  $0.17 / $0.66, 10M ctx (supports images)
  { pattern: /llama4.*scout|llama-4.*scout/, meta: { maxInputTokens: 10_000_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.17, outputCostPerMillion: 0.66, supportsThinking: false, supportsImages: true } },
  // Llama 3.3 70B  →  $0.72 / $0.72, 128k ctx
  { pattern: /llama3-3|llama-3-3|llama3\.3|llama-3\.3/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.72, outputCostPerMillion: 0.72, supportsThinking: false, supportsImages: false } },
  // Llama 3.2 90B  →  $0.72 / $0.72, 128k ctx (supports images)
  { pattern: /llama3-2.*90b|llama-3-2.*90b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.72, outputCostPerMillion: 0.72, supportsThinking: false, supportsImages: true } },
  // Llama 3.2 11B  →  $0.16 / $0.16, 128k ctx (supports images)
  { pattern: /llama3-2.*11b|llama-3-2.*11b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.16, outputCostPerMillion: 0.16, supportsThinking: false, supportsImages: true } },
  // Llama 3.2 3B  →  $0.15 / $0.15, 128k ctx
  { pattern: /llama3-2.*3b|llama-3-2.*3b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.15, outputCostPerMillion: 0.15, supportsThinking: false, supportsImages: false } },
  // Llama 3.2 1B  →  $0.10 / $0.10, 128k ctx
  { pattern: /llama3-2.*1b|llama-3-2.*1b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.10, outputCostPerMillion: 0.10, supportsThinking: false, supportsImages: false } },
  // Llama 3.1 405B  →  $5.32 / $16.00, 128k ctx
  { pattern: /llama3-1.*405b|llama-3-1.*405b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 5.32, outputCostPerMillion: 16.0, supportsThinking: false, supportsImages: false } },
  // Llama 3.1 70B  →  $0.99 / $0.99, 128k ctx
  { pattern: /llama3-1.*70b|llama-3-1.*70b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.99, outputCostPerMillion: 0.99, supportsThinking: false, supportsImages: false } },
  // Llama 3.1 8B  →  $0.22 / $0.22, 128k ctx
  { pattern: /llama3-1.*8b|llama-3-1.*8b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.22, outputCostPerMillion: 0.22, supportsThinking: false, supportsImages: false } },

  // ── Mistral AI ────────────────────────────────────────────────────────────
  // Mistral Large 3  →  $0.50 / $1.50, 128k ctx
  { pattern: /mistral-large-3|mistral-large-2.*|mistral-large$/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.50, outputCostPerMillion: 1.50, supportsThinking: false, supportsImages: false } },
  // Mistral Small 3.x / Magistral Small  →  $0.10 / $0.30, 32k ctx
  { pattern: /mistral-small|magistral-small/, meta: { maxInputTokens: 32_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.10, outputCostPerMillion: 0.30, supportsThinking: false, supportsImages: false } },
  // Pixtral Large  →  $2.00 / $6.00, 128k ctx (supports images)
  { pattern: /pixtral-large/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, inputCostPerMillion: 2.0, outputCostPerMillion: 6.0, supportsThinking: false, supportsImages: true } },
  // Mistral 7B / Ministral  →  $0.15 / $0.20, 32k ctx
  { pattern: /mistral-7b|ministral/, meta: { maxInputTokens: 32_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.15, outputCostPerMillion: 0.20, supportsThinking: false, supportsImages: false } },
  // Mixtral 8x7B  →  $0.45 / $0.70, 32k ctx
  { pattern: /mixtral-8x7b/, meta: { maxInputTokens: 32_000, maxOutputTokens: 8_192, inputCostPerMillion: 0.45, outputCostPerMillion: 0.70, supportsThinking: false, supportsImages: false } },
];

const DEFAULT_METADATA: ModelMetadata = { maxInputTokens: 128_000, maxOutputTokens: 4_096, inputCostPerMillion: 1.0, outputCostPerMillion: 5.0, cacheCostPerMillion: 0.10, cacheWriteCostPerMillion: 1.25, supportsThinking: false, supportsImages: false };

function getModelMetadata(bedrockId: string): ModelMetadata {
  const lower = bedrockId.toLowerCase();
  return PRICING_TABLE.find(entry => entry.pattern.test(lower))?.meta ?? DEFAULT_METADATA;
}

// ---------------------------------------------------------------------------
// Dynamic model cache — refreshed at activation and on demand.
// Falls back to a minimal hardcoded list if the API call fails.
// ---------------------------------------------------------------------------
const FALLBACK_MODELS: ModelDef[] = [
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Bedrock)', bedrockId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', ...getModelMetadata('claude-sonnet-4-5') },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Bedrock)', bedrockId: 'us.anthropic.claude-sonnet-4-6-20251031-v1:0', ...getModelMetadata('claude-sonnet-4-6') },
];

let cachedModels: ModelDef[] = FALLBACK_MODELS;
let modelCacheTime = 0;
const MODEL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getRegion(): string {
  return vscode.workspace.getConfiguration('awsBedrock').get<string>('region') ?? 'us-east-1';
}

async function fetchModels(apiKey: string): Promise<ModelDef[]> {
  // We use a standard Bedrock management client pointed at us-east-1 (region
  // doesn't matter for ListFoundationModels / ListInferenceProfiles).
  const client = new BedrockClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' },
  });

  // Inject Bearer token the same way as the runtime client.
  client.middlewareStack.add(
    (next) => async (args) => {
      const req = (args as { request: { headers: Record<string, string> } }).request;
      if (req?.headers) {
        delete req.headers['authorization'];
        delete req.headers['Authorization'];
        delete req.headers['x-amz-date'];
        delete req.headers['x-amz-security-token'];
        delete req.headers['x-amz-content-sha256'];
        req.headers['authorization'] = `Bearer ${apiKey}`;
      }
      return next(args);
    },
    { step: 'finalizeRequest', name: 'bearerAuth', priority: 'low' }
  );

  const models: ModelDef[] = [];
  const seen = new Set<string>();

  // 1. Cross-region inference profiles (the "us." prefix models recommended for
  //    production use). These reflect the actual deployable model IDs.
  try {
    const profilesResp = await client.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED' }));
    for (const p of profilesResp.inferenceProfileSummaries ?? []) {
      const bedrockId = p.inferenceProfileId;
      const rawName = p.inferenceProfileName;
      if (!bedrockId || !rawName) { continue; }
      // Only surface text-generation models (skip embedding / image models)
      const lower = bedrockId.toLowerCase();
      if (!lower.includes('claude') && !lower.includes('nova') && !lower.includes('llama') && !lower.includes('mistral')) { continue; }

      const meta = getModelMetadata(bedrockId);
      // Derive a clean ID without the cross-region prefix and version suffix
      const id = bedrockId.replace(/^(us|eu|ap)\./, '').replace(/(-v\d+:\d+|-v\d+)$/, '');
      if (seen.has(id)) { continue; }
      seen.add(id);

      models.push({
        id,
        name: rawName,
        bedrockId,
        ...meta,
      });
    }
  } catch {
    // Inference profiles not available; fall through to foundation models
  }

  // 2. Foundation models as supplemental source (gives models not in profiles)
  try {
    const fmResp = await client.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }));
    for (const fm of fmResp.modelSummaries ?? []) {
      const bedrockId = fm.modelId;
      const rawName = fm.modelName;
      if (!bedrockId || !rawName) { continue; }
      // Skip embedding models and non-streaming models
      if (!fm.responseStreamingSupported) { continue; }
      // Derive clean ID
      const id = bedrockId.replace(/^(us|eu|ap)\./, '').replace(/(-v\d+:\d+|-v\d+)$/, '');
      if (seen.has(id)) { continue; }
      seen.add(id);

      const meta = getModelMetadata(bedrockId);

      models.push({
        id,
        name: `${rawName} (${fm.providerName ?? 'AWS'})`,
        bedrockId,
        ...meta,
      });
    }
  } catch {
    // Ignore; we may already have models from profiles
  }

  return models.length > 0 ? models : FALLBACK_MODELS;
}

async function getModels(secrets: vscode.SecretStorage): Promise<ModelDef[]> {
  const now = Date.now();
  if (cachedModels.length > 0 && (now - modelCacheTime) < MODEL_CACHE_TTL) {
    return cachedModels;
  }
  const apiKey = await secrets.get(SECRET_KEY);
  if (!apiKey) { return FALLBACK_MODELS; }
  try {
    cachedModels = await fetchModels(apiKey);
    modelCacheTime = Date.now();
  } catch {
    // Keep existing cache on error
  }
  return cachedModels;
}

// ---------------------------------------------------------------------------
// Persistent cost tracking
// ---------------------------------------------------------------------------
const COST_STATE_KEY = 'awsBedrock.totalCostUSD';

class CostTracker {
  private totalCost = 0;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private state: vscode.Memento) {
    this.totalCost = state.get<number>(COST_STATE_KEY) ?? 0;
  }

  get total(): number { return this.totalCost; }

  add(inputTokens: number, outputTokens: number, meta: ModelMetadata): void {
    const cost =
      (inputTokens / 1_000_000) * meta.inputCostPerMillion +
      (outputTokens / 1_000_000) * meta.outputCostPerMillion;
    this.totalCost += cost;
    this.state.update(COST_STATE_KEY, this.totalCost);
    this._onDidChange.fire();
  }

  reset(): void {
    this.totalCost = 0;
    this.state.update(COST_STATE_KEY, 0);
    this._onDidChange.fire();
  }

  formatTotal(): string {
    return `$${this.totalCost.toFixed(2)}`;
  }
}

class BedrockProvider implements vscode.LanguageModelChatProvider {
  private secrets: vscode.SecretStorage;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private costTracker: CostTracker;

  constructor(secrets: vscode.SecretStorage, costTracker: CostTracker) {
    this.secrets = secrets;
    this.costTracker = costTracker;
  }

  /** Refresh the model list and notify VS Code to re-query. */
  async refresh(): Promise<void> {
    modelCacheTime = 0; // invalidate cache
    await getModels(this.secrets);
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(
    _options: { silent: boolean },
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const models = await getModels(this.secrets);
    return models.map(m => {
      const ctxK = Math.round(m.maxInputTokens / 1000);
      const inCost = m.inputCostPerMillion ?? 1.0;
      const outCost = m.outputCostPerMillion ?? 5.0;
      const cacheCost = m.cacheCostPerMillion;
      const cacheWriteCost = m.cacheWriteCostPerMillion;
      
      const tooltipParts = [
        `Context: ${ctxK}k tokens`,
        `Input: $${inCost} / Output: $${outCost} per 1M tokens`,
        cacheCost && cacheWriteCost ? `Cache: $${cacheCost} read / $${cacheWriteCost} write per 1M tokens` : '',
        m.supportsImages ? 'Supports image input' : 'Text only',
        m.supportsThinking ? 'Supports extended thinking' : '',
      ].filter(Boolean);

      // Build pricing label: VS Code displays the `pricing` string in the Language Models view.
      // The inputCost/outputCost/cacheCost/cacheWriteCost fields are shown in the hover tooltip.
      const pricingLabel = `In: $${inCost} · Out: $${outCost} per 1M tokens`;

      const info: vscode.LanguageModelChatInformation & Record<string, unknown> = {
        id: m.id,
        name: m.name,
        family: deriveFamily(m.bedrockId),
        version: '1.0.0',
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        detail: `${ctxK}k ctx · $${inCost}/$${outCost}`,
        tooltip: tooltipParts.join('\n'),
        capabilities: {
          toolCalling: true,
          imageInput: m.supportsImages ?? false,
        } as vscode.LanguageModelChatCapabilities,
        // Pricing fields for Language Models view (proposed API: languageModelPricing)
        pricing: pricingLabel,
        inputCost: inCost,
        outputCost: outCost,
        cacheCost: cacheCost,
        cacheWriteCost: cacheWriteCost,
        isBYOK: true,
      };
      return info;
    });
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiKey = await this.secrets.get(SECRET_KEY);
    if (!apiKey) {
      throw new Error('No AWS Bedrock API key configured. Run "AWS Bedrock: Configure API Key & Region" from the Command Palette.');
    }

    const allModels = await getModels(this.secrets);
    const entry = allModels.find(m => m.id === model.id) ?? allModels[0];
    const { bedrockMessages, system, tools } = convertMessages(messages, options);

    if (bedrockMessages.length === 0) {
      return;
    }

    // Add prompt caching to system blocks (mark last block as cacheable)
    const systemWithCaching = system.length > 0 ? system.map((block, idx) => {
      if (idx === system.length - 1) {
        return { ...block, cacheControl: { type: 'ephemeral' as const } };
      }
      return block;
    }) : undefined;

    // Extract thinking effort from modelOptions (VS Code sets this via the thinking slider)
    // Bedrock maps effort via performanceConfig.latency: "standard" | "optimized"
    const thinkingEffort = options.modelOptions?.['thinkingEffort'] as string | undefined;
    const additionalModelFields: Record<string, unknown> = {};
    if (thinkingEffort && entry.supportsThinking) {
      // Map VS Code effort levels ("low","medium","high") to Bedrock latency values
      const latency = thinkingEffort === 'high' ? 'standard' : 'optimized';
      additionalModelFields['performanceConfig'] = { latency };
    }

    // Tool choice: respect toolMode (auto vs required vs none)
    let toolChoice: ConverseStreamCommandInput['toolConfig'] = undefined;
    if (tools.length > 0) {
      const mode = options.toolMode;
      if (mode === vscode.LanguageModelChatToolMode.Required) {
        toolChoice = { tools, toolChoice: { any: {} } };
      } else {
        toolChoice = { tools, toolChoice: { auto: {} } };
      }
    }

    const input: ConverseStreamCommandInput = {
      modelId: entry.bedrockId,
      messages: bedrockMessages,
      system: systemWithCaching,
      inferenceConfig: { maxTokens: entry.maxOutputTokens },
      toolConfig: toolChoice,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      additionalModelRequestFields: Object.keys(additionalModelFields).length > 0 ? additionalModelFields as any : undefined,
    };

    const client = new BedrockRuntimeClient({
      region: getRegion(),
      credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' },
    });

    // Replace SigV4 auth with Bearer token
    client.middlewareStack.add(
      (next) => async (args) => {
        const req = (args as { request: { headers: Record<string, string> } }).request;
        if (req?.headers) {
          delete req.headers['authorization'];
          delete req.headers['Authorization'];
          delete req.headers['x-amz-date'];
          delete req.headers['x-amz-security-token'];
          delete req.headers['x-amz-content-sha256'];
          req.headers['authorization'] = `Bearer ${apiKey}`;
        }
        return next(args);
      },
      { step: 'finalizeRequest', name: 'bearerAuth', priority: 'low' }
    );

    const response = await client.send(new ConverseStreamCommand(input));
    if (!response.stream) { return; }

    // Track in-flight tool calls: Bedrock streams tool input as incremental JSON
    // string chunks. We must accumulate them and emit a single LanguageModelToolCallPart
    // once the block is complete (contentBlockStop).
    interface PendingTool { callId: string; name: string; inputJson: string; }
    const pendingTools = new Map<number, PendingTool>();

    for await (const event of response.stream) {
      if (token.isCancellationRequested) { break; }

      if (event.contentBlockDelta?.delta?.text) {
        progress.report(new vscode.LanguageModelTextPart(event.contentBlockDelta.delta.text));
      }

      if (event.contentBlockStart?.start?.toolUse) {
        const toolUse = event.contentBlockStart.start.toolUse;
        const idx = event.contentBlockStart.contentBlockIndex ?? 0;
        if (toolUse.toolUseId && toolUse.name) {
          pendingTools.set(idx, { callId: toolUse.toolUseId, name: toolUse.name, inputJson: '' });
        }
      }

      if (event.contentBlockDelta?.delta?.toolUse?.input) {
        const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
        const pending = pendingTools.get(idx);
        if (pending) {
          pending.inputJson += event.contentBlockDelta.delta.toolUse.input;
        }
      }

      if (event.contentBlockStop !== undefined) {
        const idx = event.contentBlockStop.contentBlockIndex ?? 0;
        const pending = pendingTools.get(idx);
        if (pending) {
          let parsedInput: object = {};
          try {
            parsedInput = pending.inputJson ? JSON.parse(pending.inputJson) : {};
          } catch {
            parsedInput = { _raw: pending.inputJson };
          }
          progress.report(new vscode.LanguageModelToolCallPart(pending.callId, pending.name, parsedInput));
          pendingTools.delete(idx);
        }
      }

      // Bedrock emits usage totals in the metadata event at the end of the stream
      if (event.metadata?.usage) {
        const inputTokens = event.metadata.usage.inputTokens ?? 0;
        const outputTokens = event.metadata.usage.outputTokens ?? 0;

        // Accumulate persistent cost
        this.costTracker.add(inputTokens, outputTokens, entry);

        // Report usage to VS Code via LanguageModelDataPart.
        // The MIME type must be 'usage' (CustomDataPartMimeTypes.Usage in VS Code internals).
        // The data format must match APIUsage (OpenAI-style) so the context-window circle updates.
        const usageData = {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        };
        progress.report(
          new vscode.LanguageModelDataPart(
            new TextEncoder().encode(JSON.stringify(usageData)),
            'usage'
          )
        );
      }
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const str = typeof text === 'string' ? text : extractText(text);
    return Math.ceil(str.length / 4);
  }
}

function extractText(msg: vscode.LanguageModelChatRequestMessage): string {
  if (!Array.isArray(msg.content)) { return ''; }
  return msg.content
    .map((p: unknown) => {
      const cp = p as Record<string, unknown>;
      if (typeof cp?.['value'] === 'string') { return cp['value'] as string; }
      return '';
    })
    .join('');
}

/** Map a MIME type string to the Bedrock ImageFormat enum value, or null if unsupported. */
function mimeToBedrockFormat(mime: string): typeof ImageFormat[keyof typeof ImageFormat] | null {
  switch (mime.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return ImageFormat.JPEG;
    case 'image/png':
      return ImageFormat.PNG;
    case 'image/gif':
      return ImageFormat.GIF;
    case 'image/webp':
      return ImageFormat.WEBP;
    default:
      return null;
  }
}

/**
 * Convert a single VS Code chat message to one or more Bedrock content blocks.
 * Returns null for System messages (handled separately).
 */
function convertMessageContent(
  msg: vscode.LanguageModelChatRequestMessage
): { role: 'user' | 'assistant'; content: ContentBlock[] } | { system: true; text: string } | null {
  const role =
    msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' :
    msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' :
    'system';

  const content: ContentBlock[] = [];

  if (!Array.isArray(msg.content)) {
    // Plain string content (legacy)
    const text = typeof (msg.content as unknown) === 'string' ? (msg.content as unknown as string).trim() : '';
    if (!text) { return null; }
    if (role === 'system') { return { system: true, text }; }
    return { role, content: [{ text }] };
  }

  for (const part of msg.content) {
    // Use duck-typing instead of instanceof to handle parts originating from
    // VS Code core (different prototype chain than this extension's vscode module).
    const p = part as Record<string, unknown>;
    if (typeof p?.['value'] === 'string' && !('callId' in p)) {
      // LanguageModelTextPart: { value: string }
      const text = (p['value'] as string).trim();
      if (text) { content.push({ text }); }
    } else if (p && 'data' in p && 'mimeType' in p) {
      // LanguageModelDataPart: { data: Uint8Array, mimeType: string }
      const mimeType = p['mimeType'] as string;
      if (mimeType.startsWith('image/')) {
        const fmt = mimeToBedrockFormat(mimeType);
        if (fmt) {
          const imageSource: ImageSource = { bytes: p['data'] as Uint8Array };
          const imageBlock: ImageBlock = { format: fmt, source: imageSource };
          content.push({ image: imageBlock });
        }
      }
      // Non-image data parts are silently skipped (no Bedrock equivalent)
    } else if (p && 'callId' in p && 'name' in p && 'input' in p) {
      // LanguageModelToolCallPart: { callId, name, input }
      content.push({
        toolUse: {
          toolUseId: p['callId'] as string,
          name: p['name'] as string,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: p['input'] as any,
        },
      });
    } else if (p && 'callId' in p && 'content' in p && Array.isArray(p['content'])) {
      // LanguageModelToolResultPart: { callId, content: [...] }
      const resultText = (p['content'] as unknown[])
        .map((c: unknown) => {
          const cp = c as Record<string, unknown>;
          if (typeof cp?.['value'] === 'string') { return cp['value'] as string; }
          return '';
        })
        .join('');
      content.push({
        toolResult: {
          toolUseId: p['callId'] as string,
          content: [{ text: resultText }],
        },
      });
    }
  }

  if (content.length === 0) { return null; }
  if (role === 'system') {
    // System messages can only be text
    const texts = content.filter((c): c is { text: string } => 'text' in c).map(c => c.text).join('\n');
    return texts ? { system: true, text: texts } : null;
  }
  return { role: role as 'user' | 'assistant', content };
}

function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions
) {
  const system: SystemContentBlock[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: ContentBlock[] }> = [];

  for (const msg of messages) {
    const result = convertMessageContent(msg);
    if (!result) { continue; }
    if ('system' in result) {
      system.push({ text: result.text });
    } else {
      turns.push(result);
    }
  }

  // Merge consecutive same-role turns
  const merged: Array<{ role: 'user' | 'assistant'; content: ContentBlock[] }> = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) {
      last.content.push(...t.content);
    } else {
      merged.push({ role: t.role, content: [...t.content] });
    }
  }

  // Bedrock requires first message to be user
  if (merged.length > 0 && merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: [{ text: '(continued)' }] });
  }

  const bedrockMessages: Message[] = merged.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // Convert VS Code tools to Bedrock format
  const tools: Tool[] = (options.tools ?? []).map(tool => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        json: (tool.inputSchema as any) ?? { type: 'object', properties: {} },
      },
    },
  } satisfies Tool));

  return { bedrockMessages, system, tools };
}

function deriveFamily(bedrockId: string): string {
  const lower = bedrockId.toLowerCase();
  if (lower.includes('claude')) { return 'claude'; }
  if (lower.includes('nova')) { return 'nova'; }
  if (lower.includes('llama')) { return 'llama'; }
  if (lower.includes('mistral')) { return 'mistral'; }
  if (lower.includes('titan')) { return 'titan'; }
  return 'unknown';
}

// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  // Cost tracker — persists in globalState across all sessions
  const costTracker = new CostTracker(context.globalState);

  // Build the rich MarkdownString tooltip shown on hover.
  //
  // VS Code's MarkdownString sanitizer only allows `style` on <span> elements
  // with exactly: color, background-color, border-radius. Everything else
  // (padding, margin, font-size, font-weight, div, etc.) is stripped by DOMPurify.
  // The hover widget itself provides its own internal padding — we cannot add more.
  // Use pure Markdown structure: bold, separators, icons, and allowed span colours.
  const buildTooltip = (): vscode.MarkdownString => {
    const region = getRegion();
    const md = new vscode.MarkdownString('', true);
    md.supportHtml = true;

    // ── Header ──────────────────────────────────────────────────────────────
    md.appendMarkdown(`$(cloud) **AWS Bedrock**\n\n`);
    md.appendMarkdown(`---\n\n`);

    // ── Cost ────────────────────────────────────────────────────────────────
    // Label in muted colour, cost in green — only color/background-color/border-radius
    // are allowed on <span> by the sanitizer.
    md.appendMarkdown(
      `<span style="color:var(--vscode-descriptionForeground);">Estimated total spend</span>\n\n`
    );
    md.appendMarkdown(
      `**<span style="color:var(--vscode-charts-green);">${costTracker.formatTotal()}</span>**\n\n`
    );
    md.appendMarkdown(`---\n\n`);

    // ── Region ───────────────────────────────────────────────────────────────
    md.appendMarkdown(
      `$(globe) <span style="color:var(--vscode-descriptionForeground);">Region</span> — **${region}**\n\n`
    );
    md.appendMarkdown(`---\n\n`);

    // ── Actions ──────────────────────────────────────────────────────────────
    md.appendMarkdown(
      `[$(key) Update API Key](command:awsBedrock.updateApiKey) \u2002 ` +
      `[$(globe) Change Region](command:awsBedrock.changeRegion) \u2002 ` +
      `[$(trash) Reset](command:awsBedrock.resetCost)`
    );

    md.isTrusted = {
      enabledCommands: [
        'awsBedrock.resetCost',
        'awsBedrock.updateApiKey',
        'awsBedrock.changeRegion',
      ],
    };
    return md;
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = 'AWS Bedrock Cost';
  const updateStatusBar = () => {
    statusBar.text = `$(cloud) ${costTracker.formatTotal()}`;
    statusBar.tooltip = buildTooltip();
  };
  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);
  context.subscriptions.push(costTracker.onDidChange(updateStatusBar));

  const provider = new BedrockProvider(context.secrets, costTracker);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('awsBedrock.configure', async () => {
      await runSetup(context.secrets);
      await provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('awsBedrock.updateApiKey', async () => {
      const updated = await runUpdateApiKey(context.secrets);
      if (updated) {
        await provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('awsBedrock.changeRegion', async () => {
      const changed = await runSelectRegion();
      if (changed) {
        await provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('awsBedrock.refreshModels', async () => {
      await provider.refresh();
      vscode.window.showInformationMessage('AWS Bedrock: Model list refreshed.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('awsBedrock.resetCost', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Reset AWS Bedrock cost tracker? This cannot be undone.',
        { modal: true }, 'Reset'
      );
      if (confirm === 'Reset') {
        costTracker.reset();
      }
    })
  );

  // First-run prompt
  context.secrets.get(SECRET_KEY).then(key => {
    if (!key) {
      vscode.window.showInformationMessage(
        'AWS Bedrock: No API key configured. Set up now?',
        'Configure', 'Later'
      ).then(answer => {
        if (answer === 'Configure') {
          runSetup(context.secrets).then(() => provider.refresh());
        }
      });
    } else {
      // Pre-warm model cache in the background
      provider.refresh().catch(() => { /* ignore */ });
    }
  });
}

async function runSetup(secrets: vscode.SecretStorage): Promise<void> {
  const changedRegion = await runSelectRegion();
  if (!changedRegion) { return; }

  const changedApiKey = await runUpdateApiKey(secrets);
  if (!changedApiKey) { return; }
}

async function runSelectRegion(): Promise<boolean> {
  // Region
  const regions = ['us-east-1', 'us-west-2', 'eu-central-1', 'eu-west-1', 'ap-northeast-1', 'ap-southeast-2'];
  const current = getRegion();
  const picked = await vscode.window.showQuickPick(
    regions.map(r => ({ label: r, picked: r === current })),
    { title: 'AWS Bedrock: Select Region', placeHolder: current }
  );
  if (!picked) { return false; }
  await vscode.workspace.getConfiguration('awsBedrock').update('region', picked.label, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`AWS Bedrock region updated: ${picked.label}`);
  return true;
}

async function runUpdateApiKey(secrets: vscode.SecretStorage): Promise<boolean> {
  // API Key
  const apiKey = await vscode.window.showInputBox({
    title: 'AWS Bedrock: Update API Key',
    prompt: 'Enter your Bedrock long-term API key',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => v.trim() ? undefined : 'API key is required',
  });
  if (!apiKey) { return false; }
  await secrets.store(SECRET_KEY, apiKey.trim());

  vscode.window.showInformationMessage('AWS Bedrock API key updated.');
  return true;
}

export function deactivate(): void {}
