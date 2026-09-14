// Boots the keyhive-protected Automerge repo that holds every space.
//
// Documents are end-to-end encrypted. The sync server only gets relay access,
// so it stores and forwards ciphertext it cannot read. There is a single sync
// server for the whole app; spaces do not record which server they use.

// The repo's subduction subsystem uses the slim subduction entry, which does
// not initialize its WASM. Importing the full entry initializes the shared
// module instance.
import "@automerge/automerge-subduction";
import {
  initializeAutomergeRepoKeyhive,
  uint8ArrayToHex,
} from "@automerge/automerge-repo-keyhive";
import { Repo } from "@automerge/automerge-repo";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";

const SERVER_KEY = "barkeeper-sync-server";

export const DEFAULT_SERVER = {
  endpoint: "wss://keyhive.sync.automerge.org",
  // ARK's built-in identity for the public keyhive sync server.
  identity: "keyhive",
};

/** The configured sync server, or the public default. */
export function loadServerConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(SERVER_KEY));
    if (stored?.endpoint && stored?.contactCardJson && stored?.peerId) {
      return {
        endpoint: stored.endpoint,
        identity: { contactCardJson: stored.contactCardJson, peerId: stored.peerId },
      };
    }
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_SERVER;
}

/** Store a custom sync server, or clear it with null. Takes effect on reload. */
export function saveServerConfig(config) {
  if (!config) {
    localStorage.removeItem(SERVER_KEY);
    return;
  }
  localStorage.setItem(SERVER_KEY, JSON.stringify(config));
}

export async function startArk() {
  const server = loadServerConfig();
  const storage = new IndexedDBStorageAdapter("barkeeper");

  const { hive, repo } = await initializeAutomergeRepoKeyhive({
    createRepo: (config) => new Repo(config),
    storage,
    peerIdSuffix: "barkeeper",
    automaticArchiveIngestion: true,
    cachingMode: "periodic",
    syncServer: server.identity,
    repo: {
      storage,
      subductionWebsocketEndpoints: [server.endpoint],
      enableRemoteHeadsGossiping: true,
    },
  });

  // Ask the browser not to evict our storage. The identity key lives there,
  // and losing it means losing access to every space on this device.
  navigator.storage?.persist?.().catch(() => {});

  return {
    hive,
    repo,
    server,
    selfId: uint8ArrayToHex(hive.active.individual.id.toBytes()),
  };
}
