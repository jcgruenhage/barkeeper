import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap/dist/js/bootstrap.bundle.min.js";
import Alpine from "alpinejs";
import { createStore } from "./store.js";
import { startArk } from "./sync/ark.js";
import { inviteFromHash, redeemInviteLink } from "./sync/invite.js";
import { SpacesController } from "./sync/spaces.js";

// Templates use Alpine.raw().
window.Alpine = Alpine;

const status = document.getElementById("boot-status");

function showStatus(text, isError = false) {
  status.hidden = false;
  status.querySelector(".boot-message").textContent = text;
  status.classList.toggle("boot-error", isError);
}

function loadDarkMode() {
  try {
    return JSON.parse(localStorage.getItem("barkeeper-dark-mode")) ?? false;
  } catch {
    return false;
  }
}

async function boot() {
  showStatus("Starting…");
  const ark = await startArk();
  const spaces = new SpacesController(ark, {
    defaultData: () => createStore().data,
    toRaw: Alpine.raw,
  });

  const invite = inviteFromHash(window.location.hash);
  if (invite) {
    try {
      const url = await redeemInviteLink(ark.hive, ark.repo, ark.server, invite, {
        onAttempt: (attempt, of) =>
          showStatus(attempt === 1 ? "Joining space…" : `Joining space (attempt ${attempt} of ${of})…`),
      });
      spaces.remember(url);
      spaces.setActive(url);
    } catch (error) {
      console.error(error);
      alert(`Could not join the space: ${error.message}`);
    } finally {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  showStatus("Opening space…");
  await spaces.ensureSpace();
  const session = await spaces.openActive();

  const store = createStore(spaces);
  store.data = session.initialView();
  store.data.settings ??= {};
  store.data.settings.darkMode = loadDarkMode();

  Alpine.store("barkeeper", store);
  const live = Alpine.store("barkeeper");
  session.attach(live.data);
  spaces.bind(live);

  // Debug handles.
  window.barkeeper = { ark, spaces, session };

  Alpine.start();
  status.hidden = true;
}

boot().catch((error) => {
  console.error(error);
  showStatus(`barkeeper could not start: ${error.message}`, true);
});
