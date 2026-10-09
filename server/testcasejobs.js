'use strict';

/**
 * Filling in detailed test cases without anyone clicking a row at a time.
 *
 * Generating them one scenario per click is the longest manual job left in the
 * tool: a set of two hundred scenarios is two hundred clicks, each waiting on
 * a model. A job here walks a whole enhancement instead, writes each result as
 * it arrives, and can be asked how far it has got.
 *
 * Results are written one by one on purpose. A job that stops — a restart, a
 * key that runs out — leaves everything it finished already stored, and
 * starting again simply picks up the scenarios that are still empty.
 */

const store = require('./store');
const { generateTestCases, friendlyApiError, activeProvider } = require('./testcases');

/* Enough to keep the model busy without tripping a rate limit. */
const WORKERS = 3;

/* A key that is wrong is wrong for every scenario, so stop rather than spend
   two hundred calls proving it. Failures that are specific to one scenario do
   not count toward this. */
const GIVE_UP_AFTER = 4;

/** Jobs by enhancement id. One per enhancement at a time. */
const jobs = new Map();

function publicView(job) {
  if (!job) return null;
  return {
    id: job.id,
    state: job.state,
    total: job.total,
    done: job.done,
    failed: job.failed,
    skipped: job.skipped,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    // the last few, so the page can say what it is working through
    recent: job.recent.slice(-3),
  };
}

function get(enhancementId) {
  return publicView(jobs.get(enhancementId));
}

/** The scenarios a run would cover, in order. */
function pending(enhancement, regenerate) {
  return (enhancement.scenarios || [])
    .filter((s) => regenerate || !(s.testCases && s.testCases.length))
    .map((s) => ({ sno: Number(s.sno), text: String(s.scenario || '') }));
}

async function run(job, enhancement) {
  const product = store.PRODUCTS.find((p) => p.key === enhancement.product);
  const productLabel = product ? product.label : enhancement.product;

  const queue = job.queue;
  let cursor = 0;
  let consecutiveFatal = 0;

  async function worker() {
    for (;;) {
      if (job.state !== 'running') return;
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;

      const item = queue[index];

      /* The rows can move while a long job runs. Re-read before writing, and
         leave the row alone if it is no longer the scenario we planned for. */
      const current = await store.getEnhancement(job.enhancementId);
      if (!current) { job.state = 'cancelled'; return; }

      const row = (current.scenarios || []).find((s) => Number(s.sno) === item.sno);
      if (!row || String(row.scenario || '') !== item.text) {
        job.skipped += 1;
        continue;
      }
      if (!job.regenerate && row.testCases && row.testCases.length) {
        job.skipped += 1;
        continue;
      }

      try {
        const generated = await generateTestCases({
          productLabel,
          enhancementName: current.name,
          scenarioText: item.text,
          sno: item.sno,
        });

        await store.setTestCases(job.enhancementId, item.sno, generated);
        job.done += 1;
        job.recent.push({ sno: item.sno, cases: generated.testCases.length });
        consecutiveFatal = 0;
      } catch (err) {
        job.failed += 1;
        const friendly = friendlyApiError(err, activeProvider().provider);
        job.recent.push({ sno: item.sno, error: friendly.message });

        /* 401, 402, 403, 429 and the like are about the account, not the row. */
        const aboutTheKey = !err.status || err.status === 401 || err.status === 402
          || err.status === 403 || err.status === 429 || err.status === 503;
        consecutiveFatal = aboutTheKey ? consecutiveFatal + 1 : 0;

        if (consecutiveFatal >= GIVE_UP_AFTER) {
          job.state = 'failed';
          job.error = `Stopped after ${consecutiveFatal} failures in a row: ${friendly.message}`;
          return;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, worker));

  if (job.state === 'running') job.state = 'done';
  job.finishedAt = new Date().toISOString();
}

/**
 * Start filling in an enhancement's test cases, or return the run already
 * under way. Nothing is regenerated unless asked for.
 */
async function start(enhancementId, { regenerate = false } = {}) {
  const existing = jobs.get(enhancementId);
  if (existing && existing.state === 'running') return publicView(existing);

  const enhancement = await store.getEnhancement(enhancementId);
  if (!enhancement) {
    const err = new Error('Enhancement not found.');
    err.status = 404;
    throw err;
  }

  const queue = pending(enhancement, regenerate);
  const job = {
    id: `${enhancementId}:${Date.now()}`,
    enhancementId,
    regenerate,
    queue,
    total: queue.length,
    done: 0,
    failed: 0,
    skipped: 0,
    recent: [],
    error: null,
    state: queue.length ? 'running' : 'done',
    startedAt: new Date().toISOString(),
    finishedAt: queue.length ? null : new Date().toISOString(),
  };
  jobs.set(enhancementId, job);

  if (queue.length) {
    // the caller gets the job straight away; the work carries on behind it
    run(job, enhancement).catch((err) => {
      job.state = 'failed';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
    });
  }

  return publicView(job);
}

function cancel(enhancementId) {
  const job = jobs.get(enhancementId);
  if (!job || job.state !== 'running') return publicView(job);
  job.state = 'cancelled';
  job.finishedAt = new Date().toISOString();
  return publicView(job);
}

/** How much of the tool is still missing its test cases. */
async function outstanding() {
  const all = await store.allEnhancements();
  return all
    .map((e) => {
      const missing = (e.scenarios || []).filter((s) => !(s.testCases && s.testCases.length)).length;
      return { id: e.id, name: e.name, product: e.product, missing, total: (e.scenarios || []).length };
    })
    .filter((e) => e.missing > 0);
}

module.exports = { start, cancel, get, outstanding };
