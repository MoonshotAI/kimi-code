import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import HomeLayout from './components/HomeLayout.vue'

import './styles/vars.css'
import './styles/base.css'
import './styles/home.css'
import './styles/kap.css'

export default {
  extends: DefaultTheme,
  Layout: HomeLayout,
} satisfies Theme
