import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const DATA_DIR = `${homedir()}/.local/share/skill-gateway`;
const SECRET_PATH = `${DATA_DIR}/typesafe-api-key.enc.json`;
const MASTER_KEY_PATH = `${DATA_DIR}/typesafe-api-key.key`;
const META_PATH = `${DATA_DIR}/typesafe-api-key.meta.json`;
const KEYCHAIN_SERVICE = "skill-gateway.typesafe-api-key";
const KEYCHAIN_ACCOUNT = "typesafe-api-key";

type EncryptedSecret = { version: 3; iv: string; tag: string; ciphertext: string };
type SecretMeta = { updated_at: string };

function keychainReadCommand(args: string[]): string | null {
  try {
    return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || null;
  } catch {
    return null;
  }
}

function keychainWriteCommand(args: string[]): boolean {
  try {
    execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function localMasterKey(): Buffer {
  if (existsSync(MASTER_KEY_PATH)) return readFileSync(MASTER_KEY_PATH);
  const key = randomBytes(32);
  writeFileSync(MASTER_KEY_PATH, key, { mode: 0o600 });
  chmodSync(MASTER_KEY_PATH, 0o600);
  return key;
}

function localMeta(): SecretMeta | null {
  if (!existsSync(META_PATH)) return null;
  try {
    return JSON.parse(readFileSync(META_PATH, "utf8")) as SecretMeta;
  } catch {
    return null;
  }
}

function writeMeta(updated_at: string): void {
  writeFileSync(META_PATH, `${JSON.stringify({ updated_at })}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(META_PATH, 0o600);
}

function localRead(): string | null {
  if (!existsSync(SECRET_PATH) || !existsSync(MASTER_KEY_PATH)) return null;
  try {
    const encrypted = JSON.parse(readFileSync(SECRET_PATH, "utf8")) as EncryptedSecret;
    const decipher = createDecipheriv("aes-256-gcm", localMasterKey(), Buffer.from(encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function localSave(value: string, updated_at: string): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const encrypted: EncryptedSecret = { version: 3, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  const temp = `${SECRET_PATH}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(encrypted)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, SECRET_PATH);
  writeMeta(updated_at);
}

function keychainRead(): string | null {
  return keychainReadCommand(["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"]);
}

function keychainSave(value: string): boolean {
  return keychainWriteCommand(["add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w", value]);
}

function keychainRemove(): void {
  keychainWriteCommand(["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE]);
}

export function secretStatus(): { configured: boolean; unlocked: boolean; updated_at: string | null } {
  const configured = Boolean(keychainRead() ?? localRead());
  return { configured, unlocked: configured, updated_at: localMeta()?.updated_at ?? null };
}

export function readTypeSafeKey(): string | null {
  return keychainRead() ?? localRead();
}

export function saveTypeSafeKey(value: string): void {
  const key = value.trim();
  if (!key) throw new Error("API key is required");
  const updated_at = new Date().toISOString();
  if (keychainSave(key)) {
    if (existsSync(SECRET_PATH)) unlinkSync(SECRET_PATH);
    if (existsSync(MASTER_KEY_PATH)) unlinkSync(MASTER_KEY_PATH);
    writeMeta(updated_at);
    return;
  }
  // Managed runtimes can block Keychain writes; the local fallback remains encrypted.
  localSave(key, updated_at);
}

export function removeTypeSafeKey(): void {
  keychainRemove();
  for (const path of [SECRET_PATH, MASTER_KEY_PATH, META_PATH]) {
    if (existsSync(path)) unlinkSync(path);
  }
}
