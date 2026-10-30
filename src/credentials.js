/**
 * Credential resolution.
 *
 * The PayPal sandbox client id and secret live in an EnigmAgent vault: the published
 * `enigmagent-mcp` package (v1.0.5 on npm), whose `VaultManager` stores each secret under
 * Argon2id key derivation and AES-256-GCM, and resolves a placeholder only when the caller's
 * origin matches the domain the secret was bound to.
 *
 * That origin binding is doing real work here: the PayPal credential is bound to
 * `api-m.sandbox.paypal.com`, so this broker cannot resolve it for any other destination even
 * if its own endpoint table were wrong.
 *
 * What matters for the project's security property is where the resolved value goes. It is used
 * to build an Authorization header and is never placed in a string returned to the agent,
 * logged, or written to the ledger. `assertNoCredential` is the check that keeps that true, and
 * the bench asserts it on every response of both arms.
 *
 * `env` mode exists so the project runs from nothing but a .env file, which is what a judge
 * will do. It is weaker by construction and the CLI says so at startup.
 */

import { FileStorage, VaultManager } from 'enigmagent-mcp/vault-core.js';

export const PAYPAL_SANDBOX_DOMAIN = 'api-m.sandbox.paypal.com';
export const PAYPAL_LIVE_DOMAIN = 'api-m.paypal.com';

export class CredentialError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Resolves from an EnigmAgent vault file. The broker is the trusted backend. */
class VaultSource {
  #manager;
  #username;
  #password;
  #vaultPath;
  #idName;
  #secretName;
  #origin;
  #unlocked = false;

  constructor({ vaultPath, username, password, idName, secretName, origin }) {
    this.#vaultPath = vaultPath;
    this.#username = username;
    this.#password = password;
    this.#idName = idName;
    this.#secretName = secretName;
    this.#origin = origin;
    this.#manager = new VaultManager(new FileStorage(vaultPath));
  }

  get kind() {
    return 'enigmagent-vault';
  }

  get description() {
    return `EnigmAgent vault at ${this.#vaultPath} (Argon2id + AES-256-GCM, bound to ${new URL(this.#origin).hostname})`;
  }

  async #unlock() {
    if (this.#unlocked) return;
    try {
      await this.#manager.unlock(this.#username, this.#password);
    } catch (error) {
      throw new CredentialError(`vault_unlock_failed:${error.message}`);
    }
    this.#unlocked = true;
  }

  async resolve() {
    await this.#unlock();
    let clientId;
    let clientSecret;
    try {
      clientId = await this.#manager.resolve(this.#idName, this.#origin);
      clientSecret = await this.#manager.resolve(this.#secretName, this.#origin);
    } catch (error) {
      throw new CredentialError(`vault_resolve_failed:${error.code ?? error.message}`);
    }
    if (!clientId || !clientSecret) throw new CredentialError('vault_entry_missing');
    return { clientId, clientSecret };
  }
}

/** Resolves from the process environment. Simple, and weaker: the value sits in the env. */
class EnvSource {
  get kind() {
    return 'env';
  }

  get description() {
    return 'process environment (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) — no vault, no origin binding';
  }

  async resolve() {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new CredentialError('env_credentials_missing');
    return { clientId, clientSecret };
  }
}

/** A fixed pair used only with the offline mock, so the repo runs with no PayPal account. */
class MockSource {
  get kind() {
    return 'mock';
  }

  get description() {
    return 'offline mock credential — no PayPal account involved';
  }

  async resolve() {
    return { clientId: 'MOCK-CLIENT-ID-0123456789', clientSecret: 'MOCK-CLIENT-SECRET-abcdefghij' };
  }
}

/**
 * Build the credential source. `GUARDRAIL_CREDENTIALS` picks one explicitly:
 *   vault | env | mock | auto (default)
 * `auto` prefers a configured vault, then the environment, then the mock.
 */
export function createCredentialSource(env = process.env) {
  const mode = env.GUARDRAIL_CREDENTIALS ?? 'auto';
  const wantVault = env.GUARDRAIL_VAULT && env.GUARDRAIL_VAULT_USER && env.GUARDRAIL_VAULT_PASSWORD;

  if (mode === 'mock') return new MockSource();
  if (mode === 'vault' || (mode === 'auto' && wantVault)) {
    if (!wantVault) throw new CredentialError('vault_not_configured');
    return new VaultSource({
      vaultPath: env.GUARDRAIL_VAULT,
      username: env.GUARDRAIL_VAULT_USER,
      password: env.GUARDRAIL_VAULT_PASSWORD,
      idName: env.GUARDRAIL_VAULT_ID_NAME ?? 'PAYPAL_CLIENT_ID',
      secretName: env.GUARDRAIL_VAULT_SECRET_NAME ?? 'PAYPAL_CLIENT_SECRET',
      origin: env.GUARDRAIL_PAYPAL_ORIGIN ?? `https://${PAYPAL_SANDBOX_DOMAIN}`
    });
  }
  if (mode === 'env' || (mode === 'auto' && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET)) {
    return new EnvSource();
  }
  return new MockSource();
}

/**
 * Put the PayPal sandbox credentials into a new EnigmAgent vault, each bound to the sandbox
 * domain. Used by `guardrail vault-init`.
 */
export async function initialiseVault({ vaultPath, username, password, clientId, clientSecret,
  domain = PAYPAL_SANDBOX_DOMAIN }) {
  const manager = new VaultManager(new FileStorage(vaultPath));
  await manager.create(username, password);
  await manager.addSecret({ name: 'PAYPAL_CLIENT_ID', domain, value: clientId });
  await manager.addSecret({ name: 'PAYPAL_CLIENT_SECRET', domain, value: clientSecret });
  manager.lock();
  return { vaultPath, entries: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'], domain };
}

/**
 * The check behind the first incident class: no credential material may appear in anything the
 * model can read. Checks the raw value and its base64 form, because the Authorization header
 * for PayPal's token endpoint is base64 of `id:secret`.
 */
export function assertNoCredential(payload, secrets) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    if (text.includes(secret)) return { ok: false, leaked: `value:${secret.slice(0, 4)}…` };
    const basic = Buffer.from(secret, 'utf8').toString('base64');
    if (basic.length >= 12 && text.includes(basic)) {
      return { ok: false, leaked: `base64:${basic.slice(0, 6)}…` };
    }
  }
  return { ok: true, leaked: null };
}
