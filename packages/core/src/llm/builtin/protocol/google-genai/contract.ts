export type GoogleContent = {
  role: 'user' | 'model';
  parts: GooglePart[];
};

export type GooglePart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string; mimeType: string };
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, string>;
    parts?: GooglePart[];
  };
};
