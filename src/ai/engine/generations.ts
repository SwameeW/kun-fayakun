/*
 * The model worker's generations, one at a time (docs/AI-INTELLIGENCE.md §3).
 *
 * WebLLM 0.2.86 streams a completion from an async generator (MLCEngine.asyncGenerate) that takes the
 * model's lock on its first step and lets it go only in its own `finally`: when it has written its
 * last piece, when it throws, or when it is returned. A generator left at a yield keeps the lock, and
 * every later generation waits on it for good. The worker once dropped an unfinished stream when the
 * next began, so a question asked over another (or straight after a stop) never got its answer, and
 * the render budget its generation held was never let go.
 *
 * So a generation is started only once the one before it has ended: it is interrupted (WebLLM's
 * interruptGenerate, which WebLLM reads between tokens, so the step under way, a token or the whole of
 * a prompt being read, finishes first), its iterator is returned (WebLLM's `finally` runs and the lock
 * goes), and only then is the next one asked for. Requests are handled in the order they came: a start
 * waits for the starts before it.
 *
 * A stop asked before WebLLM has been asked for a generation's first piece is kept here, not passed on:
 * asyncGenerate clears WebLLM's interrupt once it has taken the lock, on that first step, so the stop
 * would be lost and the whole reply written. Such a generation is never started: its iterator is
 * returned before its first step, and it never takes the lock.
 *
 * Plain data in, plain data out, with WebLLM's engine given as two functions, so tests drive it with
 * WebLLM's own MLCEngine and a stand-in pipeline (tests/unit/ai-generations.spec.ts).
 */
import type { ChatCompletionChunk, ChatCompletionRequestStreaming } from '@mlc-ai/web-llm';

/** What a generation is made from: WebLLM's streaming completion, and its interrupt. */
export interface GenerationSource {
  create(request: ChatCompletionRequestStreaming): Promise<AsyncIterable<ChatCompletionChunk>>;
  /** Asks the generation under way to stop at its next token (WebLLM's interruptGenerate). */
  interrupt(): void | Promise<void>;
}

export interface Generations {
  /** Ends the generation before it (if any), then starts this one as `id`; rejects with WebLLM's failure to start it. */
  start(id: number, request: ChatCompletionRequestStreaming): Promise<void>;
  /** The next piece of generation `id`, decoded now; null once it has ended, or when it is not the one under way. */
  pull(id: number): Promise<ChatCompletionChunk | null>;
  /**
   * Asks generation `id` (without one, the one under way) to stop at its next token; its pieces up to
   * the stop still come. One not yet started, or not yet asked for its first piece, is never started.
   */
  interrupt(id?: number): Promise<void>;
  /** Ends the generation under way as a start would, and waits until it has (before an unload). */
  end(): Promise<void>;
  /** The generation under way, or null. */
  readonly current: number | null;
}

interface Stream {
  id: number;
  pieces: AsyncIterator<ChatCompletionChunk>;
  /** The step under way (a piece being decoded, or the prompt being read), or null. */
  step: Promise<IteratorResult<ChatCompletionChunk>> | null;
  /** WebLLM has been asked for its first piece (it has taken, or is taking, the lock). */
  begun: boolean;
  /** A stop was asked before that: it is ended at its first pull without being started. */
  stopAsked: boolean;
  /** No more pieces are asked of it: it has finished, failed, or is being ended. */
  closed: boolean;
  /** Settles once its iterator has been returned (WebLLM's lock let go). */
  ending: Promise<void> | null;
}

/** Read through a function: a stream is closed in callbacks while a pull awaits. */
const isClosed = (s: Stream): boolean => s.closed;

export function createGenerations(source: GenerationSource): Generations {
  let current: Stream | null = null;
  /** Starts and ends in the order they were asked for. */
  let queue: Promise<void> = Promise.resolve();
  /** Generations asked for and not yet under way (waiting for the one before them, or being created). */
  const starting = new Set<number>();
  /** Those of them stopped already. */
  const stoppedEarly = new Set<number>();

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** Interrupts the stream, lets its step under way finish, and returns its iterator; idempotent. */
  const finish = (s: Stream): Promise<void> => {
    if (s.ending) return s.ending;
    s.closed = true;
    s.ending = (async () => {
      // One never started has nothing to interrupt (and WebLLM's interrupt would wait for the next).
      if (s.begun) {
        try {
          await source.interrupt();
        } catch {
          // An engine that cannot be interrupted still has its iterator returned below.
        }
      }
      // WebLLM reads the interrupt between tokens: the token (or the prompt) under way is finished first.
      if (s.step) await s.step.catch(() => undefined);
      try {
        // Its finally runs: the pipeline is stopped and the model's lock let go. A stream that ended
        // on its own has nothing left to return, and one never started never took the lock.
        await s.pieces.return?.();
      } catch {
        // A generator that throws as it is returned has left its finally too.
      }
      if (current === s) current = null;
    })();
    return s.ending;
  };

  return {
    get current() {
      return current?.id ?? null;
    },
    start(id, request) {
      starting.add(id);
      return serial(async () => {
        try {
          if (current) await finish(current);
          const created = await source.create(request);
          current = { id, pieces: created[Symbol.asyncIterator](), step: null, begun: false, stopAsked: stoppedEarly.has(id), closed: false, ending: null };
        } finally {
          starting.delete(id);
          stoppedEarly.delete(id);
        }
      });
    },
    async pull(id) {
      const s = current;
      if (s?.id !== id || s.closed) return null;
      // The page pulls one piece at a time; a second pull waits for the first.
      if (s.step) await s.step.catch(() => undefined);
      if (isClosed(s)) return null;
      if (!s.begun && s.stopAsked) {
        // Stopped before its first step: returned without being started, so it never takes the lock.
        await finish(s);
        return null;
      }
      s.begun = true;
      const step = s.pieces.next();
      s.step = step;
      try {
        const next = await step;
        if (next.done === true) {
          // Finished on its own: its finally has run.
          s.closed = true;
          s.ending ??= Promise.resolve();
          if (current === s) current = null;
          return null;
        }
        return next.value;
      } catch (err) {
        // A generator that throws has left its finally (the lock with it).
        s.closed = true;
        s.ending ??= Promise.resolve();
        if (current === s) current = null;
        throw err;
      } finally {
        if (s.step === step) s.step = null;
      }
    },
    async interrupt(id) {
      if (id !== undefined && starting.has(id)) {
        stoppedEarly.add(id);
        return;
      }
      const s = current;
      if (!s || s.closed || (id !== undefined && s.id !== id)) return;
      // WebLLM clears its interrupt on a generation's first step: a stop before it is kept here instead.
      if (!s.begun) {
        s.stopAsked = true;
        return;
      }
      await source.interrupt();
    },
    end() {
      return serial(async () => {
        if (current) await finish(current);
      });
    },
  };
}
