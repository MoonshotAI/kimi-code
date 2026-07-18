<!-- apps/kimi-web/src/components/GlobalLoading.vue -->
<!-- Full-screen splash shown on first load until the client has talked to the
     daemon, so a page refresh doesn't flash a half-rendered, not-yet-connected
     app. Hidden once useKimiWebClient.initialized flips true.
     The KIMI wordmark is the official mark from kimi.com (viewBox added so it
     scales; paths use currentColor so we can ink it). -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Spinner from './ui/Spinner.vue';
/** Last connection error from the first-load auth gate's retry loop, shown so
 *  a "cannot connect" state is diagnosable instead of a bare spinner. */
defineProps<{ issue?: string | null }>();
const { t } = useI18n();
</script>

<template>
  <div class="gload" role="status" :aria-label="t('app.connecting')">
    <div class="gload-box">
      <svg class="gload-logo" viewBox="0 0 96 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path fill="currentColor" d="M35.767 31.329c0 .37.3.671.67.671h4.305c.371 0 .672-.3.672-.671V.67c0-.37-.3-.671-.672-.671h-4.304c-.37 0-.671.3-.671.671z" />
        <path fill="currentColor" d="M90.353 31.329c0 .37.3.671.67.671h4.305c.371 0 .672-.3.672-.671V.67c0-.37-.3-.671-.672-.671h-4.304a.67.67 0 0 0-.671.671z" />
        <path fill="currentColor" d="M73.256 0a.67.67 0 0 0-.652.512l-6.366 26.1c-.106.428-.607.428-.71 0L59.159.512A.67.67 0 0 0 58.511 0H47.725c-.37 0-.668.3-.668.671V31.33c0 .37.3.671.67.671h4.781c.37 0 .671-.292.671-.662V5.554c0-.515.604-.622.726-.127l6.358 26.06a.67.67 0 0 0 .653.513h9.931c.31 0 .58-.212.653-.512L77.855 5.43c.122-.495.726-.388.726.127v25.772c0 .37.3.671.671.671h4.78c.371 0 .672-.3.672-.671V.67c0-.37-.3-.671-.671-.671z" />
        <path fill="currentColor" d="M15.279 14.837 28.264 1.133A.671.671 0 0 0 27.777 0h-6.043a.67.67 0 0 0-.477.199L6.374 15.223c-.231.234-.573.025-.573-.35V.672c0-.37-.3-.671-.671-.671H.67a.67.67 0 0 0-.67.67V31.33c0 .37.3.671.671.671H5.13c.37 0 .671-.3.671-.671v-6.114a.5.5 0 0 1 .13-.35l4.594-4.69a.293.293 0 0 1 .386-.045l12.286 9.305c1.796 1.245 4.083 2.06 6.178 2.401a.645.645 0 0 0 .743-.648v-5.537a.7.7 0 0 0-.562-.677c-1.215-.262-2.565-.758-3.59-1.468L15.332 15.58c-.22-.152-.248-.544-.052-.744" />
      </svg>
      <Spinner size="md" :label="t('app.connecting')" />
      <div class="gload-text">{{ t('app.connecting') }}</div>
      <div v-if="issue" class="gload-issue">
        <div>{{ t('app.connectRetrying') }}</div>
        <div class="gload-issue-detail">{{ issue }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gload {
  position: fixed;
  top: 0;
  left: 0;
  /* Viewport units for size + position so the splash always fills the screen,
     even if a transformed/collapsed <html> would otherwise shrink a fixed box. */
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  min-width: 100vw;
  min-height: 100dvh;
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}
.gload-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  /* nudge slightly above center — feels more intentional than dead-center */
  transform: translateY(-6%);
}
.gload-logo {
  width: 128px;
  height: auto;
  color: var(--color-text);
  animation: gload-pop 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.gload-text {
  font-family: var(--mono);
  font-size: var(--text-base);
  color: var(--muted);
  letter-spacing: 0.04em;
}
.gload-issue {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  max-width: min(480px, 80vw);
  font-family: var(--sans);
  font-size: var(--text-sm);
  color: var(--muted);
  text-align: center;
}
.gload-issue-detail {
  font-family: var(--mono);
  font-size: var(--text-xs);
  color: var(--muted);
  opacity: 0.8;
  word-break: break-word;
}
@keyframes gload-pop {
  from { opacity: 0; transform: translateY(6px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .gload-logo { animation: none; }
}

.gload-text { font-family: var(--sans); }
</style>
