import type {
  AssetLoader,
  ConstantId,
  ConstantsFile,
  DataStore,
  HadithEntry,
  HadithFile,
  HadithId,
  QuranEntry,
  QuranFile,
  ScienceConstant,
  SourcesFile,
  VerseKey,
} from './types';

/**
 * A verse whose text failed the integrity check (or is missing) is returned
 * with empty arabic, translit and translation: the UI shows its reference only.
 */
export function isWithheld(entry: QuranEntry): boolean {
  return entry.arabic === '';
}

function referenceOnly(key: VerseKey, from?: QuranEntry): QuranEntry {
  const [surah = 0, ayah = 0] = key.split(':').map(Number);
  return {
    key,
    surah,
    ayah,
    arabic: '',
    translit: '',
    translation: '',
    translationId: from?.translationId ?? '',
    license: from?.license ?? '',
    source: from?.source ?? { arabic: '', translit: '', translation: '' },
    sourceVersion: from?.sourceVersion ?? '',
    sha256: '',
    fetchedAt: from?.fetchedAt ?? '',
  };
}

async function sha256Hex(subtle: SubtleCrypto, text: string): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Defence in depth: data/quran.json is already checked by scripts/validate.ts,
 * but the browser re-checks what it is about to show. Returns the problems found.
 */
async function verifyVerse(entry: QuranEntry, subtle: SubtleCrypto | undefined): Promise<string[]> {
  const problems: string[] = [];
  if (!entry.arabic) return ['no text'];
  if (entry.key !== `${entry.surah}:${entry.ayah}`) problems.push('key does not match surah:ayah');
  if (entry.arabic.normalize('NFC') !== entry.arabic) problems.push('text is not NFC');
  if (subtle) {
    const hash = await sha256Hex(subtle, entry.arabic);
    if (hash !== entry.sha256.toLowerCase()) problems.push('sha256 mismatch');
  }
  return problems;
}

/**
 * Hadith wording is shown only once a person has entered and reviewed it. A blank
 * reviewer ("" or whitespace) is not a recorded reviewer: it is normalised to null,
 * so the UI's own `reviewer === null` check agrees.
 */
function guardHadith(entry: HadithEntry): HadithEntry {
  const reviewer = entry.reviewer?.trim() ? entry.reviewer : null;
  const unreviewed = reviewer === null && (entry.text.en !== null || entry.text.ar !== null);
  const arNotNfc = entry.text.ar !== null && entry.text.ar.normalize('NFC') !== entry.text.ar;
  if (!unreviewed && !arNotNfc) return reviewer === entry.reviewer ? entry : { ...entry, reviewer };
  console.error(`[data] Hadith ${entry.id}: wording withheld (${unreviewed ? 'no reviewer recorded' : 'text is not NFC'}).`);
  return { ...entry, reviewer, text: { en: unreviewed ? null : entry.text.en, ar: null, source: entry.text.source } };
}

function assertShape(ok: boolean, file: string): void {
  if (!ok) throw new Error(`data/${file} is malformed.`);
}

export function createDataStore(assets: AssetLoader): DataStore {
  const verses = new Map<string, QuranEntry>();
  const withheld = new Set<string>();
  const hadith = new Map<HadithId, HadithEntry>();
  const constants = new Map<ConstantId, ScienceConstant>();
  const reported = new Set<string>();
  let sources: SourcesFile | null = null;
  let quranMeta: QuranFile['meta'] | null = null;
  let loaded = false;

  const reportOnce = (message: string): void => {
    if (reported.has(message)) return;
    reported.add(message);
    console.error(`[data] ${message}`);
  };

  const ready = (async () => {
    const [quran, hadithFile, constantsFile, sourcesFile] = await Promise.all([
      assets.json<QuranFile>('data/quran.json'),
      assets.json<HadithFile>('data/hadith.json'),
      assets.json<ConstantsFile>('data/constants.json'),
      assets.json<SourcesFile>('data/sources.json'),
    ]);
    assertShape(Array.isArray(quran.ayat), 'quran.json');
    assertShape(Array.isArray(hadithFile.hadith) && Array.isArray(hadithFile.excluded), 'hadith.json');
    assertShape(Array.isArray(constantsFile.constants), 'constants.json');
    assertShape(Array.isArray(sourcesFile.sources), 'sources.json');

    // crypto.subtle exists only in secure contexts (https, localhost).
    const subtle = (globalThis.crypto as Partial<Crypto> | undefined)?.subtle;
    if (!subtle) console.warn('[data] crypto.subtle unavailable (insecure context): verse sha256 not re-checked in the browser.');
    const checks = await Promise.all(quran.ayat.map((entry) => verifyVerse(entry, subtle)));
    quran.ayat.forEach((entry, i) => {
      verses.set(entry.key, entry);
      const problems = checks[i] ?? [];
      if (problems.length > 0) {
        withheld.add(entry.key);
        console.error(`[data] Verse ${entry.key} withheld: ${problems.join(', ')}.`);
      }
    });

    const excluded = new Set(hadithFile.excluded.map((e) => e.sunnahKey));
    for (const entry of hadithFile.hadith) {
      if (excluded.has(entry.sunnahKey) || entry.parallels.some((k) => excluded.has(k))) {
        console.error(`[data] Hadith ${entry.id} references an excluded narration and is withheld.`);
        continue;
      }
      hadith.set(entry.id, guardHadith(entry));
    }
    for (const c of constantsFile.constants) constants.set(c.id, c);
    sources = sourcesFile;
    quranMeta = quran.meta;
    loaded = true;
  })();

  const requireLoaded = (what: string): void => {
    if (!loaded) throw new Error(`DataStore: ${what} requested before data/*.json finished loading.`);
  };

  return {
    ready,
    verse(key) {
      const entry = verses.get(key);
      if (!entry) {
        reportOnce(loaded ? `Verse ${key} is not in data/quran.json; showing its reference only.` : `Verse ${key} requested before data loaded; showing its reference only.`);
        return referenceOnly(key);
      }
      return withheld.has(key) ? referenceOnly(key, entry) : entry;
    },
    hadith(id) {
      requireLoaded(`hadith ${id}`);
      const entry = hadith.get(id);
      if (!entry) throw new Error(`Unknown or withheld hadith "${id}".`);
      return entry;
    },
    constant(id) {
      requireLoaded(`constant ${id}`);
      const entry = constants.get(id);
      if (!entry) throw new Error(`Unknown constant "${id}".`);
      return entry;
    },
    sources() {
      requireLoaded('sources');
      if (!sources) throw new Error('DataStore: sources missing.');
      return sources;
    },
    quranMeta() {
      requireLoaded('quran meta');
      if (!quranMeta) throw new Error('DataStore: quran meta missing.');
      return quranMeta;
    },
  };
}
