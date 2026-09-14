import type { PluginModule } from "@prism-fusion/plugin-runtime";

import { installShellBridge } from "./composables/embeddedSession";

let removeShellBridge: (() => void) | undefined;

const deliverables: PluginModule = {
  name: "deliverables",
  description: "Deliverable catalog, upload and safe document preview",
  manifest: {
    apiVersion: "prism-fusion/v2",
    kind: "frontend-addon",
    id: "deliverables",
    version: "0.1.0",
    requires: [],
    routeScopes: ["/deliverables"],
  },
  routes: [
    {
      path: "/deliverables",
      name: "deliverables",
      component: () => import("./pages/DeliverablesPage.vue"),
    },
  ],
  setup() {
    removeShellBridge = installShellBridge();
  },
  destroy() {
    removeShellBridge?.();
    removeShellBridge = undefined;
  },
};

export default deliverables;
