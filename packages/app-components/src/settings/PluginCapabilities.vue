<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Button, Icon, Link, Spinner } from '@moonshot-ai/app-ui';
import type { AppPluginCapabilities } from '@moonshot-ai/app-core/api';
import type {
  McpAuthorizationTarget,
  McpAuthorizationViewState,
} from '@moonshot-ai/app-client/composables';
import ConfirmDialog from '../dialogs/ConfirmDialog.vue';

type McpServer = AppPluginCapabilities['mcpServers'][number];

const props = withDefaults(defineProps<{
  capabilities?: AppPluginCapabilities;
  loading?: boolean;
  error?: string;
  pluginId?: string;
  authorization?: Readonly<Record<string, McpAuthorizationViewState>>;
  authorizationError?: string;
}>(), {
  capabilities: undefined,
  loading: false,
  error: undefined,
  pluginId: undefined,
  authorization: () => ({}),
  authorizationError: undefined,
});

const emit = defineEmits<{
  authorize: [target: McpAuthorizationTarget];
  cancel: [runtimeName: string];
  reset: [target: McpAuthorizationTarget];
  retry: [];
  retryCapabilities: [];
}>();

const { t } = useI18n();
const hasMcpServers = computed(() => (props.capabilities?.mcpServers.length ?? 0) > 0);
const hasSkills = computed(() => (props.capabilities?.skills.length ?? 0) > 0);
const visible = computed(() =>
  props.loading ||
  props.error !== undefined ||
  props.authorizationError !== undefined ||
  hasMcpServers.value ||
  hasSkills.value,
);
const failedMcpIconUrls = ref(new Set<string>());

watch(() => props.capabilities, () => {
  failedMcpIconUrls.value = new Set();
});

function showMcpIcon(server: McpServer): boolean {
  return server.iconUrl !== undefined && !failedMcpIconUrls.value.has(server.iconUrl);
}

function markMcpIconFailed(server: McpServer): void {
  if (server.iconUrl === undefined) return;
  const next = new Set(failedMcpIconUrls.value);
  next.add(server.iconUrl);
  failedMcpIconUrls.value = next;
}

function authState(server: McpServer): McpAuthorizationViewState | undefined {
  if (props.pluginId === undefined) return undefined;
  return props.authorization[server.runtimeName];
}

function authVisible(server: McpServer): boolean {
  if (props.pluginId === undefined) return false;
  const state = authState(server);
  if (state === undefined) return false;
  return state.status === 'oauth-required' ||
    state.status === 'oauth-expired' ||
    state.status === 'oauth-authorized' ||
    state.phase !== 'idle' ||
    state.cancelled === true;
}

function authorize(server: McpServer): void {
  if (props.pluginId === undefined) return;
  emit('authorize', {
    pluginId: props.pluginId,
    serverName: server.name,
    runtimeName: server.runtimeName,
  });
}

const resetTarget = ref<McpServer>();

function reset(server: McpServer): void {
  resetTarget.value = server;
}

function confirmReset(): void {
  const server = resetTarget.value;
  if (server === undefined || props.pluginId === undefined) return;
  resetTarget.value = undefined;
  emit('reset', {
    pluginId: props.pluginId,
    serverName: server.name,
    runtimeName: server.runtimeName,
  });
}
</script>

<template>
  <section v-if="visible" class="plugin-capabilities">
    <h4 class="plugin-capabilities__title">{{ t('settings.plugins.capabilities') }}</h4>
    <div v-if="authorizationError" class="plugin-capabilities__error" role="alert">
      <span>{{ authorizationError }}</span>
      <Button size="xs" variant="secondary" @click="emit('retry')">
        {{ t('settings.plugins.retryAuthorizationStatus') }}
      </Button>
    </div>
    <p v-if="loading" class="plugin-capabilities__loading">{{ t('common.loading') }}</p>
    <div v-else-if="error" class="plugin-capabilities__error" role="alert">
      <span>{{ error }}</span>
      <Button size="xs" variant="secondary" @click="emit('retryCapabilities')">
        {{ t('settings.plugins.retry') }}
      </Button>
    </div>
    <template v-else>
      <section v-if="hasMcpServers" class="plugin-capabilities__group">
        <h5 class="plugin-capabilities__group-title">{{ t('settings.plugins.applications') }}</h5>
        <ul class="plugin-capabilities__list">
          <li v-for="server in capabilities?.mcpServers" :key="server.runtimeName" class="plugin-capabilities__item">
            <img
              v-if="showMcpIcon(server)"
              class="plugin-capabilities__icon"
              :src="server.iconUrl"
              alt=""
              aria-hidden="true"
              @error="markMcpIconFailed(server)"
            >
            <div v-else class="plugin-capabilities__icon plugin-capabilities__icon--default">
              <Icon name="mcp" size="md" />
            </div>
            <div class="plugin-capabilities__identity">
              <strong class="plugin-capabilities__name">{{ server.displayName ?? server.name }}</strong>
              <Badge
                v-if="authState(server)?.status === 'oauth-authorized' && authState(server)?.phase === 'idle'"
                size="sm"
                variant="success"
              >
                {{ t('settings.plugins.authorized') }}
              </Badge>
            </div>
            <span v-if="server.description" class="plugin-capabilities__description">{{ server.description }}</span>
            <template v-if="authVisible(server)">
              <div class="plugin-capabilities__actions">
                <template v-if="authState(server)?.phase === 'idle'">
                  <Button
                    v-if="authState(server)?.status === 'oauth-authorized'"
                    size="xs"
                    variant="secondary"
                    @click="reset(server)"
                  >
                    {{ t('settings.plugins.cancelAuthorization') }}
                  </Button>
                  <Button
                    v-else
                    size="xs"
                    variant="primary"
                    @click="authorize(server)"
                  >
                    {{ t('settings.plugins.authorize') }}
                  </Button>
                </template>
                <template v-else>
                  <span class="plugin-capabilities__authorization-status">
                    <Spinner size="sm" />
                    {{ authState(server)?.phase === 'resetting'
                      ? t('settings.plugins.resettingAuthorization')
                      : t('settings.plugins.authorizing') }}
                  </span>
                  <Link
                    v-if="authState(server)?.openBlocked === true && authState(server)?.authorizationUrl !== undefined"
                    class="plugin-capabilities__authorization-link"
                    :href="authState(server)!.authorizationUrl!"
                    external
                    variant="muted"
                  >
                    {{ t('settings.plugins.openAuthorizationLink') }}
                    <Icon name="external-link" size="sm" />
                  </Link>
                  <Button
                    v-if="authState(server)?.phase === 'waiting'"
                    size="xs"
                    variant="secondary"
                    @click="emit('cancel', server.runtimeName)"
                  >
                    {{ t('settings.plugins.cancelAuthorization') }}
                  </Button>
                </template>
              </div>
            </template>
          </li>
        </ul>
      </section>
      <section v-if="hasSkills" class="plugin-capabilities__group">
        <h5 class="plugin-capabilities__group-title">{{ t('settings.plugins.skills') }}</h5>
        <ul class="plugin-capabilities__list">
          <li v-for="skill in capabilities?.skills" :key="skill.name" class="plugin-capabilities__item">
            <div class="plugin-capabilities__icon plugin-capabilities__icon--default">
              <Icon name="skill" size="md" />
            </div>
            <strong class="plugin-capabilities__name">{{ skill.displayName ?? skill.name }}</strong>
            <span class="plugin-capabilities__description">{{ skill.description || t('settings.plugins.skillGuide') }}</span>
          </li>
        </ul>
      </section>
    </template>
    <ConfirmDialog
      :open="resetTarget !== undefined"
      :title="t('settings.plugins.cancelAuthorization')"
      :message="resetTarget === undefined
        ? ''
        : t('settings.plugins.resetAuthorizationConfirmMessage', {
            name: resetTarget.displayName ?? resetTarget.name,
          })"
      :confirm-label="t('settings.plugins.cancelAuthorization')"
      variant="danger"
      initial-focus="cancel"
      @confirm="confirmReset"
      @cancel="resetTarget = undefined"
    />
  </section>
</template>

<style scoped>
.plugin-capabilities,
.plugin-capabilities__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.plugin-capabilities__title,
.plugin-capabilities__group-title,
.plugin-capabilities__loading,
.plugin-capabilities__error {
  margin: 0;
}

.plugin-capabilities__title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.plugin-capabilities__group-title {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: var(--weight-regular);
}

.plugin-capabilities__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.plugin-capabilities__item {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  align-items: start;
  gap: var(--space-1) var(--space-3);
  padding: var(--space-3) 0;
  background: transparent;
}

.plugin-capabilities__icon {
  grid-row: 1 / span 2;
  align-self: start;
  width: 45px;
  height: 45px;
  object-fit: contain;
}

.plugin-capabilities__icon:not(.plugin-capabilities__icon--default) {
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
}

.plugin-capabilities__icon--default {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-muted);
}

.plugin-capabilities__identity {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.plugin-capabilities__name {
  min-width: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  overflow-wrap: anywhere;
}

.plugin-capabilities__description {
  grid-column: 2;
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  overflow-wrap: anywhere;
}

.plugin-capabilities__actions {
  display: flex;
  grid-column: 3;
  grid-row: 1 / span 2;
  align-items: center;
  align-self: start;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.plugin-capabilities__authorization-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
}

.plugin-capabilities__authorization-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.plugin-capabilities__loading,
.plugin-capabilities__error {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.plugin-capabilities__error {
  color: var(--color-danger);
}
</style>
