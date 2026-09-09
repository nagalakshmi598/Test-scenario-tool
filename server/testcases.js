'use strict';

/**
 * Turns one test scenario into detailed test cases with an LLM.
 * Output columns match the QA sheet: Test Case | Test Scenario | Preconditions |
 * Test Steps | Expected Result.
 *
 * Works with either provider — whichever key is present in .env:
 *   OPENAI_API_KEY     -> OpenAI  (model from OPENAI_MODEL, default gpt-4o)
 *   ANTHROPIC_API_KEY  -> Claude  (model from ANTHROPIC_MODEL, default claude-opus-5)
 * Set AI_PROVIDER=openai|anthropic to force one when both keys exist.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

/* Tiny .env reader so keys can live in a file instead of a Windows env var.
   `.env.example` is read last as a fallback: a key pasted into the template by
   mistake still works instead of failing with "no key configured". */
const ENV_FILES = ['.env', '.env.local', '.env.example'];

function loadEnvFiles() {
  ENV_FILES.forEach((name) => {
    const file = path.join(__dirname, '..', name);
    if (!fs.existsSync(file)) return;

    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      // first file that supplies a non-empty value wins
      if (key && value && !process.env[key]) process.env[key] = value;
    });
  });
}
loadEnvFiles();

function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function hasAnthropicKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Which provider will be used, and with which model. */
function activeProvider() {
  const forced = String(process.env.AI_PROVIDER || '').trim().toLowerCase();

  if (forced === 'openai' || (!forced && hasOpenAiKey())) {
    return {
      provider: 'openai',
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      ready: hasOpenAiKey(),
    };
  }
  return {
    provider: 'anthropic',
    model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    ready: hasAnthropicKey(),
  };
}

function hasApiKey() {
  return activeProvider().ready;
}

/**
 * Catch a key pasted into the wrong slot — an Anthropic key in OPENAI_API_KEY
 * (or the reverse) otherwise fails as a bare 401 that explains nothing.
 */
function keyProblem() {
  const { provider, ready } = activeProvider();
  if (!ready) return null;

  if (provider === 'openai') {
    const key = String(process.env.OPENAI_API_KEY || '');
    if (key.startsWith('sk-ant-')) {
      return 'OPENAI_API_KEY holds an Anthropic key (it starts with "sk-ant-"). OpenAI keys start with "sk-" or "sk-proj-". Either paste a real OpenAI key from platform.openai.com/api-keys, or move that key to ANTHROPIC_API_KEY and remove AI_PROVIDER=openai from .env.';
    }
  } else {
    const key = String(process.env.ANTHROPIC_API_KEY || '');
    if (key && !key.startsWith('sk-ant-')) {
      return 'ANTHROPIC_API_KEY does not look like an Anthropic key (those start with "sk-ant-"). If this is an OpenAI key, put it in OPENAI_API_KEY instead.';
    }
  }
  return null;
}

/** "Group DM Name" -> "TC_GDN", "Attachment size limit" -> "TC_ASL" */
function idPrefix(name) {
  const initials = String(name || '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase())
    .join('')
    .slice(0, 4);
  return `TC_${initials || 'QA'}`;
}

/* Shared JSON shape. OpenAI strict mode rejects minItems/maxItems, so those
   live only in the Claude copy below. */
const CASE_PROPERTIES = {
  title: { type: 'string' },
  test_scenario: { type: 'string' },
  preconditions: { type: 'string' },
  test_steps: { type: 'array', items: { type: 'string' } },
  expected_result: { type: 'string' },
};
const CASE_REQUIRED = ['title', 'test_scenario', 'preconditions', 'test_steps', 'expected_result'];

const OPENAI_SCHEMA = {
  type: 'object',
  properties: {
    test_cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: CASE_PROPERTIES,
        required: CASE_REQUIRED,
        additionalProperties: false,
      },
    },
  },
  required: ['test_cases'],
  additionalProperties: false,
};

const ANTHROPIC_SCHEMA = {
  type: 'object',
  properties: {
    test_cases: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        properties: { ...CASE_PROPERTIES, test_steps: { type: 'array', minItems: 1, items: { type: 'string' } } },
        required: CASE_REQUIRED,
        additionalProperties: false,
      },
    },
  },
  required: ['test_cases'],
  additionalProperties: false,
};

const SYSTEM = `You are a senior QA engineer on a cloud data migration product (CloudFuze).
You expand a single test scenario into detailed, executable manual test cases.

Rules:
- Write test cases a QA engineer can execute without asking questions.
- "preconditions" states the setup and data needed (clouds configured, CSV available, users mapped, licences) as prose.
- "test_steps" is an ordered list of short imperative UI/API actions, one action per item, no numbering inside the text.
- "expected_result" states the observable, verifiable outcome, including the message or state the tester should see.
- Stay strictly within the given scenario. Do not invent features that the scenario and enhancement name do not imply.
- Usually one thorough positive case; add a negative or boundary case only when the scenario clearly implies one. Never more than 4 cases.
- "title" is a short name for the case, not an id.`;

function buildPrompt({ productLabel, enhancementName, scenarioText, sno }) {
  return [
    `Product area: ${productLabel}`,
    `Enhancement / feature under test: ${enhancementName}`,
    `Test scenario (S.No ${sno}): ${scenarioText}`,
    '',
    'Write the detailed test case(s) for this scenario.',
  ].join('\n');
}

/** Turn an SDK error into something a QA engineer can act on. */
function friendlyApiError(apiErr, providerName) {
  const status = apiErr.status;
  const nested = apiErr.error && (apiErr.error.error || apiErr.error);
  const raw = String((nested && nested.message) || apiErr.message || '');
  const code = String((nested && nested.code) || '');
  const label = providerName === 'openai' ? 'OpenAI' : 'Claude';
  let message;

  if (/credit balance is too low/i.test(raw)) {
    message =
      'Your Anthropic account has no API credits. Add credits at console.anthropic.com → Plans & Billing, then try again. (The key itself is working.)';
  } else if (code === 'insufficient_quota' || /quota|billing/i.test(raw)) {
    message =
      'Your OpenAI account has no available quota. Add a payment method or credits at platform.openai.com → Billing, then try again. (The key itself is working.)';
  } else if (status === 401 || code === 'invalid_api_key' || /invalid[_ ]api[_ ]key|authentication/i.test(raw)) {
    message = `The ${label} API key was rejected. Check the key in the .env file, then restart the server.`;
  } else if (status === 404 && providerName === 'openai') {
    message = `The model "${activeProvider().model}" is not available on this OpenAI account. Set OPENAI_MODEL in .env to a model you have access to (for example gpt-4o or gpt-4o-mini), then restart the server.`;
  } else if (status === 403) {
    message = `This ${label} API key is not allowed to use that endpoint. Check the key’s permissions.`;
  } else if (status === 429) {
    message = `Rate limited by the ${label} API. Wait a moment and try again.`;
  } else if (status === 529 || status >= 500) {
    message = `The ${label} API is temporarily unavailable. Try again in a minute.`;
  } else {
    message = `${label} API error (${status || 'network'}): ${raw}`;
  }

  const err = new Error(message);
  err.status = status === 401 || status === 403 ? 503 : 502;
  return err;
}

async function callOpenAi({ model, prompt }) {
  const OpenAIModule = require('openai');
  const OpenAI = OpenAIModule.default || OpenAIModule;
  const client = new OpenAI();

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'qa_test_cases', strict: true, schema: OPENAI_SCHEMA },
    },
  });

  const choice = completion.choices && completion.choices[0];
  if (choice && choice.finish_reason === 'length') {
    const err = new Error('The response was cut off before it finished. Try again.');
    err.status = 502;
    throw err;
  }
  return (choice && choice.message && choice.message.content) || '';
}

async function callAnthropic({ model, prompt }) {
  const AnthropicModule = require('@anthropic-ai/sdk');
  const Anthropic = AnthropicModule.default || AnthropicModule;
  const client = new Anthropic();

  const message = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: ANTHROPIC_SCHEMA },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  if (message.stop_reason === 'refusal') {
    const err = new Error('Claude declined to generate test cases for this scenario.');
    err.status = 502;
    throw err;
  }

  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * @returns {Promise<{testCases: Array, model: string, provider: string, generatedAt: string}>}
 */
async function generateTestCases({ productLabel, enhancementName, scenarioText, sno }) {
  const { provider, model, ready } = activeProvider();

  if (!ready) {
    const err = new Error(
      'No AI API key configured. Put OPENAI_API_KEY=sk-... (or ANTHROPIC_API_KEY=sk-ant-...) in the .env file in the project folder, then restart the server.'
    );
    err.status = 503;
    throw err;
  }

  const problem = keyProblem();
  if (problem) {
    const err = new Error(problem);
    err.status = 503;
    throw err;
  }

  const prompt = buildPrompt({ productLabel, enhancementName, scenarioText, sno });

  let text;
  try {
    text = provider === 'openai' ? await callOpenAi({ model, prompt }) : await callAnthropic({ model, prompt });
  } catch (apiErr) {
    if (apiErr.status === 502 && !apiErr.error) throw apiErr; // already friendly
    throw friendlyApiError(apiErr, provider);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseErr) {
    const err = new Error('The model returned an unexpected response; try again.');
    err.status = 502;
    throw err;
  }

  const list = Array.isArray(parsed.test_cases) ? parsed.test_cases.slice(0, 4) : [];
  const prefix = idPrefix(enhancementName);
  const testCases = list.map((tc, idx) => ({
    id: `${prefix}_${String(sno).padStart(3, '0')}${list.length > 1 ? String.fromCharCode(97 + idx) : ''}`,
    title: tc.title,
    testScenario: tc.test_scenario,
    preconditions: tc.preconditions,
    testSteps: Array.isArray(tc.test_steps) ? tc.test_steps : [],
    expectedResult: tc.expected_result,
  }));

  if (!testCases.length) {
    const err = new Error('No test cases came back; try again.');
    err.status = 502;
    throw err;
  }

  return { testCases, model, provider, generatedAt: new Date().toISOString() };
}

module.exports = { generateTestCases, hasApiKey, activeProvider, keyProblem, idPrefix };
