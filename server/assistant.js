'use strict';

/**
 * The in-tool assistant.
 *
 * It answers questions about what is actually in this tool — products,
 * enhancements, test scenarios, their pass/fail state, and the uploaded
 * write-ups. The whole store is small enough to hand to the model as context
 * on every turn, so the answers are grounded in real rows rather than guessed.
 *
 * Provider selection, keys and error wording are shared with test-case
 * generation; see testcases.js.
 */

const store = require('./store');
const { activeProvider, friendlyApiError } = require('./testcases');

/* A turn is capped so one huge document cannot crowd out the question. */
const MAX_QUESTION = 1000;
const MAX_HISTORY = 8;
const DOC_EXCERPT = 1200;
const SCENARIO_CAP = 400;

/** Open-ended questions need the model; the rest of the assistant still works. */
const UNAVAILABLE = (reason) => `${reason}, so I cannot answer open-ended questions right now.

I can still answer these straight from the tool:
  • How many scenarios are there? How many passed or failed?
  • Which enhancement has the most scenarios?
  • Show the failed scenarios
  • Find scenarios about <term>
  • Which enhancements have no test cases yet?
  • What documents do we have? What is <document> about?`;

const SYSTEM = `You are the assistant built into a QA test scenario tool used by the
product engineering team at CloudFuze, a cloud data migration company.

You answer questions about the data held in this tool: its products, the
enhancements under test, their test scenarios and pass/fail results, and the
enhancement write-ups that have been uploaded.

Rules:
- Answer only from the CONTEXT below. It is the complete contents of the tool.
- If the answer is not in the context, say so plainly and suggest where the user
  might look instead. Never invent a scenario, a count, a document or a result.
- Be exact with numbers. Count the rows in the context rather than estimating.
- Keep answers short and factual: a sentence or two, or a short list. This is a
  working tool, not a chat companion.
- When you refer to a scenario, give its number and the enhancement it sits in.
- Plain text only. No markdown headings, no code fences, no tables.`;

const SYSTEM_DRAFT = `You are a senior QA engineer on CloudFuze, a cloud data
migration product. Teams migrate chat, mail and content between Slack, Microsoft
Teams, Google Chat, Google Drive and similar clouds.

The user names a feature and wants test scenarios for it. Draft them.

Rules:
- Write 8 to 12 scenarios, each on its own numbered line, each starting
  "Verify that ".
- One check per scenario, concrete and verifiable by a tester.
- Cover the shape of a migration: what moves, what must survive the move
  (names, content, order, timestamps, formatting), who can see it afterwards
  (mapped and unmapped users, membership, permissions), the awkward inputs
  (special characters, emojis, maximum lengths, empty and very large cases),
  and the edges (re-running a migration, partial failure, the source being
  left untouched).
- The CONTEXT below is the team's existing scenarios and write-ups. Match their
  wording and level of detail, and do not repeat a scenario already there.
- If the CONTEXT documents this feature, draft only from what it states.
- Plain text only. No headings, no code fences, no commentary before or after
  the numbered list.`;

/** Strip tags so a document's matter reads as plain text, one block per line. */
function toPlainText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|h[1-6]|li|div|tr|blockquote|section|article)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function statusOf(scenario) {
  const value = scenario && scenario.status;
  return value === 'fail' || value === 'pending' ? value : 'pass';
}

/**
 * Everything in the tool, flattened into text the model can read.
 * Built fresh per question so the answers track the current data.
 */
function buildContext() {
  const products = store.listProducts();
  const lines = [];

  lines.push('=== PRODUCTS ===');
  products.forEach((p) => {
    lines.push(
      `${p.label} (key: ${p.key}) — ${p.enhancementCount} enhancements, ` +
        `${p.scenarioCount} test scenarios, ${p.documentCount || 0} documents. ${p.blurb}`
    );
  });

  lines.push('', '=== ENHANCEMENTS AND THEIR TEST SCENARIOS ===');
  let shown = 0;
  let hidden = 0;

  products.forEach((product) => {
    const enhancements = store.listEnhancements(product.key);
    enhancements.forEach((summary) => {
      const enhancement = store.getEnhancement(summary.id);
      if (!enhancement) return;

      const scenarios = enhancement.scenarios || [];
      const counts = { pass: 0, fail: 0, pending: 0 };
      scenarios.forEach((s) => { counts[statusOf(s)] += 1; });

      lines.push('');
      lines.push(
        `[${product.label}] "${enhancement.name}" — ${scenarios.length} scenarios ` +
          `(${counts.pass} pass, ${counts.fail} fail, ${counts.pending} not run)` +
          (enhancement.description ? ` — ${enhancement.description}` : '') +
          (enhancement.sourceFile ? ` — source: ${enhancement.sourceFile}` : '')
      );

      scenarios.forEach((s) => {
        if (shown >= SCENARIO_CAP) { hidden += 1; return; }
        shown += 1;
        const extra = Object.entries(s.extra || {})
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
        const cases = (s.testCases || []).length;
        lines.push(
          `  ${s.sno}. [${statusOf(s).toUpperCase()}] ${s.scenario}` +
            (extra ? ` (${extra})` : '') +
            (cases ? ` (${cases} detailed test cases generated)` : '')
        );
      });
    });
  });

  if (hidden) lines.push('', `(${hidden} further scenarios not listed here.)`);

  lines.push('', '=== ENHANCEMENT DOCUMENTS ===');
  const documents = store.listDocuments();
  if (!documents.length) lines.push('No documents uploaded.');

  documents.forEach((summary) => {
    const doc = store.getDocument(summary.id);
    if (!doc) return;
    const product = products.find((p) => p.key === doc.product);
    const text = toPlainText(doc.html);
    lines.push('');
    lines.push(
      `"${doc.name}" — ${product ? product.label : 'unassigned'}, file ${doc.fileName}, ` +
        `${doc.imageCount || 0} screenshots, added ${doc.createdAt}`
    );
    if (text) {
      lines.push(`  ${text.slice(0, DOC_EXCERPT)}${text.length > DOC_EXCERPT ? ' …(truncated)' : ''}`);
    }
  });

  return lines.join('\n');
}

async function callOpenAi({ model, context, question, history, system = SYSTEM }) {
  const OpenAIModule = require('openai');
  const OpenAI = OpenAIModule.default || OpenAIModule;
  const client = new OpenAI();

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: `${system}\n\n=== CONTEXT ===\n${context}` },
      ...history,
      { role: 'user', content: question },
    ],
  });

  const choice = completion.choices && completion.choices[0];
  return (choice && choice.message && choice.message.content) || '';
}

async function callAnthropic({ model, context, question, history, system = SYSTEM }) {
  const AnthropicModule = require('@anthropic-ai/sdk');
  const Anthropic = AnthropicModule.default || AnthropicModule;
  const client = new Anthropic();

  const message = await client.messages.create({
    model,
    max_tokens: 1600,
    system: `${system}\n\n=== CONTEXT ===\n${context}`,
    messages: [...history, { role: 'user', content: question }],
  });

  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/* ---------------- answering from the store itself ----------------
   Most questions asked of this tool are structured: counts, results, lookups.
   Those are answered here, straight from the data — exact, instant, free, and
   working whether or not an AI key is configured. A model is only needed for
   open-ended questions, and it counts less reliably than this does. */

/* ---------------- drafting test scenarios ----------------
   Ask for scenarios on a feature and the write-ups are mined for the behaviour
   they state, each statement turned into a scenario to verify. Every line comes
   from something the team actually documented, so nothing is invented. */

/* The recurring shape of a migration test in this tool: what gets moved,
   what must survive the move, who can see it afterwards, and what happens at
   the edges. Used when no write-up exists for the feature yet. */
const MIGRATION_CHECKS = [
  'is migrated successfully from the source to the destination',
  'keeps its original name in the destination after migration',
  'keeps its content unchanged after migration',
  'preserves the original order and timestamps of the migrated items',
  'is migrated for every mapped source user',
  'excludes unmapped source users from the destination',
  'preserves membership and access permissions after migration',
  'handles names containing capital letters, spaces, special characters and emojis',
  'handles a name at the maximum length the destination allows',
  'does not create duplicates when the migration is run a second time',
  'reports a clear error when the migration fails partway through',
  'leaves the source unchanged after migration',
];

/** Title-style the feature so it reads as the subject of a sentence. */
function featureSubject(feature) {
  const s = feature.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Words that can be lowercased when a statement becomes "Verify that …". */
const OPENERS = new Set([
  'the', 'a', 'an', 'all', 'any', 'each', 'both', 'no', 'only', 'this', 'these',
  'those', 'it', 'there', 'when', 'where', 'after', 'before', 'during', 'once',
  'if', 'users', 'user', 'members', 'files', 'messages', 'migration', 'migrated',
  'in', 'on', 'at', 'for', 'with', 'by', 'from', 'to', 'as', 'not', 'we', 'you',
  'they', 'multiple', 'every', 'while', 'unless', 'however', 'additionally',
  'also', 'based', 'using', 'under', 'within', 'across', 'post', 'existing',
]);

function asScenario(sentence) {
  let s = sentence.replace(/\s+$/, '');
  if (/^verify\b/i.test(s)) return s;

  const first = s.split(/\s+/)[0] || '';
  const lead = OPENERS.has(first.toLowerCase()) ? first.toLowerCase() : first;
  const rest = s.slice(first.length);
  return `Verify that ${lead}${rest}`;
}

/* The ask can sit at either end: "write scenarios for X", or a paragraph
   describing X that finishes "…write scenarios for this". Removing the ask
   wherever it appears leaves the feature either way. */
const ASK_PHRASE = new RegExp(
  '\\b(?:please\\s+)?(?:can you\\s+|could you\\s+)?' +
  '(?:i\\s+)?(?:write|give|generate|create|draft|suggest|provide|prepare|make|compose|need|want)\\s*' +
  '(?:me\\s+)?(?:some\\s+|a\\s+|an\\s+|the\\s+|few\\s+|new\\s+)*(?:test\\s+)?' +
  '(?:sce\\w*rios?|test\\s*cases?)' +
  '\\s*(?:for|on|about|regarding)?\\s*(?:this|that|it|these|those)?',
  'gi'
);
const ASK_BARE = /\b(?:sce\w*rios?|test\s*cases?)\s+(?:for|on|about|regarding)\s+/gi;

/** The feature the message is about, with the asking words stripped off. */
function featureOf(q) {
  const tidy = (s) => s
    .replace(/^\s*(this|that|the|a|an|our|my)\s+(new\s+)?feature\b/i, '')
    .replace(/^\s*(new\s+)?feature\b/i, '')
    .replace(/^[\s:,\-\u2013\u2014]+/, '')
    .replace(/[\s:,\-]+$/, '')
    .replace(/[?.!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const stripped = tidy(q.replace(ASK_PHRASE, ' ').replace(ASK_BARE, ' '));
  if (keyTerms(stripped).length >= 2) return stripped;

  // nothing meaningful survived — fall back to the whole message
  return tidy(q);
}

/** Edit distance, capped — only used on single words. */
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);

  for (let i = 1; i < rows; i += 1) {
    const row = [i];
    for (let j = 1; j < cols; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[cols - 1];
}

/** Does the question say "scenario"? Typed in a hurry, it often nearly does. */
function mentionsScenario(q) {
  return q.split(/[^a-z0-9]+/).some((word) => {
    if (word.length < 5) return false;
    return ['scenario', 'scenarios', 'testcase', 'testcases']
      .some((key) => editDistance(word, key) <= 2);
  });
}

/* Asking to see the scenarios already held is a different job from asking for
   new ones to be written, and the two share most of their vocabulary. */
const LOOKUP_VERBS = /\b(find|show|search|display|list|see|view|which|how many|are there|do we have|exist)\b/;
const DRAFT_VERBS = /\b(write|generate|create|draft|prepare|suggest|compose|provide|give|need|want|make|come up)\b/;

/** Does this read as a question, rather than a statement of a feature? */
function isQuestion(q) {
  const s = q.trim();
  if (s.endsWith('?')) return true;
  return /^(how|what|whats|which|why|when|where|who|whose|is|are|was|were|do|does|did|can|could|should|would|will|has|have|any|tell|explain|describe|count)\b/.test(s);
}

/** Did the user ask, in so many words, for scenarios? */
function wantsScenarios(q) {
  if (!mentionsScenario(q)) return false;
  if (LOOKUP_VERBS.test(q)) return false;
  return DRAFT_VERBS.test(q) || /\b(scenarios?|test cases?|sceanrios?)\s+(for|on|about)\b/.test(q);
}

/** Naming a feature is a request for scenarios too — no keyword needed. */
function isDraftRequest(q) {
  if (wantsScenarios(q)) return true;
  if (LOOKUP_VERBS.test(q) || isQuestion(q)) return false;
  return keyTerms(q).length >= 2;
}

/** The checklist, for when a drafting request cannot reach a model. */
function scenarioFallback(question) {
  const q = String(question).toLowerCase().trim();
  if (!isDraftRequest(q)) return null;

  const feature = featureOf(q);
  return keyTerms(feature).length ? checklistFor(feature) : null;
}

/** A starting set for a feature with no write-up behind it yet. */
function checklistFor(feature) {
  const subject = featureSubject(feature);
  const lines = [
    `No write-up covers "${feature}" yet, so here is a starting set from the checks this team applies to every migration feature:`,
    '',
  ];
  MIGRATION_CHECKS.forEach((check, i) => lines.push(`${i + 1}. Verify that ${subject} ${check}.`));
  lines.push('');
  lines.push('Upload the enhancement write-up and ask again — I will then draft scenarios from what it actually states, which will be sharper than this.');
  return lines.join('\n');
}

/**
 * @returns {string|null} a numbered draft, or null when this is not that kind of question
 */
function draftScenarios(q, data) {
  if (!isDraftRequest(q)) return null;

  const feature = featureOf(q);
  const terms = keyTerms(feature);

  // a description, not just a name: the model can draft for it directly
  if (feature.split(/\s+/).length >= 12 && activeProvider().ready) return null;
  if (!terms.length) {
    return 'Tell me the feature and I will draft scenarios from the write-ups, for example: "scenarios for group DM name migration".';
  }

  /* Words like "slack", "teams" and "migration" appear in every write-up, so
     matching only those says nothing about the topic. Work out which of the
     question's words actually narrow things down, and insist on one of them. */
  const bodies = [];
  data.documents.forEach((summary) => {
    const doc = store.getDocument(summary.id);
    if (doc && doc.html) bodies.push({ name: doc.name, text: toPlainText(doc.html) });
  });

  const docFreq = {};
  terms.forEach((term) => {
    docFreq[term] = bodies.filter((b) => b.text.toLowerCase().includes(term)).length;
  });

  /* If a real word from the feature appears in none of the write-ups, they are
     not describing this feature — "reactions sync" shares "slack" and "teams"
     with every document while its own vocabulary is nowhere. That is a new
     feature: hand it to the model, or fall back to the checklist. */
  const absent = terms.filter((term) => term.length >= 4 && docFreq[term] === 0);
  if (absent.length) {
    if (activeProvider().ready) return null;
    return checklistFor(feature);
  }

  // Among the words that are present, insist on the least common ones —
  // they are what separates this feature from the rest of the product.
  const rarest = Math.min(...terms.map((term) => docFreq[term]));
  const usable = rarest < bodies.length ? terms.filter((term) => docFreq[term] === rarest) : [];

  const statements = [];
  const required = Math.max(Math.min(2, terms.length), Math.ceil(terms.length * 0.6));

  bodies.forEach((body) => {
    splitSentences(body.text).forEach((raw) => {
      const clean = tidySentence(raw);
      if (!clean) return;
      const low = clean.toLowerCase();
      const score = terms.filter((term) => low.includes(term)).length;
      if (score < required) return;
      if (usable.length && !usable.some((term) => low.includes(term))) return;
      statements.push({ clean, score, doc: body.name });
    });
  });

  if (!statements.length) {
    // A model can do better than a checklist for something undocumented, so
    // hand over when one is configured and working.
    if (activeProvider().ready) return null;
    return checklistFor(feature);
  }

  statements.sort((a, b) => b.score - a.score);

  // do not re-draft what the tool already has
  const existing = [];
  data.enhancements.forEach((e) => e.scenarios.forEach((s) => existing.push(s.scenario.toLowerCase())));

  const drafted = [];
  const seen = [];
  statements.forEach(({ clean, doc }) => {
    if (drafted.length >= 8) return;
    const scenario = asScenario(clean);
    const norm = scenario.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    if (seen.some((k) => k === norm || k.includes(norm) || norm.includes(k))) return;
    if (existing.some((x) => x.includes(clean.toLowerCase().slice(0, 40)))) return;
    seen.push(norm);
    drafted.push({ scenario, doc });
  });

  if (!drafted.length) {
    return `Every documented behaviour for "${feature}" is already covered by scenarios in the tool. Ask "find scenarios about ${feature}" to see them, or describe what is new about the feature and I will draft from that.`;
  }

  const source = [...new Set(drafted.map((d) => d.doc))];
  const lines = [`${plural(drafted.length, 'scenario')} drafted for "${feature}":`, ''];
  drafted.forEach((d, i) => lines.push(`${i + 1}. ${d.scenario}`));
  lines.push('');
  lines.push(`Drawn from: ${source.join(', ')}. Paste any of these into Add a Test Scenario on the enhancement.`);

  return lines.join('\n');
}

/* ---------------- reading the documents ----------------
   Feature questions ("how are group DM names migrated?") are answered from the
   write-ups themselves. The question is reduced to its meaningful words, every
   sentence in every document is scored against them, and the best passages come
   back with the document they came from. No model needed, and it cites a real
   source rather than paraphrasing one. */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'how', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'whose',
  'do', 'does', 'did', 'doing', 'done', 'can', 'could', 'will', 'would',
  'shall', 'should', 'may', 'might', 'must', 'we', 'you', 'i', 'he', 'she',
  'it', 'they', 'them', 'their', 'our', 'my', 'me', 'us', 'your', 'his', 'her',
  'in', 'on', 'of', 'to', 'for', 'and', 'or', 'but', 'with', 'from', 'about',
  'into', 'over', 'under', 'after', 'before', 'during', 'at', 'by', 'as',
  'that', 'this', 'these', 'those', 'there', 'here', 'any', 'all', 'some',
  'has', 'have', 'had', 'get', 'gets', 'got', 'use', 'used', 'using',
  'way', 'ways', 'tell', 'show', 'explain', 'describe', 'regarding', 'please',
  'know', 'want', 'need', 'does', 'happen', 'happens', 'work', 'works',
]);

/** The words in a question that actually carry meaning. */
function keyTerms(q) {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const terms = [];
  words.forEach((w) => {
    if (w.length < 3 || STOPWORDS.has(w)) return;
    let stem = w;
    if (stem.length > 4 && stem.endsWith('s') && !stem.endsWith('ss')) stem = stem.slice(0, -1);
    // longer words keep only their root, so "authenticate" finds "authentication"
    if (stem.length > 6) stem = stem.slice(0, Math.max(5, stem.length - 3));
    if (stem.length >= 3 && !terms.includes(stem)) terms.push(stem);
  });
  return terms;
}

function splitSentences(text) {
  return text
    .split(/\n+/)
    .flatMap((block) => block.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'\u2022])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 24);
}

/**
 * Trim a sentence down to the part worth reading, or drop it.
 * @returns {string} the cleaned sentence, or '' if it carries no information
 */
function tidySentence(raw) {
  let s = raw.replace(/\s+/g, ' ').trim();

  // a numbered heading stub: "Private Channel Migration (API Approach) 1."
  if (/\s\d+\.?$/.test(s)) return '';
  // a bare section number opening the line: "2.During Migration ..."
  s = s.replace(/^\d+\s*[.)]\s*/, '');

  if (s.split(/\s+/).length < 7) return '';     // headings and labels
  if (!/[a-z]/.test(s)) return '';               // ALL CAPS banners
  if (!/[.!?]["')\u201d]?$/.test(s)) return '';   // a heading, not a statement
  return s;
}

/** Drop repeats and sentences already contained in one we are keeping. */
function dedupe(sentences) {
  const kept = [];
  sentences.forEach((s) => {
    const norm = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const clash = kept.some((k) => {
      const kn = k.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      return kn === norm || kn.includes(norm) || norm.includes(kn);
    });
    if (!clash) kept.push(s);
  });
  return kept;
}

/**
 * Passages from the write-ups that answer the question.
 * @returns {string|null}
 */
function searchDocuments(q, documents) {
  const terms = keyTerms(q);
  if (terms.length < 2) return null;

  const perDoc = [];

  documents.forEach((summary) => {
    const doc = store.getDocument(summary.id);
    if (!doc || !doc.html) return;

    const text = toPlainText(doc.html);
    if (!text) return;

    // A document whose own title matches the question starts ahead.
    const titleWords = doc.name.toLowerCase();
    const titleBonus = terms.filter((term) => titleWords.includes(term)).length;

    const scored = splitSentences(text)
      .map((sentence) => {
        const clean = tidySentence(sentence);
        const low = clean.toLowerCase();
        const hits = terms.filter((term) => low.includes(term));
        return { sentence: clean, score: hits.length };
      })
      .filter((s) => s.sentence && s.score >= Math.min(2, terms.length));

    if (!scored.length) return;

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].score;

    perDoc.push({
      doc,
      titleBonus,
      best,
      total: scored.reduce((sum, s) => sum + s.score, 0),
      passages: dedupe(scored.map((s) => s.sentence)),
    });
  });

  if (!perDoc.length) return null;

  // Rank on what the text actually says; the title only breaks a close call.
  const rank = (d) => d.best * 3 + d.total * 0.4 + d.titleBonus;
  perDoc.sort((a, b) => rank(b) - rank(a));

  const top = perDoc[0];
  // A single weak keyword hit is not an answer.
  if (top.best < 2 && !top.titleBonus) return null;

  const answer = top.passages.slice(0, 3).join(' ');
  if (!answer) return null;

  return `${answer}\n\nSource: ${top.doc.name}`;
}

/** Everything flattened once, so the matchers below can just read it. */
function snapshot() {
  const products = store.listProducts();
  const enhancements = [];

  products.forEach((product) => {
    store.listEnhancements(product.key).forEach((summary) => {
      const full = store.getEnhancement(summary.id);
      if (!full) return;
      const scenarios = full.scenarios || [];
      enhancements.push({
        id: full.id,
        name: full.name,
        product,
        scenarios,
        counts: scenarios.reduce(
          (acc, s) => { acc[statusOf(s)] += 1; return acc; },
          { pass: 0, fail: 0, pending: 0 }
        ),
        withCases: scenarios.filter((s) => (s.testCases || []).length).length,
      });
    });
  });

  return { products, enhancements, documents: store.listDocuments() };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The product the question names, if any. */
function findProduct(q, products) {
  return products.find((p) => q.includes(p.label.toLowerCase()) || q.includes(p.key)) || null;
}

/** The enhancement the question names — longest title match wins. */
function findEnhancement(q, enhancements) {
  return enhancements
    .filter((e) => q.includes(e.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0] || null;
}

function findDocument(q, documents) {
  const named = documents
    .filter((d) => q.includes(d.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (named) return named;

  // fall back to a document whose title shares a distinctive word with the question
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 4);
  return documents.find((d) => {
    const title = d.name.toLowerCase();
    const hits = words.filter((w) => title.includes(w)).length;
    return hits >= 2;
  }) || null;
}

/** Scenarios in scope once a product or enhancement has been named. */
function scopedScenarios({ enhancements }, product, enhancement) {
  if (enhancement) return [{ enhancement, scenarios: enhancement.scenarios }];
  const list = product ? enhancements.filter((e) => e.product.key === product.key) : enhancements;
  return list.map((e) => ({ enhancement: e, scenarios: e.scenarios }));
}

function listScenarioLines(groups, filter, limit = 12) {
  const lines = [];
  let total = 0;
  groups.forEach(({ enhancement, scenarios }) => {
    scenarios.filter(filter).forEach((s) => {
      total += 1;
      if (lines.length < limit) lines.push(`  ${s.sno}. ${s.scenario}  — ${enhancement.name}`);
    });
  });
  return { lines, total };
}

/**
 * @returns {string|null} an answer, or null to let the model handle it.
 */
function answerLocally(question) {
  const q = String(question).toLowerCase().trim();
  if (!q) return null;

  const data = snapshot();
  const { products, enhancements, documents } = data;
  const product = findProduct(q, products);
  const enhancement = findEnhancement(q, enhancements);

  const totals = enhancements.reduce(
    (acc, e) => {
      acc.scenarios += e.scenarios.length;
      acc.pass += e.counts.pass;
      acc.fail += e.counts.fail;
      acc.pending += e.counts.pending;
      acc.withCases += e.withCases;
      return acc;
    },
    { scenarios: 0, pass: 0, fail: 0, pending: 0, withCases: 0 }
  );

  /* ---- drafting scenarios for a named feature ---- */
  if (wantsScenarios(q)) return draftScenarios(q, data);

  /* ---- what can you do ---- */
  if (/^(help|what can you do|what do you do|hi|hello|hey)\b/.test(q) || q.includes('what can you answer')) {
    return [
      'I answer questions about what is in this tool. For example:',
      '  • How many scenarios are there? How many passed or failed?',
      '  • Which enhancement has the most scenarios?',
      '  • Show the failed scenarios',
      '  • Find scenarios about private channels',
      '  • Which enhancements have no test cases yet?',
      '  • What documents do we have? What is <document> about?',
      '  • Draft test scenarios for <feature>',
      '  • Or just describe the feature and I will write scenarios for it',
    ].join('\n');
  }

  /* ---- a document named in the question ----
     The word "document" need not appear: naming the write-up is enough. */
  const namedDoc = findDocument(q, documents);
  if (namedDoc && !mentionsScenario(q)
      && /about|summar|say|contain|explain|what is|what's|tell me|describe/.test(q)) {
    const full = store.getDocument(namedDoc.id);
    const text = toPlainText(full && full.html);
    if (!text) {
      return `"${namedDoc.name}" has no readable text in the tool — it is a ${namedDoc.kind}. Open it to view the file.`;
    }
    return `"${namedDoc.name}" (${namedDoc.imageCount || 0} screenshots):\n\n${text.slice(0, 600)}${text.length > 600 ? '…' : ''}`;
  }

  /* ---- documents ---- */
  if (/document|write-?up|screenshot/.test(q)) {
    const doc = findDocument(q, documents);

    if (doc && /about|summar|say|contain|explain|what is|what's|tell me/.test(q)) {
      const full = store.getDocument(doc.id);
      const text = toPlainText(full && full.html);
      if (!text) return `"${doc.name}" has no readable text in the tool — it is a ${doc.kind}. Open it to view the file.`;
      const excerpt = text.slice(0, 600);
      return `"${doc.name}" (${doc.imageCount || 0} screenshots):\n\n${excerpt}${text.length > 600 ? '…' : ''}`;
    }

    if (/how many|count|number of/.test(q)) {
      const scoped = product ? documents.filter((d) => d.product === product.key) : documents;
      return product
        ? `${product.label} has ${plural(scoped.length, 'document')}.`
        : `There ${documents.length === 1 ? 'is' : 'are'} ${plural(documents.length, 'document')} in the tool.`;
    }

    if (/what|which|list|show/.test(q)) {
      const scoped = product ? documents.filter((d) => d.product === product.key) : documents;
      if (!scoped.length) return product ? `${product.label} has no documents yet.` : 'No documents have been uploaded yet.';
      const lines = scoped.map((d) => {
        const owner = products.find((p) => p.key === d.product);
        return `  • ${d.name} — ${owner ? owner.label : 'unassigned'}, ${plural(d.imageCount || 0, 'screenshot')}`;
      });
      return `${plural(scoped.length, 'document')}${product ? ` for ${product.label}` : ''}:\n${lines.join('\n')}`;
    }
  }

  /* ---- enhancements with no generated test cases ---- */
  if (/no test case|without test case|missing test case|not.*(generated|have).*test case/.test(q)) {
    const none = enhancements.filter((e) => e.withCases === 0);
    if (!none.length) return 'Every enhancement has at least one scenario with generated test cases.';
    return `${plural(none.length, 'enhancement')} with no generated test cases:\n${
      none.map((e) => `  • ${e.name} (${e.product.label}, ${plural(e.scenarios.length, 'scenario')})`).join('\n')}`;
  }

  /* ---- most / fewest ---- */
  if (/most|highest|largest|biggest/.test(q) && /scenario/.test(q)) {
    const top = [...enhancements].sort((a, b) => b.scenarios.length - a.scenarios.length)[0];
    if (!top) return 'There are no enhancements yet.';
    return `"${top.name}" (${top.product.label}) has the most, with ${plural(top.scenarios.length, 'scenario')}.`;
  }
  if (/fewest|least|lowest|smallest/.test(q) && /scenario/.test(q)) {
    const low = [...enhancements].sort((a, b) => a.scenarios.length - b.scenarios.length)[0];
    if (!low) return 'There are no enhancements yet.';
    return `"${low.name}" (${low.product.label}) has the fewest, with ${plural(low.scenarios.length, 'scenario')}.`;
  }

  /* ---- failed / not run ---- */
  const wantsFail = /fail/.test(q);
  const wantsPending = /not run|pending|untested|not tested|yet to/.test(q);
  if (wantsFail || wantsPending) {
    const want = wantsFail ? 'fail' : 'pending';
    const label = wantsFail ? 'failed' : 'not yet run';
    const groups = scopedScenarios(data, product, enhancement);
    const { lines, total } = listScenarioLines(groups, (s) => statusOf(s) === want);
    const where = enhancement ? ` in "${enhancement.name}"` : product ? ` for ${product.label}` : '';
    if (!total) return `No scenarios are marked ${label}${where}. ${totals.pass} of ${totals.scenarios} are passing.`;
    return `${plural(total, 'scenario')} ${label}${where}:\n${lines.join('\n')}${
      total > lines.length ? `\n  …and ${total - lines.length} more.` : ''}`;
  }

  /* ---- counts ---- */
  if (/how many|count|number of|total/.test(q)) {
    if (/test case/.test(q)) {
      return `${plural(totals.withCases, 'scenario')} have detailed test cases generated, out of ${totals.scenarios}.`;
    }
    if (/enhancement/.test(q)) {
      const n = product ? enhancements.filter((e) => e.product.key === product.key).length : enhancements.length;
      return product ? `${product.label} has ${plural(n, 'enhancement')}.` : `There are ${plural(n, 'enhancement')} across all products.`;
    }
    if (/product/.test(q)) {
      return `There are ${plural(products.length, 'product')}: ${products.map((p) => p.label).join(', ')}.`;
    }
    if (/scenario|test/.test(q)) {
      if (enhancement) {
        const c = enhancement.counts;
        return `"${enhancement.name}" has ${plural(enhancement.scenarios.length, 'scenario')} — ${c.pass} pass, ${c.fail} fail, ${c.pending} not run.`;
      }
      if (product) {
        const scoped = enhancements.filter((e) => e.product.key === product.key);
        const n = scoped.reduce((sum, e) => sum + e.scenarios.length, 0);
        const pass = scoped.reduce((sum, e) => sum + e.counts.pass, 0);
        return n
          ? `${product.label} has ${plural(n, 'test scenario')}, ${pass} of them passing.`
          : `${product.label} has no test scenarios yet.`;
      }
      return `There are ${plural(totals.scenarios, 'test scenario')} in total — ${totals.pass} pass, ${totals.fail} fail, ${totals.pending} not run.`;
    }
  }

  /* ---- a named enhancement or product, asked about generally ---- */
  if (enhancement && /about|status|summar|tell me|how is|what is|what's/.test(q)) {
    const c = enhancement.counts;
    return `"${enhancement.name}" sits under ${enhancement.product.label}. ` +
      `${plural(enhancement.scenarios.length, 'scenario')}: ${c.pass} pass, ${c.fail} fail, ${c.pending} not run. ` +
      `${enhancement.withCases} of them have detailed test cases.`;
  }
  if (product && /about|status|summar|tell me|how is|what is|what's|anything|any /.test(q)) {
    const scoped = enhancements.filter((e) => e.product.key === product.key);
    const n = scoped.reduce((sum, e) => sum + e.scenarios.length, 0);
    const docs = documents.filter((d) => d.product === product.key).length;
    if (!scoped.length) return `${product.label} has nothing in the tool yet — no enhancements, scenarios or documents.`;
    return `${product.label}: ${plural(scoped.length, 'enhancement')}, ${plural(n, 'test scenario')}, ${plural(docs, 'document')}.\n${
      scoped.map((e) => `  • ${e.name} — ${plural(e.scenarios.length, 'scenario')}`).join('\n')}`;
  }

  /* ---- free-text search over the scenarios ---- */
  const searchMatch = q.match(/(?:scenarios?|tests?)\s+(?:about|for|on|mentioning|related to|covering|with)\s+(.+)/)
    || q.match(/(?:find|search|show me|list|any)\s+(?:scenarios?|tests?)?\s*(?:about|for|on|mentioning|related to|covering|with)?\s*(.+)/);
  if (searchMatch) {
    const term = searchMatch[1].replace(/[?.!]+$/, '').trim();
    if (term.length >= 3) {
      const groups = scopedScenarios(data, product, enhancement);
      const { lines, total } = listScenarioLines(groups, (s) => s.scenario.toLowerCase().includes(term));
      if (total) {
        return `${plural(total, 'scenario')} mention "${term}":\n${lines.join('\n')}${
          total > lines.length ? `\n  …and ${total - lines.length} more.` : ''}`;
      }
    }
  }

  /* ---- a bare feature description: "group DM rename in Teams" ---- */
  if (isDraftRequest(q)) return draftScenarios(q, data);

  /* ---- a feature question: read the write-ups ---- */
  const fromDocs = searchDocuments(q, documents);
  if (fromDocs) return fromDocs;

  /* ---- last resort before the model: any scenario mentioning these words ---- */
  const terms = keyTerms(q);
  if (terms.length >= 2) {
    const groups = scopedScenarios(data, product, enhancement);
    const { lines, total } = listScenarioLines(
      groups,
      (s) => {
        const low = s.scenario.toLowerCase();
        return terms.filter((term) => low.includes(term)).length >= Math.min(2, terms.length);
      },
      8
    );
    if (total) {
      return `Nothing in the documents covers that directly, but ${plural(total, 'scenario')} mention it:\n${
        lines.join('\n')}${total > lines.length ? `\n  …and ${total - lines.length} more.` : ''}`;
    }
  }

  return null;   // nothing matched with confidence — let the model try
}

/**
 * @param {{question: string, history: Array<{role: string, content: string}>}} input
 * @returns {Promise<{answer: string, model: string, provider: string}>}
 */
async function askAssistant({ question, history = [] }) {
  const text = String(question || '').trim();
  if (!text) {
    const err = new Error('Ask a question first.');
    err.status = 400;
    throw err;
  }
  if (text.length > MAX_QUESTION) {
    const err = new Error(`Keep the question under ${MAX_QUESTION} characters.`);
    err.status = 400;
    throw err;
  }

  // Structured questions are answered from the store: exact, instant, and
  // independent of any API key or its billing state.
  const direct = answerLocally(text);
  if (direct) return { answer: direct, model: 'built-in', provider: 'local' };

  const { provider, model, ready } = activeProvider();
  if (!ready) {
    const err = new Error(UNAVAILABLE('No AI key is configured'));
    err.status = 503;
    throw err;
  }

  // Only the recent turns, and only the two roles the APIs accept.
  const trimmed = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }));

  const context = buildContext();
  // a drafting request only reaches here when no write-up covered the feature
  const system = scenarioFallback(text) ? SYSTEM_DRAFT : SYSTEM;

  try {
    const answer = provider === 'openai'
      ? await callOpenAi({ model, context, question: text, history: trimmed, system })
      : await callAnthropic({ model, context, question: text, history: trimmed, system });

    if (!answer.trim()) {
      const err = new Error('No answer came back; try again.');
      err.status = 502;
      throw err;
    }
    return { answer: answer.trim(), model, provider };
  } catch (apiErr) {
    const fallback = scenarioFallback(text);
    if (fallback) return { answer: fallback, model: 'built-in', provider: 'local' };

    if (apiErr.status === 502) throw apiErr;
    const friendly = friendlyApiError(apiErr, provider);
    friendly.message = UNAVAILABLE(friendly.message);
    throw friendly;
  }
}

module.exports = { askAssistant, buildContext };
