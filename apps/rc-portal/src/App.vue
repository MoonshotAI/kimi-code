<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { createAppViewportVarsWriter } from '@moonshot-ai/app-client/lib';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { AuthStateIcon, Button, Icon } from '@moonshot-ai/app-ui';
import { detectEmbeddedBrowser, isIosDevice, type EmbeddedBrowser } from './helpers';
import { logoutSession, probeSession, type SessionInfo } from './session';
import AccountMenu from './AccountMenu.vue';
import AccountPage from './AccountPage.vue';
import UserAvatar from './UserAvatar.vue';
import logoDarkText from './assets/kimi-code-logo-dark-text.svg';
import logoLightText from './assets/kimi-code-logo-light-text.svg';

const { t } = useI18n();
const route = useRoute();

const embeddedBrowser = ref<EmbeddedBrowser | null>(null);
const showOpenGuide = ref(false);
const guideIsIos = isIosDevice(navigator.userAgent);
const mobileMedia = window.matchMedia('(max-width: 639px)');
const isMobile = ref(mobileMedia.matches);
const mobileSection = ref<'devices' | 'account'>('devices');
const session = ref<SessionInfo | null>(null);
const sessionChecking = ref(true);
const loggingOut = ref(false);
const logoutFailed = ref(false);
const devicesAllOffline = ref(false);
let sessionGeneration = 0;

const showAccountMenu = computed(
  () => route.name === 'home' && !isMobile.value && !embeddedBrowser.value && session.value !== null,
);
const showBottomNav = computed(
  () => route.name === 'home' && isMobile.value && !embeddedBrowser.value && session.value !== null,
);
const showAccountPage = computed(() => showBottomNav.value && mobileSection.value === 'account');
const pageTitle = computed(() => {
  if (showAccountPage.value) return t('account.title');
  return route.name === 'home' ? t('devices.title') : t('login.title');
});
const pageSubtitle = computed(() => {
  if (showAccountPage.value) return t('account.subtitle');
  if (route.name !== 'home') return t('login.rcSubtitle');
  return devicesAllOffline.value ? t('devices.allOfflineHint') : t('devices.subtitle');
});
const routeViewProps = computed(() => route.name === 'home'
  ? { session: session.value, sessionChecking: sessionChecking.value }
  : {},
);

function onGuideKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') showOpenGuide.value = false;
}

function onMobileChange(event: MediaQueryListEvent): void {
  isMobile.value = event.matches;
}

let appHeightRaf = 0;
const writeAppViewportVars = createAppViewportVarsWriter(document.documentElement.style);

function setAppHeight(): void {
  const vv = window.visualViewport;
  writeAppViewportVars({ height: vv?.height ?? window.innerHeight, top: vv?.offsetTop ?? 0 });
}

function syncAppHeight(): void {
  if (appHeightRaf) return;
  appHeightRaf = requestAnimationFrame(() => {
    appHeightRaf = 0;
    setAppHeight();
  });
}

async function refreshSession(): Promise<void> {
  const generation = ++sessionGeneration;
  sessionChecking.value = true;
  const next = await probeSession();
  if (generation !== sessionGeneration) return;
  session.value = next;
  sessionChecking.value = false;
  logoutFailed.value = false;
}

function clearSession(): void {
  sessionGeneration += 1;
  session.value = null;
  sessionChecking.value = false;
  logoutFailed.value = false;
  mobileSection.value = 'devices';
}

async function onLogout(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  logoutFailed.value = false;
  try {
    await logoutSession();
    clearSession();
  } catch {
    logoutFailed.value = true;
  } finally {
    loggingOut.value = false;
  }
}

onMounted(() => {
  embeddedBrowser.value = detectEmbeddedBrowser(navigator.userAgent);
  mobileMedia.addEventListener('change', onMobileChange);
  window.addEventListener('keydown', onGuideKeydown);
  setAppHeight();
  window.visualViewport?.addEventListener('resize', syncAppHeight);
  window.visualViewport?.addEventListener('scroll', syncAppHeight);
  window.addEventListener('resize', syncAppHeight);
  if (route.name === 'home' && !embeddedBrowser.value) {
    void refreshSession();
  } else {
    sessionChecking.value = false;
  }
});

onBeforeUnmount(() => {
  mobileMedia.removeEventListener('change', onMobileChange);
  window.removeEventListener('keydown', onGuideKeydown);
  window.visualViewport?.removeEventListener('resize', syncAppHeight);
  window.visualViewport?.removeEventListener('scroll', syncAppHeight);
  window.removeEventListener('resize', syncAppHeight);
  if (appHeightRaf) {
    cancelAnimationFrame(appHeightRaf);
    appHeightRaf = 0;
  }
  document.documentElement.style.removeProperty('--app-height');
  document.documentElement.style.removeProperty('--app-top');
});

watch(
  () => route.name,
  (name) => {
    devicesAllOffline.value = false;
    mobileSection.value = 'devices';
    if (name === 'home' && !embeddedBrowser.value) void refreshSession();
  },
);

const pageLinkCopied = ref(false);

async function copyPageLink(): Promise<void> {
  const ok = await copyTextToClipboard(location.href);
  if (!ok) return;
  pageLinkCopied.value = true;
  setTimeout(() => {
    pageLinkCopied.value = false;
  }, 2000);
}
</script>

<template>
  <header v-if="!embeddedBrowser && route.name !== 'offline'" class="top-header">
    <img class="header-logo brand-logo-dark-text" :src="logoDarkText" alt="Kimi Code" />
    <img class="header-logo brand-logo-light-text" :src="logoLightText" alt="" aria-hidden="true" />
    <AccountMenu
      v-if="showAccountMenu && session"
      :user-info="session"
      :logging-out="loggingOut"
      :logout-failed="logoutFailed"
      @logout="onLogout"
    />
  </header>

  <main class="page" :class="{ 'has-bottom-nav': showBottomNav, 'is-offline-page': route.name === 'offline' }">
    <div class="panel">
      <header v-if="route.name !== 'offline'" class="brand">
        <h1 class="title">{{ pageTitle }}</h1>
        <p class="subtitle">{{ pageSubtitle }}</p>
      </header>

      <div v-if="embeddedBrowser" class="center-body">
        <AuthStateIcon kind="expired" />
        <span class="center-text warn-text">{{ t('login.rcUnsupportedTitle') }}</span>
        <span class="center-hint">
          {{ embeddedBrowser === 'lark' ? t('login.rcUnsupportedHintLark') : t('login.rcUnsupportedHintWechat') }}
        </span>
        <Button variant="primary" class="retry-btn" @click="showOpenGuide = true">
          {{ t('login.rcOpenInBrowser') }}
        </Button>
        <Button variant="secondary" class="retry-btn" @click="copyPageLink">
          {{ pageLinkCopied ? t('login.copied') : t('login.copyLink') }}
        </Button>
      </div>

      <AccountPage
        v-else-if="showAccountPage && session"
        :user-info="session"
        :logging-out="loggingOut"
        :logout-failed="logoutFailed"
        @logout="onLogout"
      />

      <RouterView v-else v-slot="{ Component }">
        <component
          :is="Component"
          v-bind="routeViewProps"
          @all-offline-change="devicesAllOffline = $event"
          @authenticated="refreshSession"
          @session-expired="clearSession"
        />
      </RouterView>
    </div>

    <Teleport to="body">
      <div
        v-if="showOpenGuide"
        class="open-guide-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="t('login.rcOpenInBrowser')"
        @click="showOpenGuide = false"
      >
        <div class="open-guide-content">
          <svg
            class="open-guide-arrow"
            viewBox="0 0 64 64"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M14 58C22 44 34 30 50 18"
              stroke="currentColor"
              stroke-width="4"
              stroke-linecap="round"
            />
            <path
              d="M36 14L52 12L54 28"
              stroke="currentColor"
              stroke-width="4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <p class="open-guide-text">
            {{ guideIsIos ? t('login.rcOpenGuideIos') : t('login.rcOpenGuideAndroid') }}
          </p>
        </div>
      </div>
    </Teleport>
  </main>

  <nav v-if="showBottomNav" class="bottom-nav" :aria-label="t('account.navigation')">
    <div class="bottom-nav-inner">
      <button
        type="button"
        class="bottom-tab"
        :class="{ active: mobileSection === 'devices' }"
        :aria-current="mobileSection === 'devices' ? 'page' : undefined"
        @click="mobileSection = 'devices'"
      >
        <Icon name="device-desktop" size="sm" />
        <span>{{ t('account.devices') }}</span>
      </button>
      <button
        type="button"
        class="bottom-tab"
        :class="{ active: mobileSection === 'account' }"
        :aria-current="mobileSection === 'account' ? 'page' : undefined"
        @click="mobileSection = 'account'"
      >
        <UserAvatar :src="session?.avatar" size="sm" />
        <span>{{ t('account.title') }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.top-header {
  position: fixed;
  inset: 0 0 auto;
  z-index: 30;
  height: calc(64px + env(safe-area-inset-top));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  box-sizing: border-box;
  padding: env(safe-area-inset-top) calc(var(--space-6) + env(safe-area-inset-right)) 0
    calc(var(--space-6) + env(safe-area-inset-left));
  border-bottom: var(--p-hairline) solid var(--color-subtle);
  background: var(--color-bg);
}
.header-logo { height: 24px; width: auto; display: block; }
.page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: calc(88px + env(safe-area-inset-top))
    calc(var(--space-4) + env(safe-area-inset-right))
    calc(var(--space-6) + env(safe-area-inset-bottom))
    calc(var(--space-4) + env(safe-area-inset-left));
}
.page.has-bottom-nav { padding-bottom: calc(90px + env(safe-area-inset-bottom)); }
.panel {
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.bottom-nav {
  position: fixed;
  inset: auto 0 0;
  z-index: 30;
  min-height: calc(66px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  border-top: var(--p-hairline) solid var(--color-line);
  background: var(--color-surface-raised);
}
.bottom-nav-inner { max-width: 400px; height: 66px; display: grid; grid-template-columns: 1fr 1fr; margin: 0 auto; }
.bottom-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  border: none;
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  cursor: pointer;
}
.bottom-tab.active { color: var(--color-accent); }
.bottom-tab:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

@media (min-width: 640px) {
  .panel {
    background: var(--color-surface);
    border: var(--p-hairline) solid var(--color-line);
    border-radius: var(--radius-xl);
    padding: var(--space-8);
  }
}
@media (max-width: 639px) {
  .top-header {
    height: calc(56px + env(safe-area-inset-top));
    padding-right: calc(var(--space-4) + env(safe-area-inset-right));
    padding-left: calc(var(--space-4) + env(safe-area-inset-left));
  }
  .header-logo { height: 22px; }
  .page { padding-top: calc(80px + env(safe-area-inset-top)); }
  .page.has-bottom-nav { padding-bottom: calc(90px + env(safe-area-inset-bottom)); }
}
.page.is-offline-page { padding-top: calc(var(--space-6) + env(safe-area-inset-top)); }

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  text-align: center;
}
.brand-logo-light-text {
  display: none;
}
html[data-color-scheme="dark"] .brand-logo-dark-text {
  display: none;
}
html[data-color-scheme="dark"] .brand-logo-light-text {
  display: block;
}
@media (prefers-color-scheme: dark) {
  html[data-color-scheme="system"] .brand-logo-dark-text {
    display: none;
  }
  html[data-color-scheme="system"] .brand-logo-light-text {
    display: block;
  }
}
.title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
}
.subtitle {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.open-guide-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: var(--color-scrim-strong);
  animation: open-guide-in var(--duration-base) var(--ease-out);
}
@keyframes open-guide-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.open-guide-content {
  position: absolute;
  top: calc(var(--space-6) + env(safe-area-inset-top));
  right: calc(var(--space-5) + env(safe-area-inset-right));
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-3);
  max-width: min(280px, 70vw);
  color: var(--color-text-on-scrim);
}
.open-guide-arrow {
  width: 48px;
  height: 48px;
  margin-right: var(--space-2);
}
.open-guide-text {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
  text-align: right;
}

@media (prefers-reduced-motion: reduce) {
  .open-guide-overlay { animation: none; }
}
</style>
