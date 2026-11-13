/** AES-GCM sealing for stored provider keys. Pure Web Crypto (works on the server runtime and in tests). */
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('Key vault is not configured.');
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`snapsolve-ai-key-vault:v1:${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** The provider id is bound as associated data, so a row copied to another provider will not open. */
export async function sealKey(secret: string, provider: string, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(provider) }, await deriveKey(secret), enc.encode(plain));
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(ct)) };
}

export async function openKey(secret: string, provider: string, sealed: { iv: string; ciphertext: string }): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: enc.encode(provider) }, await deriveKey(secret), unb64(sealed.ciphertext));
  return dec.decode(pt);
}
