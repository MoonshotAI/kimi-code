<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { FontTarget } from '@moonshot-ai/app-core';
import type { FontPreviewChrome } from './fontPreviewChrome';
import { formatMessageTime } from '@moonshot-ai/app-core/lib';
import { Markdown } from '@moonshot-ai/app-markdown';
import { Icon } from '@moonshot-ai/app-ui';
import FontUiPreview from './FontUiPreview.vue';
import TerminalFontPreview from './TerminalFontPreview.vue';
import HighlightedCode from '../HighlightedCode.vue';
import MessageTime from '../chat/MessageTime.vue';

const props = defineProps<{ target: FontTarget; chrome?: FontPreviewChrome }>();
const { t } = useI18n();
const inverseSquareRoot = `float Q_rsqrt(float number) {
  const float x2 = number * 0.5f;
  // evil floating point bit level hacking
  auto i = std::bit_cast<std::uint32_t>(number);
  i = 0x5f3759df - (i >> 1);        // what the heck?
  float y = std::bit_cast<float>(i);
  y = y * (1.5f - (x2 * y * y));    // 1st iteration
//y = y * (1.5f - (x2 * y * y));    // 2nd iteration, unnecessary
  return y;
}`;
const codeLineNumbers = inverseSquareRoot.split('\n').map((_, index) => index + 1);
const codeKeywords = ['float', 'const', 'auto', 'return'];
const landing = [
  { role: 'user', time: '1969-07-20T20:14:08Z', key: 'settings.fontPreviewApolloGo' },
  { role: 'assistant', time: '1969-07-20T20:17:58Z', key: 'settings.fontPreviewApolloLanded' },
  { role: 'user', time: '1969-07-20T20:18:06Z', key: 'settings.fontPreviewApolloCopy' },
  { role: 'assistant', time: '1969-07-20T20:27:16Z', key: 'settings.fontPreviewApolloCrater' },
] as const;
</script>

<template>
  <figure class="font-specimen">
    <figcaption class="font-specimen-caption">{{ t('settings.fontPreviewCaption') }}</figcaption>
    <FontUiPreview v-if="target === 'ui'" :chrome="chrome" />
    <section v-else class="font-preview" :class="`font-preview--${props.target}`" :aria-label="t('settings.fontPreview')" tabindex="0">
    <TerminalFontPreview v-if="target === 'terminal'" />
    <HighlightedCode
      v-else-if="target === 'code'"
      :code="inverseSquareRoot"
      path="q_rsqrt.cpp"
      :line-numbers="codeLineNumbers"
      :bold-words="codeKeywords"
      :framed="false"
    />
    <div v-else-if="target === 'transcript'" class="font-preview-chat" inert>
      <template v-for="message in landing" :key="message.time">
        <div v-if="message.role === 'user'" class="u-turn">
          <div class="u-bub"><div class="u-text">{{ t(message.key) }}</div></div>
          <div class="u-meta">
            <span class="fp-action"><Icon name="copy" size="sm" /></span>
            <MessageTime :time="message.time" />
          </div>
        </div>
        <div v-else class="a-msg">
          <div class="msg"><Markdown :text="t(message.key)" /></div>
          <div class="a-msg-ft">
            <span class="fp-action"><Icon name="copy" size="sm" /></span>
            <span class="fp-action"><Icon name="git-fork" size="sm" /></span>
            <span class="a-time">{{ formatMessageTime(message.time, t('conversation.yesterday')) }}</span>
          </div>
        </div>
      </template>
    </div>
  </section>
  </figure>
</template>

<style scoped>
.font-specimen {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  min-width: 0;
  margin: 0 0 var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-3);
  border: var(--p-hairline) dashed var(--color-line-strong);
  border-radius: var(--radius-lg);
  background: var(--color-surface-sunken);
}
.font-specimen-caption {
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  user-select: none;
}
.font-preview {
  block-size: var(--p-font-preview-height);
  box-sizing: border-box;
  min-width: 0;
  contain: inline-size;
  flex: none;
  margin: 0;
  padding: var(--space-3);
  overflow: auto;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-regular);
  line-height: var(--leading-prose);
  user-select: text;
}
.font-preview:focus,
.font-preview:focus-visible {
  outline: none;
}
.font-preview strong {
  font-weight: var(--weight-medium);
}
.font-preview--transcript {
  block-size: auto;
}
.font-preview--transcript {
  background: var(--color-bg);
}
.font-preview--code {
  block-size: auto;
  padding: 0;
  background: var(--color-bg);
}
.font-preview--code :deep(.hl-body) {
  padding-block: var(--space-1);
}
.font-preview--terminal {
  background: var(--color-bg);
  overflow: hidden;
}
.font-preview-chat {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  overflow-wrap: anywhere;
}
.u-turn {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  width: 100%;
}
.u-bub {
  max-width: 78%;
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  background: var(--color-user-bubble-bg);
  color: var(--color-text);
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
}
.u-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.u-meta,
.a-msg-ft {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.u-meta :deep(.msg-time) {
  min-height: 20px;
  padding: 0 0 0 3px;
  color: var(--color-text-muted);
  font-size: var(--text-base);
  font-weight: var(--weight-regular);
  line-height: 20px;
  opacity: 1;
}
.a-msg {
  width: 94%;
}
.a-time {
  display: inline-flex;
  align-items: center;
  color: var(--color-text-muted);
  font-size: var(--text-base);
  line-height: 20px;
}
.fp-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-height: 20px;
  padding: 3px;
  color: var(--color-text-muted);
}
.fp-action :deep(svg) {
  display: block;
}
</style>
