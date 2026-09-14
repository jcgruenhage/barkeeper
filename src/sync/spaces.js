// Spaces: which ones this device knows, opening them, sharing them, and moving
// data in and out of them.
//
// The list of spaces lives in localStorage and belongs to this device. Space
// contents, names and members live in the (encrypted) space documents.

import * as A from "@automerge/automerge";
import { Access } from "@automerge/automerge-repo-keyhive";
import { initialValue, materialize, applyView } from "./codec.js";
import { copyCocktailInto } from "./copy.js";
import { createInviteLink } from "./invite.js";
import { SpaceSession } from "./session.js";
import { saveServerConfig } from "./ark.js";
import { migrateData } from "../migrate.js";

const LIST_KEY = "barkeeper-spaces";
const ACTIVE_KEY = "barkeeper-active-space";
const LEGACY_KEY = "barkeeper";
const MIGRATED_KEY = "barkeeper-migrated";
const NAME_KEY = "barkeeper-name";
const OPEN_TIMEOUT_MS = 20_000;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function namesOf(doc) {
  return Object.fromEntries(
    Object.entries(doc?.names ?? {}).map(([id, name]) => [id, String(name)]),
  );
}

export class SpacesController {
  constructor(ark, { defaultData, toRaw }) {
    this.ark = ark;
    this.defaultData = defaultData;
    this.toRaw = toRaw;
    this.session = null;
    this.store = null;
  }

  // -- device-local list ----------------------------------------------------

  list() {
    return readJson(LIST_KEY, []);
  }

  saveList(list) {
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
    if (this.store) this.store.space.list = list;
  }

  remember(url, name) {
    const list = this.list();
    const entry = list.find((s) => s.url === url);
    if (entry) {
      if (name && entry.name !== name) entry.name = name;
    } else {
      list.push({ url, name: name ?? "Space" });
    }
    this.saveList(list);
  }

  activeUrl() {
    return localStorage.getItem(ACTIVE_KEY);
  }

  setActive(url) {
    localStorage.setItem(ACTIVE_KEY, url);
  }

  deviceName() {
    return localStorage.getItem(NAME_KEY) ?? "";
  }

  // -- creating and opening -------------------------------------------------

  async createSpace(name, data = this.defaultData()) {
    const { hive, repo } = this.ark;
    const handle = await repo.create2(initialValue(data, name));
    try {
      await hive.addSyncServerRelayToDoc(handle.url);
    } catch (error) {
      // Retried whenever the space is opened.
      console.warn("Could not grant the sync server relay access yet:", error);
    }
    await this.setName(handle, this.deviceName());
    this.remember(handle.url, name);
    return handle.url;
  }

  /** Make sure there is an active space, migrating pre-sync data once. */
  async ensureSpace() {
    const list = this.list();
    if (list.length === 0) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      let url;
      if (legacy && !localStorage.getItem(MIGRATED_KEY)) {
        // The old key stays behind as a backup.
        url = await this.createSpace("Home bar", this.withDefaults(JSON.parse(legacy)));
        localStorage.setItem(MIGRATED_KEY, url);
      } else {
        url = await this.createSpace("Home bar");
      }
      this.setActive(url);
      return;
    }
    if (!list.some((s) => s.url === this.activeUrl())) this.setActive(list[0].url);
  }

  async openActive() {
    const url = this.activeUrl();
    const handle = await withTimeout(
      this.ark.repo.find(url),
      OPEN_TIMEOUT_MS,
      "This space is not on this device yet and could not be fetched from the sync server.",
    );
    this.session = new SpaceSession(handle, this.toRaw);
    this.remember(url, handle.doc()?.name?.toString());
    return this.session;
  }

  /** Wire up the reactive store once Alpine has it. */
  bind(store) {
    this.store = store;
    const handle = this.session.handle;
    Object.assign(store.space, {
      url: handle.url,
      name: handle.doc()?.name?.toString() ?? "",
      list: this.list(),
      selfId: this.ark.selfId,
      server: this.ark.server.endpoint,
    });
    store.device.name = this.deviceName();
    this.session.subscribe((doc) => {
      const name = doc?.name?.toString() ?? "";
      if (store.space.name !== name) {
        store.space.name = name;
        this.remember(handle.url, name);
      }
      store.space.names = namesOf(doc);
    });
    store.space.names = namesOf(handle.doc());

    let timer;
    this.ark.hive.emitter.on("update", () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.refreshMembers(), 500);
    });
    void this.refreshMembers();
    void this.ensureRelay();
    void this.setName(handle, this.deviceName());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.persist();
    });
  }

  async ensureRelay() {
    const url = this.session.handle.url;
    try {
      const members = await this.ark.hive.listMembers(url);
      if (!members.some((m) => m.isSyncServer) && (await this.canAdmin())) {
        await this.ark.hive.addSyncServerRelayToDoc(url);
      }
    } catch (error) {
      console.warn("Could not check the sync server's access:", error);
    }
  }

  async setName(handle, name) {
    if (!name) return;
    const selfId = this.ark.selfId;
    const current = handle.doc()?.names?.[selfId];
    if (current?.toString() === name) return;
    handle.change((d) => {
      if (!d.names) d.names = {};
      d.names[selfId] = new A.ImmutableString(name);
    });
  }

  /**
   * Write everything to storage. Storage writes are otherwise batched, and a
   * reload right after creating a space would lose it.
   */
  async persist() {
    this.session?.flush();
    await this.ark.repo.flush();
    await this.ark.hive.keyhiveStorage.saveKeyhiveWithHash(this.ark.hive.keyhive);
  }

  async reload() {
    await this.persist();
    window.location.reload();
  }

  async switchTo(url) {
    this.setActive(url);
    await this.reload();
  }

  // -- the open space -------------------------------------------------------

  rename(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.session.change((d) => {
      d.name = new A.ImmutableString(trimmed);
    });
    this.remember(this.session.handle.url, trimmed);
  }

  setDeviceName(name) {
    localStorage.setItem(NAME_KEY, name.trim());
    void this.setName(this.session.handle, name.trim());
  }

  async canAdmin() {
    const { hive } = this.ark;
    const access = await hive.bestAccessForDoc(hive.active.individual.id, this.session.handle.url);
    return access?.atLeast(Access.admin()) ?? false;
  }

  async refreshMembers() {
    if (!this.store) return;
    try {
      const members = await this.ark.hive.listMembers(this.session.handle.url);
      this.store.space.members = members
        .filter((m) => !m.isPublic)
        .map((m) => ({
          id: m.id,
          access: m.access.toString(),
          isSelf: m.isSelf,
          isSyncServer: m.isSyncServer,
        }));
      this.store.space.canAdmin = await this.canAdmin();
    } catch (error) {
      console.warn("Could not list members:", error);
    }
  }

  async createInvite(level) {
    const url = this.session.handle.url;
    const link = await createInviteLink(this.ark.hive, url, Access.fromString(level));
    this.session.change((d) => {
      if (!d.names) d.names = {};
      d.names[link.memberId] = new A.ImmutableString(`Invite link (${level})`);
    });
    await this.refreshMembers();
    return link.url;
  }

  async revoke(memberId) {
    await this.ark.hive.revokeMemberFromDoc(this.session.handle.url, memberId);
    await this.refreshMembers();
  }

  /** Forget a space on this device. Access is not given up. */
  leave(url) {
    const list = this.list().filter((s) => s.url !== url);
    this.saveList(list);
    if (url === this.activeUrl()) {
      localStorage.removeItem(ACTIVE_KEY);
      void this.reload();
    }
  }

  /** Use a different sync server, or the default with null. Reloads. */
  async setServer(config) {
    saveServerConfig(config);
    await this.reload();
  }

  // -- moving data ----------------------------------------------------------

  async newSpace(name) {
    const url = await this.createSpace(name);
    await this.switchTo(url);
  }

  /** Fill in top-level fields that files from older versions may lack. */
  withDefaults(data) {
    const defaults = this.defaultData();
    const merged = { ...defaults, ...data };
    merged.settings = { ...defaults.settings, ...(data?.settings ?? {}) };
    return migrateData(merged);
  }

  async importSpace(data, name) {
    const url = await this.createSpace(name, this.withDefaults(data));
    await this.switchTo(url);
  }

  /** Replace everything in the open space with `data`. */
  async replaceSpace(data) {
    this.session.replace(this.withDefaults(data));
    await this.persist();
  }

  async copyCocktailTo(cocktailId, targetUrl) {
    this.session.flush();
    const source = this.toRaw(this.store.data);
    const handle = await withTimeout(
      this.ark.repo.find(targetUrl),
      OPEN_TIMEOUT_MS,
      "The target space could not be opened.",
    );
    const keyOf = new WeakMap();
    const target = materialize(handle.doc(), keyOf);
    copyCocktailInto(source, cocktailId, target, {
      space: this.session.handle.url,
      heads: this.session.handle.heads(),
    });
    handle.change((d) => applyView(d, target, keyOf));
    await this.ark.repo.flush();
  }
}
