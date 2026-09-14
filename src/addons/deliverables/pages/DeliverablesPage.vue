<script setup lang="ts">
import DeliverablePanel from "@/addons/deliverables/components/DeliverablePanel.vue";
import { resolvePageContext } from "@/addons/deliverables/utils/pageContext";

const context = resolvePageContext(window.location.search);
</script>

<template>
  <main class="deliverables-page" :class="{ embedded: context.embedded }">
    <DeliverablePanel :conversation-id="context.conversationId" :embedded="context.embedded" />
  </main>
</template>

<style scoped>
.deliverables-page {
  position: relative;
  min-height: 100%;
  padding: 30px clamp(18px, 3vw, 44px) 48px;
}

.deliverables-page.embedded {
  padding: 16px 14px 24px;
}
</style>
