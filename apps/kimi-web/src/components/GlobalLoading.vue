<!-- apps/kimi-web/src/components/GlobalLoading.vue -->
<!-- Full-screen splash shown on first load until the client has talked to the
     daemon, so a page refresh doesn't flash a half-rendered, not-yet-connected
     app. Hidden once useKimiWebClient.initialized flips true. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
</script>

<template>
  <div class="gload" role="status" :aria-label="t('app.connecting')">
    <div class="gload-box">
      <div class="gload-mark" aria-hidden="true">
        <span class="gload-k">K</span>
        <span class="gload-word">Kimi</span>
      </div>
      <div class="gload-bar" aria-hidden="true"><span class="gload-bar-fill"></span></div>
      <div class="gload-text">{{ t('app.connecting') }}</div>
    </div>
  </div>
</template>

<style scoped>
.gload {
  position: fixed;
  top: 0;
  left: 0;
  /* Viewport units for size + position so the splash always fills the screen,
     even if a transformed/collapsed <html> would otherwise shrink a fixed box
     (same guard as the other overlays). */
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  min-width: 100vw;
  min-height: 100dvh;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}
.gload-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  /* nudge slightly above center — feels more intentional than dead-center */
  transform: translateY(-6%);
}
.gload-mark {
  display: flex;
  align-items: center;
  gap: 11px;
}
.gload-k {
  width: 40px;
  height: 40px;
  flex: none;
  background: var(--ink);
  color: #fff;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 22px;
  animation: gload-pop 0.5s cubic-bezier(0.34, 1.4, 0.6, 1) both;
}
.gload-word {
  font-family: var(--mono);
  font-size: 22px;
  font-weight: 600;
  color: var(--ink);
  letter-spacing: -0.01em;
}
/* slim indeterminate progress bar */
.gload-bar {
  width: 150px;
  height: 3px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
  position: relative;
}
.gload-bar-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 40%;
  border-radius: 3px;
  background: var(--blue);
  animation: gload-slide 1.1s ease-in-out infinite;
}
.gload-text {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0.04em;
}
@keyframes gload-pop {
  from { opacity: 0; transform: scale(0.7); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes gload-slide {
  0% { left: -42%; }
  100% { left: 102%; }
}
@media (prefers-reduced-motion: reduce) {
  .gload-k { animation: none; }
  .gload-bar-fill { animation-duration: 2.4s; }
}
</style>
