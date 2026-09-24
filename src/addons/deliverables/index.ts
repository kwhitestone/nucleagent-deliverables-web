import type { PluginModule } from "@prism-fusion/plugin-runtime";

import router from "@/router";
import { getAccessToken } from "./utils/token";
import { installShellBridge, leaveForShellLogin } from "./composables/embeddedSession";

let removeShellBridge: (() => void) | undefined;
let removeAuthGuard: (() => void) | undefined;

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
      meta: { requiresAuth: true },
    },
  ],
  setup() {
    removeShellBridge = installShellBridge();
    // Embedded runs wait for the shell's auth push; only standalone navigates.
    removeAuthGuard = router.beforeEach((to) => {
      if (!to.meta.requiresAuth || window.parent !== window || getAccessToken()) return true;
      leaveForShellLogin();
      return false;
    });
  },
  destroy() {
    removeAuthGuard?.();
    removeAuthGuard = undefined;
    removeShellBridge?.();
    removeShellBridge = undefined;
  },
};

export default deliverables;
