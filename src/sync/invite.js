// Invite links, ported from the keyhive todo demo
// (inkandswitch/keyhive-todo-app-demo, src/invite.ts).
//
// A link carries a throwaway keyhive identity: an Ed25519 key pair plus that
// identity's prekey secrets. Creating a link mints such an identity and grants
// it access to the space once. Opening the link rebuilds the identity in the
// visitor's browser, and the visitor uses it to grant the same access to their
// own identity.
//
// The link is a multi-use bearer capability. Revoking the invite identity in
// the member list turns it off; people who already joined through it stay.

import {
  Access,
  CiphertextStore,
  DocumentId as KeyhiveDocumentId,
  initializeAutomergeRepoKeyhive,
  initKeyhiveWasm,
  Keyhive,
  Signer,
  uint8ArrayToHex,
} from "@automerge/automerge-repo-keyhive";
import { Repo, isValidAutomergeUrl, parseAutomergeUrl } from "@automerge/automerge-repo";

const INVITE_HASH_PREFIX = "invite=";
const DOC_SYNC_TIMEOUT_MS = 30_000;
const FIRST_ATTEMPT_SYNC_TIMEOUT_MS = 10_000;
const JOIN_CONFIRM_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const REDEEM_ATTEMPTS = 3;
const REDEEM_RETRY_DELAY_MS = 3_000;

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodePayload(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return bytesToBase64(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeInvite(encoded) {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(base64)));
    if (payload.v !== 1) return null;
    if (!isValidAutomergeUrl(payload.doc)) return null;
    if (!payload.key?.privateKey || !payload.key?.publicKey) return null;
    if (typeof payload.prekeys !== "string") return null;
    Access.fromString(payload.access);
    return payload;
  } catch {
    return null;
  }
}

/** The invite in a location hash, if there is one. */
export function inviteFromHash(hash) {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!withoutHash.startsWith(INVITE_HASH_PREFIX)) return null;
  return decodeInvite(withoutHash.slice(INVITE_HASH_PREFIX.length));
}

function keyhiveDocId(docUrl) {
  const { binaryDocumentId } = parseAutomergeUrl(docUrl);
  return new KeyhiveDocumentId(binaryDocumentId);
}

async function exportKeyPair(keyPair) {
  return {
    publicKey: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", keyPair.privateKey),
  };
}

async function importKeyPair(key) {
  return {
    publicKey: await crypto.subtle.importKey("jwk", key.publicKey, "Ed25519", true, ["verify"]),
    privateKey: await crypto.subtle.importKey("jwk", key.privateKey, "Ed25519", true, ["sign"]),
  };
}

async function poll(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result != null) return result;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// The progress query has to be created once and then polled; asking for a
// fresh one each time restarts it. "unavailable" is not terminal here.
async function waitUntilReadable(repo, docUrl, timeoutMs, message) {
  const query = repo.findWithProgress(docUrl);
  await poll(
    async () => {
      const state = query.peek();
      if (state.state === "failed") throw new Error(message, { cause: state.error });
      return state.state === "ready" ? true : null;
    },
    timeoutMs,
    message,
  );
}

/** Storage for the invite identity's short-lived hive, thrown away after. */
class MemoryStorageAdapter {
  #data = new Map();

  async load(key) {
    return this.#data.get(JSON.stringify(key));
  }
  async save(key, data) {
    this.#data.set(JSON.stringify(key), data);
  }
  async remove(key) {
    this.#data.delete(JSON.stringify(key));
  }
  async loadRange(prefix) {
    const chunks = [];
    for (const [stringified, data] of this.#data) {
      const key = JSON.parse(stringified);
      if (prefix.every((part, i) => key[i] === part)) chunks.push({ key, data });
    }
    return chunks;
  }
  async removeRange(prefix) {
    for (const stringified of [...this.#data.keys()]) {
      const key = JSON.parse(stringified);
      if (prefix.every((part, i) => key[i] === part)) this.#data.delete(stringified);
    }
  }
  async saveBatch(entries) {
    for (const [key, data] of entries) await this.save(key, data);
  }
}

/**
 * Create a throwaway identity with `access` to the space and return a link
 * that lets anyone act on its behalf. The caller must hold at least `access`.
 */
export async function createInviteLink(hive, docUrl, access) {
  initKeyhiveWasm();
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);

  // A bare keyhive, only used to produce the contact card and prekey secrets.
  const inviteKeyhive = await Keyhive.init(
    await Signer.webCryptoSigner(keyPair),
    CiphertextStore.newInMemory(),
    () => {},
  );
  const contactCard = await inviteKeyhive.getExistingContactCard();
  const prekeys = await inviteKeyhive.exportPrekeySecrets();

  await hive.addMemberToDoc(docUrl, contactCard, access);

  const payload = {
    v: 1,
    doc: docUrl,
    access: access.toString(),
    key: await exportKeyPair(keyPair),
    prekeys: bytesToBase64(prekeys),
  };
  const url = new URL(window.location.href);
  url.hash = `${INVITE_HASH_PREFIX}${encodePayload(payload)}`;
  return { url: url.toString(), memberId: uint8ArrayToHex(contactCard.id.toBytes()) };
}

class BeforeDelegationError extends Error {}

/**
 * Act as the invite identity long enough to grant our own identity the same
 * access, then drop it. Resolves with the space URL once it is readable.
 */
export async function redeemInviteLink(hive, repo, server, payload, options = {}) {
  for (let attempt = 1; attempt <= REDEEM_ATTEMPTS; attempt++) {
    options.onAttempt?.(attempt, REDEEM_ATTEMPTS);
    try {
      return await attemptRedeem(hive, repo, server, payload, attempt);
    } catch (error) {
      if (!(error instanceof BeforeDelegationError)) throw error;
      if (attempt >= REDEEM_ATTEMPTS) throw new Error(error.message, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, REDEEM_RETRY_DELAY_MS));
    }
  }
  throw new Error("The invite link could not be redeemed.");
}

async function attemptRedeem(hive, repo, server, payload, attempt) {
  const access = Access.fromString(payload.access);
  const docUrl = payload.doc;
  const storage = new MemoryStorageAdapter();
  const syncTimeoutMs = attempt === 1 ? FIRST_ATTEMPT_SYNC_TIMEOUT_MS : DOC_SYNC_TIMEOUT_MS;

  const { hive: inviteHive, repo: inviteRepo } = await initializeAutomergeRepoKeyhive({
    createRepo: (config) => new Repo(config),
    storage,
    peerIdSuffix: "barkeeper-invite",
    keyPair: await importKeyPair(payload.key),
    automaticArchiveIngestion: true,
    cachingMode: "periodic",
    syncServer: server.identity,
    repo: { storage, subductionWebsocketEndpoints: [server.endpoint] },
  });

  try {
    await inviteHive.keyhive.importPrekeySecrets(base64ToBytes(payload.prekeys));

    const docId = keyhiveDocId(docUrl);
    try {
      await poll(
        () => inviteHive.keyhive.getDocument(docId),
        syncTimeoutMs,
        "The space did not sync. The link may have been revoked.",
      );
      // ARK rotates the key and writes into the document right after the add
      // below, so the invite repo has to hold the document by then.
      await waitUntilReadable(
        inviteRepo,
        docUrl,
        syncTimeoutMs,
        "The space synced but could not be read. The link may be stale.",
      );
    } catch (error) {
      throw new BeforeDelegationError(error instanceof Error ? error.message : String(error));
    }

    await inviteHive.addMemberToDoc(docUrl, hive.active.contactCard, access);

    const selfId = uint8ArrayToHex(hive.active.individual.id.toBytes());
    await poll(
      async () => {
        try {
          const members = await hive.listMembers(docUrl);
          return members.some((m) => m.id === selfId) || null;
        } catch {
          return null;
        }
      },
      JOIN_CONFIRM_TIMEOUT_MS,
      "Joined, but the membership has not synced back yet.",
    );

    // The invite hive has to stay open until we can actually read the space.
    await waitUntilReadable(
      repo,
      docUrl,
      JOIN_CONFIRM_TIMEOUT_MS,
      "Joined, but the space has not become readable yet.",
    );
    return docUrl;
  } finally {
    inviteHive.close();
    await inviteRepo.shutdown();
  }
}
