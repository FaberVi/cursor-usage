/// <reference types="node" />
/// <reference path="../types/bun-test.d.ts" />
import { createCipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { describe, expect, it } from "bun:test";
import { openCursorAuthSecret } from "../src/cursor-safe-storage";

const PREFIX = "cursor-safe-storage:v1:";

function seal(blob: Buffer): string {
  return PREFIX + blob.toString("base64");
}

function gcmBlob(plaintext: string, key: Buffer, nonce: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, ciphertext, cipher.getAuthTag()]);
}

function cbcBlob(plaintext: string, password: string, iterations: number, prefix: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from(prefix), body]);
}

async function expectMessage(run: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`expected ${message}`);
}

describe("openCursorAuthSecret", () => {
  it("returns a plaintext value unchanged", async () => {
    const jwt = "header.payload.signature";
    expect(await openCursorAuthSecret(jwt)).toBe(jwt);
  });

  it("opens a v10 AES-GCM blob with an injected key", async () => {
    const key = randomBytes(32);
    const plaintext = "eyJhbGciOiJub25lIn0.e30.sig";
    const sealed = seal(gcmBlob(plaintext, key, randomBytes(12)));
    expect(await openCursorAuthSecret(sealed, { aes256Key: key })).toBe(plaintext);
  });

  it("rejects a flipped GCM tag without echoing the secret", async () => {
    const key = randomBytes(32);
    const plaintext = "secret-jwt-value";
    const blob = gcmBlob(plaintext, key, randomBytes(12));
    blob[blob.length - 1] ^= 0xff;
    const sealed = seal(blob);
    try {
      await openCursorAuthSecret(sealed, { aes256Key: key });
      throw new Error("expected decrypt failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toBe("Could not decrypt sealed token");
      expect(message.includes(plaintext)).toBe(false);
      expect(message.includes(sealed.slice(PREFIX.length))).toBe(false);
    }
  });

  it("opens macOS and Linux CBC layouts with an injected password", async () => {
    const password = "keychain-password";
    const plaintext = "jwt-from-cbc";
    const mac = seal(cbcBlob(plaintext, password, 1003, "v10"));
    expect(await openCursorAuthSecret(mac, { cbcPassword: password, cbcIterations: 1003 })).toBe(plaintext);

    for (const prefix of ["v10", "v11"]) {
      const linux = seal(cbcBlob(plaintext, "peanuts", 1, prefix));
      expect(await openCursorAuthSecret(linux, { cbcPassword: "peanuts", cbcIterations: 1 })).toBe(plaintext);
    }
  });

  it("rejects v20 even when an AES key is supplied", async () => {
    const blob = Buffer.concat([Buffer.from("v20"), randomBytes(32)]);
    await expectMessage(
      () => openCursorAuthSecret(seal(blob), { aes256Key: randomBytes(32) }),
      "Sealed token uses an unsupported OSCrypt version",
    );
  });

  it("rejects a truncated v10 payload and a non-base64 payload", async () => {
    const key = randomBytes(32);
    await expectMessage(
      () => openCursorAuthSecret(seal(Buffer.concat([Buffer.from("v10"), randomBytes(8)])), { aes256Key: key }),
      "Sealed token payload is truncated",
    );
    await expectMessage(
      () => openCursorAuthSecret(`${PREFIX}not-valid_base64`),
      "Sealed token payload is not valid base64",
    );
  });
});
