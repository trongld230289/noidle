import type { HookInput } from './speech';

type HookQuestion = NonNullable<NonNullable<HookInput['tool_input']>['questions']>[number];

export interface VoiceQuestion extends HookQuestion {
  allowFreeform?: boolean;
  key?: string;
  /** Aligned with options; never substitute spoken labels for these values. */
  values?: unknown[];
  valueType?: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  required?: boolean;
}

export interface AgentHookInput extends HookInput {
  session_id?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  prompt?: string;
  agent_id?: string;
  agent_type?: string;
  initial_prompt?: string;
  tool_input?: Omit<NonNullable<HookInput['tool_input']>, 'questions'> & { questions?: VoiceQuestion[] };
  /** A nonempty reason means the whole ask_user form must be answered manually. */
  question_fallback_reason?: string;
  [key: string]: unknown;
}

const EVENTS = new Map([
  ['sessionStart', 'SessionStart'], ['userPromptSubmitted', 'UserPromptSubmit'], ['agentStop', 'Stop'],
  ['permissionRequest', 'PermissionRequest'], ['preToolUse', 'PreToolUse'], ['notification', 'Notification'],
]);
const TOOLS = new Map([
  ['powershell', 'Bash'], ['bash', 'Bash'], ['view', 'Read'], ['edit', 'Edit'],
  ['apply_patch', 'Edit'], ['str_replace_editor', 'Edit'], ['create', 'Write'],
  ['grep', 'Grep'], ['rg', 'Grep'], ['glob', 'Glob'], ['ask_user', 'AskUserQuestion'],
  ['web_fetch', 'WebFetch'], ['update_todo', 'TodoWrite'], ['task', 'Agent'],
]);
const FILE_TOOLS = new Set(['view', 'edit', 'apply_patch', 'str_replace_editor', 'create']);
const RESERVED_TOOLS = new Set([...TOOLS.values(), 'LS', 'WebSearch', 'Task', 'MultiEdit', 'NotebookEdit']);
const has = (record: Record<string, unknown>, key: string) => Object.hasOwn(record, key);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkStrings(record: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (has(record, key) && typeof record[key] !== 'string') throw new Error(`Invalid Copilot ${key}: expected a string`);
  }
}

function eventName(event: string, hookName: unknown): string {
  const name = event || hookName;
  if (typeof name === 'string') {
    if ([...EVENTS.values()].includes(name)) return name;
    const mapped = EVENTS.get(name);
    if (mapped) return mapped;
  }
  throw new Error('Invalid Copilot hook event');
}

function toolArguments(raw: Record<string, unknown>): Record<string, unknown> {
  if (has(raw, 'toolInput') === has(raw, 'toolArgs')) throw new Error('Expected exactly one of toolInput or toolArgs');
  const field = has(raw, 'toolInput') ? 'toolInput' : 'toolArgs';
  let value = raw[field];
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(`Invalid Copilot ${field}: malformed JSON`);
    }
  }
  if (!isRecord(value)) throw new Error(`Invalid Copilot ${field}: expected an object`);
  return { ...value };
}

export function normalizeCopilotInput(value: unknown, event: string): { source: 'copilot' | 'copilot-cli'; input: AgentHookInput } {
  if (!isRecord(value)) throw new Error('Invalid Copilot hook input: expected a record');
  const isCli = has(value, 'sessionId');
  if (isCli === has(value, 'session_id')) throw new Error('Missing or mixed Copilot session identity');
  if (isCli ? !nonempty(value.sessionId) : typeof value.session_id !== 'string') {
    throw new Error('Invalid Copilot session identity');
  }
  checkStrings(value, ['cwd', 'prompt', 'message', 'title']);
  if (has(value, 'stop_hook_active') && typeof value.stop_hook_active !== 'boolean') {
    throw new Error('Invalid Copilot stop_hook_active: expected a boolean');
  }
  if (!isCli) {
    checkStrings(value, ['transcript_path', 'hook_event_name', 'notification_type', 'tool_name', 'initial_prompt', 'agent_id', 'agent_type']);
    if (has(value, 'tool_input') && !isRecord(value.tool_input)) throw new Error('Invalid Copilot tool_input: expected an object');
    return { source: 'copilot', input: { ...value, hook_event_name: value.hook_event_name as string ?? eventName(event, undefined) } };
  }

  checkStrings(value, ['transcriptPath', 'hookName', 'notificationType', 'toolName', 'initialPrompt', 'agentId', 'agentType']);
  for (const key of ['tool_name', 'tool_input', 'transcript_path', 'initial_prompt', 'agent_id', 'agent_type']) {
    if (has(value, key)) throw new Error(`Mixed Copilot CLI field: ${key}`);
  }
  const input: AgentHookInput = { ...value, session_id: value.sessionId as string, hook_event_name: eventName(event, value.hookName) };
  delete input.question_fallback_reason;
  for (const [from, to] of [
    ['transcriptPath', 'transcript_path'], ['initialPrompt', 'initial_prompt'],
    ['agentId', 'agent_id'], ['agentType', 'agent_type'], ['notificationType', 'notification_type'],
  ]) {
    if (has(value, from)) input[to] = value[from];
  }
  if (has(value, 'toolName') || has(value, 'toolInput') || has(value, 'toolArgs')) {
    if (!nonempty(value.toolName)) throw new Error('Invalid Copilot toolName');
    // Unknown native tools must not inherit approval privileges from Claude's trusted names.
    if (!TOOLS.has(value.toolName) && RESERVED_TOOLS.has(value.toolName)) throw new Error(`Unsupported Copilot CLI tool: ${value.toolName}`);
    input.tool_name = TOOLS.get(value.toolName) ?? value.toolName;
    const args = toolArguments(value);
    if (FILE_TOOLS.has(value.toolName)) {
      checkStrings(args, ['path', 'file_path']);
      if (has(args, 'path') && has(args, 'file_path') && args.path !== args.file_path) {
        throw new Error('Conflicting Copilot path and file_path');
      }
      if (has(args, 'path')) args.file_path = args.path;
    }
    input.tool_input = args;
    if (value.toolName === 'ask_user') {
      const parsed = parseQuestions(args);
      input.tool_input.questions = parsed.questions;
      if (parsed.reason) input.question_fallback_reason = parsed.reason;
    }
  }
  return { source: 'copilot-cli', input };
}

function parseQuestions(args: Record<string, unknown>): { questions: VoiceQuestion[]; reason?: string } {
  try {
    if (has(args, 'requestedSchema')) {
      if (has(args, 'question') || has(args, 'choices') || has(args, 'allow_freeform')) {
        throw new Error('Mixed standard and structured ask_user forms');
      }
      if (!nonempty(args.message)) throw new Error('Structured ask_user requires a message');
      return { questions: structuredQuestions(args.requestedSchema) };
    }
    if (!nonempty(args.question)) throw new Error('ask_user requires a question');
    if (has(args, 'allow_freeform') && typeof args.allow_freeform !== 'boolean') throw new Error('Invalid allow_freeform');
    const choices = has(args, 'choices') ? stringChoices(args.choices, 'choices') : [];
    const allowFreeform = args.allow_freeform !== false;
    if (!choices.length && !allowFreeform) throw new Error('ask_user has no available answers');
    return {
      questions: [{ question: args.question, options: choices.map((label) => ({ label })), multiSelect: false, allowFreeform }],
    };
  } catch (error) {
    return { questions: [], reason: error instanceof Error ? error.message : 'Unsupported ask_user form' };
  }
}

function stringChoices(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || !value.every(nonempty)) throw new Error(`${location}: expected string choices`);
  if (new Set(value.map((label) => label.trim().toLowerCase())).size !== value.length) {
    throw new Error(`${location}: ambiguous duplicate choices`);
  }
  return value;
}

function schemaRecord(value: unknown, allowed: string[], location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${location}: expected a schema object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${location}: unsupported schema keyword ${key}`);
  }
  for (const key of ['title', 'description']) {
    if (has(value, key) && !nonempty(value[key])) throw new Error(`${location}: invalid ${key}`);
  }
  return value;
}

function structuredQuestions(value: unknown): VoiceQuestion[] {
  const root = schemaRecord(value, ['type', 'title', 'description', 'properties', 'required', 'additionalProperties'], 'requestedSchema');
  if (has(root, 'type') && root.type !== 'object') throw new Error('requestedSchema: expected object type');
  if (has(root, 'additionalProperties') && typeof root.additionalProperties !== 'boolean') {
    throw new Error('requestedSchema: unsupported additionalProperties');
  }
  if (!isRecord(root.properties) || !Object.keys(root.properties).length) throw new Error('requestedSchema: expected nonempty properties');
  const required = has(root, 'required') ? stringChoices(root.required, 'required') : [];
  if (required.some((key) => !has(root.properties as Record<string, unknown>, key))) {
    throw new Error('requestedSchema: required references an unknown property');
  }
  return Object.entries(root.properties).map(([key, schema]) => {
    if (!nonempty(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Unsafe schema property: ${key}`);
    const property = schemaRecord(schema, ['type', 'title', 'description', 'enum', 'oneOf', 'items'], key);
    const question: VoiceQuestion = {
      key, question: (property.description ?? property.title ?? key) as string, required: required.includes(key),
      options: [], multiSelect: false, allowFreeform: false,
    };
    if (has(property, 'title')) question.header = property.title as string;
    if (property.type === 'array') {
      if (has(property, 'enum') || has(property, 'oneOf')) throw new Error(`${key}: unsupported array choices`);
      const items = schemaRecord(property.items, ['type', 'title', 'description', 'enum', 'anyOf'], `${key}.items`);
      Object.assign(question, schemaChoices(items, 'anyOf', `${key}.items`), { multiSelect: true, valueType: 'array' });
    } else {
      if (has(property, 'items')) throw new Error(`${key}: items requires array type`);
      if (has(property, 'enum') || has(property, 'oneOf')) {
        Object.assign(question, schemaChoices(property, 'oneOf', key), { valueType: 'string' });
      } else if (property.type === 'boolean') {
        Object.assign(question, { options: [{ label: 'Yes' }, { label: 'No' }], values: [true, false], valueType: 'boolean' });
      } else if (['string', 'number', 'integer'].includes(property.type as string)) {
        Object.assign(question, { allowFreeform: true, valueType: property.type });
      } else {
        throw new Error(`${key}: unsupported schema type`);
      }
    }
    return question;
  });
}

function schemaChoices(schema: Record<string, unknown>, variants: 'oneOf' | 'anyOf', location: string): Pick<VoiceQuestion, 'options' | 'values'> {
  if (has(schema, 'type') && schema.type !== 'string') throw new Error(`${location}: choices must be strings`);
  if (has(schema, 'enum') === has(schema, variants)) throw new Error(`${location}: expected exactly one choice schema`);
  let values: string[];
  let labels: string[];
  if (has(schema, 'enum')) {
    values = stringChoices(schema.enum, location);
    labels = values;
  } else {
    const entries = schema[variants];
    if (!Array.isArray(entries)) throw new Error(`${location}: invalid ${variants}`);
    const choices = entries.map((entry, index) => {
      const where = `${location}.${variants}[${index}]`;
      const branch = schemaRecord(entry, ['type', 'const', 'enum', 'title', 'description'], where);
      if (has(branch, 'type') && branch.type !== 'string') throw new Error(`${where}: expected string type`);
      if (has(branch, 'const') === has(branch, 'enum')) throw new Error(`${where}: expected const or singleton enum`);
      const options = has(branch, 'const') ? stringChoices([branch.const], where) : stringChoices(branch.enum, where);
      if (options.length !== 1) throw new Error(`${where}: expected one value`);
      return { value: options[0], label: (branch.title ?? options[0]) as string };
    });
    values = stringChoices(choices.map((choice) => choice.value), location);
    labels = stringChoices(choices.map((choice) => choice.label), location);
  }
  if (!values.length) throw new Error(`${location}: empty choices`);
  return { values, options: labels.map((label) => ({ label })) };
}
