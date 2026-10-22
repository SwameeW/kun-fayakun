/**
 * Quran Foundation Content API v4, used only by `validate --online` to cross-check
 * the Tanzil text. Per the API terms its text must not be cached or bundled, so
 * nothing returned here is ever written to disk.
 *
 * Endpoints (api-docs.quran.foundation, read 2026-10-22):
 *   POST {auth}/oauth2/token  (HTTP Basic client_id:client_secret,
 *        body grant_type=client_credentials&scope=content) -> { access_token, expires_in }
 *   GET  {api}/content/api/v4/quran/verses/uthmani?verse_key=S:A
 *        headers x-auth-token, x-client-id -> { verses: [{ verse_key, text_uthmani }] }
 * The pre-live environment only serves surahs 1 and 2.
 */
import { fetchJson } from './net';
import { isRecord } from './shape';

export interface QfConfig {
  clientId: string;
  clientSecret: string;
  env: 'production' | 'prelive';
}

const HOSTS = {
  production: { auth: 'https://oauth2.quran.foundation', api: 'https://apis.quran.foundation' },
  prelive: { auth: 'https://prelive-oauth2.quran.foundation', api: 'https://apis-prelive.quran.foundation' },
} as const;

/** QF_CLIENT_ID + QF_CLIENT_SECRET (and optional QF_ENV=prelive), or null when unset. */
export function qfConfigFromEnv(env: NodeJS.ProcessEnv = process.env): QfConfig | null {
  const clientId = env.QF_CLIENT_ID;
  const clientSecret = env.QF_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, env: env.QF_ENV === 'prelive' ? 'prelive' : 'production' };
}

/** Surahs the environment can serve. */
export function qfServesSurah(config: QfConfig, surah: number): boolean {
  return config.env === 'production' || surah <= 2;
}

export class QfClient {
  private token: string | null = null;

  constructor(private readonly config: QfConfig) {}

  private async requestToken(): Promise<string> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const { status, body } = await fetchJson(`${HOSTS[this.config.env].auth}/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=content',
    });
    const token = isRecord(body) ? body.access_token : undefined;
    if (status !== 200 || typeof token !== 'string') throw new Error(`Quran Foundation token request failed: HTTP ${status}`);
    return token;
  }

  /** text_uthmani for one ayah; retries once with a fresh token on 401. */
  async uthmani(key: string): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.token ??= await this.requestToken();
      const url = `${HOSTS[this.config.env].api}/content/api/v4/quran/verses/uthmani?verse_key=${encodeURIComponent(key)}`;
      const { status, body } = await fetchJson(url, {
        headers: { 'x-auth-token': this.token, 'x-client-id': this.config.clientId },
      });
      if (status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      if (status !== 200) throw new Error(`Quran Foundation ${key}: HTTP ${status}`);
      const verses = isRecord(body) ? body.verses : undefined;
      const first: unknown = Array.isArray(verses) ? (verses as unknown[])[0] : undefined;
      if (isRecord(first) && first.verse_key === key && typeof first.text_uthmani === 'string') return first.text_uthmani;
      throw new Error(`Quran Foundation ${key}: response has no text_uthmani for this verse`);
    }
    throw new Error(`Quran Foundation ${key}: unauthorised after a fresh token`);
  }
}
