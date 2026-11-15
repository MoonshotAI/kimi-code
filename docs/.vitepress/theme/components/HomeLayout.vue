<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { useData } from 'vitepress'
import { onMounted, onUnmounted } from 'vue'
import HomeHero from './HomeHero.vue'
import HomeFeatures from './HomeFeatures.vue'
import HomeQuickStart from './HomeQuickStart.vue'

const { Layout } = DefaultTheme
const { frontmatter } = useData()

function handleKapWireAction(event: Event) {
  const target = event.target as HTMLElement | null
  if (!target) return

  const preview = target.closest('.kap-wire .jp') as HTMLElement | null
  if (preview && preview.parentElement) {
    event.preventDefault()
    preview.parentElement.classList.add('open')
    return
  }

  const more = target.closest('.kap-wire .je') as HTMLElement | null
  if (more) {
    event.preventDefault()
    more.closest('.jn')?.classList.add('open')
    return
  }

  const fold = target.closest('.kap-wire .jt') as HTMLElement | null
  if (fold) {
    event.preventDefault()
    fold.closest('.jn')?.classList.remove('open')
    return
  }

  const toggleBtn = target.closest('.kap-wire .wire-toggle') as HTMLButtonElement | null
  if (toggleBtn) {
    event.preventDefault()
    const wire = toggleBtn.closest('.kap-wire')
    if (!wire) return
    const nodes = [...wire.querySelectorAll('.jn')]
    const open = nodes.some((node) => !node.classList.contains('open'))
    for (const node of nodes) node.classList.toggle('open', open)
    toggleBtn.textContent = open
      ? (toggleBtn.dataset.openText ?? 'Collapse all')
      : (toggleBtn.dataset.closedText ?? 'Expand all')
    return
  }

  const copyBtn = target.closest('.kap-wire .wire-copy') as HTMLButtonElement | null
  if (copyBtn) {
    event.preventDefault()
    const wire = copyBtn.closest('.kap-wire') as HTMLElement | null
    if (!wire) return
    const source = wire.dataset.source ?? wire.textContent ?? ''
    void navigator.clipboard.writeText(source).then(() => {
      const original = copyBtn.dataset.copyText ?? 'Copy'
      copyBtn.textContent = copyBtn.dataset.copiedText ?? 'Copied'
      setTimeout(() => {
        copyBtn.textContent = original
      }, 1200)
    })
  }
}

function handleKapWireKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    handleKapWireAction(event)
  }
}

onMounted(() => {
  document.addEventListener('click', handleKapWireAction)
  document.addEventListener('keydown', handleKapWireKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', handleKapWireAction)
  document.removeEventListener('keydown', handleKapWireKeydown)
})
</script>

<template>
  <Layout>
    <template v-if="frontmatter.layout === 'home'" #home-hero-before>
      <div class="KimiHome">
        <HomeHero />
      </div>
    </template>

    <template v-if="frontmatter.layout === 'home'" #home-features-after>
      <div class="KimiHome">
        <HomeQuickStart />
        <HomeFeatures />
      </div>
    </template>
  </Layout>
</template>

<style>
/* Hide the default hero + features rendered by VitePress when our custom home is active.
   We keep frontmatter.layout: home so VitePress still applies layout-specific behavior. */
.VPHome > .VPHero {
  display: none;
}
.VPHome > .VPFeatures {
  display: none;
}
</style>
