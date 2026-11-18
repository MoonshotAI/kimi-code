

export interface AttachmentTooltipInfo {
  name: string;
  path?: string;
  size?: number;
  error?: string;
  uploading?: boolean;
  uploadProgress?: number;
  fileId?: string;
  sessionId?: string;

  previewUrl?: string;
}

export type AttachmentTooltipResolver = (attId: string) => AttachmentTooltipInfo | null;

let attachmentResolver: AttachmentTooltipResolver | null = null;
let attachmentResolverToken: unknown = null;

export function getAttachmentTooltipResolver(): AttachmentTooltipResolver | null {
  return attachmentResolver;
}

export function setAttachmentTooltipResolver(resolver: AttachmentTooltipResolver): () => void {
  const token = {};
  attachmentResolverToken = token;
  attachmentResolver = resolver;
  return () => {
    if (attachmentResolverToken === token) {
      attachmentResolverToken = null;
      attachmentResolver = null;
    }
  };
}
