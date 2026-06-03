import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Self-hosted fonts (latin subset, only the weights the UI uses) so the
// dashboard renders its real type offline instead of falling back to system
// fonts. Vite fingerprints the woff2 into the signed bundle.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/instrument-serif/latin-400-italic.css";

import "./styles.css";
// Portable skill template (.sd-* / .skill-tile / .dir-*) — the shared layer the
// website examples page and remote cloud vault converge on. Imported after the
// base styles so the template's --av-* alias layer can read the :root tokens.
import "./skill-template.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
