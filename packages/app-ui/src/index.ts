// @moonshot-ai/app-ui — presentational design-system components.
// Source-only package: consumers' bundler transpiles these (`exports` points at
// ./src/*). Tokens live in ./style.css; the icon resolver + dialog stack are
// the small bits of UI infrastructure exported alongside the components.

export { default as ActionToast } from './components/ui/ActionToast.vue';
export { default as AuthStateIcon } from './components/ui/AuthStateIcon.vue';
export { default as Avatar } from './components/ui/Avatar.vue';
export { default as Badge } from './components/ui/Badge.vue';
export { default as Banner } from './components/ui/Banner.vue';
export { default as Button } from './components/ui/Button.vue';
export { default as Card } from './components/ui/Card.vue';
export { default as Checkbox } from './components/ui/Checkbox.vue';
export { default as CommandBar } from './components/ui/CommandBar.vue';
export { default as ContextRing } from './components/ui/ContextRing.vue';
export { default as Dialog } from './components/ui/Dialog.vue';
export { default as Divider } from './components/ui/Divider.vue';
export { default as EmptyState } from './components/ui/EmptyState.vue';
export { default as Field } from './components/ui/Field.vue';
export { default as Icon } from './components/ui/Icon.vue';
export { default as IconButton } from './components/ui/IconButton.vue';
export { default as Input } from './components/ui/Input.vue';
export { default as Kbd } from './components/ui/Kbd.vue';
export { default as Link } from './components/ui/Link.vue';
export { default as Menu } from './components/ui/Menu.vue';
export { default as MenuItem } from './components/ui/MenuItem.vue';
export { default as PanelHeader } from './components/ui/PanelHeader.vue';
export { default as Pill } from './components/ui/Pill.vue';
export { default as ScrollArea } from './components/ui/ScrollArea.vue';
export { default as SegmentedControl } from './components/ui/SegmentedControl.vue';
export { default as Select } from './components/ui/Select.vue';
export { default as Sheet } from './components/ui/Sheet.vue';
export { default as Skeleton } from './components/ui/Skeleton.vue';
export { default as Spinner } from './components/ui/Spinner.vue';
export { default as StatusDot } from './components/ui/StatusDot.vue';
export { default as Switch } from './components/ui/Switch.vue';
export { default as Tabs } from './components/ui/Tabs.vue';
export { default as Textarea } from './components/ui/Textarea.vue';
export { default as Toast } from './components/ui/Toast.vue';
export { default as Tooltip } from './components/ui/Tooltip.vue';
export { default as TopBar } from './components/ui/TopBar.vue';

// UI infrastructure shared with the consumer (not presentational components):
export { openDialogCount } from './composables/dialogStack';
export { useImeComposition } from './composables/useImeComposition';
export { IconResolverKey, SIZE_PX, type IconSize } from './icons';
