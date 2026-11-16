/**
 * Passphrase-based encryption for the API key.
 *
 * The ciphertext lives in the vault (data.json), the passphrase never does.
 * PBKDF2-SHA256 derives a 256-bit AES-GCM key; each encryption uses a fresh
 * salt and IV, and GCM authenticates the payload so tampering fails to decrypt.
 */

export interface EncryptedSecret {
  v: 1;
  /** base64, 16 bytes */
  salt: string;
  /** base64, 12 bytes */
  iv: string;
  /** base64 ciphertext (includes the GCM tag) */
  data: string;
  iterations: number;
}

export const PBKDF2_ITERATIONS = 310000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

export function isCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && !!crypto?.subtle && typeof crypto.getRandomValues === "function";
}

export function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EncryptedSecret>;
  return (
    candidate.v === 1 &&
    typeof candidate.salt === "string" &&
    typeof candidate.iv === "string" &&
    typeof candidate.data === "string" &&
    typeof candidate.iterations === "number" &&
    candidate.iterations > 1000
  );
}

export async function encryptSecret(plaintext: string, passphrase: string): Promise<EncryptedSecret> {
  assertUsable(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    v: 1,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(encrypted)),
    iterations: PBKDF2_ITERATIONS,
  };
}

/** Throws when the passphrase is wrong or the payload was tampered with. */
export async function decryptSecret(secret: EncryptedSecret, passphrase: string): Promise<string> {
  assertUsable(passphrase);
  if (!isEncryptedSecret(secret)) throw new Error("密文格式无效");
  const salt = fromBase64(secret.salt);
  const iv = fromBase64(secret.iv);
  const data = fromBase64(secret.data);
  const key = await deriveKey(passphrase, salt, secret.iterations);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    data as unknown as BufferSource,
  );
  return new TextDecoder().decode(decrypted);
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase) as unknown as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

function assertUsable(passphrase: string): void {
  if (!isCryptoAvailable()) throw new Error("当前环境不支持 WebCrypto，无法加密存储");
  if (!passphrase || passphrase.length < 6) throw new Error("口令至少 6 位");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
