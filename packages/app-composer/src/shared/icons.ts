import RawFile from '~icons/kimi/file?raw';
import RawFolderOpen from '~icons/kimi/folder-open?raw';
import RawSkill from '~icons/kimi/skill?raw';
import RawCopy from '~icons/kimi/copy?raw';
import RawCheck from '~icons/kimi/check?raw';
import RawExternalLinkLine from '~icons/ri/external-link-line?raw';
import RawTarget from '~icons/kimi/target?raw';
import RawEdit from '~icons/kimi/edit?raw';
import RawClose from '~icons/kimi/close?raw';
import RawAttachment2 from '~icons/ri/attachment-2?raw';
import RawImageLine from '~icons/ri/image-line?raw';
import RawVideoLine from '~icons/ri/video-line?raw';
import RawFullscreenLine from '~icons/ri/fullscreen-line?raw';
import RawChatQuoteLine from '~icons/ri/chat-quote-line?raw';
import RawBrowser from '~icons/kimi/browser?raw';
import RawFileTextLine from '~icons/ri/file-text-line?raw';

type IconName = 'file' | 'folder' | 'skill' | 'copy' | 'check' | 'external-link' | 'target' | 'file-edit' | 'close' | 'attachment' | 'image' | 'video' | 'fullscreen' | 'quote' | 'browser' | 'text';
type IconSize = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<IconSize, number> = { sm: 14, md: 16, lg: 20 };

const RAW: Record<IconName, string> = {
  file: RawFile,
  folder: RawFolderOpen,
  skill: RawSkill,
  copy: RawCopy,
  check: RawCheck,
  'external-link': RawExternalLinkLine,
  target: RawTarget,
  'file-edit': RawEdit,
  close: RawClose,
  attachment: RawAttachment2,
  image: RawImageLine,
  video: RawVideoLine,
  fullscreen: RawFullscreenLine,
  quote: RawChatQuoteLine,
  browser: RawBrowser,
  text: RawFileTextLine,
};

export function iconSvg(name: IconName, size: IconSize = 'md'): string {
  const px = SIZE_PX[size];
  return RAW[name]
    .replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, ''))
    .replace(/^<svg\b/, `<svg class="kw-icon" width="${px}" height="${px}" aria-hidden="true"`);
}
