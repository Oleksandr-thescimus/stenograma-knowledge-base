// kb: the core from the command line (docs/PLAN.md, M1). Run with `yarn kb <command>`, which starts it under
// Electron's Node like the app's core. Prints to the terminal what the user asked for; logs nothing else of the content
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { citedNumbers, prepareAnswer, streamAnswer } from '../answer/answer.ts';
import { rewriteQuestion, type SearchRequest } from '../answer/rewrite.ts';
import { BROWSER_KIND, createBrowserSource, renewBrowserToken } from '../browsers.ts';
import { getKbId, openDb, type Db } from '../db.ts';
import { embeddingModelId, isLocalEmbedding } from '../embed/provider.ts';
import { embedPending, pendingEmbeddings } from '../embed/store.ts';
import { evaluate, readGoldenSet, summarize } from '../eval.ts';
import { formatChunkStart, formatDay } from '../format.ts';
import { createConfiguredEmbeddingProvider, createLanguageModel, isLocalLlm, llmKeyName } from '../llm.ts';
import { acquireLock } from '../lock.ts';
import { dataDir, dbPath, ensureDataDir, goldenSetPath, lockPath, settingsPath } from '../paths.ts';
import { search, type SearchHit } from '../search.ts';
import { buildServer, stenogramaOpenUrl } from '../server.ts';
import { createRocketChatApi } from '../rocketchat/api.ts';
import { readConfig, ROCKETCHAT_KIND, syncRocketChat, tokenSecretName } from '../rocketchat/sync.ts';
import { deleteSecret, getSecret, setSecret } from '../secrets.ts';
import { loadSettings } from '../settings.ts';
import { answersLlm, keyIdOf } from '../servers.ts';
import type { KeyProvider } from '../protocol.ts';
import { findOrCreateOnlySource, listSources, markSynced, removeSource, setCloudAllowed } from '../sources.ts';
import { bundlesFromBackup, readBackup } from '../stenograma/backup.ts';
import { ingestBundles, reconcileSessions } from '../stenograma/ingest.ts';
import { getIndexedVersion } from '../stenograma/meeting.ts';

const USAGE = `Usage: yarn kb <command>

  import <data.json>   Import a Stenograma backup's meetings (unzip -p backup.zip data.json > data.json), then embed
                       them. Importing a newer backup again replaces the old one's meetings.
  embed                Embed what's still in the queue (after an interrupted import)
  search <query>       Hybrid search. --source <kind>, --from/--to <YYYY-MM-DD>, --person <name>, --limit <n>
  ask <question>       An answer with citations, by the LLM of settings.json. Dates and a person are taken from the
                       question; --source, --from, --to and --person set them instead
  key set|delete <groq|gemini|anthropic|ollama-cloud>
  key set|delete openai <the API's address>   an OpenAI-compatible API's (Cerebras, OpenRouter…)
                       Keep an LLM key in the keyring (typed without echo), or remove it
  eval                 Recall@10 and MRR on the golden set (--golden <path>, default ${goldenSetPath()})
  serve                The API for the extension on 127.0.0.1 (the port in settings.json), embedding what it pushes
  add-browser [label]  Pair a browser: makes its source and prints the token to paste into the extension's popup
  new-token <source>   A new token for a paired browser whose token is lost; the old one stops working
  sync <source>        Sync a connector's source once (Rocket.Chat; the app syncs on its own), then embed
  remove <source>      Remove a source with all its documents
  status               Sources, documents and the embedding queue
  cloud <source> on|off
                       Whether a source's content may go to a cloud LLM and cloud embeddings (F8)
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    person: { type: 'string' },
    limit: { type: 'string' },
    golden: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...args] = positionals;

// A local date: --from is its start, --to the start of the next day
const parseDay = (day: string | undefined, nextDay = false) => {
  if (!day) {
    return undefined;
  }

  const date = new Date(`${day}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Not a date: ${day} (YYYY-MM-DD)`);
  }

  if (nextDay) {
    date.setDate(date.getDate() + 1);
  }

  return date.getTime();
};

const hitLine = (hit: SearchHit) => `${hit.title} · ${formatDay(hit.createdAt)}${formatChunkStart(hit)}${hit.madeByAi ? ' · made by AI' : ''}`;

const describeRequest = (request: SearchRequest) => [
  request.from !== undefined && ` · from ${formatDay(request.from)}`,
  request.to !== undefined && ` · to ${formatDay(request.to - 1)}`,
  request.person && ` · person: ${request.person}`,
].filter(Boolean).join('');

const readLine = (prompt: string) => new Promise<string>((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(prompt, (answer) => {
    rl.close();
    resolve(answer.trim());
  });
});

// Reads a line without echoing it, so a key is neither shown nor kept in the shell's history
const readHidden = (prompt: string) => new Promise<string>((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  process.stdout.write(prompt);
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => undefined;
  rl.question('', (answer) => {
    rl.close();
    process.stdout.write('\n');
    resolve(answer.trim());
  });
});

const progress = (label: string) => (done: number, total: number) => process.stdout.write(`\r${label} ${done}/${total}`);

const embedQueue = async (db: Db) => {
  const provider = createConfiguredEmbeddingProvider(loadSettings().embedding);
  const pending = pendingEmbeddings(db, provider);

  if (!pending) {
    console.log(`Nothing to embed with ${provider.id}`);

    return;
  }

  const started = Date.now();
  const done = await embedPending(db, provider, { onProgress: progress(`Embedding with ${provider.id}:`) });
  console.log(`\nEmbedded ${done} chunks in ${Math.round((Date.now() - started) / 1000)} s`);
};

// Writes: holds the lock, so it never runs next to the app's core
const withWritableDb = async (run: (db: Db) => Promise<void>) => {
  ensureDataDir();
  const release = acquireLock(lockPath());
  const db = openDb(dbPath());

  try {
    await run(db);
  } finally {
    db.close();
    release();
  }
};

// Only reads, so it can run next to the app: the query's embedding isn't cached
const withReadonlyDb = async (run: (db: Db) => Promise<void>) => {
  if (!existsSync(dbPath())) {
    throw new Error(`No knowledge base in ${dataDir()} yet: start with yarn kb import <data.json>`);
  }

  const db = openDb(dbPath(), { readonly: true });

  try {
    await run(db);
  } finally {
    db.close();
  }
};

const commands: Record<string, () => Promise<void>> = {
  import: () => withWritableDb(async (db) => {
    const [path] = args;

    if (!path) {
      throw new Error('Usage: yarn kb import <data.json>');
    }

    const bundles = bundlesFromBackup(readBackup(path));
    const source = findOrCreateOnlySource(db, 'stenograma-backup', basename(path));
    const { embedding } = loadSettings();
    const model = embeddingModelId(embedding);
    ingestBundles(db, source.id, bundles, model);
    const removed = reconcileSessions(db, source.id, bundles.map((bundle) => bundle.session.sessionId), model);
    markSynced(db, source.id);
    console.log(`Imported ${bundles.length} sessions into source ${source.id}${removed ? `, removed ${removed} no longer in it` : ''}`);
    await embedQueue(db);
  }),

  embed: () => withWritableDb(embedQueue),

  search: () => withReadonlyDb(async (db) => {
    const query = args.join(' ');

    if (!query) {
      throw new Error('Usage: yarn kb search <query>');
    }

    const provider = createConfiguredEmbeddingProvider(loadSettings().embedding);
    const { hits, warning } = await search(db, query, {
      provider,
      limit: values.limit ? Number(values.limit) : 10,
      sourceKind: values.source,
      from: parseDay(values.from),
      to: parseDay(values.to, true),
      person: values.person,
    });

    if (warning) {
      console.log(`${warning}\n`);
    }

    hits.forEach((hit, index) => {
      const snippet = hit.text.replace(/\s+/g, ' ').slice(0, 220);
      console.log(`${index + 1}. ${hitLine(hit)}`);
      console.log(`   ${snippet}${hit.text.length > 220 ? '…' : ''}\n`);
    });

    if (!hits.length) {
      console.log('Nothing found');
    }
  }),

  eval: () => withReadonlyDb(async (db) => {
    const questions = readGoldenSet(values.golden ?? goldenSetPath());
    const provider = createConfiguredEmbeddingProvider(loadSettings().embedding);
    const results = await evaluate(db, questions, provider);
    console.log(`${questions.length} questions, embeddings ${provider.id}\n`);
    console.log('group       recall@10  MRR@10  session@10');

    for (const row of summarize(results)) {
      console.log(`${`${row.group} (${row.questions})`.padEnd(12)}${row.recall.toFixed(2).padStart(9)}${row.mrr.toFixed(2).padStart(8)}${row.session.toFixed(2).padStart(12)}`
        + `${row.unanswerable.length ? `   no answering chunk: ${row.unanswerable.join(', ')}` : ''}`);
    }

    console.log(`\nMissed: ${results.filter((result) => !result.rank).map((result) => result.id).join(', ') || 'none'}`);
  }),

  ask: () => withReadonlyDb(async (db) => {
    const question = args.join(' ');

    if (!question) {
      throw new Error('Usage: yarn kb ask <question>');
    }

    const settings = loadSettings();
    // The chat's model: the first server's with one (Settings → AI models)
    const llm = answersLlm(settings);
    const model = createLanguageModel(llm);
    const request: SearchRequest = values.source || values.from || values.to || values.person
      ? { query: question, from: parseDay(values.from), to: parseDay(values.to, true), person: values.person }
      : await rewriteQuestion(model, llm, question);
    console.log(`Searching for: ${request.query}${describeRequest(request)}`);

    const { query, ...filters } = request;
    const { hits, warning } = await search(db, query, {
      ...filters, provider: createConfiguredEmbeddingProvider(settings.embedding), limit: 20, sourceKind: values.source,
    });

    if (warning) {
      console.log(warning);
    }

    const prepared = prepareAnswer(db, llm, question, hits);
    const leftOut = prepared.leftOut ? `${prepared.leftOut} found chunks were left out: their sources don't allow a cloud LLM (F8)` : '';

    if (!prepared.sources.length) {
      console.log(`\nNothing found that answers it. ${leftOut}`);

      return;
    }

    console.log(`Answering with ${llm.provider} ${llm.model}${isLocalLlm(llm) ? ' (local)' : ''} from ${prepared.sources.length} chunks\n`);

    let streamError: unknown;
    const result = streamAnswer(model, llm, prepared, (error) => {
      streamError = error;
    });
    let answer = '';

    for await (const part of result.textStream) {
      answer += part;
      process.stdout.write(part);
    }

    if (streamError) {
      throw streamError;
    }

    const cited = citedNumbers(answer);
    const uncited = prepared.sources.filter((source) => !cited.has(source.n)).length;
    console.log('\n\nSources:');
    const { port } = settings.server;
    prepared.sources.filter((source) => cited.has(source.n)).forEach(({ n, hit }) => {
      // A meeting pushed by a browser opens there, at the moment (docs/PLAN.md, The app); an imported one has no browser
      const link = hit.sourceKind === BROWSER_KIND && hit.threadId
        ? `\n      ${stenogramaOpenUrl(port, hit.sourceId, hit.threadId, hit.startMs, getIndexedVersion(db, hit.sourceId, hit.threadId))}`
        : '';
      console.log(`  [${n}] ${hitLine(hit)}${link}`);
    });
    console.log([uncited && `  ${uncited} more given but not cited`, leftOut && `  ${leftOut}`].filter(Boolean).join('\n'));
  }),

  key: async () => {
    const [action, provider, url = ''] = args;

    if (!['set', 'delete'].includes(action) || !['groq', 'gemini', 'anthropic', 'ollama-cloud', 'openai'].includes(provider)
      || (provider === 'openai' && !URL.canParse(url))) {
      throw new Error('Usage: yarn kb key set|delete <groq|gemini|anthropic|ollama-cloud>, or yarn kb key set|delete openai <the API\'s address>');
    }

    const keyId = keyIdOf({ kind: provider as KeyProvider, url });

    if (action === 'delete') {
      deleteSecret(llmKeyName(keyId));
      console.log(`Removed the ${provider} key`);

      return;
    }

    const key = await readHidden(`Paste the ${provider} API key: `);

    if (!key) {
      throw new Error('No key given');
    }

    setSecret(llmKeyName(keyId), key);
    console.log(`Kept the ${provider} key. To answer with it, set "llm" in ${settingsPath()}`);
  },

  serve: () => withWritableDb(async (db) => {
    const settings = loadSettings();
    const { port } = settings.server;
    const provider = createConfiguredEmbeddingProvider(settings.embedding);
    const controller = new AbortController();
    let running: Promise<void> | null = null;
    let again = false;

    // One embedding run at a time; a push during it runs it again after
    const embedSoon = () => {
      if (running) {
        again = true;

        return;
      }

      running = (async () => {
        do {
          again = false;

          try {
            // eslint-disable-next-line no-await-in-loop
            const done = await embedPending(db, provider, { abortSignal: controller.signal });

            if (done) {
              console.log(`embedded ${done} chunks with ${provider.id}`);
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              console.error(`embedding failed: ${(error as Error).message}`);
            }
          }
        } while (again && !controller.signal.aborted);

        running = null;
      })();
    };

    const server = buildServer({ db, port, embedModel: () => provider.id, onChange: embedSoon, log: (line) => console.log(line) });
    await server.listen({ host: '127.0.0.1', port });
    console.log(`The knowledge base listens on http://127.0.0.1:${port} (Ctrl+C stops it)`);
    embedSoon();

    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    controller.abort();
    await server.close();
    await running;
  }),

  'add-browser': () => withWritableDb(async (db) => {
    const label = args.join(' ') || 'Browser';
    const { source, token } = createBrowserSource(db, label);
    console.log(`Paired "${label}" as source ${source.id}. Paste this token into the extension's popup, under "Local knowledge base":`);
    console.log(`\n  ${token}\n`);
    console.log(`It's shown only now: the knowledge base keeps only its hash. If it's lost, yarn kb new-token ${source.id} makes another.`);

    const backup = listSources(db).find((candidate) => candidate.kind === 'stenograma-backup');

    if (backup) {
      const answer = await readLine(`\nRemove source ${backup.id}, the imported backup (${backup.documents} documents)? Once this browser pushes, each of its meetings would be found twice. [y/N] `);

      if (/^y/i.test(answer)) {
        removeSource(db, backup.id, embeddingModelId(loadSettings().embedding));
        console.log(`Removed source ${backup.id}`);
      }
    }
  }),

  'new-token': () => withWritableDb(async (db) => {
    const source = listSources(db).find((candidate) => candidate.id === Number(args[0]) && candidate.kind === BROWSER_KIND);

    if (!source) {
      throw new Error('Usage: yarn kb new-token <browser source id> (yarn kb status lists them)');
    }

    const answer = await readLine(`The current token of source ${source.id} (${source.account ?? ''}) stops working. Make a new one? [y/N] `);

    if (/^y/i.test(answer)) {
      const token = renewBrowserToken(db, source.id);
      console.log(`Paste this token into the extension's popup, under "Local knowledge base":\n\n  ${token}\n`);
      console.log('Its meetings stay: the browser continues the same source.');
    }
  }),

  remove: () => withWritableDb(async (db) => {
    const source = listSources(db).find((candidate) => candidate.id === Number(args[0]));

    if (!source) {
      throw new Error('Usage: yarn kb remove <source id> (yarn kb status lists them)');
    }

    const answer = await readLine(`Remove source ${source.id} (${source.kind} ${source.account ?? ''}) with its ${source.documents} documents? [y/N] `);

    if (/^y/i.test(answer)) {
      removeSource(db, source.id, embeddingModelId(loadSettings().embedding));

      if (source.kind === ROCKETCHAT_KIND) {
        deleteSecret(tokenSecretName(getKbId(db), source.id));
      }

      console.log(`Removed source ${source.id}`);
    }
  }),

  sync: () => withWritableDb(async (db) => {
    const source = listSources(db).find((candidate) => candidate.id === Number(args[0]) && candidate.kind === ROCKETCHAT_KIND);

    if (!source) {
      throw new Error('Usage: yarn kb sync <Rocket.Chat source id> (yarn kb status lists them; the app adds one)');
    }

    const token = getSecret(tokenSecretName(getKbId(db), source.id));

    if (!token) {
      throw new Error(`The token of source ${source.id} isn't in the keyring: give it again in the app`);
    }

    const api = createRocketChatApi({ ...readConfig(db, source.id), token });

    try {
      const result = await syncRocketChat({
        db, sourceId: source.id, api, embedModel: embeddingModelId(loadSettings().embedding),
        progress: (text) => process.stdout.write(`\rReading ${text}   `),
      });
      markSynced(db, source.id);
      console.log(`\nRead ${result.rooms} rooms, ${result.messages} messages`);
    } catch (error) {
      markSynced(db, source.id, (error as Error).message);
      throw error;
    }

    await embedQueue(db);
  }),

  cloud: () => withWritableDb(async (db) => {
    const [id, state] = args;

    if (!id || !['on', 'off'].includes(state)) {
      throw new Error('Usage: yarn kb cloud <source id> on|off (yarn kb status lists the sources)');
    }

    if (!setCloudAllowed(db, Number(id), state === 'on')) {
      throw new Error(`No source ${id} (yarn kb status lists them)`);
    }

    console.log(`Source ${id}: a cloud LLM and cloud embeddings ${state === 'on' ? 'may now see' : 'no longer see'} its content`);
  }),

  status: () => withReadonlyDb(async (db) => {
    const { embedding } = loadSettings();
    const provider = { id: embeddingModelId(embedding), local: isLocalEmbedding(embedding) };
    console.log(`Knowledge base ${getKbId(db)} in ${dataDir()}`);
    console.log(`Embeddings: ${provider.id}, ${pendingEmbeddings(db, provider)} chunks in the queue\n`);

    for (const source of listSources(db)) {
      const elsewhere = source.indexedElsewhere ? ` · ${source.indexedElsewhere} meetings indexed from another browser` : '';
      console.log(`${source.id}. ${source.kind} ${source.account ?? ''} · ${source.documents} documents, ${source.chunks} chunks${elsewhere}`
        + ` · cloud ${source.cloudAllowed ? 'allowed' : 'not allowed'}`
        + ` · last sync ${source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : 'never'}${source.lastError ? ` · error: ${source.lastError}` : ''}`);
    }
  }),
};

if (values.help || !command || !commands[command]) {
  console.log(USAGE);
  process.exitCode = command && !values.help ? 1 : 0;
} else {
  try {
    await commands[command]();
  } catch (error) {
    console.error(`kb ${command}: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
