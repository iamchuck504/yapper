// Storing an API key.
//
// settings.json is a plain file in the user's profile, so a key written there
// as-is can be read by anything running as that user, and gets copied along
// with the folder. Electron's safeStorage hands the encryption to the OS
// keystore (DPAPI on Windows, Keychain on macOS), which ties the ciphertext to
// this user on this machine.
//
// safeStorage is passed in rather than required, so this can be tested without
// booting Electron and so the "no keystore available" path is reachable.

/**
 * @returns {{enc: boolean, v: string}|null} what to write to settings, or null
 * to clear. `enc: false` means the platform had no keystore, which the UI
 * surfaces rather than hides.
 */
function seal(safeStorage, plain) {
  const text = (plain || '').trim();
  if (!text) return null;
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    return { enc: true, v: safeStorage.encryptString(text).toString('base64') };
  }
  return { enc: false, v: text };
}

/** The key back, or '' when it cannot be read — a wrong answer is worse. */
function open(safeStorage, stored) {
  if (!stored || !stored.v) return '';
  if (!stored.enc) return stored.v;
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(stored.v, 'base64'));
  } catch {
    return '';   // encrypted by another user, or on another machine
  }
}

module.exports = { seal, open };
