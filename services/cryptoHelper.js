/**
 * services/cryptoHelper.js
 * Cryptographic helper utilizing the native Web Crypto API (AES-GCM + PBKDF2).
 * Secures sensitive API keys with a Master Password before local persistence.
 */

// Convert a binary buffer to a Base64 string
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert a Base64 string to a binary buffer
function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Derives an AES-GCM 256-bit key from a password and salt using PBKDF2.
 */
async function deriveKey(password, saltBuffer) {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  
  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: 100000,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts cleartext using a password.
 * Returns an object with ciphertext, iv, and salt (all Base64).
 */
async function encryptText(cleartext, password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(cleartext);
  
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  const key = await deriveKey(password, salt);
  
  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    data
  );
  
  return {
    ciphertext: bufferToBase64(ciphertextBuffer),
    iv: bufferToBase64(iv),
    salt: bufferToBase64(salt)
  };
}

/**
 * Decrypts an encrypted object using a password.
 */
async function decryptText(encryptedObj, password) {
  const { ciphertext, iv, salt } = encryptedObj;
  
  const saltBuffer = base64ToBuffer(salt);
  const ivBuffer = base64ToBuffer(iv);
  const ciphertextBuffer = base64ToBuffer(ciphertext);
  
  const key = await deriveKey(password, saltBuffer);
  
  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: ivBuffer
    },
    key,
    ciphertextBuffer
  );
  
  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}

// Export functions for ES Modules / Service Worker context if necessary
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    encryptText,
    decryptText
  };
}
