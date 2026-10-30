import { spawn } from "child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "crypto";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SAFE_STORAGE_PREFIX = "cursor-safe-storage:v1:";
const DECRYPT_FAILED = "Could not decrypt sealed token";
const UNSUPPORTED = "Sealed token uses an unsupported OSCrypt version";
const INVALID_BASE64 = "Sealed token payload is not valid base64";
const TRUNCATED = "Sealed token payload is truncated";
const KEY_UNWRAP_FAILED = "OSCrypt key unwrap failed";
const KEYCHAIN_MISSING = "Cursor Safe Storage password was not found";
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HELPER_TIMEOUT_MS = 15_000;
const GCM_PREFIX = "v10";
const CBC_IV = Buffer.alloc(16, 0x20);
const DPAPI_UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$cipher = [Convert]::FromBase64String($b64)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

export type OsCryptMaterial = {
  aes256Key?: Buffer;
  cbcPassword?: string;
  cbcIterations?: number;
};

let windowsKey: Buffer | null = null;
let windowsKeyTask: Promise<Buffer> | null = null;
let macPassword: string | null = null;
let macPasswordTask: Promise<string> | null = null;
const legacyPlaintext = new Map<string, string>();
const legacyTasks = new Map<string, Promise<string>>();

export function openCursorAuthSecret(stored: string, material?: OsCryptMaterial): Promise<string> {
  if (!stored.startsWith(SAFE_STORAGE_PREFIX)) return Promise.resolve(stored);
  const blob = decodeSealedPayload(stored.slice(SAFE_STORAGE_PREFIX.length));
  const version = blob.length >= 3 ? blob.subarray(0, 3).toString("utf8") : "";
  if (version === "v20") return Promise.reject(new Error(UNSUPPORTED));

  const hasAes = material?.aes256Key !== undefined;
  const hasCbc = material?.cbcPassword !== undefined;
  if (hasAes && hasCbc) return Promise.reject(new Error(DECRYPT_FAILED));
  if (hasCbc && material?.cbcIterations === undefined) return Promise.reject(new Error(DECRYPT_FAILED));

  if (version === "v11") {
    if (hasAes) return Promise.reject(new Error(UNSUPPORTED));
    if (hasCbc) return Promise.resolve(decryptCbc(blob, material!.cbcPassword!, material!.cbcIterations!));
    if (process.platform === "linux") return Promise.resolve(decryptCbc(blob, "peanuts", 1));
    return Promise.reject(new Error(UNSUPPORTED));
  }

  if (version === GCM_PREFIX) {
    if (hasAes) return Promise.resolve(decryptGcm(blob, material!.aes256Key!));
    if (hasCbc) return Promise.resolve(decryptCbc(blob, material!.cbcPassword!, material!.cbcIterations!));
    return decryptHostV10(blob);
  }

  if (hasAes || hasCbc) return Promise.reject(new Error(UNSUPPORTED));
  if (process.platform === "win32") return openLegacyDpapi(blob);
  return Promise.reject(new Error(UNSUPPORTED));
}

function decodeSealedPayload(payload: string): Buffer {
  if (payload.length === 0 || !STANDARD_BASE64.test(payload)) throw new Error(INVALID_BASE64);
  return Buffer.from(payload, "base64");
}

function decryptGcm(blob: Buffer, key: Buffer): string {
  if (blob.length < 3 + 12 + 16) throw new Error(TRUNCATED);
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(15, blob.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(DECRYPT_FAILED);
  }
}

function decryptCbc(blob: Buffer, password: string, iterations: number): string {
  if (blob.length < 3 + 16) throw new Error(TRUNCATED);
  try {
    const key = pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, CBC_IV);
    return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message === TRUNCATED) throw error;
    throw new Error(DECRYPT_FAILED);
  }
}

function decryptHostV10(blob: Buffer): Promise<string> {
  if (process.platform === "win32") return windowsOsCryptKey().then((key) => decryptGcm(blob, key));
  if (process.platform === "darwin") return cursorSafeStoragePassword().then((password) => decryptCbc(blob, password, 1003));
  if (process.platform === "linux") return Promise.resolve(decryptCbc(blob, "peanuts", 1));
  return Promise.reject(new Error(UNSUPPORTED));
}

function windowsOsCryptKey(): Promise<Buffer> {
  if (windowsKey) return Promise.resolve(windowsKey);
  if (!windowsKeyTask) {
    windowsKeyTask = unwrapWindowsKey().then(
      (key) => {
        windowsKey = key;
        return key;
      },
      (error) => {
        windowsKeyTask = null;
        throw error;
      },
    );
  }
  return windowsKeyTask;
}

function unwrapWindowsKey(): Promise<Buffer> {
  let sealed: Buffer;
  try {
    const localStatePath = join(
      process.env.APPDATA ?? join(homedir(), "AppData/Roaming"),
      "Cursor",
      "Local State",
    );
    const parsed = JSON.parse(readFileSync(localStatePath, "utf8")) as { os_crypt?: { encrypted_key?: unknown } };
    const encoded = parsed.os_crypt?.encrypted_key;
    if (typeof encoded !== "string") throw new Error(KEY_UNWRAP_FAILED);
    const wrapped = Buffer.from(encoded, "base64");
    if (wrapped.length < 5 || wrapped.subarray(0, 5).toString("utf8") !== "DPAPI") throw new Error(KEY_UNWRAP_FAILED);
    sealed = wrapped.subarray(5);
  } catch (error) {
    if (error instanceof Error && error.message === KEY_UNWRAP_FAILED) throw error;
    throw new Error(KEY_UNWRAP_FAILED);
  }
  return unprotectDpapi(sealed).then((key) => {
    if (key.length !== 32) throw new Error(KEY_UNWRAP_FAILED);
    return key;
  });
}

function openLegacyDpapi(blob: Buffer): Promise<string> {
  const id = createHash("sha256").update(blob).digest("hex");
  const cached = legacyPlaintext.get(id);
  if (cached !== undefined) return Promise.resolve(cached);
  let task = legacyTasks.get(id);
  if (!task) {
    task = unprotectDpapi(blob).then(
      (plain) => {
        const text = plain.toString("utf8");
        legacyPlaintext.set(id, text);
        legacyTasks.delete(id);
        return text;
      },
      (error) => {
        legacyTasks.delete(id);
        throw error;
      },
    );
    legacyTasks.set(id, task);
  }
  return task;
}

function unprotectDpapi(blob: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", DPAPI_UNPROTECT_SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const fail = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(KEY_UNWRAP_FAILED));
      try {
        child.kill();
      } catch {
        // The helper already exited.
      }
    };
    timer = setTimeout(fail, HELPER_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stdout.on("error", fail);
    child.stderr.on("data", () => {});
    child.stderr.on("error", fail);
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(KEY_UNWRAP_FAILED));
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8").trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
        reject(new Error(KEY_UNWRAP_FAILED));
        return;
      }
      resolve(Buffer.from(text, "base64"));
    });
    try {
      child.stdin.write(blob.toString("base64"));
      child.stdin.end();
    } catch {
      fail();
    }
  });
}

function cursorSafeStoragePassword(): Promise<string> {
  if (macPassword !== null) return Promise.resolve(macPassword);
  if (!macPasswordTask) {
    macPasswordTask = readKeychainPassword().then(
      (password) => {
        macPassword = password;
        return password;
      },
      (error) => {
        macPasswordTask = null;
        throw error;
      },
    );
  }
  return macPasswordTask;
}

function readKeychainPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(
      "security",
      ["find-generic-password", "-w", "-s", "Cursor Safe Storage", "-a", "Cursor"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const fail = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(KEYCHAIN_MISSING));
      try {
        child.kill();
      } catch {
        // The helper already exited.
      }
    };
    timer = setTimeout(fail, HELPER_TIMEOUT_MS);
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stdout.on("error", fail);
    child.stderr.on("data", () => {});
    child.stderr.on("error", fail);
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const password = Buffer.concat(stdout).toString("utf8").trim();
      if (code !== 0 || password === "") {
        reject(new Error(KEYCHAIN_MISSING));
        return;
      }
      resolve(password);
    });
  });
}
