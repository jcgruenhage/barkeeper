import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap/dist/js/bootstrap.bundle.min.js";
import Alpine from "alpinejs";
import { createStore } from "./store.js";

// Templates use Alpine.raw().
window.Alpine = Alpine;

Alpine.store("barkeeper", createStore());
Alpine.start();
