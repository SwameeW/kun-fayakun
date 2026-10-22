/**
 * Rule b (--online only): re-download Tanzil and compare with the pinned files; when
 * QF_CLIENT_ID / QF_CLIENT_SECRET are set, compare every ayah with the Quran Foundation API.
 * Nothing fetched here is written to disk.
 */
import { PINS } from '../../fetch-quran';
import { letterSkeleton } from '../arabic';
import type { ValidationContext } from '../context';
import { fileExists, readBytes } from '../files';
import { fetchBytes } from '../net';
import { toRawTanzil } from '../quran-build';
import { QfClient, qfConfigFromEnv, qfServesSurah } from '../quran-foundation';
import type { RuleLog } from '../report';
import { TANZIL_FILES, tanzilPath } from '../tanzil';
import { nfc } from '../text';

async function compareTanzil(ctx: ValidationContext, log: RuleLog): Promise<void> {
  const cited = new Set<string>(ctx.quran.status === 'ok' ? ctx.quran.value.ayat.map((a) => a.key) : []);
  for (const file of TANZIL_FILES) {
    let fresh;
    try {
      fresh = toRawTanzil(file, await fetchBytes(file.url));
    } catch (err) {
      log.fail(`${file.filename}: download failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (fresh.sha256 === PINS[file.id].sha256) {
      log.pass(`${file.filename}: tanzil.net still serves the pinned file (sha256 ${fresh.sha256.slice(0, 16)}...)`);
      continue;
    }
    const pinnedPath = tanzilPath(file);
    if (!fileExists(pinnedPath)) {
      log.fail(`${file.filename}: download differs from the pin and no pinned copy exists to compare`);
      continue;
    }
    const pinned = toRawTanzil(file, readBytes(pinnedPath));
    const changed = [...fresh.parsed.lines].filter(([key, line]) => pinned.parsed.lines.get(key) !== line).map(([key]) => key);
    if (changed.length === 0) {
      log.warn(
        `${file.filename}: file hash changed but every verse line is identical (comment lines differ, e.g. the copyright year); ` +
          'run npm run fetch:quran -- --update-pins deliberately',
      );
    } else {
      const citedChanged = changed.filter((k) => cited.has(k));
      log.fail(
        `${file.filename}: ${changed.length} verse line(s) changed upstream (${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', ...' : ''}); ` +
          `cited keys affected: ${citedChanged.length > 0 ? citedChanged.join(', ') : 'none'}`,
      );
    }
  }
}

async function compareQuranFoundation(ctx: ValidationContext, log: RuleLog): Promise<void> {
  const config = qfConfigFromEnv();
  if (!config) {
    log.skip('QF_CLIENT_ID / QF_CLIENT_SECRET not set: Quran Foundation API comparison skipped');
    return;
  }
  if (ctx.quran.status !== 'ok') {
    log.fail('data/quran.json unavailable: cannot compare with the Quran Foundation API');
    return;
  }
  const client = new QfClient(config);
  let identical = 0;
  let skipped = 0;
  for (const entry of ctx.quran.value.ayat) {
    if (!qfServesSurah(config, entry.surah)) {
      skipped += 1;
      continue;
    }
    let remote: string;
    try {
      remote = nfc(await client.uthmani(entry.key));
    } catch (err) {
      log.fail(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (remote === entry.arabic) {
      identical += 1;
    } else {
      const sameLetters = letterSkeleton(remote) === letterSkeleton(entry.arabic);
      log.fail(
        `${entry.key}: Quran Foundation text_uthmani differs from Tanzil after NFC ` +
          `(${sameLetters ? 'same letters; marks or encoding differ' : 'letters differ'})`,
      );
    }
  }
  if (identical > 0) log.pass(`${identical} ayat identical (NFC) to Quran Foundation text_uthmani (${config.env})`);
  if (skipped > 0) log.skip(`${skipped} ayat not served by the ${config.env} environment (pre-live has surahs 1-2 only)`);
}

export async function checkOnline(ctx: ValidationContext, log: RuleLog): Promise<void> {
  if (!ctx.online) {
    log.skip('offline run; pass --online to re-download Tanzil and query the Quran Foundation API');
    return;
  }
  await compareTanzil(ctx, log);
  await compareQuranFoundation(ctx, log);
}
