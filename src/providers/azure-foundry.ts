import * as vscode from 'vscode';
import OpenAI from 'openai';
import { type ModelDef } from '../models';
import { createModelInformation, extractMessageText, reportUsage } from './provider';
import type { IProvider, UsageEvent } from './provider';
import { getAzureEndpoint, SECRET_KEYS } from '../config';
import { createAbortController } from '../cancellation';
import type { ProviderLogger } from '../diagnostics';

interface AzureModelDef extends ModelDef {
  modelId: string;
}

const AZURE_MODELS: AzureModelDef[] = [
  { id: 'gpt-5.6-sol', modelId: 'gpt-5.6-sol', name: 'OpenAI GPT-5.6 Sol', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true },
  { id: 'gpt-5.6-terra', modelId: 'gpt-5.6-terra', name: 'OpenAI GPT-5.6 Terra', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true },
  { id: 'gpt-5.6-luna', modelId: 'gpt-5.6-luna', name: 'OpenAI GPT-5.6 Luna', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true },
  { id: 'gpt-5.3-codex', modelId: 'gpt-5.3-codex', name: 'OpenAI GPT-5.3 Codex', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: false },
  { id: 'gpt-5.4-mini', modelId: 'gpt-5.4-mini', name: 'OpenAI GPT-5.4 Mini', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true },
  { id: 'gpt-5.4-pro', modelId: 'gpt-5.4-pro', name: 'OpenAI GPT-5.4 Pro', maxInputTokens: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true, supportsImages: true },
];

const THINKING_EFFORT_SCHEMA = {
  properties: {
    thinkingEffort: {
      type: 'string',
      title: 'Thinking Effort',
      enum: ['low', 'medium', 'high'],
      enumItemLabels: ['Low', 'Medium', 'High'],
      enumDescriptions: [
        'Faster responses with less reasoning',
        'Balanced reasoning and speed',
        'Greater reasoning depth but slower',
      ],
      default: 'medium',
      group: 'navigation',
    },
  },
} as const;

type AzureMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | AzureContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: AzureToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

interface AzureContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface AzureToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface AzureTool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) { binary += String.fromCharCode(bytes[i]); }
  return btoa(binary);
}

function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
): { azureMessages: AzureMessage[]; tools: AzureTool[] } {
  const azureMessages: AzureMessage[] = [];

  for (const msg of messages) {
    const role =
      msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' :
        msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system';

    if (!Array.isArray(msg.content)) {
      const text = typeof (msg.content as unknown) === 'string' ? (msg.content as unknown as string).trim() : '';
      if (text) { azureMessages.push({ role: role as 'user' | 'system', content: text }); }
      continue;
    }

    const toolResults: AzureMessage[] = [];
    const toolCalls: AzureToolCall[] = [];
    const contentParts: AzureContentPart[] = [];

    for (const part of msg.content) {
      const p = part as Record<string, unknown>;

      if (p && 'callId' in p && 'content' in p && Array.isArray(p['content'])) {
        const resultText = (p['content'] as unknown[])
          .map(c => { const cp = c as Record<string, unknown>; return typeof cp?.['value'] === 'string' ? cp['value'] as string : ''; })
          .join('');
        toolResults.push({ role: 'tool', content: resultText, tool_call_id: p['callId'] as string });

      } else if (p && 'callId' in p && 'name' in p && 'input' in p) {
        toolCalls.push({
          id: p['callId'] as string,
          type: 'function',
          function: { name: p['name'] as string, arguments: JSON.stringify(p['input']) },
        });

      } else if (p && 'data' in p && 'mimeType' in p) {
        const mime = p['mimeType'] as string;
        if (mime.startsWith('image/')) {
          const b64 = uint8ToBase64(p['data'] as Uint8Array);
          contentParts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
        }

      } else if (typeof p?.['value'] === 'string' && !('callId' in p)) {
        const text = (p['value'] as string).trim();
        if (text) { contentParts.push({ type: 'text', text }); }
      }
    }

    if (toolResults.length > 0) {
      azureMessages.push(...toolResults);
      continue;
    }

    if (toolCalls.length > 0) {
      azureMessages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
      continue;
    }

    if (contentParts.length === 0) { continue; }

    if (role === 'system') {
      const text = contentParts.filter(c => c.type === 'text').map(c => c.text!).join('\n');
      if (text) { azureMessages.push({ role: 'system', content: text }); }
      continue;
    }

    const hasImages = contentParts.some(c => c.type === 'image_url');
    if (!hasImages) {
      azureMessages.push({ role: role as 'user' | 'assistant', content: contentParts.map(c => c.text!).join('') });
    } else {
      azureMessages.push({ role: 'user', content: contentParts });
    }
  }

  const merged: AzureMessage[] = [];
  for (const m of azureMessages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role && m.role !== 'tool' && m.role !== 'assistant'
      && typeof last.content === 'string' && typeof m.content === 'string') {
      (last as { content: string }).content += '\n' + m.content;
      continue;
    }
    merged.push(m);
  }

  if (merged.length > 0 && merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: '(continued)' });
  }

  const tools: AzureTool[] = (options.tools ?? []).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.inputSchema as unknown) ?? { type: 'object', properties: {} },
    },
  }));

  return { azureMessages: merged, tools };
}

export class AzureFoundryProvider implements IProvider {
  readonly label = 'Azure AI Foundry';
  readonly vendor = 'azure-foundry';

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  private readonly _onUsage = new vscode.EventEmitter<UsageEvent>();
  readonly onUsage = this._onUsage.event;

  private readonly models: AzureModelDef[] = AZURE_MODELS;

  constructor(private readonly secrets: vscode.SecretStorage, private readonly logger?: ProviderLogger) { }

  async refresh(): Promise<void> {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._onUsage.dispose();
  }

  async provideLanguageModelChatInformation(
    _options: { silent: boolean },
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return this.models.map(m => {
      return createModelInformation(m, {
        family: m.modelId.toLowerCase().split(/[-_.]/)[0],
        configurationSchema: m.supportsThinking ? THINKING_EFFORT_SCHEMA : undefined,
      });
    });
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const endpoint = getAzureEndpoint();
    if (!endpoint) {
      throw new Error('Azure AI Foundry: no endpoint configured. Run "Azure AI Foundry: Update Endpoint" from the Command Palette.');
    }
    const apiKey = await this.secrets.get(SECRET_KEYS.azureApiKey);
    if (!apiKey) {
      throw new Error('Azure AI Foundry: no API key configured. Run "Azure AI Foundry: Update API Key" from the Command Palette.');
    }

    const entry = this.models.find(m => m.id === model.id);
    if (!entry) {
      throw new Error(`Azure AI Foundry: unknown model "${model.id}"`);
    }

    const { azureMessages, tools } = convertMessages(messages, options);
    if (azureMessages.length === 0) { return; }

    const toolChoice = tools.length > 0
      ? (options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto')
      : undefined;
    const thinkingEffort = options.modelOptions?.['thinkingEffort'] as string | undefined;

    const openai = new OpenAI({
      baseURL: endpoint,
      apiKey,
      defaultHeaders: { 'api-key': apiKey },
    });
    const abortController = createAbortController(token);
    this.logger?.info(`Azure AI Foundry: starting request for ${entry.id}`);

    const request: Record<string, unknown> = {
      model: entry.modelId,
      messages: azureMessages as any,
      stream: true,
      max_completion_tokens: entry.maxOutputTokens,
      tools: tools.length > 0 ? tools as any : undefined,
      tool_choice: toolChoice as any,
      stream_options: { include_usage: true },
    };
    if (entry.supportsThinking && thinkingEffort) {
      request['reasoning_effort'] = thinkingEffort;
    }

    const stream = (await openai.chat.completions.create(request as any, { signal: abortController.signal })) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    const pendingTools = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (token.isCancellationRequested) { break; }

      const choices = chunk.choices;
      if (choices && choices.length > 0) {
        const delta = choices[0].delta;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content) {
            progress.report(new vscode.LanguageModelTextPart(delta.content));
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (tc.id && tc.function?.name) {
                pendingTools.set(idx, {
                  id: tc.id,
                  name: tc.function.name,
                  args: tc.function.arguments ?? '',
                });
              } else if (tc.function?.arguments) {
                const existing = pendingTools.get(idx);
                if (existing) { existing.args += tc.function.arguments; }
              }
            }
          }
        }

        const finishReason = choices[0].finish_reason;
        if (finishReason === 'tool_calls' || (finishReason === 'stop' && pendingTools.size > 0)) {
          for (const [, tc] of pendingTools) {
            let parsedInput: object = {};
            try { parsedInput = tc.args ? JSON.parse(tc.args) : {}; }
            catch { parsedInput = { _raw: tc.args }; }
            progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.name, parsedInput));
          }
          pendingTools.clear();
        }
      }

      if (chunk.usage) {
        reportUsage(
          progress,
          event => this._onUsage.fire(event),
          entry,
          chunk.usage.prompt_tokens ?? 0,
          chunk.usage.completion_tokens ?? 0,
        );
      }
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const str = extractMessageText(text);
    return Math.ceil(str.length / 4);
  }
}
