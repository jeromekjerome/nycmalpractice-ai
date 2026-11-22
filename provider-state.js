// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Whether each AI provider is answering, as every server instance of the app sees it: one row for each provider in
// the table ai_provider_state (setup-db.js). providers.js asks it, before each job of a reply, which providers are
// marked down, and tells it once, when each reply ends, how the reply went for each provider (the design, section 2,
// "Marking a provider down").
//
// - A reply is a failure for a provider only when the provider answered none of its jobs, after failing in a way that
//   counts against it; a reply in which it answered any job is a success for it, whatever failed beside.
// - At the provider's first failure in a reply, one small test request, the ping, is sent to it, beside the rest of
//   the reply. If the reply ends a failure for it, a failed ping marks it down. Three failed replies within five
//   minutes mark it down whatever the ping says. A refused key or a spent quota marks it down with no ping.
// - A provider marked down is asked after the providers that are up (providers.js). Five minutes after it was marked
//   down, and every five minutes after that while it stays down, one request is let through to it in its usual
//   place, by the one instance that claims it. A reply it answers clears it, once it has served its five minutes;
//   before that, the mark stays as it is. When the job that claims the request asks another provider first, the
//   request may never reach it: its ping (probe) is sent instead, beside the reply, and a ping it answers clears it as
//   a reply would; one it fails leaves it down, until the next request five minutes on.
// - The owner is told once when a provider is marked down and once when it comes back. Each change is claimed by an
//   UPDATE ... RETURNING that only one instance can win, so two instances never both send the email.
// - The table is read at most once in fifteen seconds by each instance, and what an instance writes it knows at once.
// - When the table cannot be read or written (it was never made, or the database is down), every provider counts as
//   up and nothing is marked down; each instance logs it once.
//
// This file imports nothing, so that it is the same in each app. The app gives it the database client, the ping (a
// health check of the provider's main model, through the spending caps) and the telling.

// How long a read of the table is used before it is read again.
const MEMORY_MS = 15_000;
// The failed replies within five minutes (failed_replies keeps no older ones) that mark a provider down without a ping.
const FAILED_REPLIES_TO_MARK_DOWN = 3;
// How long a provider marked down stays marked, however many replies it answers meanwhile: the statements' interval
// '5 minutes'.
const DOWN_AT_LEAST_MS = 5 * 60_000;

// A time from the database (a Date, or its text) in milliseconds, or null.
function millis(value) {
  if (value === null || value === undefined) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function iso(value) {
  const time = millis(value);
  return time === null ? null : new Date(time).toISOString();
}

// What an instance knows of a provider's row: since when it is marked down, and why (null while it is up), when the
// next request may be let through to it, and how many failed replies are on record.
function knownFrom(row) {
  return { downSince: millis(row.down_since), reason: row.reason ?? null, retryAt: millis(row.retry_at), failed: Number(row.failed) || 0 };
}

/**
 * @param {object} options
 * @param {Function} options.sqlClient  the database's tagged-template client
 * @param {Function} [options.now]      the time, for the fifteen seconds' memory; the database keeps its own
 * @param {Function} [options.ping]     ping(provider, { signal }) -> Promise<boolean | null>: whether the provider
 *   answers a small test request: true when it answered, false when it failed it, null when the ping says nothing of
 *   it. false marks it down; a ping that cannot be made says nothing. `signal` fires when the reply no longer needs it.
 * @param {Function} [options.tell]     tell({ kind: 'down' | 'up', provider, reason, since }): tells the owner
 * @returns {{ standing(provider): Promise<'up' | 'down' | 'let-through'>, isDown(provider): Promise<boolean>,
 *   ping(provider, { signal }): Promise<boolean | null>, probe(provider, { signal }): Promise<boolean | null>,
 *   replyFailed(provider, { reason, markDownNow, pinged }): Promise<void>, replySucceeded(provider): Promise<void>,
 *   snapshot(): Promise<object> }}
 *   snapshot gives { [provider]: { downSince, reason } } for each provider marked down. None of them throws.
 */
export function providerState({ sqlClient, now = Date.now, ping = null, tell = null }) {
  // The last read: { at, known: Map(provider -> knownFrom(row)) }, of the rows that say something.
  let memory = null;
  // The read in flight, which every caller meanwhile waits for, and what this instance wrote while it was in flight.
  let reading = null;
  let writtenMeanwhile = null;
  // The providers whose one request let through this instance is claiming.
  const claiming = new Set();
  let complained = false;

  // The table could not be read or written: every provider counts as up, and the instance says so once.
  function unreadable(error) {
    if (complained) return;
    complained = true;
    console.error(`[providers] The provider state could not be read or written, so every provider counts as up: ${error?.message ?? error}`);
  }

  async function read() {
    try {
      const rows = await sqlClient`
        SELECT provider, down_since, reason, retry_at, cardinality(failed_replies) AS failed
        FROM ai_provider_state
        WHERE down_since IS NOT NULL OR cardinality(failed_replies) > 0`;
      return new Map(rows.map(row => [row.provider, knownFrom(row)]));
    } catch (error) {
      unreadable(error);
      return new Map();
    }
  }

  // The rows that say something (a provider marked down, or failed replies on record), read at most once in
  // MEMORY_MS. A read that failed is kept as long, as a table with nothing in it.
  function known() {
    if (memory && now() - memory.at < MEMORY_MS) return Promise.resolve(memory.known);
    if (!reading) {
      writtenMeanwhile = new Map();
      reading = read().then(found => {
        for (const [provider, entry] of writtenMeanwhile) {
          if (entry) found.set(provider, entry); else found.delete(provider);
        }
        memory = { at: now(), known: found };
        reading = null;
        writtenMeanwhile = null;
        return found;
      });
    }
    return reading;
  }

  // What this instance wrote, known at once. null: nothing on record for the provider.
  function remember(provider, entry) {
    if (memory) {
      if (entry) memory.known.set(provider, entry); else memory.known.delete(provider);
    }
    writtenMeanwhile?.set(provider, entry);
  }

  // Another instance changed the row first: it is read afresh at the next question.
  function stale() {
    if (memory) memory.at = -Infinity;
  }

  async function told(note) {
    if (typeof tell !== 'function') return;
    try {
      await tell(note);
    } catch (error) {
      console.error(`[providers] Telling the owner that ${note.provider} is ${note.kind} failed: ${error?.message ?? error}`);
    }
  }

  // Whether the provider answers its ping. A ping that cannot be made, or says nothing, says nothing of the provider.
  async function answers(provider, { signal = null } = {}) {
    if (typeof ping !== 'function') return true;
    try {
      return (await ping(provider, { signal })) !== false;
    } catch {
      console.error(`[providers] The check of ${provider} could not be made; it is not marked down for it.`);
      return true;
    }
  }

  // Marks the provider down, unless it already is. The instance whose UPDATE does it tells the owner.
  async function markDown(provider, reason) {
    let marked;
    try {
      [marked] = await sqlClient`
        UPDATE ai_provider_state
        SET down_since = now(), reason = ${reason}, retry_at = now() + interval '5 minutes', updated_at = now()
        WHERE provider = ${provider} AND down_since IS NULL
        RETURNING down_since, retry_at, cardinality(failed_replies) AS failed`;
    } catch (error) {
      unreadable(error);
      return;
    }
    if (!marked) {
      stale();
      return;
    }
    const entry = knownFrom({ ...marked, reason });
    entry.downSince ??= now();
    remember(provider, entry);
    await told({ kind: 'down', provider, reason, since: new Date(entry.downSince).toISOString() });
  }

  // How the provider stands: 'up', 'down' (marked down), or 'let-through' (marked down, and this one question claimed
  // the request let through to it). When its next request may be let through, the instance whose UPDATE claims it
  // gets 'let-through' for this one question, and moves the next five minutes ahead; every other caller gets 'down'.
  async function standing(provider) {
    const entry = (await known()).get(provider);
    if (!entry || entry.downSince === null) return 'up';
    if (entry.retryAt !== null && entry.retryAt > now()) return 'down';
    if (claiming.has(provider)) return 'down';
    claiming.add(provider);
    try {
      const [claimed] = await sqlClient`
        UPDATE ai_provider_state SET retry_at = now() + interval '5 minutes', updated_at = now()
        WHERE provider = ${provider} AND down_since IS NOT NULL AND retry_at <= now()
        RETURNING retry_at`;
      if (claimed) {
        remember(provider, { ...entry, retryAt: millis(claimed.retry_at) });
        return 'let-through';
      }
      // Another instance let this request through, or the provider came back: down here until the next read.
      remember(provider, { ...entry, retryAt: Infinity });
      return 'down';
    } catch (error) {
      unreadable(error);
      return 'up';
    } finally {
      claiming.delete(provider);
    }
  }

  return {
    standing,

    // Whether the provider counts as marked down for this question: a provider let through for its one request does
    // not (standing).
    async isDown(provider) {
      return (await standing(provider)) === 'down';
    },

    // The small test request a failed reply sends its provider, which the reply's clock starts at the provider's first
    // failure, so that it runs beside the rest of the reply (providers.js). It resolves to whether the provider
    // answered it, or to null for a provider this instance knows to be marked down, which is not pinged again.
    // `signal` fires when the reply no longer needs it (the provider answered a job after all).
    async ping(provider, { signal = null } = {}) {
      if ((await known()).get(provider)?.downSince != null) return null;
      return answers(provider, { signal });
    },

    // The check of a provider marked down that a reply let through for its one request but asks only after another
    // provider (providers.js): its ping, which carries nothing a visitor wrote. It resolves to true only when the
    // provider answered it, to false when the provider failed it, and to null when it says nothing (no ping is set, it
    // could not be made, it said nothing of the provider, or the reply cut it off because the provider answered a job
    // or failed one after all). It changes nothing itself: the reply tells the state what it found when it ends.
    async probe(provider, { signal = null } = {}) {
      if (typeof ping !== 'function') return null;
      try {
        const said = await ping(provider, { signal });
        if (signal?.aborted) return null;
        return said === true || said === false ? said : null;
      } catch {
        console.error(`[providers] The check of ${provider}, marked down, could not be made; it stays as it is.`);
        return null;
      }
    },

    // A reply that ended with the provider answering none of its jobs, after it failed in a way that counts against
    // it. providers.js tells it once for each reply, when the reply ends. `pinged` is what ping(provider) gave at that
    // failure; with none, or when it gave null, the provider is pinged now if a verdict is needed.
    async replyFailed(provider, { reason = null, markDownNow = false, pinged = null } = {}) {
      let recorded;
      try {
        // The failed replies of the last five minutes, this one included.
        [recorded] = await sqlClient`
          INSERT INTO ai_provider_state (provider, failed_replies) VALUES (${provider}, ARRAY[now()])
          ON CONFLICT (provider) DO UPDATE SET
            failed_replies = array_append(ARRAY(SELECT failed_at FROM unnest(ai_provider_state.failed_replies) AS failed_at WHERE failed_at > now() - interval '5 minutes'), now()),
            updated_at = now()
          RETURNING down_since, reason, retry_at, cardinality(failed_replies) AS failed`;
      } catch (error) {
        unreadable(error);
        return;
      }
      const entry = knownFrom(recorded ?? {});
      remember(provider, entry);
      // Marked down already: a failed reply tells nothing new, and the provider is not pinged again.
      if (entry.downSince !== null) return;
      if (markDownNow || entry.failed >= FAILED_REPLIES_TO_MARK_DOWN) {
        await markDown(provider, reason);
        return;
      }
      const early = await Promise.resolve(pinged).catch(() => null);
      if ((early ?? await answers(provider)) === false) await markDown(provider, reason);
    },

    // A reply in which the provider answered a job. A provider that is up has its failed replies cleared. One marked
    // down keeps its mark until it has served its five minutes, however many replies it answers meanwhile; after that,
    // the instance whose UPDATE clears it tells the owner it is back. Nothing to clear, as far as this instance knows,
    // costs no write.
    async replySucceeded(provider) {
      const entry = (await known()).get(provider);
      if (!entry) return;
      if (entry.downSince !== null && entry.downSince > now() - DOWN_AT_LEAST_MS) return;
      let cleared;
      try {
        // The row as it was before it is cleared, to tell the owner since when the provider was down and why. Five
        // minutes is served from down_since: the request let through moves retry_at on, so retry_at cannot say.
        [cleared] = await sqlClient`
          WITH was AS (SELECT provider, down_since, reason FROM ai_provider_state WHERE provider = ${provider} FOR UPDATE)
          UPDATE ai_provider_state AS state
          SET down_since = NULL, reason = NULL, retry_at = NULL, failed_replies = '{}', updated_at = now()
          FROM was
          WHERE state.provider = was.provider
            AND (was.down_since <= now() - interval '5 minutes' OR (was.down_since IS NULL AND cardinality(state.failed_replies) > 0))
          RETURNING was.down_since, was.reason`;
      } catch (error) {
        unreadable(error);
        return;
      }
      // Nothing cleared: another instance did, or the database's clock says the five minutes are not yet up.
      if (!cleared) {
        stale();
        return;
      }
      remember(provider, null);
      if (millis(cleared.down_since) !== null) await told({ kind: 'up', provider, reason: cleared.reason ?? null, since: iso(cleared.down_since) });
    },

    async snapshot() {
      const found = await known();
      return Object.fromEntries([...found]
        .filter(([, entry]) => entry.downSince !== null)
        .map(([provider, entry]) => [provider, { downSince: new Date(entry.downSince).toISOString(), reason: entry.reason }]));
    },
  };
}
