/**
 * Crypto tests for the encrypted API key blob.
 */

import {
  decryptSecret,
  encryptSecret,
  isCryptoAvailable,
  isEncryptedSecret,
  PBKDF2_ITERATIONS,
} from "../src/security/keyVault";

let failures = 0;
let checks = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
}

async function main(): Promise<void> {
  check("WebCrypto is available", isCryptoAvailable());

  const plaintext = "sk-test-0123456789abcdef";
  const passphrase = "correct horse battery";

  const blob = await encryptSecret(plaintext, passphrase);
  check("produces an encrypted blob", isEncryptedSecret(blob), blob);
  check("uses PBKDF2 iterations", blob.iterations === PBKDF2_ITERATIONS, blob.iterations);
  check("ciphertext does not contain the plaintext", !JSON.stringify(blob).includes(plaintext));
  check("declares version 1", blob.v === 1);

  const decrypted = await decryptSecret(blob, passphrase);
  check("round-trips with the right passphrase", decrypted === plaintext, decrypted);

  const again = await encryptSecret(plaintext, passphrase);
  check("fresh salt per encryption", again.salt !== blob.salt);
  check("fresh iv per encryption", again.iv !== blob.iv);
  check("different ciphertext each time", again.data !== blob.data);

  let wrongPassphraseFailed = false;
  try {
    await decryptSecret(blob, "wrong passphrase");
  } catch {
    wrongPassphraseFailed = true;
  }
  check("wrong passphrase is rejected", wrongPassphraseFailed);

  // Tamper with one byte of the ciphertext; GCM must reject it.
  const raw = Buffer.from(blob.data, "base64");
  raw[0] = raw[0] ^ 0xff;
  const tampered = { ...blob, data: raw.toString("base64") };
  let tamperFailed = false;
  try {
    await decryptSecret(tampered, passphrase);
  } catch {
    tamperFailed = true;
  }
  check("tampered ciphertext is rejected", tamperFailed);

  let shortPassphraseFailed = false;
  try {
    await encryptSecret(plaintext, "123");
  } catch {
    shortPassphraseFailed = true;
  }
  check("short passphrase is rejected", shortPassphraseFailed);

  check("isEncryptedSecret rejects plaintext", !isEncryptedSecret("sk-123"));
  check("isEncryptedSecret rejects missing fields", !isEncryptedSecret({ v: 1, salt: "x" }));

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${checks - failures}/${checks} checks passed\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Key vault test crashed:", error);
  process.exitCode = 1;
});
