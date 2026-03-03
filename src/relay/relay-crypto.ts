// ---------------------------------------------------------------------------
// E2E encryption primitives for relay client
// Uses Web Crypto API (crypto.subtle) — no extra dependencies
// ---------------------------------------------------------------------------

const subtle = globalThis.crypto.subtle;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Base64-encoded raw public key bytes (for wire transport) */
  publicKeyBase64: string;
}

export interface SessionContentKey {
  key: CryptoKey;
  /** Raw 32-byte key material (for wrap/unwrap) */
  rawBytes: Uint8Array;
}

/** Wire format: base64( nonce[12] || ciphertext || tag[16] ) */
export type EncryptedPayload = string;

// ---------------------------------------------------------------------------
// ECDH key pair generation
// ---------------------------------------------------------------------------

export async function generateSessionKeyPair(): Promise<SessionKeyPair> {
  const keyPair = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );

  const rawPub = await subtle.exportKey("raw", keyPair.publicKey);
  const publicKeyBase64 = Buffer.from(rawPub).toString("base64");

  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyBase64,
  };
}

// ---------------------------------------------------------------------------
// Session Content Key (AES-256-GCM)
// ---------------------------------------------------------------------------

export async function generateSessionContentKey(): Promise<SessionContentKey> {
  const key = await subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );

  const rawBytes = new Uint8Array(await subtle.exportKey("raw", key));
  return { key, rawBytes };
}

// ---------------------------------------------------------------------------
// Import peer public key from base64
// ---------------------------------------------------------------------------

export async function importPeerPublicKey(base64: string): Promise<CryptoKey> {
  const rawBytes = Buffer.from(base64, "base64");
  return subtle.importKey(
    "raw",
    rawBytes,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

// ---------------------------------------------------------------------------
// ECDH + HKDF → Key Encryption Key (KEK)
// ---------------------------------------------------------------------------

export interface DerivedKekResult {
  kek: CryptoKey;
  /** Base64-encoded 32-byte random salt (must be transmitted to the peer) */
  salt: string;
}

export async function deriveKeyEncryptionKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  ownPublicKeyBase64: string,
  peerPublicKeyBase64: string,
  /** If provided, use this salt (receiver side). If absent, generate a random one (sender side). */
  salt?: string,
): Promise<DerivedKekResult> {
  // ECDH shared secret
  const sharedBits = await subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256,
  );

  // Import shared secret as HKDF key material
  const hkdfKey = await subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  // Sort public keys lexicographically so both sides compute the same info
  const sorted = [ownPublicKeyBase64, peerPublicKeyBase64].sort();
  const info = new TextEncoder().encode(
    `flaio-e2e-v1:${sorted[0]}:${sorted[1]}`,
  );

  // Use provided salt (receiver) or generate a random one (sender)
  const saltBytes = salt
    ? Buffer.from(salt, "base64")
    : globalThis.crypto.getRandomValues(new Uint8Array(32));

  // HKDF-SHA256 → AES-256-GCM KEK
  const kek = await subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: saltBytes,
      info,
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return { kek, salt: Buffer.from(saltBytes).toString("base64") };
}

// ---------------------------------------------------------------------------
// Wrap / unwrap SCK with KEK
// ---------------------------------------------------------------------------

export async function wrapSessionContentKey(
  sck: SessionContentKey,
  kek: CryptoKey,
): Promise<EncryptedPayload> {
  return encryptRaw(sck.rawBytes, kek);
}

export async function unwrapSessionContentKey(
  payload: EncryptedPayload,
  kek: CryptoKey,
): Promise<SessionContentKey> {
  const rawBytes = new Uint8Array(await decryptRaw(payload, kek));
  const key = await subtle.importKey(
    "raw",
    rawBytes,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  return { key, rawBytes };
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt data with SCK
// ---------------------------------------------------------------------------

export async function encryptData(
  plaintext: Buffer | Uint8Array,
  sck: SessionContentKey,
): Promise<EncryptedPayload> {
  return encryptRaw(plaintext, sck.key);
}

export async function decryptData(
  payload: EncryptedPayload,
  sck: SessionContentKey,
): Promise<Buffer> {
  return decryptRaw(payload, sck.key);
}

// ---------------------------------------------------------------------------
// Low-level AES-256-GCM helpers
// Wire format: base64( nonce[12] || ciphertext || tag[16] )
// ---------------------------------------------------------------------------

async function encryptRaw(
  plaintext: Buffer | Uint8Array,
  key: CryptoKey,
): Promise<EncryptedPayload> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertextWithTag = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new Uint8Array(plaintext),
  );

  // Concatenate: nonce[12] || ciphertext || tag[16]
  const result = new Uint8Array(12 + ciphertextWithTag.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(ciphertextWithTag), 12);

  return Buffer.from(result).toString("base64");
}

async function decryptRaw(
  payload: EncryptedPayload,
  key: CryptoKey,
): Promise<Buffer> {
  const data = Buffer.from(payload, "base64");

  if (data.length < 12 + 16) {
    throw new Error("Encrypted payload too short");
  }

  const nonce = new Uint8Array(data.subarray(0, 12));
  const ciphertextWithTag = new Uint8Array(data.subarray(12));

  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ciphertextWithTag,
  );

  return Buffer.from(plaintext);
}
