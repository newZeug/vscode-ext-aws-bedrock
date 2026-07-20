export interface ParsedBedrockId {
  model: string;
  region: string | null;
  family: string;
  provider: string;
}

const PROVIDER_MAP: Record<string, string> = {
  anthropic: 'Anthropic', amazon: 'Amazon', meta: 'Meta', mistral: 'Mistral',
  ai21: 'AI21', cohere: 'Cohere', openai: 'OpenAI', nvidia: 'NVIDIA',
  qwen: 'Qwen', writer: 'Writer', twelvelabs: 'TwelveLabs', zai: 'Zai',
  deepseek: 'DeepSeek',
};

export function parseBedrockId(bedrockId: string): ParsedBedrockId {
  let region: string | null = null;
  let rest = bedrockId;
  const regionMatch = rest.match(/^(us|eu|ap)\./i);
  if (regionMatch) {
    region = regionMatch[1].toUpperCase();
    rest = rest.slice(regionMatch[0].length);
  } else if (/^global\./i.test(rest)) {
    region = 'GLOBAL';
    rest = rest.replace(/^global\./i, '');
  }

  const dotIdx = rest.indexOf('.');
  let providerKey = '';
  let rawModel = rest;
  if (dotIdx !== -1) {
    providerKey = rest.slice(0, dotIdx).toLowerCase();
    rawModel = rest.slice(dotIdx + 1);
  }
  const provider = PROVIDER_MAP[providerKey] ?? (providerKey ? providerKey.charAt(0).toUpperCase() + providerKey.slice(1) : 'AWS');

  rawModel = rawModel
    .replace(/-v\d+(?::\d+)?$/i, '')
    .replace(/:\d+[a-z]*$/i, '')
    .replace(/-(\d{8,}).*$/i, '');

  const model = rawModel
    .replace(/-(\d+)-(\d+)(?=-|$)/g, '-$1.$2')
    .replace(/(\d)\.(\d)/g, '$1~D~$2')
    .replace(/[-._]+/g, ' ')
    .replace(/~D~/g, '.')
    .trim()
    .replace(/\b\w+/g, w => {
      const l = w.toLowerCase();
      if (l === 'gpt' || l === 'oss' || l === 'glm' || l === 'vl') { return w.toUpperCase(); }
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });

  const lower = rawModel.toLowerCase();
  let family = 'unknown';
  if (lower.includes('claude')) { family = 'claude'; }
  else if (lower.includes('nova')) { family = 'nova'; }
  else if (lower.includes('llama')) { family = 'llama'; }
  else if (lower.includes('mistral')) { family = 'mistral'; }
  else if (lower.includes('titan')) { family = 'titan'; }

  return { model, region, family, provider };
}

export function formatModelName(parsed: ParsedBedrockId): string {
  return parsed.region
    ? `${parsed.provider} ${parsed.model} [${parsed.region}]`
    : `${parsed.provider} ${parsed.model}`;
}

export interface ModelMetadata {
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsImages: boolean;
}

export interface ModelDef extends ModelMetadata {
  modelId: string;
  name: string;
  provider: 'aws' | 'azure';
}

export const MODEL_CATALOG: ModelDef[] = [
  { modelId: 'gpt-5.6-sol', name: 'OpenAI GPT-5.6 Sol', provider: 'azure', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true },
  { modelId: 'gpt-5.6-terra', name: 'OpenAI GPT-5.6 Terra', provider: 'azure', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true },
  { modelId: 'gpt-5.6-luna', name: 'OpenAI GPT-5.6 Luna', provider: 'azure', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true },
  { modelId: 'gpt-5-mini', name: 'OpenAI GPT-5 Mini', provider: 'azure', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true },
];

export const MODEL_METADATA_RULES: { pattern: RegExp; meta: ModelMetadata }[] = [
  { pattern: /claude-fable-5/, meta: { maxInputTokens: 200_000, maxOutputTokens: 32_000, supportsThinking: true, supportsImages: true } },
  { pattern: /claude-sonnet-5/, meta: { maxInputTokens: 200_000, maxOutputTokens: 32_000, supportsThinking: true, supportsImages: true } },

  { pattern: /claude-sonnet-4/, meta: { maxInputTokens: 200_000, maxOutputTokens: 64_000, supportsThinking: true, supportsImages: true } },
  { pattern: /claude-opus-4/, meta: { maxInputTokens: 200_000, maxOutputTokens: 32_000, supportsThinking: true, supportsImages: true } },
  { pattern: /claude-haiku-4/, meta: { maxInputTokens: 200_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: true } },

  { pattern: /claude-3-5-sonnet-20241022/, meta: { maxInputTokens: 200_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: true } },
  { pattern: /claude-3-5-sonnet/, meta: { maxInputTokens: 200_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: true } },
  { pattern: /claude-3-5-haiku/, meta: { maxInputTokens: 200_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: true } },

  { pattern: /claude-3-opus/, meta: { maxInputTokens: 200_000, maxOutputTokens: 4_096, supportsThinking: false, supportsImages: true } },
  { pattern: /claude-3-sonnet/, meta: { maxInputTokens: 200_000, maxOutputTokens: 4_096, supportsThinking: false, supportsImages: true } },
  { pattern: /claude-3-haiku/, meta: { maxInputTokens: 200_000, maxOutputTokens: 4_096, supportsThinking: false, supportsImages: true } },

  { pattern: /nova-2-lite|nova-lite-2/, meta: { maxInputTokens: 300_000, maxOutputTokens: 5_120, supportsThinking: false, supportsImages: true } },
  { pattern: /nova-2-pro|nova-pro-2/, meta: { maxInputTokens: 300_000, maxOutputTokens: 5_120, supportsThinking: false, supportsImages: true } },
  { pattern: /nova-pro/, meta: { maxInputTokens: 300_000, maxOutputTokens: 5_120, supportsThinking: false, supportsImages: true } },
  { pattern: /nova-lite/, meta: { maxInputTokens: 300_000, maxOutputTokens: 5_120, supportsThinking: false, supportsImages: true } },
  { pattern: /nova-micro/, meta: { maxInputTokens: 128_000, maxOutputTokens: 5_120, supportsThinking: false, supportsImages: false } },

  { pattern: /llama4.*maverick|llama-4.*maverick/, meta: { maxInputTokens: 1_000_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: true } },
  { pattern: /llama4.*scout|llama-4.*scout/, meta: { maxInputTokens: 10_000_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: true } },

  { pattern: /llama3-3|llama-3-3|llama3\.3|llama-3\.3/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },
  { pattern: /llama3-2.*90b|llama-3-2.*90b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: true } },
  { pattern: /llama3-2.*11b|llama-3-2.*11b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: true } },
  { pattern: /llama3-2.*3b|llama-3-2.*3b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },
  { pattern: /llama3-2.*1b|llama-3-2.*1b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },
  { pattern: /llama3-1.*405b|llama-3-1.*405b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },
  { pattern: /llama3-1.*70b|llama-3-1.*70b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },
  { pattern: /llama3-1.*8b|llama-3-1.*8b/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },

  { pattern: /mistral-large-3|mistral-large-2.*|mistral-large$/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },
  { pattern: /mistral-small|magistral-small/, meta: { maxInputTokens: 32_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },
  { pattern: /pixtral-large/, meta: { maxInputTokens: 128_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: true } },
  { pattern: /mistral-7b|ministral/, meta: { maxInputTokens: 32_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },
  { pattern: /mixtral-8x7b/, meta: { maxInputTokens: 32_000, maxOutputTokens: 8_192, supportsThinking: false, supportsImages: false } },

  { pattern: /gpt-5\.6-sol/i, meta: { maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true } },
  { pattern: /gpt-5\.6-terra/i, meta: { maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true } },
  { pattern: /gpt-5\.6-luna/i, meta: { maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true } },
  { pattern: /gpt-5\.4-pro/i, meta: { maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true } },
  { pattern: /gpt-5\.4-mini/i, meta: { maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true } },
  { pattern: /gpt-5\.3-codex/i, meta: { maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: false } },
  { pattern: /gpt-5-mini/i, meta: { maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true } },
  { pattern: /gpt-4o-mini/i, meta: { maxInputTokens: 128_000, maxOutputTokens: 16_384, supportsThinking: false, supportsImages: true } },
  { pattern: /gpt-4o/i, meta: { maxInputTokens: 128_000, maxOutputTokens: 4_096, supportsThinking: false, supportsImages: true } },
  { pattern: /o1-mini/i, meta: { maxInputTokens: 128_000, maxOutputTokens: 65_536, supportsThinking: true, supportsImages: false } },
  { pattern: /o1-preview|o1$/i, meta: { maxInputTokens: 128_000, maxOutputTokens: 32_768, supportsThinking: true, supportsImages: false } },
  { pattern: /o3-mini/i, meta: { maxInputTokens: 200_000, maxOutputTokens: 100_000, supportsThinking: true, supportsImages: false } },
];

export const DEFAULT_METADATA: ModelMetadata = {
  maxInputTokens: 128_000,
  maxOutputTokens: 4_096,
  supportsThinking: false,
  supportsImages: false,
};

export function getModelMetadata(bedrockId: string): ModelMetadata {
  const normalized = bedrockId
    .toLowerCase()
    .replace(/^(us|eu|ap)\./i, '')
    .replace(/\.?global\./i, '.')
    .replace(/^global\./i, '')
    .replace(/^[a-z0-9-]+\./, '')
    .replace(/^\./, '');
  return MODEL_METADATA_RULES.find(e => e.pattern.test(normalized))?.meta ?? DEFAULT_METADATA;
}

