import { claudeRoute } from './claude-cli.mjs';
import { keyFor } from './keys.mjs';
import { anthropicKey } from './providers.mjs';

// Only list models that these chat adapters can route. The Gemini list also
// includes media-only generators, so generateContent alone is insufficient.
export function directModelEntries(provider, body) {
  const rows = provider === 'anthropic' ? body?.data : body?.models;
  if (!Array.isArray(rows)) throw new Error('The provider returned no model list.');
  const entries = new Map();
  for (const row of rows) {
    const id = provider === 'anthropic' ? row?.id : row?.name?.replace?.(/^models\//, '');
    if (typeof id !== 'string' || !/^[a-z\d][a-z\d._-]{1,119}$/.test(id)) continue;
    if (provider === 'anthropic') {
      if (!id.startsWith('claude-')) continue;
    } else if (!/^gemini-\d+(?:\.\d+)?-/.test(id) || /(?:^|-)(?:image|live|audio|tts|embedding|robotics|computer-use)(?:-|$)/.test(id) ||
      !Array.isArray(row.supportedGenerationMethods) || !row.supportedGenerationMethods.includes('generateContent')) continue;
    const name = provider === 'anthropic' ? row.display_name : row.displayName;
    const label = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
    entries.set(id, { id, label: `${label || id} (${provider === 'anthropic' ? 'Anthropic API' : 'Google AI API'})` });
    if (entries.size >= 120) break;
  }
  if (!entries.size) throw new Error('The provider returned no supported chat models.');
  return [...entries.values()];
}

export async function readDirectModels(provider) {
  const claude = provider === 'anthropic';
  // Do not send a key for a custom endpoint to the public Claude API.
  if (claude && process.env.ANTHROPIC_BASE_URL) return null;
  const key = claude ? (await anthropicKey()).key : await keyFor('googleai');
  if (!key || (claude && await claudeRoute() !== 'api')) return null;
  const url = claude ? 'https://api.anthropic.com/v1/models?limit=100' : 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';
  const headers = claude ? { 'x-api-key': key, 'anthropic-version': '2026-10-21' } : { 'x-goog-api-key': key };
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const reader = response.body?.getReader();
  if (!response.ok || !reader) {
    await reader?.cancel().catch(() => {});
    throw new Error('The model list could not be read.');
  }
  const buffers = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1024 * 1024) {
      await reader.cancel().catch(() => {});
      throw new Error('The model list was too large.');
    }
    buffers.push(value);
  }
  return directModelEntries(provider, JSON.parse(Buffer.concat(buffers).toString('utf8')));
}
